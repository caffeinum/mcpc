/**
 * `mcpc supervise` — keep the bridges that receive events running.
 *
 * mcpc restarts a crashed bridge lazily, on the next command for its session. That is
 * enough for polled events (the bridge resumes from its journaled cursor), but a push-only
 * source such as `claude/channel` loses everything sent while no bridge is listening. The
 * supervisor closes that window: every tick it brings up the bridge of each session with
 * an active event subscription or a channel listener. Run it in the foreground, once
 * (`--once`, e.g. from cron), or installed as a launchd / systemd user service.
 *
 * Sessions that need a human (unauthorized, expired) are reported, never retried in a loop.
 */

import { execFile } from 'child_process';
import { mkdir, rm, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import chalk from 'chalk';
import type { CommandOptions, SessionData } from '../../lib/types.js';
import { ClientError } from '../../lib/errors.js';
import { getEventsDir, readCursors } from '../../lib/event-journal.js';
import { CHANNEL_SUBSCRIPTION } from '../../bridge/channel-receiver.js';
import { ensureDir, getLogsDir, getMcpcHome, sleep } from '../../lib/utils.js';
import { formatOutput } from '../output.js';

const execFileAsync = promisify(execFile);

import { DEFAULT_SUPERVISE_INTERVAL_SECS } from './supervise-constants.js';

export { DEFAULT_SUPERVISE_INTERVAL_SECS };
export const SERVICE_LABEL = 'com.apify.mcpc.supervise';

export interface SuperviseResult {
  session: string;
  state: 'healthy' | 'restarted' | 'needs-attention' | 'error';
  detail?: string;
}

/** Sessions whose bridge should stay up: active subscriptions or a channel listener. */
export async function sessionsToSupervise(sessions: SessionData[]): Promise<SessionData[]> {
  const watched: SessionData[] = [];
  for (const session of sessions) {
    const polling = Object.values(session.eventSubscriptions ?? {}).some((e) => !e.terminatedAt);
    const listening =
      !polling &&
      (await readCursors(getEventsDir(session.name)))[CHANNEL_SUBSCRIPTION] !== undefined;
    if (polling || listening) watched.push(session);
  }
  return watched;
}

/** One supervision pass over every session that receives events. */
export async function superviseOnce(): Promise<SuperviseResult[]> {
  const { loadSessions } = await import('../../lib/sessions.js');
  const { ensureBridgeReady } = await import('../../lib/bridge-manager.js');
  const sessions = Object.values((await loadSessions()).sessions);
  const results: SuperviseResult[] = [];
  for (const session of await sessionsToSupervise(sessions)) {
    if (session.status === 'unauthorized' || session.status === 'expired') {
      results.push({
        session: session.name,
        state: 'needs-attention',
        detail: `session is ${session.status}; run: mcpc ${session.name} restart`,
      });
      continue;
    }
    try {
      await ensureBridgeReady(session.name);
      const { getSession } = await import('../../lib/sessions.js');
      const after = await getSession(session.name);
      results.push({
        session: session.name,
        state: after?.pid !== session.pid ? 'restarted' : 'healthy',
      });
    } catch (error) {
      results.push({ session: session.name, state: 'error', detail: (error as Error).message });
    }
  }
  return results;
}

export async function supervise(
  options: CommandOptions & {
    once?: boolean;
    intervalSecs?: number;
    install?: boolean;
    uninstall?: boolean;
  }
): Promise<void> {
  if (options.install && options.uninstall) {
    throw new ClientError('Pass either --install or --uninstall, not both');
  }
  if (options.install) return installService(options);
  if (options.uninstall) return uninstallService(options);

  const intervalSecs = options.intervalSecs ?? DEFAULT_SUPERVISE_INTERVAL_SECS;
  if (!Number.isFinite(intervalSecs) || intervalSecs < 5) {
    throw new ClientError('--interval must be at least 5 seconds');
  }

  if (options.once) {
    const results = await superviseOnce();
    if (options.outputMode !== 'human') {
      console.log(formatOutput(results, 'json'));
      return;
    }
    if (results.length === 0) {
      console.log(chalk.dim('No session has event subscriptions or a channel listener.'));
      return;
    }
    for (const result of results) console.log(formatResult(result));
    return;
  }

  let stopped = false;
  process.once('SIGINT', () => (stopped = true));
  process.once('SIGTERM', () => (stopped = true));
  console.error(chalk.dim(`Supervising event sessions every ${intervalSecs}s (Ctrl+C to stop)...`));
  while (!stopped) {
    for (const result of await superviseOnce()) {
      // Quiet when all is well, so a service log only records what changed.
      if (result.state === 'healthy') continue;
      const line =
        options.outputMode === 'human'
          ? `${new Date().toISOString()} ${formatResult(result)}`
          : JSON.stringify({ at: new Date().toISOString(), ...result });
      console.log(line);
    }
    for (let waited = 0; waited < intervalSecs && !stopped; waited++) await sleep(1000);
  }
}

function formatResult(result: SuperviseResult): string {
  const colour =
    result.state === 'healthy'
      ? chalk.green
      : result.state === 'restarted'
        ? chalk.cyan
        : chalk.yellow;
  return `${result.session} ${colour(result.state)}${result.detail ? chalk.dim(` — ${result.detail}`) : ''}`;
}

/** The command a service manager runs: this Node binary and this mcpc entry point. */
function serviceCommand(): string[] {
  const entry = process.argv[1];
  if (!entry) throw new ClientError('Cannot determine the mcpc entry point to install');
  return [process.execPath, entry, 'supervise'];
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** launchd agent definition. `MCPC_HOME_DIR` is pinned so the service sees the same data. */
export function launchdPlist(command: string[], mcpcHome: string, logPath: string): string {
  const args = command.map((arg) => `    <string>${escapeXml(arg)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MCPC_HOME_DIR</key>
    <string>${escapeXml(mcpcHome)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logPath)}</string>
</dict>
</plist>
`;
}

/** systemd user unit. Arguments are quoted, so paths with spaces survive. */
export function systemdUnit(command: string[], mcpcHome: string): string {
  const quote = (arg: string): string => `"${arg.replace(/(["\\])/g, '\\$1')}"`;
  return `[Unit]
Description=mcpc supervisor: keep MCP sessions with event subscriptions connected

[Service]
ExecStart=${command.map(quote).join(' ')}
Environment=${quote(`MCPC_HOME_DIR=${mcpcHome}`)}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;
}

function servicePaths(): { kind: 'launchd' | 'systemd'; path: string } {
  if (process.platform === 'darwin') {
    return {
      kind: 'launchd',
      path: join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`),
    };
  }
  if (process.platform === 'linux') {
    return {
      kind: 'systemd',
      path: join(homedir(), '.config', 'systemd', 'user', 'mcpc-supervise.service'),
    };
  }
  throw new ClientError(
    `Installing the supervisor as a service is supported on macOS (launchd) and Linux (systemd).\n` +
      `On ${process.platform}, run "mcpc supervise" from your own service manager instead.`
  );
}

