/**
 * Events command handlers — the MCP Events extension (`io.modelcontextprotocol/events`,
 * SEP-3415, Draft).
 *
 * `events-subscribe` asks the session bridge to poll an event type; every event lands in a
 * durable per-session journal before the bridge advances its cursor. `events-tail` and
 * `events-ack` read and write that journal directly, so they work while the bridge is
 * down, and an event stays in `events-tail` until it is acknowledged (at-least-once).
 * Loss the client cannot prevent (a server-side gap, an event type without replay, a
 * terminated subscription) is written to the journal as a gap record, never skipped.
 */

import chalk from 'chalk';
import { watch, type FSWatcher } from 'fs';
import { ClientError } from '../../lib/errors.js';
import { isValidSessionName } from '../../lib/utils.js';
import type { CommandOptions, EventSubscriptionEntry } from '../../lib/types.js';
import {
  DEFAULT_AGENT,
  ackRecords,
  getEventsDir,
  journalExists,
  readCursors,
  readJournal,
  readUnacked,
  validateAgentName,
  type JournalRecord,
} from '../../lib/event-journal.js';
import { withMcpClient } from '../helpers.js';
import { readCommandArgs } from '../parser.js';
import { formatOutput, formatSuccess } from '../output.js';

export const EVENTS_SPEC_URL =
  'https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415';

const FOLLOW_POLL_INTERVAL_MILLIS = 1000;

export type EventsAgentOptions = CommandOptions & { agent?: string };

/** The agent whose acknowledgements are read and written: `--agent`, `MCPC_AGENT`, or default. */
export function resolveAgent(options: { agent?: string }): string {
  const agent = options.agent ?? process.env.MCPC_AGENT ?? DEFAULT_AGENT;
  validateAgentName(agent);
  return agent;
}

export async function listEvents(target: string, options: CommandOptions): Promise<void> {
  await withMcpClient(target, options, async (client) => {
    const events = await client.listEvents();
    if (options.outputMode !== 'human') {
      console.log(formatOutput(events, 'json'));
      return;
    }
    if (events.length === 0) {
      console.log(chalk.dim('The server offers no event types.'));
      return;
    }
    for (const event of events) {
      console.log(`${chalk.bold(event.name)}  ${chalk.dim(`[${event.delivery.join(', ')}]`)}`);
      if (event.description) console.log(`  ${event.description}`);
      const properties = Object.keys(
        (event.inputSchema?.properties as Record<string, unknown> | undefined) ?? {}
      );
      if (properties.length > 0) console.log(chalk.dim(`  arguments: ${properties.join(', ')}`));
    }
    console.log('');
    console.log(
      chalk.dim(`To subscribe, run: mcpc ${target} events-subscribe <name> [key:=value ...]`)
    );
  });
}

export async function subscribeEvents(
  target: string,
  name: string,
  options: CommandOptions & { args?: string[] }
): Promise<void> {
  const args = await readCommandArgs(options.args);
  const hasArgs = Object.keys(args).length > 0;
  await withMcpClient(target, options, async (client) => {
    const entry = await client.subscribeEvents(name, hasArgs ? args : undefined);
    if (options.outputMode !== 'human') {
      console.log(formatOutput({ subscribed: true, ...entry }, 'json'));
      return;
    }
    console.log(formatSuccess(`Subscribed to events: ${entry.id}`));
    console.log(chalk.dim('Events are journaled while the session bridge runs, starting now.'));
    console.log(chalk.dim(`To read them, run: mcpc ${target} events-tail --follow`));
  });
}

export async function unsubscribeEvents(
  target: string,
  id: string,
  options: CommandOptions
): Promise<void> {
  await withMcpClient(target, options, async (client) => {
    const entry = await client.unsubscribeEvents(id);
    if (options.outputMode !== 'human') {
      console.log(formatOutput({ unsubscribed: true, id: entry.id, name: entry.name }, 'json'));
      return;
    }
    console.log(formatSuccess(`Unsubscribed from events: ${entry.id}`));
    console.log(chalk.dim(`Journaled events are kept; read them with: mcpc ${target} events-tail`));
  });
}

/** Journal directory of a session, failing loudly when the session has never had events. */
async function requireEventsDir(target: string): Promise<string> {
  if (!isValidSessionName(target)) {
    throw new ClientError(
      `Invalid session name: ${target}\nSession names must start with @ (e.g. @apify).`
    );
  }
  const dir = getEventsDir(target);
  if (!(await journalExists(dir))) {
    const { getSession } = await import('../../lib/sessions.js');
    if (!(await getSession(target))) {
      throw new ClientError(`Session not found: ${target}\nTo list sessions, run: mcpc`);
    }
  }
  return dir;
}

