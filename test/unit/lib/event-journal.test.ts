import { appendFile, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  EventJournal,
  ackRecords,
  readCursors,
  readJournal,
  readUnacked,
  subscriptionId,
  type NewJournalRecord,
} from '../../../src/lib/event-journal.js';

function event(sub: string, eventId: string): NewJournalRecord {
  return {
    kind: 'event',
    sub,
    name: 'test.durable',
    eventId,
    timestamp: '2026-11-05T00:00:00.000Z',
    receivedAt: '2026-11-05T00:00:01.000Z',
    data: { eventId },
  };
}

describe('event journal', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcpc-journal-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('assigns monotonic seqs and persists the cursor after the records', async () => {
    const journal = await EventJournal.open(dir);
    const written = await journal.commit('s', [event('s', 'a'), event('s', 'b')], 'c2');
    expect(written.map((r) => r.seq)).toEqual([1, 2]);
    expect((await readCursors(dir)).s?.cursor).toBe('c2');

    const reopened = await EventJournal.open(dir);
    const more = await reopened.commit('s', [event('s', 'c')], 'c3');
    expect(more.map((r) => r.seq)).toEqual([3]);
    expect(reopened.getCursor('s')?.cursor).toBe('c3');
  });

  it('drops events already journaled for the same subscription, including within a batch', async () => {
    const journal = await EventJournal.open(dir);
    await journal.commit('s', [event('s', 'a')], 'c1');
    const written = await journal.commit(
      's',
      [event('s', 'a'), event('s', 'b'), event('s', 'b')],
      'c2'
    );
    expect(written.map((r) => (r.kind === 'event' ? r.eventId : r.reason))).toEqual(['b']);
  });

  it('treats the same eventId on another subscription as a distinct event', async () => {
    const journal = await EventJournal.open(dir);
    await journal.commit('s1', [event('s1', 'a')], 'x');
    const written = await journal.commit('s2', [event('s2', 'a')], 'y');
    expect(written).toHaveLength(1);
  });

  it('dedupes a batch replayed after a crash between journal fsync and cursor write', async () => {
    const journal = await EventJournal.open(dir);
    await journal.commit('s', [event('s', 'a')], 'c1');
    const stateBefore = await readFile(join(dir, 'state.json'), 'utf-8');
    await journal.commit('s', [event('s', 'b'), event('s', 'c')], 'c3');
    // Simulate the crash: journal has b and c, but the cursor write never happened.
    await writeFile(join(dir, 'state.json'), stateBefore);

    const restarted = await EventJournal.open(dir);
    expect(restarted.getCursor('s')?.cursor).toBe('c1');
    const replayed = await restarted.commit('s', [event('s', 'b'), event('s', 'c')], 'c3');
    expect(replayed).toEqual([]);
    expect((await readJournal(dir)).map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(restarted.getCursor('s')?.cursor).toBe('c3');
  });

  it('truncates a torn final line on open and readers ignore it', async () => {
    const journal = await EventJournal.open(dir);
    await journal.commit('s', [event('s', 'a')], 'c1');
    await appendFile(join(dir, 'journal.jsonl'), '{"seq":2,"kind":"ev');
    expect(await readJournal(dir)).toHaveLength(1);

    const reopened = await EventJournal.open(dir);
    const written = await reopened.commit('s', [event('s', 'b')], 'c2');
    expect(written[0]?.seq).toBe(2);
    expect((await readJournal(dir)).map((r) => r.seq)).toEqual([1, 2]);
  });

  it('assigns unique seqs to concurrent commits', async () => {
    const journal = await EventJournal.open(dir);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        journal.commit(`s${i % 3}`, [event(`s${i % 3}`, `e${i}`)], `c${i}`)
      )
    );
    const seqs = (await readJournal(dir)).map((r) => r.seq);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('never dedupes gap records', async () => {
    const journal = await EventJournal.open(dir);
    const gap: NewJournalRecord = {
      kind: 'gap',
      sub: 's',
      name: 'test.durable',
      reason: 'truncated',
      receivedAt: '2026-11-05T00:00:00.000Z',
    };
    await journal.commit('s', [gap], 'c1');
    expect(await journal.commit('s', [gap], 'c2')).toHaveLength(1);
  });

  describe('acks', () => {
    beforeEach(async () => {
      const journal = await EventJournal.open(dir);
      await journal.commit(
        's',
        ['a', 'b', 'c', 'd'].map((id) => event('s', id)),
        'c4'
      );
    });

    it('redelivers until acked and compacts contiguous acks', async () => {
      expect((await readUnacked(dir, 'default')).map((r) => r.seq)).toEqual([1, 2, 3, 4]);
      expect(await ackRecords(dir, 'default', [2])).toEqual({ ackedThrough: 0, acked: [2] });
      expect(await ackRecords(dir, 'default', [1])).toEqual({ ackedThrough: 2, acked: [] });
      expect((await readUnacked(dir, 'default')).map((r) => r.seq)).toEqual([3, 4]);
    });

    it('is idempotent', async () => {
      await ackRecords(dir, 'default', [1]);
      expect(await ackRecords(dir, 'default', [1])).toEqual({ ackedThrough: 1, acked: [] });
    });

    it('keeps acks per agent', async () => {
      await ackRecords(dir, 'alice', 'all');
      expect(await readUnacked(dir, 'alice')).toEqual([]);
      expect(await readUnacked(dir, 'bob')).toHaveLength(4);
    });

    it('fails loudly on an unknown seq', async () => {
      await expect(ackRecords(dir, 'default', [5])).rejects.toThrow('Unknown event seq: 5');
      await expect(ackRecords(dir, 'default', [0])).rejects.toThrow('Unknown event seq: 0');
    });

    it('rejects an invalid agent name', async () => {
      await expect(ackRecords(dir, '../x', [1])).rejects.toThrow('Invalid agent name');
    });
  });
});

describe('subscriptionId', () => {
  it('is the bare name without arguments', () => {
    expect(subscriptionId('a.b', undefined)).toBe('a.b');
    expect(subscriptionId('a.b', {})).toBe('a.b');
  });

  it('is independent of argument key order', () => {
    expect(subscriptionId('a', { x: 1, y: { p: 1, q: 2 } })).toBe(
      subscriptionId('a', { y: { q: 2, p: 1 }, x: 1 })
    );
    expect(subscriptionId('a', { x: 1 })).not.toBe(subscriptionId('a', { x: 2 }));
  });
});
