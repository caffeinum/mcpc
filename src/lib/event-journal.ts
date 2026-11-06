/**
 * Durable local journal for server-pushed events (SEP-3415, `io.modelcontextprotocol/events`).
 *
 * One journal per session, under `~/.mcpc/events/<session>/`:
 *
 * - `journal.jsonl` — append-only, one {@link JournalRecord} per line, written only by the
 *   session's bridge. Every record gets a local monotonic `seq`.
 * - `state.json` — the per-subscription cursors, replaced atomically (temp + fsync + rename).
 * - `agents/<agent>/acks.json` — which seqs an agent has acknowledged.
 *
 * Commit order for a batch is what makes the journal crash-safe: records are appended and
 * fsynced *before* the cursor that covers them is persisted. A crash in between replays the
 * batch from the old cursor on restart, and the `(subscription, eventId)` dedupe index —
 * rebuilt from the journal on open — drops the replayed events. The persisted cursor is
 * therefore never ahead of durable data, and an event is never journaled twice.
 *
 * Readers (the CLI) read the files directly, so `events-tail` and `events-ack` work while
 * the bridge is down. A line without its trailing newline is a torn write from a crash: the
 * writer truncates it on open, and readers ignore it.
 */

import { open, readFile, rename, truncate } from 'fs/promises';
import { join } from 'path';
import { ensureDir, fileExists, getMcpcHome } from './utils.js';
import { withFileLock } from './file-lock.js';
import { ClientError } from './errors.js';

/** Why the journal may be missing events. Every gap is recorded, never silent. */
export type GapReason =
  /** The server reported `truncated: true`: it resumed from a later position than our cursor. */
  | 'truncated'
  /** The event type has no replay (`cursor: null`), so events during downtime are lost. */
  | 'no-replay'
  /** The server ended the subscription (`NotFound`, `Forbidden`, `InvalidParams`, ...). */
  | 'terminated';

interface RecordBase {
  /** Local monotonic sequence number, unique within the session's journal. */
  seq: number;
  /** Subscription id (see {@link subscriptionId}). */
  sub: string;
  /** Event type name. */
  name: string;
  /** When this client wrote the record (ISO 8601). */
  receivedAt: string;
}

