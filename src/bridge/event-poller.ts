/**
 * Event subscriptions for the bridge process (SEP-3415 poll and push delivery).
 *
 * One loop per subscription. Event types offering push are received over a long-lived
 * `events/stream` for latency; when the stream ends or goes silent for longer than twice
 * the heartbeat interval, the loop catches up by polling from the journaled cursor (if the
 * type offers poll) and reopens the stream. Poll-only types use a plain poll loop. Every batch is committed to the session's
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
import type {
  EventDescriptor,
  EventStreamHandlers,
  PollEventsParams,
  PollEventsResult,
  StreamEventsParams,
} from '../core/events-schema.js';
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
/** A push stream silent this long is dead (the spec: twice the 30 s heartbeat, plus slack). */
export const STREAM_IDLE_TIMEOUT_MILLIS = 65_000;
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
  /** Look up an event type's descriptor (`events/list`), to choose its delivery mode. */
  describe?: (name: string) => Promise<EventDescriptor | undefined>;
  /** Run one push stream until it ends (see McpClient.streamEvents). */
  stream?: (
    params: StreamEventsParams,
    handlers: EventStreamHandlers,
    signal: AbortSignal
  ) => Promise<void>;
  /** Called after records are durably journaled (e.g. to wake followers). */
  onCommitted?: (records: JournalRecord[]) => void;
  minIntervalMillis?: number;
  streamIdleMillis?: number;
}

type Mode = 'poll' | 'push';

/** A promise with its settle functions, for "the stream is up" during subscribe. */
interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
  settled: boolean;
}

