/**
 * Routing of journaled events to agents (several agents sharing one session's events).
 *
 * Every event is journaled once, per session. Who sees it is decided when an agent reads
 * or acknowledges, from `routing.json` next to the journal, so routing changes apply to
 * the backlog too and need no bridge. Per subscription id:
 *
 * - `agents` — the agents the subscription is delivered to. Empty or absent: every agent
 *   (broadcast).
 * - `path` — a dot path into the record (e.g. `data.meta.to`) naming the recipient(s) of
 *   an addressed message: a string or an array of strings. A record whose path holds a
 *   value goes only to the agents it names; when `agents` is set and none of the names is
 *   in it, the record is also *unrouted* — kept and shown with `events-tail --unrouted`, never
 *   dropped. A record without a value at the path falls back to `agents`.
 *
 * Gap records go to everyone who receives the subscription: any of them may have missed
 * something. Isolation is cooperative (one OS user): it prevents mistakes, not a hostile
 * agent reading the files.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { ensureDir } from './utils.js';
import { withFileLock } from './file-lock.js';
import { ClientError } from './errors.js';
import { validateAgentName, writeFileDurably, type JournalRecord } from './event-journal.js';

export interface SubscriptionRoute {
  agents?: string[];
  path?: string;
}

export interface EventRouting {
  subs: Record<string, SubscriptionRoute>;
}

const ROUTE_PATH_PATTERN = /^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+)*$/;

function routingPath(dir: string): string {
  return join(dir, 'routing.json');
}

export async function readRouting(dir: string): Promise<EventRouting> {
  try {
    return JSON.parse(await readFile(routingPath(dir), 'utf-8')) as EventRouting;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { subs: {} };
    throw error;
  }
}

export function validateRoutePath(path: string): void {
  if (!ROUTE_PATH_PATTERN.test(path)) {
    throw new ClientError(
      `Invalid route path "${path}": use dot-separated keys into the record, e.g. data.meta.to`
    );
  }
}

/**
 * Change one subscription's route: add agents, and set or clear the recipient path.
 * @returns the subscription's route after the change
 */
export async function updateRoute(
  dir: string,
  sub: string,
  change: { addAgents?: string[]; removeAgents?: string[]; path?: string | null }
): Promise<SubscriptionRoute> {
  for (const agent of [...(change.addAgents ?? []), ...(change.removeAgents ?? [])]) {
    validateAgentName(agent);
  }
  if (typeof change.path === 'string') validateRoutePath(change.path);
  await ensureDir(dir);
  const file = routingPath(dir);
  return withFileLock(
    file,
    async () => {
      const routing = await readRouting(dir);
      const current = routing.subs[sub] ?? {};
      const agents = new Set(current.agents ?? []);
      for (const agent of change.addAgents ?? []) agents.add(agent);
      for (const agent of change.removeAgents ?? []) agents.delete(agent);
      const next: SubscriptionRoute = {
        ...(agents.size > 0 && { agents: [...agents].sort() }),
        ...(change.path === undefined
          ? current.path !== undefined && { path: current.path }
          : change.path !== null && { path: change.path }),
      };
      const subs = { ...routing.subs };
      if (Object.keys(next).length > 0) subs[sub] = next;
      else delete subs[sub];
      await writeFileDurably(file, JSON.stringify({ subs }, null, 2), dir);
      return next;
    },
    JSON.stringify({ subs: {} })
  );
}

/** The recipient names a record carries at `path`, or undefined when it carries none. */
function recipientsAt(record: JournalRecord, path: string): string[] | undefined {
  let node: unknown = record;
  for (const key of path.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  if (typeof node === 'string' && node.length > 0) return [node];
  if (Array.isArray(node)) {
    const names = node.filter((n): n is string => typeof n === 'string' && n.length > 0);
    return names.length > 0 ? names : undefined;
  }
  return undefined;
}

/** Whether `record` is delivered to `agent` under `routing`. */
export function isRoutedTo(record: JournalRecord, agent: string, routing: EventRouting): boolean {
  const route = routing.subs[record.sub];
  if (!route) return true;
  const agents = route.agents ?? [];
  const audience = agents.length === 0 || agents.includes(agent);
  if (record.kind === 'gap' || route.path === undefined) return audience;
  const named = recipientsAt(record, route.path);
  if (named === undefined) return audience;
  return named.includes(agent);
}

/** Whether `record` names recipients none of which the subscription delivers to. */
export function isUnrouted(record: JournalRecord, routing: EventRouting): boolean {
  const route = routing.subs[record.sub];
  if (!route?.path || !route.agents?.length || record.kind === 'gap') return false;
  const named = recipientsAt(record, route.path);
  return named !== undefined && !named.some((name) => route.agents?.includes(name));
}
