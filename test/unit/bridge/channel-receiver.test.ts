import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  ChannelReceiver,
  CHANNEL_SUBSCRIPTION,
  declaresChannel,
} from '../../../src/bridge/channel-receiver.js';
import { EventJournal, readJournal } from '../../../src/lib/event-journal.js';
import { createNoOpLogger } from '../../../src/lib/logger.js';

describe('ChannelReceiver', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcpc-channel-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function receiver(): Promise<ChannelReceiver> {
    return new ChannelReceiver({
      journal: await EventJournal.open(dir),
      logger: createNoOpLogger(),
    });
  }

  it('journals every message verbatim under the claude/channel subscription', async () => {
    const r = await receiver();
    await r.start();
    await r.handle({ content: 'hello', meta: { chat_id: '42' } });
    await r.handle({ content: 'hello' });
    const records = await readJournal(dir);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      kind: 'event',
      sub: CHANNEL_SUBSCRIPTION,
      data: { content: 'hello', meta: { chat_id: '42' } },
    });
    // Without a server-supplied id identical messages are distinct, never deduped away
    expect(records[0]?.kind === 'event' && records[0].eventId).not.toBe(
      records[1]?.kind === 'event' && records[1].eventId
    );
  });

  it('dedupes by a server-supplied message id', async () => {
    const r = await receiver();
    await r.start();
    await r.handle({ content: 'a', meta: { message_id: 'm1' } });
    await r.handle({ content: 'a', meta: { message_id: 'm1' } });
    expect(await readJournal(dir)).toHaveLength(1);
  });

  it('records a disconnected gap when a previous bridge was listening', async () => {
    const first = await receiver();
    await first.start();
    await first.handle({ content: 'before' });

    const second = await receiver();
    await second.start();
    const records = await readJournal(dir);
    expect(records.at(-1)).toMatchObject({ kind: 'gap', reason: 'disconnected' });
  });

  it('records the window in which the server was unreachable', async () => {
    const r = await receiver();
    await r.start();
    r.markDown();
    r.markDown();
    await r.markUp();
    await r.markUp();
    const gaps = (await readJournal(dir)).filter((rec) => rec.kind === 'gap');
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ reason: 'disconnected' });
    expect(gaps[0]?.kind === 'gap' && gaps[0].detail).toMatch(/server unreachable from .* to /);
  });
});

describe('declaresChannel', () => {
  it('reads capabilities.experimental["claude/channel"]', () => {
    expect(declaresChannel({ experimental: { 'claude/channel': {} } })).toBe(true);
    expect(declaresChannel({ experimental: {} })).toBe(false);
    expect(declaresChannel(undefined)).toBe(false);
  });
});
