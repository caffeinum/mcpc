/**
 * Event subscriptions for the bridge process (SEP-3415 poll delivery).
 *
 * One poll loop per subscription. Every batch is committed to the session's
 * {@link EventJournal} before the next poll, so events are durable before the cursor that
 * covers them moves. The loop follows the spec's pacing: drain immediately while
 * `hasMore`, otherwise wait the server's `nextPollMs` (never less than a 1 s floor), and
 * back off exponentially on transient errors.
 *
 * Nothing is lost silently. A `truncated` response, a restart of an event type without
 * replay, and a terminal server error each write a gap record to the journal.
 *
 * Subscriptions are persisted in sessions.json (via the injected `persist` callback), so a
 * restarted bridge resumes every loop from its journaled cursor.
 */

import type { EventSubscriptionEntry } from '../lib/types.js';
import type { PollEventsParams, PollEventsResult } from '../core/events-schema.js';
import {
  EVENTS_ERROR_FORBIDDEN,
  EVENTS_ERROR_NOT_FOUND,
  EVENTS_ERROR_UNSUPPORTED,
} from '../core/events-schema.js';
import {
  subscriptionId,
  type EventJournal,
  type JournalRecord,
  type NewJournalRecord,
} from '../lib/event-journal.js';
import { ClientError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';

export const MIN_POLL_INTERVAL_MILLIS = 1000;
/** Used when the server sends no `nextPollMs`. */
export const DEFAULT_POLL_INTERVAL_MILLIS = 5000;
const INITIAL_BACKOFF_MILLIS = 1000;
const MAX_BACKOFF_MILLIS = 30_000;

/** JSON-RPC codes after which polling again cannot succeed: the subscription is over. */
const TERMINAL_ERROR_CODES = new Set([
  EVENTS_ERROR_NOT_FOUND,
  EVENTS_ERROR_FORBIDDEN,
  EVENTS_ERROR_UNSUPPORTED,
  -32602, // InvalidParams: the arguments no longer match the event's inputSchema
  -32601, // Method not found: the server dropped the extension
]);

export interface EventPollerOptions {
  poll: (params: PollEventsParams) => Promise<PollEventsResult>;
  journal: EventJournal;
  persist: (entries: Record<string, EventSubscriptionEntry>) => Promise<void>;
  logger: Logger;
  /** Called after records are durably journaled (e.g. to wake followers). */
  onCommitted?: (records: JournalRecord[]) => void;
  minIntervalMillis?: number;
}

interface Loop {
  stop: () => void;
  done: Promise<void>;
}

export class EventPoller {
  private entries = new Map<string, EventSubscriptionEntry>();
  private loops = new Map<string, Loop>();
  private closed = false;

  constructor(private readonly options: EventPollerOptions) {}

  load(entries: Record<string, EventSubscriptionEntry> | undefined): void {
    for (const entry of Object.values(entries ?? {})) this.entries.set(entry.id, { ...entry });
  }

  list(): EventSubscriptionEntry[] {
    return [...this.entries.values()];
  }

  /** Start a loop for every loaded subscription that has not been terminated. */
  async startAll(): Promise<void> {
    for (const entry of this.entries.values()) {
      if (entry.terminatedAt) continue;
      await this.recordRestartGap(entry);
      this.startLoop(entry.id);
    }
  }

  /**
   * Subscribe: bootstrap with a `null` cursor (the spec's "start from now"), which also
   * validates the name and arguments, then start polling. Fails without registering
   * anything when the server rejects the subscription.
   */
  async add(
    name: string,
    args: Record<string, unknown> | undefined
  ): Promise<EventSubscriptionEntry> {
    const id = subscriptionId(name, args);
    const existing = this.entries.get(id);
    if (existing && !existing.terminatedAt) return existing;

    const result = await this.options.poll({
      name,
      ...(args && { arguments: args }),
      cursor: null,
    });
    await this.commit(id, name, result, { bootstrap: true });

    const entry: EventSubscriptionEntry = {
      id,
      name,
      ...(args && Object.keys(args).length > 0 && { arguments: args }),
      subscribedAt: new Date().toISOString(),
    };
    this.entries.set(id, entry);
    await this.persist();
    this.startLoop(id, result);
    return entry;
  }

  /** Unsubscribe by id or, when unambiguous, by event name. Journaled records are kept. */
  async remove(idOrName: string): Promise<EventSubscriptionEntry> {
    const entry = this.resolve(idOrName);
    this.loops.get(entry.id)?.stop();
    this.loops.delete(entry.id);
    this.entries.delete(entry.id);
    await this.options.journal.dropCursor(entry.id);
    await this.persist();
    return entry;
  }

  async stopAll(): Promise<void> {
    this.closed = true;
    const loops = [...this.loops.values()];
    for (const loop of loops) loop.stop();
    this.loops.clear();
    await Promise.all(loops.map((loop) => loop.done));
  }

  private resolve(idOrName: string): EventSubscriptionEntry {
    const byId = this.entries.get(idOrName);
    if (byId) return byId;
    const byName = this.list().filter((e) => e.name === idOrName);
    if (byName.length === 1) return byName[0] as EventSubscriptionEntry;
    const active = this.list().map((e) => `  ${e.id}`);
    throw new ClientError(
      byName.length > 1
        ? `Several subscriptions to ${idOrName} exist; pass the subscription id:\n${byName.map((e) => `  ${e.id}`).join('\n')}`
        : `No event subscription matches ${idOrName}.` +
            (active.length > 0
              ? `\nActive subscriptions:\n${active.join('\n')}`
              : ' This session has no event subscriptions.')
    );
  }

  /**
   * An event type without replay (`cursor: null`) cannot recover what happened while the
   * bridge was down, so a restart is a gap and is recorded as one.
   */
  private async recordRestartGap(entry: EventSubscriptionEntry): Promise<void> {
    const position = this.options.journal.getCursor(entry.id);
    if (position === undefined || position.cursor !== null) return;
    await this.writeRecords(
      entry.id,
      [
        this.gap(
          entry.id,
          entry.name,
          'no-replay',
          'events while the bridge was down cannot be replayed'
        ),
      ],
      null
    );
  }

  private startLoop(id: string, previous?: PollEventsResult): void {
    const controller = new AbortController();
    const done = this.runLoop(id, controller.signal, previous).catch((error: unknown) => {
      this.options.logger.error(`Event loop for ${id} crashed:`, error);
    });
    this.loops.set(id, { stop: () => controller.abort(), done });
  }

  private async runLoop(
    id: string,
    signal: AbortSignal,
    previous?: PollEventsResult
  ): Promise<void> {
    const minInterval = this.options.minIntervalMillis ?? MIN_POLL_INTERVAL_MILLIS;
    let delayMillis = previous ? nextDelay(previous, minInterval) : 0;
    let backoffMillis = INITIAL_BACKOFF_MILLIS;

    while (!signal.aborted && !this.closed) {
      await abortableSleep(delayMillis, signal);
      if (signal.aborted || this.closed) return;
      const entry = this.entries.get(id);
      if (!entry) return;

      try {
        const position = this.options.journal.getCursor(id);
        const result = await this.options.poll({
          name: entry.name,
          ...(entry.arguments && { arguments: entry.arguments }),
          cursor: position?.cursor ?? null,
        });
        if (signal.aborted) return;
        await this.commit(id, entry.name, result, { bootstrap: false });
        if (entry.lastError) await this.clearError(id);
        backoffMillis = INITIAL_BACKOFF_MILLIS;
        delayMillis = nextDelay(result, minInterval);
      } catch (error) {
        if (signal.aborted) return;
        const code = (error as { code?: unknown }).code;
        const message = (error as Error).message;
        if (typeof code === 'number' && TERMINAL_ERROR_CODES.has(code)) {
          await this.terminate(id, entry.name, code, message);
          return;
        }
        this.options.logger.warn(
          `Poll for ${id} failed, retrying in ${backoffMillis}ms: ${message}`
        );
        if (entry.lastError !== message) await this.updateEntry(id, { lastError: message });
        delayMillis = backoffMillis;
        backoffMillis = Math.min(backoffMillis * 2, MAX_BACKOFF_MILLIS);
      }
    }
  }

  private async commit(
    id: string,
    name: string,
    result: PollEventsResult,
    { bootstrap }: { bootstrap: boolean }
  ): Promise<void> {
    const receivedAt = new Date().toISOString();
    const batch: NewJournalRecord[] = [];
    // A gap is only meaningful against a cursor we supplied; truncated is ignored for
    // event types without replay, as the spec says clients should.
    if (result.truncated && !bootstrap && result.cursor !== null) {
      batch.push(this.gap(id, name, 'truncated', 'the server skipped events past our cursor'));
    }
    for (const event of result.events) {
      batch.push({
        kind: 'event',
        sub: id,
        name: event.name,
        eventId: event.eventId,
        timestamp: event.timestamp,
        receivedAt,
        data: event.data,
        ...(event._meta && { _meta: event._meta }),
      });
    }
    await this.writeRecords(id, batch, result.cursor);
  }

  private async writeRecords(
    id: string,
    batch: NewJournalRecord[],
    cursor: string | null
  ): Promise<void> {
    const written = await this.options.journal.commit(id, batch, cursor);
    if (written.length > 0) this.options.onCommitted?.(written);
  }

  private async terminate(id: string, name: string, code: number, message: string): Promise<void> {
    this.options.logger.warn(`Subscription ${id} terminated by the server (${code}): ${message}`);
    const position = this.options.journal.getCursor(id);
    await this.writeRecords(
      id,
      [this.gap(id, name, 'terminated', `${code}: ${message}`)],
      position?.cursor ?? null
    );
    await this.updateEntry(id, {
      terminatedAt: new Date().toISOString(),
      lastError: `${code}: ${message}`,
    });
    this.loops.delete(id);
  }

  private gap(
    sub: string,
    name: string,
    reason: 'truncated' | 'no-replay' | 'terminated',
    detail: string
  ): NewJournalRecord {
    return { kind: 'gap', sub, name, reason, detail, receivedAt: new Date().toISOString() };
  }

  private async updateEntry(
    id: string,
    patch: Partial<Pick<EventSubscriptionEntry, 'lastError' | 'terminatedAt'>>
  ): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.set(id, { ...entry, ...patch });
    await this.persist();
  }

  private async clearError(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    const { lastError: _cleared, ...rest } = entry;
    this.entries.set(id, rest);
    await this.persist();
  }

  private async persist(): Promise<void> {
    await this.options.persist(Object.fromEntries(this.entries));
  }
}

function nextDelay(result: PollEventsResult, minIntervalMillis: number): number {
  // Drain at once while there is more, but never spin on a server that claims more and sends none.
  if (result.hasMore && result.events.length > 0) return 0;
  return Math.max(result.nextPollMs ?? DEFAULT_POLL_INTERVAL_MILLIS, minIntervalMillis);
}

function abortableSleep(millis: number, signal: AbortSignal): Promise<void> {
  if (millis <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, millis);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