/** An event occurrence delivered by the server. */
export interface EventRecord extends RecordBase {
  kind: 'event';
  eventId: string;
  /** When the event occurred, as reported by the server (ISO 8601). */
  timestamp: string;
  data: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

/** A recorded loss window or the end of a subscription. */
export interface GapRecord extends RecordBase {
  kind: 'gap';
  reason: GapReason;
  /** Human-readable detail, e.g. the server's error message. */
  detail?: string;
}

export type JournalRecord = EventRecord | GapRecord;

/** A record before the journal assigns it a `seq`. */
export type NewJournalRecord = Omit<EventRecord, 'seq'> | Omit<GapRecord, 'seq'>;

/** Persisted position of one subscription. */
export interface SubscriptionCursor {
  /** Last cursor returned by the server; `null` for event types without replay. */
  cursor: string | null;
  updatedAt: string;
}

interface JournalState {
  cursors: Record<string, SubscriptionCursor>;
}

/** What an agent has acknowledged: every seq ≤ `ackedThrough`, plus the sparse `acked` ones. */
export interface AgentAcks {
  ackedThrough: number;
  acked: number[];
}

export const DEFAULT_AGENT = 'default';

const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export function validateAgentName(agent: string): void {
  if (!AGENT_NAME_PATTERN.test(agent)) {
    throw new ClientError(
      `Invalid agent name "${agent}": use 1-64 letters, digits, "_", "." or "-", starting with a letter or digit.`
    );
  }
}

export function getEventsDir(sessionName: string): string {
  return join(getMcpcHome(), 'events', sessionName);
}

function journalPath(dir: string): string {
  return join(dir, 'journal.jsonl');
}

function statePath(dir: string): string {
  return join(dir, 'state.json');
}

function acksPath(dir: string, agent: string): string {
  return join(dir, 'agents', agent, 'acks.json');
}

/**
 * Stable subscription id: the event name, plus a short digest of the arguments when there
 * are any. Two subscriptions to the same name with different arguments are different
 * subscriptions per the spec (dedupe and cursors are scoped to name + arguments).
 */
export function subscriptionId(name: string, args: Record<string, unknown> | undefined): string {
  if (!args || Object.keys(args).length === 0) return name;
  return `${name}#${fnv1a(canonicalJson(args))}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** 32-bit FNV-1a as 8 hex chars: a short, stable label, not a security boundary. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Parse journal text, ignoring a torn final line (no trailing newline). */
function parseJournal(text: string): { records: JournalRecord[]; durableBytes: number } {
  const lastNewline = text.lastIndexOf('\n');
  const durable = lastNewline === -1 ? '' : text.slice(0, lastNewline + 1);
  const records: JournalRecord[] = [];
  for (const line of durable.split('\n')) {
    if (line.length === 0) continue;
    records.push(JSON.parse(line) as JournalRecord);
  }
  return { records, durableBytes: Buffer.byteLength(durable, 'utf-8') };
}

async function readJournalText(dir: string): Promise<string> {
  try {
    return await readFile(journalPath(dir), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

async function readState(dir: string): Promise<JournalState> {
  try {
    return JSON.parse(await readFile(statePath(dir), 'utf-8')) as JournalState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { cursors: {} };
    throw error;
  }
}

/** Write a file durably: temp file, fsync, rename over the target, fsync the directory. */
async function writeFileDurably(path: string, content: string, dir: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  const handle = await open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(content, 'utf-8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
  await fsyncDir(dir);
}

async function fsyncDir(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Test hook: exit abruptly at a commit step, to prove the commit order is crash-safe. */
function crashPointReached(point: 'after-append' | 'after-fsync'): void {
  if (process.env.MCPC_TEST_CRASH_AT === point) process.exit(137);
}

/**
 * The writer side of a session's journal. Exactly one per session, owned by the bridge.
 */
export class EventJournal {
  private lastSeq: number;
  private readonly seen: Set<string>;
  private state: JournalState;
  /** Whether the journal file's directory entry is known to be durable. */
  private journalFileDurable = false;

  private constructor(
    private readonly dir: string,
    records: JournalRecord[],
    state: JournalState
  ) {
    this.lastSeq = records.at(-1)?.seq ?? 0;
    this.seen = new Set(
      records.flatMap((r) => (r.kind === 'event' ? [dedupeKey(r.sub, r.eventId)] : []))
    );
    this.state = state;
  }

  /**
   * Open the journal in `dir`, repairing a torn final line left by a crash. Nothing is
   * created on disk until the first commit, so sessions without events leave no trace.
   */
  static async open(dir: string): Promise<EventJournal> {
    const text = await readJournalText(dir);
    const { records, durableBytes } = parseJournal(text);
    if (durableBytes < Buffer.byteLength(text, 'utf-8')) {
      await truncate(journalPath(dir), durableBytes);
    }
    return new EventJournal(dir, records, await readState(dir));
  }

  getCursor(sub: string): SubscriptionCursor | undefined {
    return this.state.cursors[sub];
  }

  /**
   * Durably append a batch and then persist the subscription's new cursor.
   * Events already journaled for the subscription (same `eventId`) are dropped.
   * @returns the records actually written, with their assigned seqs
   */
  async commit(
    sub: string,
    batch: NewJournalRecord[],
    cursor: string | null
  ): Promise<JournalRecord[]> {
    const written: JournalRecord[] = [];
    const batchKeys = new Set<string>();
    for (const record of batch) {
      if (record.kind === 'event') {
        const key = dedupeKey(record.sub, record.eventId);
        if (this.seen.has(key) || batchKeys.has(key)) continue;
        batchKeys.add(key);
      }
      written.push({ seq: this.lastSeq + written.length + 1, ...record } as JournalRecord);
    }

    await ensureDir(this.dir);
    if (written.length > 0) {
      const handle = await open(journalPath(this.dir), 'a', 0o600);
      try {
        await handle.writeFile(written.map((r) => `${JSON.stringify(r)}\n`).join(''), 'utf-8');
        crashPointReached('after-append');
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (!this.journalFileDurable) {
        // A newly created file is only durable once its directory entry is
        await fsyncDir(this.dir);
        this.journalFileDurable = true;
      }
      crashPointReached('after-fsync');
      this.lastSeq += written.length;
      for (const key of batchKeys) this.seen.add(key);
    }

    const previous = this.state.cursors[sub];
    if (written.length > 0 || previous?.cursor !== cursor || previous === undefined) {
      this.state = {
        cursors: {
          ...this.state.cursors,
          [sub]: { cursor, updatedAt: new Date().toISOString() },
        },
      };
      await writeFileDurably(statePath(this.dir), JSON.stringify(this.state, null, 2), this.dir);
    }
    return written;
  }

  /** Forget a subscription's cursor (on unsubscribe). Its journaled records stay. */
  async dropCursor(sub: string): Promise<void> {
    if (!(sub in this.state.cursors)) return;
    const cursors = { ...this.state.cursors };
    delete cursors[sub];
    this.state = { cursors };
    await writeFileDurably(statePath(this.dir), JSON.stringify(this.state, null, 2), this.dir);
  }
}

function dedupeKey(sub: string, eventId: string): string {
  return `${sub}\u0000${eventId}`;
}

/** Read every durable record of a session's journal. */
export async function readJournal(dir: string): Promise<JournalRecord[]> {
  return parseJournal(await readJournalText(dir)).records;
}

/** Read the persisted cursors of a session's journal. */
export async function readCursors(dir: string): Promise<Record<string, SubscriptionCursor>> {
  return (await readState(dir)).cursors;
}

async function readAcksFile(path: string): Promise<AgentAcks> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as AgentAcks;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ackedThrough: 0, acked: [] };
    throw error;
  }
}

export async function readAcks(dir: string, agent: string): Promise<AgentAcks> {
  validateAgentName(agent);
  return readAcksFile(acksPath(dir, agent));
}

export function isAcked(acks: AgentAcks, seq: number): boolean {
  return seq <= acks.ackedThrough || acks.acked.includes(seq);
}

/** Records the agent has not acknowledged yet, in seq order. */
export async function readUnacked(dir: string, agent: string): Promise<JournalRecord[]> {
  const [records, acks] = await Promise.all([readJournal(dir), readAcks(dir, agent)]);
  const ackedSet = new Set(acks.acked);
  return records.filter((r) => r.seq > acks.ackedThrough && !ackedSet.has(r.seq));
}

/**
 * Acknowledge seqs for an agent. Idempotent; a seq that was never journaled fails loudly,
 * because acking it would silently hide a record the agent has not seen yet.
 * @returns the agent's acks after the update
 */
export async function ackRecords(
  dir: string,
  agent: string,
  seqs: number[] | 'all'
): Promise<AgentAcks> {
  validateAgentName(agent);
  const records = await readJournal(dir);
  const lastSeq = records.at(-1)?.seq ?? 0;
  const targets = seqs === 'all' ? [lastSeq] : seqs;
  if (seqs !== 'all') {
    const unknown = seqs.filter((s) => !Number.isInteger(s) || s < 1 || s > lastSeq);
    if (unknown.length > 0) {
      throw new ClientError(
        `Unknown event seq: ${unknown.join(', ')}. ` +
          (lastSeq === 0 ? 'The journal is empty.' : `Valid seqs are 1-${lastSeq}.`)
      );
    }
  }

  const path = acksPath(dir, agent);
  await ensureDir(join(path, '..'));
  return withFileLock(
    path,
    async () => {
      const current = await readAcksFile(path);
      const acked = new Set(current.acked);
      let ackedThrough = current.ackedThrough;
      if (seqs === 'all') {
        ackedThrough = Math.max(ackedThrough, lastSeq);
      } else {
        for (const seq of targets) if (seq > ackedThrough) acked.add(seq);
      }
      while (acked.has(ackedThrough + 1)) {
        acked.delete(ackedThrough + 1);
        ackedThrough++;
      }
      const next: AgentAcks = {
        ackedThrough,
        acked: [...acked].filter((s) => s > ackedThrough).sort((a, b) => a - b),
      };
      await writeFileDurably(path, JSON.stringify(next), join(path, '..'));
      return next;
    },
    JSON.stringify({ ackedThrough: 0, acked: [] })
  );
}

export async function journalExists(dir: string): Promise<boolean> {
  return fileExists(journalPath(dir));
}

/** Path of the journal file, for watchers (`events-tail --follow`). */
export function getJournalFilePath(dir: string): string {
  return journalPath(dir);
}