function deferred(): Deferred {
  const d = { settled: false } as Deferred;
  d.promise = new Promise<void>((resolve, reject) => {
    d.resolve = () => {
      d.settled = true;
      resolve();
    };
    d.reject = (error) => {
      d.settled = true;
      reject(error);
    };
  });
  return d;
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

    const delivery = await this.chooseDelivery(name);
    const entry: EventSubscriptionEntry = {
      id,
      name,
      ...(args && Object.keys(args).length > 0 && { arguments: args }),
      delivery,
      subscribedAt: new Date().toISOString(),
    };

    if (delivery.includes('poll')) {
      // Bootstrap with a null cursor ("start from now"), which also validates the
      // subscription; a push stream then resumes from the cursor it returned.
      const result = await this.options.poll({
        name,
        ...(args && { arguments: args }),
        cursor: null,
      });
      await this.commit(id, name, result, { bootstrap: true });
      this.entries.set(id, entry);
      await this.persist();
      this.startLoop(id, result);
      return entry;
    }

    // Push only: the subscription is valid once the stream confirms it.
    this.entries.set(id, entry);
    const ready = deferred();
    this.startLoop(id, undefined, ready);
    try {
      await ready.promise;
    } catch (error) {
      this.loops.get(id)?.stop();
      this.loops.delete(id);
      this.entries.delete(id);
      throw error;
    }
    await this.persist();
    return entry;
  }

  /** Delivery modes mcpc can use for an event type: push when offered, poll when offered. */
  private async chooseDelivery(name: string): Promise<Mode[]> {
    const descriptor = this.options.describe ? await this.options.describe(name) : undefined;
    // Unknown here (no events/list, or not listed): poll, whose answer is authoritative.
    if (!descriptor) return ['poll'];
    const modes = descriptor.delivery.filter(
      (mode): mode is Mode =>
        mode === 'poll' || (mode === 'push' && this.options.stream !== undefined)
    );
    if (modes.length === 0) {
      throw new ClientError(
        `Event type ${name} is only offered over ${descriptor.delivery.join(', ')} delivery, ` +
          'which mcpc cannot use (webhooks need a public HTTPS endpoint).'
      );
    }
    return modes;
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

  private startLoop(id: string, previous?: PollEventsResult, ready?: Deferred): void {
    const controller = new AbortController();
    const push = this.entries.get(id)?.delivery?.includes('push') && this.options.stream;
    const run = push
      ? this.runStreamLoop(id, controller.signal, ready)
      : this.runLoop(id, controller.signal, previous);
    const done = run.catch((error: unknown) => {
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

  /**
   * Push delivery: keep one `events/stream` open, journal what it delivers, and when it
   * ends or goes silent, catch up by polling (when offered) before reopening it.
   */
  private async runStreamLoop(id: string, signal: AbortSignal, ready?: Deferred): Promise<void> {
    const stream = this.options.stream;
    if (!stream) return;
    const idleMillis = this.options.streamIdleMillis ?? STREAM_IDLE_TIMEOUT_MILLIS;
    let backoffMillis = INITIAL_BACKOFF_MILLIS;
    let everActive = false;

    while (!signal.aborted && !this.closed) {
      const entry = this.entries.get(id);
      if (!entry) return;
      const startCursor = this.options.journal.getCursor(id)?.cursor ?? null;
      if (everActive && startCursor === null) {
        await this.writeRecords(
          id,
          [
            this.gap(
              id,
              entry.name,
              'no-replay',
              'push stream reconnected; events in between cannot be replayed'
            ),
          ],
          null
        );
      }

      const streamAbort = new AbortController();
      const onStop = (): void => streamAbort.abort();
      signal.addEventListener('abort', onStop, { once: true });
      let idleTimer: NodeJS.Timeout | undefined;
      const touch = (): void => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          this.options.logger.warn(
            `Push stream for ${id} silent for ${idleMillis}ms; reconnecting`
          );
          streamAbort.abort();
        }, idleMillis);
        idleTimer.unref?.();
      };
      let active = false;
      let terminated = false;

      try {
        touch();
        await stream(
          {
            name: entry.name,
            ...(entry.arguments && { arguments: entry.arguments }),
            cursor: startCursor,
          },
          {
            onActive: async ({ cursor, truncated }) => {
              touch();
              active = true;
              everActive = true;
              backoffMillis = INITIAL_BACKOFF_MILLIS;
              const batch =
                truncated && startCursor !== null && cursor !== null
                  ? [
                      this.gap(
                        id,
                        entry.name,
                        'truncated',
                        'the server skipped events past our cursor'
                      ),
                    ]
                  : [];
              await this.writeRecords(id, batch, cursor);
              if (entry.lastError) await this.clearError(id);
              ready?.resolve();
            },
            onEvent: async (event) => {
              touch();
              await this.writeRecords(
                id,
                [
                  {
                    kind: 'event',
                    sub: id,
                    name: event.name,
                    eventId: event.eventId,
                    timestamp: event.timestamp,
                    receivedAt: new Date().toISOString(),
                    data: event.data,
                    ...(event._meta && { _meta: event._meta }),
                  },
                ],
                event.cursor
              );
            },
            onHeartbeat: async ({ cursor }) => {
              touch();
              await this.writeRecords(id, [], cursor);
            },
            onError: async (error) => {
              touch();
              const message = `${error.code}: ${error.message}`;
              this.options.logger.warn(`Push stream for ${id} reported an error: ${message}`);
              await this.updateEntry(id, { lastError: message });
            },
            onTerminated: async (error) => {
              terminated = true;
              await this.terminate(id, entry.name, error.code, error.message);
              streamAbort.abort();
            },
          },
          streamAbort.signal
        );
      } catch (error) {
        if (signal.aborted || terminated) return;
        const code = (error as { code?: unknown }).code;
        const message = (error as Error).message;
        if (!active && typeof code === 'number' && TERMINAL_ERROR_CODES.has(code)) {
          if (ready && !ready.settled) {
            ready.reject(error);
            return;
          }
          await this.terminate(id, entry.name, code, message);
          return;
        }
        if (!streamAbort.signal.aborted) {
          this.options.logger.warn(`Push stream for ${id} failed: ${message}`);
          if (entry.lastError !== message) await this.updateEntry(id, { lastError: message });
        }
      } finally {
        clearTimeout(idleTimer);
        signal.removeEventListener('abort', onStop);
      }
      if (signal.aborted || terminated || this.closed) return;

      if (entry.delivery?.includes('poll')) {
        if (await this.catchUp(id, signal)) return;
      }
      if (active) {
        // Never spin on a server that closes every stream at once.
        await abortableSleep(this.options.minIntervalMillis ?? MIN_POLL_INTERVAL_MILLIS, signal);
      } else {
        await abortableSleep(backoffMillis, signal);
        backoffMillis = Math.min(backoffMillis * 2, MAX_BACKOFF_MILLIS);
      }
    }
  }

  /**
   * Poll from the journaled cursor until the server has nothing more, so a dropped push
   * stream loses nothing the server can replay. Returns true when the subscription ended.
   */
  private async catchUp(id: string, signal: AbortSignal): Promise<boolean> {
    for (;;) {
      const entry = this.entries.get(id);
      if (!entry || signal.aborted) return true;
      try {
        const result = await this.options.poll({
          name: entry.name,
          ...(entry.arguments && { arguments: entry.arguments }),
          cursor: this.options.journal.getCursor(id)?.cursor ?? null,
        });
        await this.commit(id, entry.name, result, { bootstrap: false });
        if (!result.hasMore || result.events.length === 0) return false;
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (typeof code === 'number' && TERMINAL_ERROR_CODES.has(code)) {
          await this.terminate(id, entry.name, code, (error as Error).message);
          return true;
        }
        this.options.logger.warn(`Catch-up poll for ${id} failed: ${(error as Error).message}`);
        return false;
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
