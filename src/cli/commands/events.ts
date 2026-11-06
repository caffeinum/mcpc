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
import {
  isRoutedTo,
  isUnrouted,
  readRouting,
  updateRoute,
  validateRoutePath,
  type SubscriptionRoute,
} from '../../lib/event-routing.js';
import { withMcpClient } from '../helpers.js';
import { CHANNEL_SUBSCRIPTION } from '../../bridge/channel-receiver.js';
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

/** The agent named on the command line or by MCPC_AGENT, or undefined for "everyone". */
function explicitAgent(options: { agent?: string }): string | undefined {
  const agent = options.agent ?? process.env.MCPC_AGENT;
  if (agent !== undefined) validateAgentName(agent);
  return agent;
}

export async function subscribeEvents(
  target: string,
  name: string,
  options: EventsAgentOptions & { args?: string[]; route?: string }
): Promise<void> {
  const args = await readCommandArgs(options.args);
  const hasArgs = Object.keys(args).length > 0;
  const agent = explicitAgent(options);
  if (options.route !== undefined) validateRoutePath(options.route);
  await withMcpClient(target, options, async (client) => {
    const entry = await client.subscribeEvents(name, hasArgs ? args : undefined);
    const route =
      agent !== undefined || options.route !== undefined
        ? await updateRoute(getEventsDir(target), entry.id, {
            ...(agent !== undefined && { addAgents: [agent] }),
            ...(options.route !== undefined && { path: options.route }),
          })
        : (await readRouting(getEventsDir(target))).subs[entry.id];
    if (options.outputMode !== 'human') {
      console.log(formatOutput({ subscribed: true, ...entry, route: route ?? {} }, 'json'));
      return;
    }
    console.log(formatSuccess(`Subscribed to events: ${entry.id}`));
    console.log(`Delivered to: ${describeAudience(route)}`);
    console.log(chalk.dim('Events are journaled while the session bridge runs, starting now.'));
    console.log(chalk.dim(`To read them, run: mcpc ${target} events-tail --follow`));
  });
}

export async function unsubscribeEvents(
  target: string,
  idOrName: string,
  options: EventsAgentOptions
): Promise<void> {
  const agent = explicitAgent(options);
  const dir = getEventsDir(target);
  if (agent !== undefined) {
    // One agent leaving a shared subscription keeps it running for the others.
    const id = await resolveSubscriptionId(target, idOrName);
    const route = await updateRoute(dir, id, { removeAgents: [agent] });
    if (route.agents?.length) {
      if (options.outputMode !== 'human') {
        console.log(
          formatOutput({ unsubscribed: true, id, agent, remainingAgents: route.agents }, 'json')
        );
        return;
      }
      console.log(formatSuccess(`Agent "${agent}" no longer receives ${id}`));
      console.log(chalk.dim(`Still delivered to: ${route.agents.join(', ')}`));
      return;
    }
  }
  await withMcpClient(target, options, async (client) => {
    const entry = await client.unsubscribeEvents(idOrName);
    await updateRoute(dir, entry.id, {
      removeAgents: (await readRouting(dir)).subs[entry.id]?.agents ?? [],
      path: null,
    });
    if (options.outputMode !== 'human') {
      console.log(formatOutput({ unsubscribed: true, id: entry.id, name: entry.name }, 'json'));
      return;
    }
    console.log(formatSuccess(`Unsubscribed from events: ${entry.id}`));
    console.log(chalk.dim(`Journaled events are kept; read them with: mcpc ${target} events-tail`));
  });
}

/** A subscription id from an id or an unambiguous event name, via the session record. */
async function resolveSubscriptionId(target: string, idOrName: string): Promise<string> {
  if (idOrName === CHANNEL_SUBSCRIPTION) return idOrName;
  const { getSession } = await import('../../lib/sessions.js');
  const entries = Object.values((await getSession(target))?.eventSubscriptions ?? {});
  if (entries.some((e) => e.id === idOrName)) return idOrName;
  const byName = entries.filter((e) => e.name === idOrName);
  if (byName.length === 1 && byName[0]) return byName[0].id;
  throw new ClientError(
    byName.length > 1
      ? `Several subscriptions to ${idOrName} exist; pass the subscription id:\n${byName.map((e) => `  ${e.id}`).join('\n')}`
      : `No event subscription matches ${idOrName}.\nTo list subscriptions, run: mcpc ${target} events-status`
  );
}

function describeAudience(route: SubscriptionRoute | undefined): string {
  const agents = route?.agents?.length ? route.agents.join(', ') : 'every agent';
  return route?.path
    ? `${agents}; addressed records only to the agents named at ${route.path}`
    : agents;
}

