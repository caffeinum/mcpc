/**
 * Waking agents when events arrive (`events-deliver`).
 *
 * A delivery target names an agent and the Claude Code session that acts for it. When the
 * bridge journals events routed to that agent, it runs `claude -p --resume <session>` with a
 * short nudge in the target's folder. The events themselves reach the agent through the
 * mcpc-events plugin's SessionStart hook (and its Stop hook for anything arriving during
 * the turn), so the nudge carries no event content.
 *
 * Collisions use Claude Code's own session registry: a session that `claude agents --json`
 * lists as running is never resumed a second time; its own Stop hook will show the events.
 * `-p` (not `--bg`) is used because it exits after the turn, so the next event can wake the
 * session again. Each event triggers at most one wake per target (a persisted high-water
 * seq), so an agent that never acknowledges cannot be woken in a loop; unacknowledged events
 * stay in the journal and show again at its next session start.
 */

import { execFile, spawn } from 'child_process';
import { open, readFile } from 'fs/promises';
import { join } from 'path';
import { promisify } from 'util';
import { ClientError } from './errors.js';
import { readJournal, readUnacked, validateAgentName, writeFileDurably } from './event-journal.js';
import { isRoutedTo, readRouting } from './event-routing.js';
import { ensureDir, getLogsDir } from './utils.js';
import type { Logger } from './logger.js';

const execFileAsync = promisify(execFile);

/** Coalesce bursts of events into one wake. */
export const DELIVERY_DEBOUNCE_MILLIS = 1500;

export const WAKE_NUDGE =
  'New MCP events are waiting for you (mcpc). They are shown in your context by the ' +
  'mcpc-events plugin. Handle them, then acknowledge them with the events-ack command given there.';

export interface DeliveryTarget {
  agent: string;
  driver: 'claude';
  /** Claude Code session id to resume. */
  claudeSession: string;
  /** Folder the session belongs to (Claude Code keys sessions by folder). */
  cwd: string;
  /** Absolute path of the claude binary, resolved when the target was saved. */
  claudeBin: string;
  /** Extra plugin directory for the woken session (when the plugin is not installed). */
  pluginDir?: string;
  /** How the woken session runs mcpc for its hooks (MCPC_BIN). */
  mcpcBin: string;
}

interface DeliveryFile {
  targets: DeliveryTarget[];
  /** Highest seq that already triggered a wake, per agent. */
  wokenThrough: Record<string, number>;
}

function deliveryPath(dir: string): string {
  return join(dir, 'deliveries.json');
}

export async function readDeliveries(dir: string): Promise<DeliveryFile> {
  try {
    return JSON.parse(await readFile(deliveryPath(dir), 'utf-8')) as DeliveryFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { targets: [], wokenThrough: {} };
    throw error;
  }
}

async function writeDeliveries(dir: string, file: DeliveryFile): Promise<void> {
  await ensureDir(dir);
  await writeFileDurably(deliveryPath(dir), JSON.stringify(file, null, 2), dir);
}

/** Add or replace the target for `target.agent` (one target per agent per session). */
export async function saveDeliveryTarget(dir: string, target: DeliveryTarget): Promise<void> {
  validateAgentName(target.agent);
  if (!/^[A-Za-z0-9-]{8,}$/.test(target.claudeSession)) {
    throw new ClientError(`Invalid Claude session id: ${target.claudeSession}`);
  }
  const file = await readDeliveries(dir);
  const targets = file.targets.filter((t) => t.agent !== target.agent);
  targets.push(target);
  // Only events journaled after this point wake the agent; the backlog shows at session start.
  const lastSeq = (await readJournal(dir)).at(-1)?.seq ?? 0;
  const wokenThrough = {
    ...file.wokenThrough,
    [target.agent]: Math.max(file.wokenThrough[target.agent] ?? 0, lastSeq),
  };
  await writeDeliveries(dir, { targets, wokenThrough });
}

export async function removeDeliveryTarget(dir: string, agent: string): Promise<boolean> {
  const file = await readDeliveries(dir);
  const targets = file.targets.filter((t) => t.agent !== agent);
  if (targets.length === file.targets.length) return false;
  await writeDeliveries(dir, { ...file, targets });
  return true;
}

