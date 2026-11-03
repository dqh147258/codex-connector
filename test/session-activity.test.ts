import test from 'node:test';
import assert from 'node:assert/strict';
import { recordActivity, validateActivityRecords, MAX_ACTIVITY_EVENTS_PER_THREAD, MAX_ACTIVITY_THREADS } from '../src/session-activity.js';
import type { ActivityRecord } from '../src/session-activity.js';

const BASE = 1_800_000_000_000;
const turn = (at = BASE, threadId = 'thread-1', turnId = 'turn-1') => ({ threadId, turn: { id: turnId, startedAt: at / 1000, completedAt: at / 1000 } });
const item = (at = BASE, threadId = 'thread-1', turnId = 'turn-1', itemId = 'item-1') => ({ threadId, turnId, item: { id: itemId, type: 'agentMessage' }, startedAtMs: at, completedAtMs: at });
const seed = () => recordActivity(undefined, 'turn/started', turn(), BASE + 2000)!;

test('producer seconds and milliseconds, not receipt times, determine activity', () => {
  for (const method of ['turn/started', 'turn/completed', 'item/started', 'item/completed']) {
    const rows = recordActivity(undefined, method, method.startsWith('turn/') ? turn() : item(), BASE + 120_000)!;
    assert.equal(rows[0]!.activityAtMs, BASE);
    assert.equal(rows[0]!.observedAtMs, BASE + 120_000);
    assert.equal(rows[0]!.eventKind, method);
    assert.match(rows[0]!.eventId, /^[a-f0-9]{64}$/);
    assert.deepEqual(rows[0]!.seenEventIds, [rows[0]!.eventId]);
  }
  const millis = recordActivity(undefined, 'item/started', item(BASE + 123), BASE + 1000)!;
  assert.equal(millis[0]!.activityAtMs, BASE + 123);
});

test('immutable identities deduplicate replay across epoch and restart without changing observation', () => {
  const original = seed(), saved = JSON.parse(JSON.stringify(original));
  for (const at of [BASE, BASE + 60_000]) {
    const replay = { ...turn(at), epoch: 'new-backend-epoch' };
    assert.equal(recordActivity(saved, 'turn/started', replay, BASE + 100_000), undefined);
  }
  assert.deepEqual(saved, original);
  assert.equal(original[0]!.observedAtMs, BASE + 2000);
});

test('missing producer timestamp, aliases, receipt fallback, and unsupported notifications never count', () => {
  for (const method of ['thread/started', 'thread/metadataUpdated', 'thread/name/updated', 'thread/read', 'thread/resume', 'thread/status/changed', 'item/agentMessage/delta']) {
    assert.equal(recordActivity(seed(), method, { ...turn(), ...item(), updatedAt: BASE }, BASE), undefined);
  }
  for (const [method, params] of [
    ['turn/started', { threadId: 'thread-1', turn: { id: 'turn-1', completedAt: BASE / 1000 }, startedAt: BASE / 1000 }],
    ['turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', startedAt: BASE / 1000 } }],
    ['item/started', { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'item-1', type: 'agentMessage', startedAtMs: BASE } }],
    ['item/completed', { ...item(), completedAtMs: undefined }],
  ] as const) assert.equal(recordActivity(undefined, method, params, BASE), undefined);
});

