/**
 * Journals `notifications/claude/channel` messages (Claude Code's channels extension).
 *
 * A server that declares `capabilities.experimental["claude/channel"]` pushes
 * `{ content, meta? }` notifications with no id, cursor or replay, so the strongest honest
 * guarantee is: every message received while connected is journaled, and every window in
 * which the receiver could not be listening is recorded as a `disconnected` gap. Those
 * windows are a bridge that was down (detected on start, from the persisted subscription)
 * and a server that stopped answering keepalive pings while the bridge kept running.
 *
 * Only 2025-11-25 sessions can receive these: 2026-07-28 removed the unsolicited GET stream
 * and only delivers notification types a client requested on `subscriptions/listen`.
 */

import { randomUUID } from 'crypto';
import type { EventJournal, JournalRecord, NewJournalRecord } from '../lib/event-journal.js';
import type { Logger } from '../lib/logger.js';

export const CHANNEL_CAPABILITY = 'claude/channel';
export const CHANNEL_NOTIFICATION = 'notifications/claude/channel';
/** The journal subscription id channel messages are recorded under. */
export const CHANNEL_SUBSCRIPTION = 'claude/channel';

/** `meta` keys a server may use to identify a message; the first present one dedupes it. */
const ID_META_KEYS = ['message_id', 'messageId', 'msg_id', 'id', 'event_id', 'eventId'] as const;

export interface ChannelReceiverOptions {
  journal: EventJournal;
  logger: Logger;
  onCommitted?: (records: JournalRecord[]) => void;
}

/** Whether a server's capabilities declare the Claude Code channel extension. */
export function declaresChannel(capabilities: unknown): boolean {
  const experimental = (capabilities as { experimental?: unknown } | undefined)?.experimental;
  return (
    typeof experimental === 'object' &&
    experimental !== null &&
    (experimental as Record<string, unknown>)[CHANNEL_CAPABILITY] !== undefined
  );
}

export class ChannelReceiver {
  /** When the server stopped answering, while the bridge kept running. */
  private downSince: string | undefined;

  constructor(private readonly options: ChannelReceiverOptions) {}

  /**
   * Begin listening. When a previous bridge was already journaling this session's channel,
   * everything pushed between that bridge's end and now is lost — record it.
   */
  async start(): Promise<void> {
    const previous = this.options.journal.getCursor(CHANNEL_SUBSCRIPTION);
    const batch: NewJournalRecord[] = previous
      ? [
          this.gap(
            `channel messages sent while the bridge was down are lost (last channel activity ${previous.updatedAt})`
          ),
        ]
      : [];
    await this.write(batch);
  }

  /** Journal one received notification. Params that are not the expected shape are kept verbatim. */
  async handle(params: Record<string, unknown>): Promise<void> {
    const receivedAt = new Date().toISOString();
    const meta = isRecord(params.meta) ? params.meta : undefined;
    const declaredId = ID_META_KEYS.map((key) => meta?.[key]).find(
      (value): value is string | number => typeof value === 'string' || typeof value === 'number'
    );
    const record: NewJournalRecord = {
      kind: 'event',
      sub: CHANNEL_SUBSCRIPTION,
      name: CHANNEL_SUBSCRIPTION,
      eventId: declaredId !== undefined ? String(declaredId) : `local:${randomUUID()}`,
      timestamp: typeof meta?.ts === 'string' ? meta.ts : receivedAt,
      receivedAt,
      data: params,
    };
    await this.write([record]);
  }

  /** The server stopped answering (keepalive failed); remember since when. */
  markDown(): void {
    this.downSince ??= new Date().toISOString();
  }

  /** The server answers again: record the window in which messages may have been lost. */
  async markUp(): Promise<void> {
    if (this.downSince === undefined) return;
    const since = this.downSince;
    this.downSince = undefined;
    await this.write([this.gap(`server unreachable from ${since} to ${new Date().toISOString()}`)]);
  }

  private async write(batch: NewJournalRecord[]): Promise<void> {
    const written = await this.options.journal.commit(CHANNEL_SUBSCRIPTION, batch, null);
    if (written.length > 0) this.options.onCommitted?.(written);
  }

  private gap(detail: string): NewJournalRecord {
    return {
      kind: 'gap',
      sub: CHANNEL_SUBSCRIPTION,
      name: CHANNEL_SUBSCRIPTION,
      reason: 'disconnected',
      detail,
      receivedAt: new Date().toISOString(),
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