export async function tailEvents(
  target: string,
  options: EventsAgentOptions & { follow?: boolean; all?: boolean }
): Promise<void> {
  const agent = resolveAgent(options);
  const dir = await requireEventsDir(target);
  const json = options.outputMode !== 'human';

  const initial = options.all ? await readJournal(dir) : await readUnacked(dir, agent);
  let lastSeq = initial.at(-1)?.seq ?? 0;
  if (!options.follow) {
    if (json) {
      console.log(formatOutput(initial, 'json'));
      return;
    }
    if (initial.length === 0) {
      console.log(
        chalk.dim(
          options.all ? 'The journal is empty.' : `No unacknowledged events for agent "${agent}".`
        )
      );
      console.log(chalk.dim(`To wait for new events, run: mcpc ${target} events-tail --follow`));
      return;
    }
    for (const record of initial) console.log(formatRecord(record));
    console.log('');
    console.log(chalk.dim(`To acknowledge, run: mcpc ${target} events-ack <seq>... (or --all)`));
    return;
  }

  // --follow: NDJSON in JSON mode, one record per line, until interrupted.
  const print = (record: JournalRecord): void => {
    console.log(json ? JSON.stringify(record) : formatRecord(record));
  };
  for (const record of initial) print(record);
  if (!json)
    console.error(chalk.dim(`Following ${target} events for agent "${agent}" (Ctrl+C to stop)...`));
  await new Promise<void>((resolve) => {
    let busy = false;
    let watcher: FSWatcher | undefined;
    const check = async (): Promise<void> => {
      if (busy) return;
      busy = true;
      try {
        const fresh = (options.all ? await readJournal(dir) : await readUnacked(dir, agent)).filter(
          (r) => r.seq > lastSeq
        );
        for (const record of fresh) print(record);
        lastSeq = fresh.at(-1)?.seq ?? lastSeq;
      } finally {
        busy = false;
      }
    };
    try {
      watcher = watch(dir, () => void check());
    } catch {
      // The interval below still delivers; fs.watch is only a latency optimisation.
    }
    const interval = setInterval(() => void check(), FOLLOW_POLL_INTERVAL_MILLIS);
    const stop = (): void => {
      clearInterval(interval);
      watcher?.close();
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

export async function ackEvents(
  target: string,
  seqs: string[],
  options: EventsAgentOptions & { all?: boolean }
): Promise<void> {
  const agent = resolveAgent(options);
  if (options.all && seqs.length > 0) {
    throw new ClientError('Pass either seqs or --all, not both');
  }
  if (!options.all && seqs.length === 0) {
    throw new ClientError(
      `Nothing to acknowledge: pass one or more seqs or --all.\nTo see unacknowledged events, run: mcpc ${target} events-tail`
    );
  }
  const parsed = seqs.map((value) => {
    const seq = Number(value);
    if (!Number.isInteger(seq) || seq < 1) throw new ClientError(`Invalid seq: ${value}`);
    return seq;
  });
  const dir = await requireEventsDir(target);
  const acks = await ackRecords(dir, agent, options.all ? 'all' : parsed);
  const remaining = (await readUnacked(dir, agent)).length;
  if (options.outputMode !== 'human') {
    console.log(formatOutput({ agent, ...acks, unacked: remaining }, 'json'));
    return;
  }
  console.log(
    formatSuccess(`Acknowledged for agent "${agent}"; ${remaining} unacknowledged left.`)
  );
}

export async function eventsStatus(target: string, options: EventsAgentOptions): Promise<void> {
  const agent = resolveAgent(options);
  const dir = await requireEventsDir(target);
  const { getSession } = await import('../../lib/sessions.js');
  const session = await getSession(target);
  const [cursors, unacked] = await Promise.all([readCursors(dir), readUnacked(dir, agent)]);
  const subscriptions = Object.values(session?.eventSubscriptions ?? {}).map(
    (entry: EventSubscriptionEntry) => ({
      ...entry,
      cursor: cursors[entry.id]?.cursor ?? null,
      cursorUpdatedAt: cursors[entry.id]?.updatedAt,
      unacked: unacked.filter((r) => r.sub === entry.id).length,
    })
  );
  const unackedGaps = unacked.filter((r) => r.kind === 'gap').length;

  if (options.outputMode !== 'human') {
    console.log(
      formatOutput({ agent, unacked: unacked.length, unackedGaps, subscriptions }, 'json')
    );
    return;
  }
  if (subscriptions.length === 0) {
    console.log(chalk.dim('No event subscriptions.'));
  }
  for (const sub of subscriptions) {
    const state = sub.terminatedAt
      ? chalk.red('terminated')
      : sub.lastError
        ? chalk.yellow('retrying')
        : chalk.green('polling');
    console.log(`${chalk.bold(sub.id)}  ${state}  ${chalk.dim(`${sub.unacked} unacked`)}`);
    if (sub.lastError) console.log(chalk.dim(`  last error: ${sub.lastError}`));
    if (sub.cursorUpdatedAt) console.log(chalk.dim(`  cursor advanced: ${sub.cursorUpdatedAt}`));
  }
  console.log('');
  console.log(`Agent "${agent}": ${unacked.length} unacknowledged (${unackedGaps} gaps)`);
  if (unacked.length > 0) console.log(chalk.dim(`To read them, run: mcpc ${target} events-tail`));
}

function formatRecord(record: JournalRecord): string {
  if (record.kind === 'gap') {
    return `${chalk.yellow(`#${record.seq}`)} ${chalk.yellow(`gap (${record.reason})`)} ${record.sub}${
      record.detail ? chalk.dim(` — ${record.detail}`) : ''
    }`;
  }
  return `${chalk.cyan(`#${record.seq}`)} ${chalk.bold(record.name)} ${chalk.dim(record.timestamp)} ${JSON.stringify(record.data)}`;
}
