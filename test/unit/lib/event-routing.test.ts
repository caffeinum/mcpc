import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  EventJournal,
  ackRecords,
  readUnacked,
  type JournalRecord,
  type NewJournalRecord,
} from '../../../src/lib/event-journal.js';
import {
  isRoutedTo,
  isUnrouted,
  readRouting,
  updateRoute,
  type EventRouting,
} from '../../../src/lib/event-routing.js';

function record(seq: number, sub: string, data: Record<string, unknown> = {}): JournalRecord {
  return {
    seq,
    kind: 'event',
    sub,
    name: sub,
    eventId: `e${seq}`,
    timestamp: '2026-11-06T00:00:00.000Z',
    receivedAt: '2026-11-06T00:00:00.000Z',
    data,
  };
}

const gap: JournalRecord = {
  seq: 9,
  kind: 'gap',
  sub: 's',
  name: 's',
  reason: 'truncated',
  receivedAt: '2026-11-06T00:00:00.000Z',
};

describe('isRoutedTo', () => {
  it('broadcasts subscriptions without a route', () => {
    expect(isRoutedTo(record(1, 's'), 'anyone', { subs: {} })).toBe(true);
  });

  it('delivers only to the subscription agents', () => {
    const routing: EventRouting = { subs: { s: { agents: ['alice', 'bob'] } } };
    expect(isRoutedTo(record(1, 's'), 'alice', routing)).toBe(true);
    expect(isRoutedTo(record(1, 's'), 'carol', routing)).toBe(false);
    expect(isRoutedTo(record(1, 'other'), 'carol', routing)).toBe(true);
  });

  it('delivers addressed records only to the named agents', () => {
    const routing: EventRouting = { subs: { s: { agents: ['alice', 'bob'], path: 'data.to' } } };
    expect(isRoutedTo(record(1, 's', { to: 'bob' }), 'bob', routing)).toBe(true);
    expect(isRoutedTo(record(1, 's', { to: 'bob' }), 'alice', routing)).toBe(false);
    expect(isRoutedTo(record(1, 's', { to: ['alice', 'bob'] }), 'alice', routing)).toBe(true);
    // No recipient at the path: falls back to the subscription agents
    expect(isRoutedTo(record(1, 's', {}), 'alice', routing)).toBe(true);
  });

  it('sends gap records to everyone who receives the subscription', () => {
    const routing: EventRouting = { subs: { s: { agents: ['alice'], path: 'data.to' } } };
    expect(isRoutedTo(gap, 'alice', routing)).toBe(true);
    expect(isRoutedTo(gap, 'bob', routing)).toBe(false);
  });
});

describe('isUnrouted', () => {
  it('flags records naming none of the subscription agents', () => {
    const routing: EventRouting = { subs: { s: { agents: ['alice'], path: 'data.to' } } };
    expect(isUnrouted(record(1, 's', { to: 'mallory' }), routing)).toBe(true);
    expect(isUnrouted(record(1, 's', { to: 'alice' }), routing)).toBe(false);
    expect(isUnrouted(record(1, 's', {}), routing)).toBe(false);
    expect(isUnrouted(gap, routing)).toBe(false);
  });
});

describe('routing with the journal', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcpc-routing-'));
    const journal = await EventJournal.open(dir);
    const batch: NewJournalRecord[] = ['alice', 'bob', 'alice'].map((to, i) => ({
      kind: 'event',
      sub: 's',
      name: 's',
      eventId: `e${i}`,
      timestamp: '2026-11-06T00:00:00.000Z',
      receivedAt: '2026-11-06T00:00:00.000Z',
      data: { to },
    }));
    await journal.commit('s', batch, 'c');
    await updateRoute(dir, 's', { addAgents: ['alice', 'bob'], path: 'data.to' });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function visibleFor(agent: string) {
    const routing = await readRouting(dir);
    return (r: JournalRecord) => isRoutedTo(r, agent, routing);
  }

  it("shows each agent only its own records and rejects acking another's", async () => {
    expect((await readUnacked(dir, 'alice', await visibleFor('alice'))).map((r) => r.seq)).toEqual([
      1, 3,
    ]);
    expect((await readUnacked(dir, 'bob', await visibleFor('bob'))).map((r) => r.seq)).toEqual([2]);
    await expect(ackRecords(dir, 'alice', [2], await visibleFor('alice'))).rejects.toThrow(
      'not routed to agent "alice"'
    );
  });

  it("advances an agent's watermark past records it never receives", async () => {
    const acks = await ackRecords(dir, 'alice', [1, 3], await visibleFor('alice'));
    expect(acks).toEqual({ ackedThrough: 3, acked: [] });
  });

  it('updates routes: add, remove, set and clear the path', async () => {
    expect(await updateRoute(dir, 's', { removeAgents: ['bob'] })).toEqual({
      agents: ['alice'],
      path: 'data.to',
    });
    expect(await updateRoute(dir, 's', { path: null })).toEqual({ agents: ['alice'] });
    expect(await updateRoute(dir, 's', { removeAgents: ['alice'] })).toEqual({});
    expect((await readRouting(dir)).subs).toEqual({});
  });

  it('rejects invalid route paths and agent names', async () => {
    await expect(updateRoute(dir, 's', { path: 'data..to' })).rejects.toThrow('Invalid route path');
    await expect(updateRoute(dir, 's', { addAgents: ['../x'] })).rejects.toThrow(
      'Invalid agent name'
    );
  });
});
