/**
 * Result validators for the Events extension (`io.modelcontextprotocol/events`, SEP-3415).
 *
 * The SDK has no schemas for `events/list` or `events/poll`, so mcpc issues them through
 * `client.request()` with these hand-written Standard Schema v1 validators, like the skills
 * and tasks extensions. Validation is strict about what deduplication and resumption depend
 * on (`eventId`, `cursor`, `hasMore`), because an occurrence without a usable id cannot be
 * deduplicated and would be journaled twice after a replay.
 *
 * Spec (Draft): https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415
 */

import type { StandardSchemaV1 } from '@modelcontextprotocol/client';

export type EventDeliveryMode = 'poll' | 'push' | 'webhook';

/** One entry of `events/list`. */
export interface EventDescriptor {
  name: string;
  description?: string;
  delivery: EventDeliveryMode[];
  inputSchema?: Record<string, unknown>;
  payloadSchema?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export interface ListEventsResult {
  events: EventDescriptor[];
  nextCursor?: string;
}

/** One delivered event (`EventOccurrence`). */
export interface EventOccurrence {
  eventId: string;
  name: string;
  timestamp: string;
  data: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export interface PollEventsResult {
  events: EventOccurrence[];
  /** Position after this batch; `null` when the event type has no replay. Absent means `null`. */
  cursor: string | null;
  truncated: boolean;
  hasMore: boolean;
  nextPollMs?: number;
}

export interface PollEventsParams {
  name: string;
  arguments?: Record<string, unknown>;
  cursor: string | null;
  maxAgeMs?: number;
  maxEvents?: number;
}

/** SEP-3415 error codes (provisional until the SEP is accepted). */
export const EVENTS_ERROR_NOT_FOUND = -32023;
export const EVENTS_ERROR_FORBIDDEN = -32024;
export const EVENTS_ERROR_RESOURCE_EXHAUSTED = -32025;
export const EVENTS_ERROR_UNSUPPORTED = -32026;

const DELIVERY_MODES: readonly EventDeliveryMode[] = ['poll', 'push', 'webhook'];

type Issue = { message: string; path: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function standardSchema<T>(
  validate: (value: unknown, issues: Issue[]) => T | undefined
): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'mcpc',
      validate: (value: unknown) => {
        const issues: Issue[] = [];
        const parsed = validate(value, issues);
        if (issues.length > 0 || parsed === undefined) {
          return { issues: issues.length > 0 ? issues : [{ message: 'invalid result', path: [] }] };
        }
        return { value: parsed };
      },
    },
  };
}

function optionalRecord(
  value: Record<string, unknown>,
  key: string,
  path: string[],
  issues: Issue[]
): Record<string, unknown> | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (!isRecord(field)) {
    issues.push({ message: `${key} must be an object`, path: [...path, key] });
    return undefined;
  }
  return field;
}

function parseDescriptor(
  value: unknown,
  path: string[],
  issues: Issue[]
): EventDescriptor | undefined {
  if (!isRecord(value)) {
    issues.push({ message: 'event descriptor must be an object', path });
    return undefined;
  }
  if (typeof value.name !== 'string' || value.name.length === 0) {
    issues.push({ message: 'name must be a non-empty string', path: [...path, 'name'] });
    return undefined;
  }
  const delivery = value.delivery;
  if (
    !Array.isArray(delivery) ||
    delivery.length === 0 ||
    !delivery.every((mode) => DELIVERY_MODES.includes(mode as EventDeliveryMode))
  ) {
    issues.push({
      message: `delivery must be a non-empty subset of ${DELIVERY_MODES.join(', ')}`,
      path: [...path, 'delivery'],
    });
    return undefined;
  }
  const descriptor: EventDescriptor = {
    name: value.name,
    delivery: delivery as EventDeliveryMode[],
  };
  if (typeof value.description === 'string') descriptor.description = value.description;
  const inputSchema = optionalRecord(value, 'inputSchema', path, issues);
  if (inputSchema) descriptor.inputSchema = inputSchema;
  const payloadSchema = optionalRecord(value, 'payloadSchema', path, issues);
  if (payloadSchema) descriptor.payloadSchema = payloadSchema;
  const meta = optionalRecord(value, '_meta', path, issues);
  if (meta) descriptor._meta = meta;
  return descriptor;
}

function parseOccurrence(
  value: unknown,
  path: string[],
  issues: Issue[]
): EventOccurrence | undefined {
  if (!isRecord(value)) {
    issues.push({ message: 'event must be an object', path });
    return undefined;
  }
  for (const key of ['eventId', 'name', 'timestamp'] as const) {
    if (typeof value[key] !== 'string' || (value[key] as string).length === 0) {
      issues.push({ message: `${key} must be a non-empty string`, path: [...path, key] });
      return undefined;
    }
  }
  if (!isRecord(value.data)) {
    issues.push({ message: 'data must be an object', path: [...path, 'data'] });
    return undefined;
  }
  const occurrence: EventOccurrence = {
    eventId: value.eventId as string,
    name: value.name as string,
    timestamp: value.timestamp as string,
    data: value.data,
  };
  const meta = optionalRecord(value, '_meta', path, issues);
  if (meta) occurrence._meta = meta;
  return occurrence;
}

export const ListEventsResultSchema = standardSchema<ListEventsResult>((value, issues) => {
  if (!isRecord(value) || !Array.isArray(value.events)) {
    issues.push({ message: 'events/list result must have an events array', path: ['events'] });
    return undefined;
  }
  const events = value.events.map((entry, i) =>
    parseDescriptor(entry, ['events', String(i)], issues)
  );
  if (issues.length > 0) return undefined;
  const result: ListEventsResult = { events: events as EventDescriptor[] };
  if (typeof value.nextCursor === 'string') result.nextCursor = value.nextCursor;
  return result;
});

export const PollEventsResultSchema = standardSchema<PollEventsResult>((value, issues) => {
  if (!isRecord(value) || !Array.isArray(value.events)) {
    issues.push({ message: 'events/poll result must have an events array', path: ['events'] });
    return undefined;
  }
  const events = value.events.map((entry, i) =>
    parseOccurrence(entry, ['events', String(i)], issues)
  );
  const cursor = value.cursor ?? null;
  if (cursor !== null && typeof cursor !== 'string') {
    issues.push({ message: 'cursor must be a string or null', path: ['cursor'] });
  }
  if (typeof value.hasMore !== 'boolean') {
    issues.push({ message: 'hasMore must be a boolean', path: ['hasMore'] });
  }
  if (value.truncated !== undefined && typeof value.truncated !== 'boolean') {
    issues.push({ message: 'truncated must be a boolean', path: ['truncated'] });
  }
  if (
    value.nextPollMs !== undefined &&
    (typeof value.nextPollMs !== 'number' || value.nextPollMs < 0)
  ) {
    issues.push({ message: 'nextPollMs must be a non-negative number', path: ['nextPollMs'] });
  }
  if (issues.length > 0) return undefined;
  const result: PollEventsResult = {
    events: events as EventOccurrence[],
    cursor: cursor as string | null,
    truncated: value.truncated === true,
    hasMore: value.hasMore as boolean,
  };
  if (typeof value.nextPollMs === 'number') result.nextPollMs = value.nextPollMs;
  return result;
});
