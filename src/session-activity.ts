import { createHash } from 'node:crypto';
import { containsSensitiveContent } from './files.js';

export type ActivityEventKind = 'turn/started' | 'turn/completed' | 'item/started' | 'item/completed';
/** Metadata only. observedAtMs is the first receipt of this particular event,
 * never a replacement for its producer timestamp. IDs are independent of epoch. */
export interface ActivityRecord {
  threadId: string;
  activityAtMs: number;
  observedAtMs: number;
  eventKind: ActivityEventKind;
  eventId: string;
  seenEventIds: string[];
}

export const MAX_ACTIVITY_THREADS = 500;
export const MAX_ACTIVITY_EVENTS_PER_THREAD = 32;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const eventKinds = new Set<string>(['turn/started', 'turn/completed', 'item/started', 'item/completed']);
// Read only the discriminator, never message, tool, reasoning, or other content.
const itemKinds = new Set<string>([
  'userMessage', 'agentMessage', 'plan', 'reasoning', 'commandExecution',
  'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall',
  'webSearch', 'imageView', 'imageGeneration', 'enteredReviewMode',
  'exitedReviewMode', 'contextCompaction',
]);
const recordKeys = ['activityAtMs', 'eventId', 'eventKind', 'observedAtMs', 'seenEventIds', 'threadId'];
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/.test(value) && !containsSensitiveContent(value);
const positiveTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$(?![\s\S])/.test(value);
const invalidState = (): never => { throw Error('INVALID_ACTIVITY_STATE'); };

/** Call on load as well as before updates. Bad stored evidence must not silently
 * turn into trustworthy activity, nor carry additional payload fields forward. */
export function validateActivityRecords(records: unknown): asserts records is ActivityRecord[] | undefined {
  if (records === undefined) return;
  if (!Array.isArray(records) || records.length > MAX_ACTIVITY_THREADS) return invalidState();
  const threads = new Set<string>();
  for (const row of records) {
    if (!object(row) || Object.keys(row).sort().join(',') !== recordKeys.join(',') ||
      !id(row.threadId) || threads.has(row.threadId) ||
      !positiveTime(row.activityAtMs) || !positiveTime(row.observedAtMs) ||
      row.activityAtMs - row.observedAtMs > MAX_FUTURE_SKEW_MS ||
      !eventKinds.has(row.eventKind) || !hash(row.eventId) ||
      !Array.isArray(row.seenEventIds) || row.seenEventIds.length < 1 ||
      row.seenEventIds.length > MAX_ACTIVITY_EVENTS_PER_THREAD ||
      Array.from(row.seenEventIds).some((value: unknown) => !hash(value)) ||
      new Set(row.seenEventIds).size !== row.seenEventIds.length ||
      !row.seenEventIds.includes(row.eventId)) invalidState();
    threads.add(row.threadId);
  }
}

/** Bounded evidence, not an audit log or exhaustive history. Evicted thread rows
 * and older event identities lose replay protection. The selected latest event
 * stays pinned in its row's identity set. Unsupported or untimed events do not
 * create activity. Callers must authenticate the backend and current epoch. */
export function recordActivity(
  records: readonly ActivityRecord[] | undefined,
  method: string,
  params: any,
  observedAt: number,
): ActivityRecord[] | undefined {
  if (!eventKinds.has(method)) return undefined;
  validateActivityRecords(records);
  if (!object(params) || !positiveTime(observedAt) || !id(params.threadId)) return undefined;
  const turnEvent = method.startsWith('turn/');
  const event = turnEvent ? params.turn : params.item;
  if (!object(event)) return undefined;
  const turnId = turnEvent ? event.id : params.turnId;
  const itemId = turnEvent ? null : event.id;
  if (!id(turnId) || (!turnEvent && (!id(itemId) || !itemKinds.has(event.type)))) return undefined;
  const producerTime = turnEvent
    ? event[method === 'turn/started' ? 'startedAt' : 'completedAt']
    : params[method === 'item/started' ? 'startedAtMs' : 'completedAtMs'];
  if (!positiveTime(producerTime)) return undefined;
  const activityAtMs = turnEvent ? producerTime * 1000 : producerTime;
  if (!positiveTime(activityAtMs) || activityAtMs - observedAt > MAX_FUTURE_SKEW_MS) return undefined;
  const eventId = createHash('sha256').update(JSON.stringify([method, params.threadId, turnId, itemId])).digest('hex');
  const existing = records?.find(row => row.threadId === params.threadId);
  // Identity is immutable, including producer time. A replay with a changed time
  // cannot freshen an already observed event, even after a backend reconnect.
  if (existing?.seenEventIds.includes(eventId)) return undefined;
  const newer = !existing || activityAtMs > existing.activityAtMs ||
    (activityAtMs === existing.activityAtMs && eventId > existing.eventId);
  const selected = newer
    ? { threadId: params.threadId, activityAtMs, observedAtMs: observedAt, eventKind: method as ActivityEventKind, eventId }
    : { threadId: existing.threadId, activityAtMs: existing.activityAtMs, observedAtMs: existing.observedAtMs, eventKind: existing.eventKind, eventId: existing.eventId };
  const seenEventIds = [...(existing?.seenEventIds || []), eventId];
  if (seenEventIds.length > MAX_ACTIVITY_EVENTS_PER_THREAD) {
    seenEventIds.splice(seenEventIds.findIndex(value => value !== selected.eventId), 1);
  }
  const rows = (records || []).filter(row => row.threadId !== params.threadId)
    .map(row => ({ ...row, seenEventIds: [...row.seenEventIds] }));
  rows.push({ ...selected, seenEventIds });
  rows.sort((a, b) => b.activityAtMs - a.activityAtMs || (a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0));
  const retained = rows.slice(0, MAX_ACTIVITY_THREADS);
  return !existing && !retained.some(row => row.threadId === params.threadId) ? undefined : retained;
}
