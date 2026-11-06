import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { EventJournal, ackRecords } from '../../../src/lib/event-journal.js';

describe('events-hook', () => {
  let home: string;
  let out: string;
  const env = { ...process.env };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'mcpc-hook-'));
    process.env = { ...env, MCPC_HOME_DIR: home, MCPC_AGENT: 'bot', MCPC_EVENTS_SESSIONS: '@s' };
    out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      out += String(chunk);
      return true;
    });
    vi.resetModules();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.env = env;
    await rm(home, { recursive: true, force: true });
  });

  async function journal(ids: string[]) {
    const j = await EventJournal.open(join(home, 'events', '@s'));
    await j.commit(
      'claude/channel',
      ids.map((id) => ({
        kind: 'event' as const,
        sub: 'claude/channel',
        name: 'claude/channel',
        eventId: id,
        timestamp: '2026-11-06T00:00:00.000Z',
        receivedAt: '2026-11-06T00:00:00.000Z',
        data: { content: `msg ${id}` },
      })),
      null
    );
  }

  async function run(event: string, input: Record<string, unknown>) {
    out = '';
    const stdin = Readable.from([JSON.stringify(input)]);
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
    const { eventsHook } = await import('../../../src/cli/commands/events-hook.js');
    await eventsHook(event);
    return out ? JSON.parse(out) : undefined;
  }

  it('injects pending events at session start, with ack instructions', async () => {
    await journal(['a', 'b']);
    const result = await run('session-start', { session_id: 'S1' });
    const text = result.hookSpecificOutput.additionalContext as string;
    expect(result.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(text).toContain('msg a');
    expect(text).toContain('mcpc @s events-ack 1 2 --agent bot');
  });

  it('uses MCPC_BIN in the ack hint when set', async () => {
    process.env.MCPC_BIN = 'node /opt/mcpc/dist/cli/index.js';
    await journal(['a']);
    const text = (await run('session-start', { session_id: 'S3' })).hookSpecificOutput
      .additionalContext;
    expect(text).toContain('node /opt/mcpc/dist/cli/index.js @s events-ack 1 --agent bot');
  });

  it('prints nothing when there is nothing pending', async () => {
    expect(await run('session-start', { session_id: 'S1' })).toBeUndefined();
    expect(await run('stop', { session_id: 'S1' })).toBeUndefined();
  });

  it('blocks the stop only for events this Claude session has not seen', async () => {
    await journal(['a']);
    await run('session-start', { session_id: 'S1' });
    // already shown at session start: no block
    expect(await run('stop', { session_id: 'S1' })).toBeUndefined();
    await journal(['b']);
    const blocked = await run('stop', { session_id: 'S1', stop_hook_active: false });
    expect(blocked.decision).toBe('block');
    expect(blocked.reason).toContain('msg b');
    expect(blocked.reason).not.toContain('msg a');
    // shown once: the next stop goes through even though nothing was acked
    expect(await run('stop', { session_id: 'S1', stop_hook_active: true })).toBeUndefined();
  });

  it('skips acknowledged events', async () => {
    await journal(['a', 'b']);
    await ackRecords(join(home, 'events', '@s'), 'bot', [1]);
    const text = (await run('session-start', { session_id: 'S2' })).hookSpecificOutput
      .additionalContext;
    expect(text).not.toContain('msg a');
    expect(text).toContain('msg b');
  });

  it('rejects an unknown hook event', async () => {
    await expect(run('pre-tool', {})).rejects.toThrow('Unknown hook event');
  });
});
