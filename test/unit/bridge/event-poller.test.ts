import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { EventPoller } from '../../../src/bridge/event-poller.js';
import { EventJournal, readJournal } from '../../../src/lib/event-journal.js';
import type {
  EventDescriptor,
  EventStreamHandlers,
  PollEventsParams,
  PollEventsResult,
  StreamEventsParams,
} from '../../../src/core/events-schema.js';
import type { EventSubscriptionEntry } from '../../../src/lib/types.js';
import { createNoOpLogger } from '../../../src/lib/logger.js';

type Step = PollEventsResult | Error;

function occurrence(eventId: string) {
  return {
    eventId,
    name: 'test.durable',
    timestamp: '2026-11-05T00:00:00.000Z',
    data: { eventId },
  };
}

function page(
  cursor: string | null,
  ids: string[],
  extra: Partial<PollEventsResult> = {}
): PollEventsResult {
  return {
    events: ids.map(occurrence),
    cursor,
    truncated: false,
    hasMore: false,
    nextPollMs: 1,
    ...extra,
  };
}

function rpcError(code: number, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** A fake server that answers polls from a script, then idles with an empty page. */
function scripted(steps: Step[]) {
  const calls: PollEventsParams[] = [];
  let idleCursor: string | null = 'idle';
  const poll = async (params: PollEventsParams): Promise<PollEventsResult> => {
    calls.push(params);
    const step = steps.shift();
    if (step instanceof Error) throw step;
    if (step) {
      idleCursor = step.cursor;
      return step;
    }
    return page(idleCursor, []);
  };
  return { poll, calls };
}

async function until(
  predicate: () => boolean | Promise<boolean>,
  timeoutMillis = 3000
): Promise<void> {
  const deadline = Date.now() + timeoutMillis;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('EventPoller', () => {
  let dir: string;
  let persisted: Record<string, EventSubscriptionEntry>;
  let poller: EventPoller | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcpc-poller-'));
    persisted = {};
  });

  afterEach(async () => {
    await poller?.stopAll();
    poller = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  async function makePoller(poll: (p: PollEventsParams) => Promise<PollEventsResult>) {
    const journal = await EventJournal.open(dir);
    poller = new EventPoller({
      poll,
      journal,
      persist: async (entries) => {
        persisted = entries;
      },
      logger: createNoOpLogger(),
      minIntervalMillis: 1,
    });
    return poller;
  }

  it('bootstraps with a null cursor, then polls from the returned cursor', async () => {
    const server = scripted([page('c0', []), page('c2', ['a', 'b'])]);
    const p = await makePoller(server.poll);
    const entry = await p.add('test.durable', undefined);
    expect(entry.id).toBe('test.durable');
    expect(persisted['test.durable']?.name).toBe('test.durable');

    await until(async () => (await readJournal(dir)).length === 2);
    expect(server.calls[0]?.cursor).toBeNull();
    expect(server.calls[1]?.cursor).toBe('c0');
    await until(() => server.calls.length >= 3);
    expect(server.calls[2]?.cursor).toBe('c2');
  });

  it('drains immediately while hasMore', async () => {
    const server = scripted([
      page('c0', []),
      page('c1', ['a'], { hasMore: true, nextPollMs: 60_000 }),
      page('c2', ['b'], { nextPollMs: 60_000 }),
    ]);
    const p = await makePoller(server.poll);
    await p.add('test.durable', undefined);
    await until(async () => (await readJournal(dir)).length === 2);
  });

  it('records a gap when the server reports truncated', async () => {
    const server = scripted([page('c0', []), page('c9', ['z'], { truncated: true })]);
    const p = await makePoller(server.poll);
    await p.add('test.durable', undefined);
    await until(async () => (await readJournal(dir)).length === 2);
    const [gap, event] = await readJournal(dir);
    expect(gap).toMatchObject({ kind: 'gap', reason: 'truncated' });
    expect(event).toMatchObject({ kind: 'event', eventId: 'z' });
  });

  it('terminates on a terminal error code with a gap record and stops polling', async () => {
    const server = scripted([page('c0', []), rpcError(-32024, 'Forbidden')]);
    const p = await makePoller(server.poll);
    await p.add('test.durable', undefined);
    await until(() => persisted['test.durable']?.terminatedAt !== undefined);
    const records = await readJournal(dir);
    expect(records).toEqual([
      expect.objectContaining({ kind: 'gap', reason: 'terminated', detail: '-32024: Forbidden' }),
    ]);
    const callsAfter = server.calls.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(server.calls.length).toBe(callsAfter);
  });

  it('retries transient errors and clears lastError on recovery', async () => {
    const server = scripted([page('c0', []), new Error('socket hang up'), page('c1', ['a'])]);
    const p = await makePoller(server.poll);
    await p.add('test.durable', undefined);
    await until(() => persisted['test.durable']?.lastError === 'socket hang up');
    await until(async () => (await readJournal(dir)).length === 1, 4000);
    await until(() => persisted['test.durable']?.lastError === undefined);
  });

  it('does not register a subscription the server rejects', async () => {
    const server = scripted([rpcError(-32023, 'NotFound')]);
    const p = await makePoller(server.poll);
    await expect(p.add('nope', undefined)).rejects.toThrow('NotFound');
    expect(p.list()).toEqual([]);
  });

  it('records a no-replay gap when an event type without replay restarts', async () => {
    const first = scripted([page(null, [])]);
    const p1 = await makePoller(first.poll);
    await p1.add('test.ephemeral', undefined);
    await p1.stopAll();

    const second = scripted([]);
    const p2 = await makePoller(second.poll);
    p2.load(persisted);
    await p2.startAll();
    const records = await readJournal(dir);
    expect(records).toEqual([expect.objectContaining({ kind: 'gap', reason: 'no-replay' })]);
  });

  it('resumes from the journaled cursor after a restart', async () => {
    const first = scripted([page('c0', []), page('c1', ['a'])]);
    const p1 = await makePoller(first.poll);
    await p1.add('test.durable', undefined);
    await until(async () => (await readJournal(dir)).length === 1);
    await p1.stopAll();

    const second = scripted([]);
    const p2 = await makePoller(second.poll);
    p2.load(persisted);
    await p2.startAll();
    await until(() => second.calls.length >= 1);
    expect(second.calls[0]?.cursor).toBe('c1');
  });

  it('unsubscribes by name and fails loudly on an unknown one', async () => {
    const server = scripted([page('c0', [])]);
    const p = await makePoller(server.poll);
    await p.add('test.durable', undefined);
    await p.remove('test.durable');
    expect(persisted).toEqual({});
    await expect(p.remove('test.durable')).rejects.toThrow('No event subscription matches');
  });
});

/** Resolves once `signal` aborts, including when it already has. */
function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
}

describe('EventPoller push delivery', () => {
  let dir: string;
  let persisted: Record<string, EventSubscriptionEntry>;
  let poller: EventPoller | undefined;

  type StreamScript = (
    params: StreamEventsParams,
    h: EventStreamHandlers,
    signal: AbortSignal
  ) => Promise<void>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcpc-push-'));
    persisted = {};
  });

  afterEach(async () => {
    await poller?.stopAll();
    poller = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  function descriptor(delivery: EventDescriptor['delivery']): EventDescriptor {
    return { name: 'test.durable', delivery };
  }

  /** Streams run the scripts in order; later opens just wait to be aborted. */
  function streams(scripts: StreamScript[]) {
    const calls: StreamEventsParams[] = [];
    const stream: StreamScript = async (params, h, signal) => {
      calls.push(params);
      const script = scripts.shift();
      if (script) return script(params, h, signal);
      await h.onActive({ cursor: params.cursor, truncated: false });
      await aborted(signal);
    };
    return { stream, calls };
  }

  async function makePoller(options: {
    poll?: (p: PollEventsParams) => Promise<PollEventsResult>;
    stream: StreamScript;
    delivery: EventDescriptor['delivery'];
    streamIdleMillis?: number;
  }) {
    poller = new EventPoller({
      poll: options.poll ?? (async (p) => page(p.cursor ?? 'c0', [])),
      describe: async () => descriptor(options.delivery),
      stream: options.stream,
      journal: await EventJournal.open(dir),
      persist: async (entries) => {
        persisted = entries;
      },
      logger: createNoOpLogger(),
      minIntervalMillis: 1,
      ...(options.streamIdleMillis && { streamIdleMillis: options.streamIdleMillis }),
    });
    return poller;
  }

  it('journals pushed events, persists heartbeat cursors, and catches up by poll on drop', async () => {
    const polls: PollEventsParams[] = [];
    const s = streams([
      async (_p, h) => {
        await h.onActive({ cursor: 'c0', truncated: false });
        await h.onEvent({ ...occurrence('a'), cursor: 'c1' });
        await h.onHeartbeat({ cursor: 'c2' });
        // the server closes the stream
      },
    ]);
    const p = await makePoller({
      delivery: ['poll', 'push'],
      stream: s.stream,
      poll: async (params) => {
        polls.push(params);
        // the catch-up poll returns an event the stream already delivered, plus a new one
        return params.cursor === 'c2' ? page('c3', ['a', 'b']) : page('c0', []);
      },
    });
    const entry = await p.add('test.durable', undefined);
    expect(entry.delivery).toEqual(['poll', 'push']);
    await until(() => s.calls.length >= 2);
    expect(s.calls[0]?.cursor).toBe('c0');
    expect(polls.map((q) => q.cursor)).toEqual([null, 'c2']);
    expect(s.calls[1]?.cursor).toBe('c3');
    const ids = (await readJournal(dir)).map((r) => (r.kind === 'event' ? r.eventId : r.reason));
    expect(ids).toEqual(['a', 'b']);
  });

  it('reconnects a stream that goes silent', async () => {
    const s = streams([
      async (_p, h, signal) => {
        await h.onActive({ cursor: 'c0', truncated: false });
        await aborted(signal);
        throw new Error('aborted');
      },
    ]);
    const p = await makePoller({ delivery: ['push'], stream: s.stream, streamIdleMillis: 30 });
    await p.add('test.durable', undefined);
    await until(() => s.calls.length >= 2);
    expect(s.calls[1]?.cursor).toBe('c0');
  });

  it('records a truncated gap from a resumed stream', async () => {
    const s = streams([
      async (_p, h) => {
        await h.onActive({ cursor: 'c0', truncated: false });
      },
      async (_p, h, signal) => {
        await h.onActive({ cursor: 'c9', truncated: true });
        await aborted(signal);
      },
    ]);
    const p = await makePoller({ delivery: ['push'], stream: s.stream });
    await p.add('test.durable', undefined);
    await until(async () => (await readJournal(dir)).length === 1);
    expect((await readJournal(dir))[0]).toMatchObject({ kind: 'gap', reason: 'truncated' });
  });

  it('ends the subscription on notifications/events/terminated', async () => {
    const s = streams([
      async (_p, h) => {
        await h.onActive({ cursor: 'c0', truncated: false });
        await h.onTerminated({ code: -32024, message: 'Forbidden' });
      },
    ]);
    const p = await makePoller({ delivery: ['push'], stream: s.stream });
    await p.add('test.durable', undefined);
    await until(() => persisted['test.durable']?.terminatedAt !== undefined);
    expect((await readJournal(dir)).at(-1)).toMatchObject({ kind: 'gap', reason: 'terminated' });
    await new Promise((r) => setTimeout(r, 30));
    expect(s.calls).toHaveLength(1);
  });

  it('rejects a push-only subscription the server refuses, registering nothing', async () => {
    const s = streams([
      async () => {
        throw rpcError(-32602, 'InvalidParams');
      },
    ]);
    const p = await makePoller({ delivery: ['push'], stream: s.stream });
    await expect(p.add('test.durable', { bad: true })).rejects.toThrow('InvalidParams');
    expect(p.list()).toEqual([]);
  });

  it('refuses webhook-only event types', async () => {
    const p = await makePoller({ delivery: ['webhook'], stream: streams([]).stream });
    await expect(p.add('test.durable', undefined)).rejects.toThrow(
      'webhooks need a public HTTPS endpoint'
    );
  });
});