async function installService(options: CommandOptions): Promise<void> {
  const { kind, path } = servicePaths();
  const command = serviceCommand();
  const mcpcHome = getMcpcHome();
  await mkdir(join(path, '..'), { recursive: true });
  if (kind === 'launchd') {
    const logPath = join(getLogsDir(), 'supervise.log');
    await ensureDir(getLogsDir());
    await writeFile(path, launchdPlist(command, mcpcHome, logPath), { mode: 0o644 });
    const domain = `gui/${process.getuid?.() ?? ''}`;
    // Replace a previously installed copy so a reinstall picks up a new mcpc path.
    await execFileAsync('launchctl', ['bootout', `${domain}/${SERVICE_LABEL}`]).catch(() => {});
    await execFileAsync('launchctl', ['bootstrap', domain, path]);
  } else {
    await writeFile(path, systemdUnit(command, mcpcHome), { mode: 0o644 });
    await execFileAsync('systemctl', ['--user', 'daemon-reload']);
    await execFileAsync('systemctl', ['--user', 'enable', '--now', 'mcpc-supervise.service']);
  }
  if (options.outputMode !== 'human') {
    console.log(formatOutput({ installed: true, service: kind, path, command }, 'json'));
    return;
  }
  console.log(`Installed the mcpc supervisor as a ${kind} service: ${path}`);
  console.log(chalk.dim('To remove it, run: mcpc supervise --uninstall'));
}

async function uninstallService(options: CommandOptions): Promise<void> {
  const { kind, path } = servicePaths();
  if (kind === 'launchd') {
    await execFileAsync('launchctl', [
      'bootout',
      `gui/${process.getuid?.() ?? ''}/${SERVICE_LABEL}`,
    ]).catch(() => {});
  } else {
    await execFileAsync('systemctl', [
      '--user',
      'disable',
      '--now',
      'mcpc-supervise.service',
    ]).catch(() => {});
  }
  await rm(path, { force: true });
  if (options.outputMode !== 'human') {
    console.log(formatOutput({ uninstalled: true, service: kind, path }, 'json'));
    return;
  }
  console.log(`Removed the mcpc supervisor ${kind} service (${path}).`);
}
