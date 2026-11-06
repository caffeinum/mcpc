import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { EventPoller } from '../../../src/bridge/event-poller.js';
import { EventJournal, readJournal } from '../../../src/lib/event-journal.js';
import type { PollEventsParams, PollEventsResult } from '../../../src/core/events-schema.js';
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