/** Show or change who receives a subscription's records (any subscription, incl. claude/channel). */
export async function routeEvents(
  target: string,
  idOrName: string,
  options: CommandOptions & {
    add?: string[];
    remove?: string[];
    path?: string;
    clearPath?: boolean;
  }
): Promise<void> {
  const dir = await requireEventsDir(target);
  if (options.path !== undefined && options.clearPath) {
    throw new ClientError('Pass either --path or --clear-path, not both');
  }
  const id = await resolveSubscriptionId(target, idOrName);
  const changing =
    (options.add?.length ?? 0) > 0 ||
    (options.remove?.length ?? 0) > 0 ||
    options.path !== undefined ||
    options.clearPath;
  const route = changing
    ? await updateRoute(dir, id, {
        ...(options.add && { addAgents: options.add }),
        ...(options.remove && { removeAgents: options.remove }),
        ...(options.path !== undefined && { path: options.path }),
        ...(options.clearPath && { path: null }),
      })
    : ((await readRouting(dir)).subs[id] ?? {});
  if (options.outputMode !== 'human') {
    console.log(formatOutput({ id, ...route }, 'json'));
    return;
  }
  console.log(`${chalk.bold(id)} is delivered to: ${describeAudience(route)}`);
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
  options: EventsAgentOptions & { follow?: boolean; all?: boolean; unrouted?: boolean }
): Promise<void> {
  const agent = resolveAgent(options);
  const dir = await requireEventsDir(target);
  const json = options.outputMode !== 'human';
  if (options.all && options.unrouted) {
    throw new ClientError('Pass either --all or --unrouted, not both');
  }
  // Routing is re-read on every check, so a change applies to a running --follow too.
  const read = async (): Promise<JournalRecord[]> => {
    if (options.all) return readJournal(dir);
    const routing = await readRouting(dir);
    if (options.unrouted) return (await readJournal(dir)).filter((r) => isUnrouted(r, routing));
    return readUnacked(dir, agent, (r) => isRoutedTo(r, agent, routing));
  };

  const initial = await read();
  let lastSeq = initial.at(-1)?.seq ?? 0;
  if (!options.follow) {
    if (json) {
      console.log(formatOutput(initial, 'json'));
      return;
    }
    if (initial.length === 0) {
      console.log(
        chalk.dim(
          options.all
            ? 'The journal is empty.'
            : options.unrouted
              ? 'No unrouted records.'
              : `No unacknowledged events for agent "${agent}".`
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
        const fresh = (await read()).filter((r) => r.seq > lastSeq);
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
  const routing = await readRouting(dir);
  const visible = (r: JournalRecord): boolean => isRoutedTo(r, agent, routing);
  const acks = await ackRecords(dir, agent, options.all ? 'all' : parsed, visible);
  const remaining = (await readUnacked(dir, agent, visible)).length;
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
  const routing = await readRouting(dir);
  const [cursors, unacked, journal] = await Promise.all([
    readCursors(dir),
    readUnacked(dir, agent, (r) => isRoutedTo(r, agent, routing)),
    readJournal(dir),
  ]);
  const unrouted = journal.filter((r) => isUnrouted(r, routing)).length;
  const polled = Object.values(session?.eventSubscriptions ?? {}).map(
    (entry: EventSubscriptionEntry) => ({
      source: 'events' as const,
      ...entry,
      cursor: cursors[entry.id]?.cursor ?? null,
      cursorUpdatedAt: cursors[entry.id]?.updatedAt,
      route: routing.subs[entry.id] ?? {},
      unacked: unacked.filter((r) => r.sub === entry.id).length,
    })
  );
  // A claude/channel listener has no subscription entry: the server pushes on its own.
  const channel = cursors[CHANNEL_SUBSCRIPTION]
    ? [
        {
          source: 'channel' as const,
          id: CHANNEL_SUBSCRIPTION,
          name: CHANNEL_SUBSCRIPTION,
          cursor: null,
          cursorUpdatedAt: cursors[CHANNEL_SUBSCRIPTION].updatedAt,
          route: routing.subs[CHANNEL_SUBSCRIPTION] ?? {},
          unacked: unacked.filter((r) => r.sub === CHANNEL_SUBSCRIPTION).length,
        },
      ]
    : [];
  const subscriptions = [...polled, ...channel];
  const unackedGaps = unacked.filter((r) => r.kind === 'gap').length;

  if (options.outputMode !== 'human') {
    console.log(
      formatOutput({ agent, unacked: unacked.length, unackedGaps, unrouted, subscriptions }, 'json')
    );
    return;
  }
  if (subscriptions.length === 0) {
    console.log(chalk.dim('No event subscriptions.'));
  }
  for (const sub of subscriptions) {
    const state =
      sub.source === 'channel'
        ? chalk.green('listening')
        : sub.terminatedAt
          ? chalk.red('terminated')
          : sub.lastError
            ? chalk.yellow('retrying')
            : 'delivery' in sub && sub.delivery?.includes('push')
              ? chalk.green('streaming')
              : chalk.green('polling');
    console.log(`${chalk.bold(sub.id)}  ${state}  ${chalk.dim(`${sub.unacked} unacked`)}`);
    if ('lastError' in sub && sub.lastError)
      console.log(chalk.dim(`  last error: ${sub.lastError}`));
    console.log(chalk.dim(`  delivered to: ${describeAudience(sub.route)}`));
    if (sub.cursorUpdatedAt) console.log(chalk.dim(`  cursor advanced: ${sub.cursorUpdatedAt}`));
  }
  console.log('');
  console.log(`Agent "${agent}": ${unacked.length} unacknowledged (${unackedGaps} gaps)`);
  if (unrouted > 0) {
    console.log(chalk.yellow(`${unrouted} record(s) name no subscribed agent.`));
    console.log(chalk.dim(`To see them, run: mcpc ${target} events-tail --unrouted`));
  }
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
