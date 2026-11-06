import { chmod, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { EventJournal, type NewJournalRecord } from '../../../src/lib/event-journal.js';
import {
  EventDeliverer,
  readDeliveries,
  removeDeliveryTarget,
  saveDeliveryTarget,
  type DeliveryTarget,
} from '../../../src/lib/event-delivery.js';
import { createNoOpLogger } from '../../../src/lib/logger.js';

const SESSION = '11111111-2222-3333-4444-555555555555';

describe('event delivery', () => {
  let home: string;
  let dir: string;
  let calls: string;
  let liveFile: string;
  let target: DeliveryTarget;
  const env = { ...process.env };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'mcpc-deliver-'));
    process.env = { ...env, MCPC_HOME_DIR: home };
    dir = join(home, 'events', '@s');
    calls = join(home, 'calls.log');
    liveFile = join(home, 'live.json');
    await writeFile(liveFile, '[]');
    // A fake claude: `agents --json` prints liveFile, anything else is logged as a wake.
    const fake = join(home, 'claude');
    await writeFile(
      fake,
      `#!/bin/sh\nif [ "$1" = agents ]; then cat "${liveFile}"; exit 0; fi\necho "$MCPC_AGENT $MCPC_EVENTS_SESSIONS $*" >> "${calls}"\n`
    );
    await chmod(fake, 0o755);
    target = {
      agent: 'bot',
      driver: 'claude',
      claudeSession: SESSION,
      cwd: home,
      claudeBin: fake,
      mcpcBin: 'node /x/mcpc.js',
    };
  });

  afterEach(async () => {
    process.env = env;
    await rm(home, { recursive: true, force: true });
  });

  async function emit(ids: string[]) {
    const journal = await EventJournal.open(dir);
    const batch: NewJournalRecord[] = ids.map((id) => ({
      kind: 'event',
      sub: 'claude/channel',
      name: 'claude/channel',
      eventId: id,
      timestamp: '2026-11-06T00:00:00.000Z',
      receivedAt: '2026-11-06T00:00:00.000Z',
      data: { content: id },
    }));
    await journal.commit('claude/channel', batch, null);
  }

  async function wakes(): Promise<string[]> {
    try {
      return (await readFile(calls, 'utf-8')).trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  async function deliverNow() {
    const deliverer = new EventDeliverer({
      sessionName: '@s',
      eventsDir: dir,
      logger: createNoOpLogger(),
    });
    // Drive one pass directly instead of waiting for the debounce
    await (deliverer as unknown as { deliver: () => Promise<void> }).deliver();
    await Promise.all([
      ...(deliverer as unknown as { running: Map<string, Promise<void>> }).running.values(),
    ]);
  }

  it('wakes the session for events journaled after the target was saved, once per event', async () => {
    await emit(['old']);
    await saveDeliveryTarget(dir, target);
    await deliverNow();
    expect(await wakes()).toEqual([]);

    await emit(['new']);
    await deliverNow();
    const [wake] = await wakes();
    expect(wake).toContain(`bot @s -p --resume ${SESSION}`);
    expect(wake).toContain('--allowedTools=Bash(node /x/mcpc.js @s events-ack:*)');

    // the same events never wake it twice, even unacknowledged
    await deliverNow();
    expect(await wakes()).toHaveLength(1);
  });

  it('does not resume a session Claude Code reports as running', async () => {
    await saveDeliveryTarget(dir, target);
    await writeFile(liveFile, JSON.stringify([{ sessionId: SESSION, status: 'busy' }]));
    await emit(['a']);
    await deliverNow();
    expect(await wakes()).toEqual([]);
    // once it is no longer running, the pending events wake it
    await writeFile(liveFile, '[]');
    await deliverNow();
    expect(await wakes()).toHaveLength(1);
  });

  it('adds, lists and removes targets', async () => {
    await saveDeliveryTarget(dir, target);
    expect((await readDeliveries(dir)).targets.map((t) => t.agent)).toEqual(['bot']);
    expect(await removeDeliveryTarget(dir, 'bot')).toBe(true);
    expect(await removeDeliveryTarget(dir, 'bot')).toBe(false);
  });

  it('rejects an invalid Claude session id', async () => {
    await expect(saveDeliveryTarget(dir, { ...target, claudeSession: '../x' })).rejects.toThrow(
      'Invalid Claude session id'
    );
  });
});