test('producer timestamps must be positive finite safe integers and fit the five-minute skew', () => {
  for (const bad of [undefined, null, NaN, Infinity, -Infinity, 0, -1, 1.5, '1800000000', Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(recordActivity(undefined, 'turn/started', { ...turn(), turn: { id: 'turn-1', startedAt: bad } }, BASE), undefined);
    assert.equal(recordActivity(undefined, 'item/started', { ...item(), startedAtMs: bad }, BASE), undefined);
  }
  assert.equal(recordActivity(undefined, 'turn/started', { ...turn(), turn: { id: 'turn-1', startedAt: Number.MAX_SAFE_INTEGER } }, BASE), undefined);
  assert.equal(recordActivity(undefined, 'turn/started', turn(BASE + 301_000), BASE), undefined);
  assert.ok(recordActivity(undefined, 'turn/started', turn(BASE + 300_000), BASE));
  assert.equal(recordActivity(undefined, 'item/started', item(BASE + 300_001), BASE), undefined);
  assert.ok(recordActivity(undefined, 'item/started', item(BASE + 300_000), BASE));
  assert.ok(recordActivity(undefined, 'item/started', item(1), BASE));
  for (const observed of [NaN, Infinity, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(recordActivity(undefined, 'turn/started', turn(), observed), undefined);
  }
});

test('all identity components are bounded strings with a safe format', () => {
  for (const bad of ['', '../private', 'has space', 'line\nbreak', 'trailing\n', 'trailing\r', 'a/b', 'a'.repeat(129), 'sk-proj-' + 'x'.repeat(24), null, 7, {}, ['id']]) {
    assert.equal(recordActivity(undefined, 'turn/started', { ...turn(), threadId: bad }, BASE), undefined);
    assert.equal(recordActivity(undefined, 'turn/started', { ...turn(), turn: { id: bad, startedAt: BASE / 1000 } }, BASE), undefined);
    assert.equal(recordActivity(undefined, 'item/started', { ...item(), turnId: bad }, BASE), undefined);
    assert.equal(recordActivity(undefined, 'item/started', { ...item(), item: { id: bad, type: 'agentMessage' } }, BASE), undefined);
  }
  assert.ok(recordActivity(undefined, 'turn/started', turn(BASE, 'a'.repeat(128)), BASE));
  for (const bad of [undefined, null, [], 3]) assert.equal(recordActivity(undefined, 'turn/started', bad, BASE), undefined);
});

test('hash identities include full method, thread, turn and item without delimiter collisions', () => {
  const events: [string, any][] = [
    ['item/started', item(BASE, 'a:b', 'c', 'd')],
    ['item/started', item(BASE, 'a', 'b:c', 'd')],
    ['item/started', item(BASE, 'a:b', 'c', 'e')],
    ['item/started', item(BASE, 'a:b', 'f', 'd')],
    ['item/completed', item(BASE, 'a:b', 'c', 'd')],
    ['turn/started', turn(BASE, 'a:b', 'c')],
    ['turn/completed', turn(BASE, 'a:b', 'c')],
  ];
  const hashes = events.map(([method, params]) => recordActivity(undefined, method, params, BASE)![0]!.eventId);
  assert.equal(new Set(hashes).size, events.length);
});

test('item metadata allowlist never reads or persists content, raw turn/item IDs, or epoch', () => {
  for (const type of ['userMessage', 'agentMessage', 'reasoning', 'commandExecution', 'fileChange', 'mcpToolCall', 'contextCompaction']) {
    const params = item();
    params.item.type = type;
    Object.defineProperty(params.item, 'text', { enumerable: true, get() { throw Error('content read'); } });
    Object.defineProperty(params.item, 'content', { enumerable: true, get() { throw Error('content read'); } });
    const result = recordActivity(undefined, 'item/started', params, BASE)!;
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('item-1'));
    assert.ok(!serialized.includes('turn-1'));
    assert.deepEqual(Object.keys(result[0]!).sort(), ['activityAtMs', 'eventId', 'eventKind', 'observedAtMs', 'seenEventIds', 'threadId']);
  }
  for (const type of ['metadataUpdated', '', undefined, null, 4]) {
    assert.equal(recordActivity(undefined, 'item/started', { ...item(), item: { id: 'item-1', type } }, BASE), undefined);
  }
});

test('out-of-order evidence cannot reduce recency; same-time event ties are deterministic', () => {
  const original = seed();
  const older = recordActivity(original, 'item/completed', item(BASE - 1000), BASE + 5000)!;
  assert.equal(older[0]!.activityAtMs, original[0]!.activityAtMs);
  assert.equal(older[0]!.eventKind, original[0]!.eventKind);
  assert.equal(older[0]!.observedAtMs, original[0]!.observedAtMs);
  assert.equal(older[0]!.seenEventIds.length, 2);
  const a = recordActivity(recordActivity(undefined, 'turn/started', turn(), BASE), 'turn/completed', turn(), BASE)!;
  const b = recordActivity(recordActivity(undefined, 'turn/completed', turn(), BASE), 'turn/started', turn(), BASE)!;
  assert.equal(a[0]!.eventId, b[0]!.eventId);
  assert.equal(a[0]!.eventKind, b[0]!.eventKind);
  const newer = recordActivity(older, 'item/started', item(BASE + 1000), BASE + 10_000)!;
  assert.equal(newer[0]!.activityAtMs, BASE + 1000);
  assert.equal(newer[0]!.observedAtMs, BASE + 10_000);
});

test('updates do not mutate inputs or return shared mutable row arrays', () => {
  const rows = seed(), snapshot = JSON.stringify(rows);
  Object.freeze(rows[0]!.seenEventIds); Object.freeze(rows[0]); Object.freeze(rows);
  const next = recordActivity(rows, 'turn/started', turn(BASE, 'thread-2'), BASE)!;
  assert.equal(JSON.stringify(rows), snapshot);
  const previous = next.find(row => row.threadId === 'thread-1')!;
  assert.notEqual(previous, rows[0]);
  assert.notEqual(previous.seenEventIds, rows[0]!.seenEventIds);
});

test('bounded identities retain the selected latest event against out-of-order replay pressure', () => {
  let rows = seed();
  const originalId = rows[0]!.eventId;
  for (let i = 0; i < 80; i++) rows = recordActivity(rows, 'item/started', item(BASE - 1000, 'thread-1', 'turn-1', `item-${i}`), BASE + 10_000)!;
  assert.equal(rows[0]!.seenEventIds.length, MAX_ACTIVITY_EVENTS_PER_THREAD);
  assert.ok(rows[0]!.seenEventIds.includes(originalId));
  assert.equal(recordActivity(rows, 'turn/started', turn(BASE + 1000), BASE + 20_000), undefined);
  assert.equal(rows[0]!.observedAtMs, BASE + 2000);
  validateActivityRecords(rows);
});

test('bounded thread retention uses producer time with stable thread-ID ties', () => {
  let rows: ActivityRecord[] | undefined;
  for (let i = 0; i < MAX_ACTIVITY_THREADS + 5; i++) rows = recordActivity(rows, 'turn/started', turn(BASE + i * 1000, `thread-${i}`), BASE + 1_000_000)!;
  assert.equal(rows!.length, MAX_ACTIVITY_THREADS);
  assert.equal(rows![0]!.threadId, 'thread-504');
  assert.equal(rows!.at(-1)!.threadId, 'thread-5');
  assert.equal(recordActivity(rows, 'turn/started', turn(BASE, 'older-thread'), BASE + 1_000_000), undefined);
  const tied = recordActivity(recordActivity(undefined, 'turn/started', turn(BASE, 'z'), BASE), 'turn/started', turn(BASE, 'a'), BASE)!;
  assert.deepEqual(tied.map(row => row.threadId), ['a', 'z']);
});

test('malformed persisted evidence fails closed rather than being copied or silently trusted', () => {
  const row = seed()[0]!;
  const malformed: unknown[] = [null, {}, 'rows', [null], [row, row], Array(MAX_ACTIVITY_THREADS + 1).fill(row)];
  for (const patch of [
    { extraPayload: 'must not survive' }, { threadId: '../bad' }, { threadId: 'sk-proj-' + 'x'.repeat(24) }, { activityAtMs: 0 },
    { activityAtMs: BASE + 400_000 }, { observedAtMs: NaN }, { eventKind: 'thread/read' },
    { eventId: 'not-a-hash' }, { eventId: row.eventId + '\n' }, { seenEventIds: [] }, { seenEventIds: [row.eventId, row.eventId] },
    { seenEventIds: [row.eventId, ,] },
    { seenEventIds: ['a'.repeat(64)] }, { seenEventIds: [row.eventId, 7] },
  ]) malformed.push([{ ...row, ...patch }]);
  for (const value of malformed) {
    assert.throws(() => validateActivityRecords(value), /INVALID_ACTIVITY_STATE/);
    assert.throws(() => recordActivity(value as any, 'turn/started', turn(), BASE), /INVALID_ACTIVITY_STATE/);
  }
  validateActivityRecords(undefined);
  validateActivityRecords([]);
  validateActivityRecords(seed());
});


test('unsupported high-rate notifications never inspect or clone activity rows',()=>{const rows=new Proxy([] as ActivityRecord[],{get(){throw Error('ledger accessed');}});assert.equal(recordActivity(rows,'item/agentMessage/delta',{threadId:'thread-1'},BASE),undefined);});