/** Session ids Claude Code reports as running (interactive, background or -p). */
async function liveClaudeSessions(claudeBin: string): Promise<Set<string>> {
  const { stdout } = await execFileAsync(claudeBin, ['agents', '--json'], {
    timeout: 20_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const sessions = JSON.parse(stdout) as Array<{ sessionId?: string }>;
  return new Set(sessions.flatMap((s) => (s.sessionId ? [s.sessionId] : [])));
}

/**
 * The bridge side: debounced wakes for every delivery target of one mcpc session.
 */
export class EventDeliverer {
  private timer: NodeJS.Timeout | undefined;
  private running = new Map<string, Promise<void>>();
  private rerun = new Set<string>();

  constructor(
    private readonly options: { sessionName: string; eventsDir: string; logger: Logger }
  ) {}

  /** New records were journaled: wake affected agents after a short debounce. */
  trigger(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.deliver(), DELIVERY_DEBOUNCE_MILLIS);
    this.timer.unref?.();
  }

  stop(): void {
    clearTimeout(this.timer);
  }

  private async deliver(): Promise<void> {
    let file: DeliveryFile;
    try {
      file = await readDeliveries(this.options.eventsDir);
    } catch (error) {
      this.options.logger.error('Cannot read delivery targets:', error);
      return;
    }
    for (const target of file.targets) {
      if (this.running.has(target.agent)) {
        this.rerun.add(target.agent);
        continue;
      }
      const run = this.wake(target)
        .catch((error: unknown) => {
          this.options.logger.error(`Waking agent ${target.agent} failed:`, error);
        })
        .finally(() => {
          this.running.delete(target.agent);
          if (this.rerun.delete(target.agent)) this.trigger();
        });
      this.running.set(target.agent, run);
    }
  }

  private async wake(target: DeliveryTarget): Promise<void> {
    const dir = this.options.eventsDir;
    const routing = await readRouting(dir);
    const pending = await readUnacked(dir, target.agent, (r) =>
      isRoutedTo(r, target.agent, routing)
    );
    const file = await readDeliveries(dir);
    const wokenThrough = file.wokenThrough[target.agent] ?? 0;
    const newest = pending.at(-1)?.seq ?? 0;
    if (newest <= wokenThrough) return;

    if ((await liveClaudeSessions(target.claudeBin)).has(target.claudeSession)) {
      this.options.logger.info(
        `Not waking ${target.agent}: Claude session ${target.claudeSession} is running; its hooks deliver`
      );
      return;
    }

    // Record before running, so a crash mid-run never re-wakes for the same events.
    await writeDeliveries(dir, {
      ...file,
      wokenThrough: { ...file.wokenThrough, [target.agent]: newest },
    });
    this.options.logger.info(
      `Waking ${target.agent} (Claude session ${target.claudeSession}) for events through #${newest}`
    );
    await this.runClaude(target);
  }

  private async runClaude(target: DeliveryTarget): Promise<void> {
    await ensureDir(getLogsDir());
    const log = await open(join(getLogsDir(), `deliver-${target.agent}.log`), 'a', 0o600);
    try {
      const args = [
        '-p',
        '--resume',
        target.claudeSession,
        // The one command a headless run may execute unasked: acknowledging these events.
        // `=` form: --allowedTools is variadic and would otherwise swallow the prompt.
        `--allowedTools=Bash(${target.mcpcBin} ${this.options.sessionName} events-ack:*)`,
        WAKE_NUDGE,
      ];
      if (target.pluginDir) args.push('--plugin-dir', target.pluginDir);
      await new Promise<void>((resolve, reject) => {
        const child = spawn(target.claudeBin, args, {
          cwd: target.cwd,
          env: {
            ...process.env,
            MCPC_AGENT: target.agent,
            MCPC_EVENTS_SESSIONS: this.options.sessionName,
            MCPC_BIN: target.mcpcBin,
          },
          stdio: ['ignore', log.fd, log.fd],
        });
        child.on('error', reject);
        child.on('exit', (code) =>
          code === 0 ? resolve() : reject(new Error(`claude exited with code ${code}`))
        );
      });
    } finally {
      await log.close();
    }
  }
}
