import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SessionSubscriptions, type Subscription, type SubscriptionHooks } from '../src/subscriptions.js';
import type { Backend, Delivery, Source, State } from '../src/types.js';

type TestState = State & { subscriptions?: Subscription[] };
type TaggedDelivery = Delivery & { subscriptionId?: string };
class MemoryStore {
  value: TestState = { version: 2, sessions: [], work: [], outbox: [], pending: [], seenEvents: {}, seenNotifications: {} };
  get state() { return structuredClone(this.value); }
  transaction<T>(change: (draft: TestState) => T) { const draft = this.state; const value = change(draft); this.value = structuredClone(draft); return value; }
}
class ObservationBackend extends EventEmitter implements Backend {
  epoch = 'epoch-1'; connected = true;
  calls: { method: string; params: any }[] = [];
  loaded = ['thread-1']; thread: any = { id: 'thread-1', cwd: '/repo', canAcceptDirectInput: false };
  readFailure = false; resumeFailure = false;
  resumeHook?: () => void | Promise<void>;
  listHook?: (params: any) => any;
  async connect() { this.connected = true; }
  async close() { this.connected = false; }
  capabilities() { return {}; }
  async respond() { throw Error('Tests must never send an approval response'); }
  async rpc(method: string, params: any) {
    this.calls.push({ method, params });
    if (method === 'thread/loaded/list') return this.listHook ? this.listHook(params) : { data: this.loaded, nextCursor: null };
    if (method === 'thread/read') { if (this.readFailure) throw Error('secret raw backend error'); return { thread: this.thread }; }
    if (method === 'thread/resume') { await this.resumeHook?.(); if (this.resumeFailure) throw Error('secret raw backend error'); return { thread: this.thread }; }
    throw Error(`Forbidden backend mutation: ${method}`);
  }
}
const source = (overrides: Partial<Source> = {}): Source => ({ kind: 'bot', userId: 'UBOT', channel: 'CIN', threadTs: '123.45', ts: '123.46', eventId: 'event-1', ...overrides });
function setup() {
  const store = new MemoryStore(), backend = new ObservationBackend();
  const policy = { fingerprint: 'policy-1', authorized: true, cwd: '/repo' };
  const hooks: SubscriptionHooks = {
    policy: () => policy.fingerprint,
    validate(thread, owner) { if (!policy.authorized || thread.cwd !== policy.cwd || owner.userId === 'UREVOKED') throw Error('scope'); return { cwd: thread.cwd, project: 'repo' }; },
    allow: row => policy.authorized && row.cwd === policy.cwd && row.owner.userId !== 'UREVOKED',
    output(state, text, subscription) {
      const delivery: TaggedDelivery = { id: `delivery-${state.outbox.length}`, subscriptionId: subscription.id, origin: subscription.owner, channel: subscription.owner.channel, threadTs: subscription.owner.threadTs, root: false, text, status: 'queued', attempts: 0, nextAttemptAt: 0 };
      state.outbox.push(delivery);
    }
  };
  const subscriptions = new SessionSubscriptions(store, backend, hooks);
  return { store, backend, policy, hooks, subscriptions };
}
const resumes = (backend: ObservationBackend) => backend.calls.filter(c => c.method === 'thread/resume');

test('loaded-only subscription persists destination before observation join, without a control binding or turn', async () => {
  const f = setup();
  f.backend.resumeHook = () => {
    const row = f.store.state.subscriptions![0]!;
    assert.equal(row.enabled, true); assert.equal(row.status, 'joining');
    assert.equal(f.subscriptions.deliveryAllowed(row.id), false);
    assert.equal(f.subscriptions.deliveryWaiting(row.id), true);
    f.store.transaction(s => f.subscriptions.emit(s, 'checkpoint during join', 'thread-1', 'event-1'));
  };
  const row = await f.subscriptions.create('thread-1', source());
  assert.match(row.id, /^[a-f\d-]{36}$/); assert.equal(row.status, 'active');
  assert.equal(row.cwd, '/repo'); assert.equal(row.owner.threadTs, '123.45');
  assert.equal(f.store.state.outbox[0]!.text, 'checkpoint during join');
  assert.deepEqual(f.backend.calls, [
    { method: 'thread/loaded/list', params: { limit: 100 } },
    { method: 'thread/read', params: { threadId: 'thread-1', includeTurns: false } },
    { method: 'thread/resume', params: { threadId: 'thread-1', excludeTurns: true } }
  ]);
  assert.deepEqual(f.store.state.sessions, []); assert.deepEqual(f.store.state.pending, []);
});

test('duplicate enabled subscription is idempotent, including concurrent requests, and no redundant join occurs', async () => {
  const f = setup();
  const [a, b] = await Promise.all([f.subscriptions.create('thread-1', source()), f.subscriptions.create('thread-1', source({ eventId: 'other' }))]);
  const c = await f.subscriptions.create('thread-1', source());
  assert.equal(a.id, b.id); assert.equal(b.id, c.id); assert.equal(resumes(f.backend).length, 1);
  assert.equal(f.store.state.subscriptions!.length, 1);
});

test('reject local origin, missing exact thread, revoked actor and denied scope', async () => {
  const f = setup();
  assert.throws(() => f.subscriptions.create('thread-1', source({ kind: 'local' })), /SUBSCRIPTION_SLACK_THREAD_REQUIRED/);
  assert.throws(() => f.subscriptions.create('thread-1', source({ threadTs: '' })), /SUBSCRIPTION_SLACK_THREAD_REQUIRED/);
  assert.equal(f.backend.calls.length, 0);
  await assert.rejects(f.subscriptions.create('thread-1', source({ userId: 'UREVOKED' })), /SUBSCRIPTION_SCOPE_REVOKED/);
  f.backend.thread.cwd = '/outside';
  await assert.rejects(f.subscriptions.create('thread-1', source()), /SUBSCRIPTION_SCOPE_REVOKED/);
  assert.equal(resumes(f.backend).length, 0); assert.equal(f.store.state.subscriptions, undefined);
});

test('cold, unconfirmed and malformed loaded listings never join or preload content', async () => {
  for (const response of [{ data: [], nextCursor: null }, { data: [{ id: 'thread-1' }], nextCursor: null }, { data: ['thread-1'], nextCursor: 4 }, {}]) {
    const f = setup(); f.backend.listHook = () => response;
    await assert.rejects(f.subscriptions.create('thread-1', source()), /SUBSCRIPTION_NOT_CONFIRMED_LOADED/);
    assert.ok(f.backend.calls.every(c => c.method === 'thread/loaded/list'));
    assert.equal(f.store.state.subscriptions, undefined);
  }
});

test('loaded discovery follows cursors, detects loops, and enforces both scan bounds', async () => {
  const f = setup();
  f.backend.listHook = p => p.cursor ? { data: ['thread-1'], nextCursor: null } : { data: ['other'], nextCursor: 'next' };
  await f.subscriptions.create('thread-1', source());
  assert.deepEqual(f.backend.calls[1], { method: 'thread/loaded/list', params: { limit: 100, cursor: 'next' } });
  for (const mode of ['loop', 'pages', 'ids']) {
    const g = setup(); let pages = 0;
    g.backend.listHook = () => ({ data: mode === 'ids' ? Array.from({ length: 100 }, (_, i) => `other-${i}`) : [], nextCursor: mode === 'loop' ? 'same' : `cursor-${++pages}` });
    await assert.rejects(g.subscriptions.create('thread-1', source()), /SUBSCRIPTION_NOT_CONFIRMED_LOADED/);
    assert.equal(g.backend.calls.length, mode === 'loop' ? 2 : mode === 'pages' ? 20 : 10);
    assert.equal(resumes(g.backend).length, 0);
  }
});

test('missing and mismatched metadata fail closed without persisting or leaking raw errors', async () => {
  const f = setup(); f.backend.readFailure = true;
  await assert.rejects(f.subscriptions.create('thread-1', source()), /^SubscriptionError: SUBSCRIPTION_METADATA_UNAVAILABLE$/);
  f.backend.readFailure = false; f.backend.thread.id = 'wrong';
  await assert.rejects(f.subscriptions.create('thread-1', source()), /SUBSCRIPTION_METADATA_UNAVAILABLE/);
  assert.equal(f.store.state.subscriptions, undefined); assert.equal(resumes(f.backend).length, 0);
});

test('join failure disables persisted route and cancels replay queued while joining', async () => {
  const f = setup(); f.backend.resumeFailure = true;
  f.backend.resumeHook = () => { f.store.transaction(s => f.subscriptions.emit(s, 'replayed', 'thread-1', 'key')); };
  await assert.rejects(f.subscriptions.create('thread-1', source()), /^SubscriptionError: SUBSCRIPTION_JOIN_FAILED$/);
  const row = f.store.state.subscriptions![0]!;
  assert.equal(row.enabled, false); assert.equal(row.status, 'error'); assert.equal(row.error, 'SUBSCRIPTION_JOIN_FAILED');
  assert.equal(f.store.state.outbox[0]!.status, 'failed'); assert.equal(f.subscriptions.deliveryAllowed(row.id), false);
  await f.subscriptions.rejoin(); assert.equal(resumes(f.backend).length, 1);
});

test('list/cancel require exact principal kind, user and invoking Slack destination', async () => {
  const f = setup(), row = await f.subscriptions.create('thread-1', source());
  for (const overrides of [{ kind: 'human' as const }, { userId: 'UOTHER' }, { channel: 'COUT' }, { threadTs: '123.99' }]) {
    const stranger = source(overrides);
    assert.deepEqual(f.subscriptions.list(stranger), []);
    assert.throws(() => f.subscriptions.cancel(row.id, stranger), /SUBSCRIPTION_NOT_FOUND/);
  }
  assert.equal(f.subscriptions.list(source()).length, 1); assert.equal(f.subscriptions.deliveryAllowed(row.id), true);
  const before = f.backend.calls.length;
  assert.deepEqual(f.subscriptions.cancel(row.id, source()), { subscriptionId: row.id, enabled: false, inFlightMayStillArrive: false });
  assert.equal(f.backend.calls.length, before); assert.equal(f.subscriptions.list(source())[0]!.enabled, false);
});

test('cancellation removes unsent deliveries only, warns for in-flight, and suppresses legacy fallback', async () => {
  const f = setup(), row = await f.subscriptions.create('thread-1', source());
  f.store.transaction(s => {
    for (const key of ['queued', 'sending', 'sent', 'uncertain']) f.subscriptions.emit(s, key, row.threadId, key);
    s.outbox[1]!.status = 'sending'; s.outbox[2]!.status = 'sent'; s.outbox[3]!.status = 'uncertain';
  });
  assert.equal(f.subscriptions.cancel(row.id, source()).inFlightMayStillArrive, true);
  assert.deepEqual(f.store.state.outbox.map(o => o.status), ['failed', 'sending', 'sent', 'uncertain']);
  assert.equal(f.subscriptions.hasExplicitDestination(row.threadId, 'CIN', '123.45'), true);
  assert.equal(f.subscriptions.hasExplicitDestination(row.threadId, 'CIN', '123.99'), false);
  assert.equal(f.subscriptions.deliveryAllowed(row.id), false);
  f.store.transaction(s => assert.equal(f.subscriptions.emit(s, 'later', row.threadId, 'later'), 0));
});

test('cancel during join remains disabled when RPC completes', async () => {
  const f = setup();
  f.backend.resumeHook = () => { f.subscriptions.cancel(f.store.state.subscriptions![0]!.id, source()); };
  const row = await f.subscriptions.create('thread-1', source());
  assert.equal(row.enabled, false); assert.equal(row.status, 'disabled');
  await f.subscriptions.rejoin(); assert.equal(resumes(f.backend).length, 1);
});

test('explicit new subscribe after cancellation creates a distinct route without reactivating old delivery authority', async () => {
  const f = setup(), before = await f.subscriptions.create('thread-1', source());
  f.subscriptions.cancel(before.id, source());
  const after = await f.subscriptions.create('thread-1', source());
  assert.notEqual(after.id, before.id); assert.equal(f.subscriptions.deliveryAllowed(before.id), false);
  assert.equal(f.subscriptions.deliveryAllowed(after.id), true); assert.equal(resumes(f.backend).length, 2);
});

test('event fanout is independently deduplicated per exact owner/destination across restarts', async () => {
  const f = setup();
  const a = await f.subscriptions.create('thread-1', source()), b = await f.subscriptions.create('thread-1', source({ userId: 'UOTHER', threadTs: '456.78' }));
  f.store.transaction(s => assert.equal(f.subscriptions.emit(s, 'checkpoint', 'thread-1', 'item-1'), 2));
  const restarted = new SessionSubscriptions(f.store, f.backend, f.hooks);
  await restarted.rejoin();
  f.store.transaction(s => assert.equal(restarted.emit(s, 'duplicate', 'thread-1', 'item-1'), 0));
  assert.deepEqual((f.store.state.outbox as TaggedDelivery[]).map(o => o.subscriptionId), [a.id, b.id]);
  assert.deepEqual(f.store.state.outbox.map(o => o.threadTs), ['123.45', '456.78']);
  f.subscriptions.cancel(a.id, source());
  f.store.transaction(s => assert.equal(restarted.emit(s, 'next', 'thread-1', 'item-2'), 1));
  assert.equal(f.store.state.outbox.at(-1)!.threadTs, '456.78');
});

test('runtime policy/scope revocation blocks delivery, disables routes, cancels queued output, and does not reactivate', async () => {
  for (const change of ['policy', 'actor', 'scope']) {
    const f = setup(), row = await f.subscriptions.create('thread-1', source());
    f.store.transaction(s => f.subscriptions.emit(s, 'queued', 'thread-1', 'before'));
    if (change === 'policy') f.policy.fingerprint = 'policy-2';
    else if (change === 'actor') f.policy.authorized = false;
    else f.policy.cwd = '/elsewhere';
    assert.equal(f.subscriptions.deliveryAllowed(row.id), false);
    f.store.transaction(s => assert.equal(f.subscriptions.emit(s, 'blocked', 'thread-1', 'after'), 0));
    assert.equal(f.store.state.subscriptions![0]!.error, 'SUBSCRIPTION_SCOPE_REVOKED');
    assert.equal(f.store.state.outbox[0]!.status, 'failed');
    f.policy.fingerprint = 'policy-1'; f.policy.authorized = true; f.policy.cwd = '/repo';
    await f.subscriptions.rejoin(); assert.equal(resumes(f.backend).length, 1);
  }
});

test('reconnect rejoins only enabled loaded subscriptions with matching fresh metadata', async () => {
  const f = setup(), row = await f.subscriptions.create('thread-1', source());
  f.backend.epoch = 'epoch-2';
  const restarted = new SessionSubscriptions(f.store, f.backend, f.hooks);
  await restarted.rejoin();
  assert.equal(resumes(f.backend).length, 2); assert.equal(f.store.state.subscriptions![0]!.enabled, true);
  f.backend.epoch = 'epoch-3'; f.backend.loaded = []; await restarted.rejoin();
  assert.equal(resumes(f.backend).length, 2); assert.equal(f.store.state.subscriptions![0]!.error, 'SUBSCRIPTION_NOT_CONFIRMED_LOADED');
  f.backend.loaded = ['thread-1']; await restarted.rejoin();
  assert.equal(resumes(f.backend).length, 2); assert.equal(restarted.deliveryAllowed(row.id), false);
});

test('reconnect revalidates metadata identity, current actor and cwd before resume', async () => {
  for (const change of ['id', 'scope', 'actor', 'read']) {
    const f = setup(); await f.subscriptions.create('thread-1', source());
    if (change === 'id') f.backend.thread.id = 'other';
    else if (change === 'scope') f.backend.thread.cwd = '/outside';
    else if (change === 'actor') f.policy.authorized = false;
    else f.backend.readFailure = true;
    f.backend.epoch = 'reconnected'; await f.subscriptions.rejoin();
    assert.equal(resumes(f.backend).length, 1); assert.equal(f.store.state.subscriptions![0]!.enabled, false);
  }
});

test('backend epoch change during join fails closed and cancels any unsent messages', async () => {
  const f = setup();
  f.backend.resumeHook = () => { f.backend.epoch = 'other-epoch'; };
  await assert.rejects(f.subscriptions.create('thread-1', source()), /SUBSCRIPTION_BACKEND_CHANGED/);
  assert.equal(f.store.state.subscriptions![0]!.enabled, false);
});

test('bounded event keys preserve latest 500; parent global replay guard remains required', async () => {
  const f = setup(); await f.subscriptions.create('thread-1', source());
  f.store.transaction(s => { for (let i = 0; i < 510; i++) f.subscriptions.emit(s, 'message', 'thread-1', `event-${i}`); });
  assert.equal(f.store.state.subscriptions![0]!.seen.length, 500);
  f.store.transaction(s => assert.equal(f.subscriptions.emit(s, 'duplicate', 'thread-1', 'event-509'), 0));
});

test('capacity never evicts disabled tombstones and invalid persisted state fails closed', async () => {
  const f = setup(), original = await f.subscriptions.create('thread-1', source());
  f.store.transaction(s => { s.subscriptions = Array.from({ length: 100 }, (_, i) => ({ ...original, id: `sub-${i}`, enabled: false, status: 'disabled' })); });
  const count = f.backend.calls.length;
  await assert.rejects(f.subscriptions.create('thread-1', source()), /SUBSCRIPTION_LIMIT_REACHED/);
  assert.equal(f.backend.calls.length, count);
  assert.equal(f.subscriptions.hasExplicitDestination('thread-1', 'CIN', '123.45'), true);
  f.store.transaction(s => { s.subscriptions![0]!.owner.kind = 'local'; });
  assert.throws(() => new SessionSubscriptions(f.store, f.backend, f.hooks), /SUBSCRIPTION_STATE_INVALID/);
});


test('reconnect polling joins only once per backend epoch and coalesces concurrent calls', async () => {
  const f = setup(); await f.subscriptions.create('thread-1', source());
  const before = f.backend.calls.length;
  await f.subscriptions.rejoin(); await f.subscriptions.rejoin();
  assert.equal(f.backend.calls.length, before);
  f.backend.epoch = 'epoch-2';
  await Promise.all([f.subscriptions.rejoin(), f.subscriptions.rejoin(), f.subscriptions.rejoin()]);
  assert.equal(resumes(f.backend).length, 2);
  await f.subscriptions.rejoin(); assert.equal(resumes(f.backend).length, 2);
});

test('filtered notice routing leaves excluded destination available for exact bound approval prompt', async () => {
  const f = setup();
  const bound = await f.subscriptions.create('thread-1', source());
  await f.subscriptions.create('thread-1', source({ threadTs: '456.78' }));
  f.store.transaction(s => {
    assert.equal(f.subscriptions.emit(s, 'Decision needed; inspect the original control thread', 'thread-1', 'approval-1', row => row.owner.threadTs !== bound.owner.threadTs), 1);
    assert.equal(f.subscriptions.emit(s, 'Exact original bound approval prompt', 'thread-1', 'approval-1', row => row.owner.threadTs === bound.owner.threadTs), 1);
  });
  assert.deepEqual(f.store.state.outbox.map(o => o.threadTs), ['456.78', '123.45']);
  f.store.transaction(s => assert.equal(f.subscriptions.emit(s, 'duplicate', 'thread-1', 'approval-1'), 0));
});


test('delivery waits for connected current-epoch join success while validated reconnect replay can enqueue', async () => {
  const f = setup(), row = await f.subscriptions.create('thread-1', source());
  assert.equal(f.subscriptions.deliveryAllowed(row.id), true);
  f.backend.connected = false;
  assert.equal(f.subscriptions.deliveryAllowed(row.id), false);
  f.store.transaction(s => assert.equal(f.subscriptions.emit(s, 'disconnected', row.threadId, 'reconnect-1'), 0));
  f.backend.epoch = 'epoch-2'; f.backend.connected = true;
  assert.equal(f.subscriptions.deliveryAllowed(row.id), false);
  f.store.transaction(s => assert.equal(f.subscriptions.emit(s, 'early current epoch', row.threadId, 'reconnect-1'), 0));
  assert.equal(f.store.state.outbox.length, 0);
  const rpc = f.backend.rpc.bind(f.backend);
  f.backend.rpc = async (method, params) => {
    if (method === 'thread/loaded/list' || method === 'thread/read') assert.equal(f.subscriptions.deliveryAllowed(row.id), false);
    return rpc(method, params);
  };
  f.backend.resumeHook = () => {
    assert.equal(f.subscriptions.deliveryAllowed(row.id), false);
    assert.equal(f.subscriptions.deliveryWaiting(row.id), true);
    f.store.transaction(s => f.subscriptions.emit(s, 'validated replay', row.threadId, 'reconnect-1'));
  };
  await f.subscriptions.rejoin();
  assert.equal(f.subscriptions.deliveryAllowed(row.id), true);
  assert.equal(f.subscriptions.deliveryWaiting(row.id), false);
  assert.equal(f.store.state.outbox.at(-1)!.text, 'validated replay');
});

test('restart cannot deliver persisted enabled rows before metadata validation; failed rejoin clears temporary authority', async () => {
  const f = setup(), row = await f.subscriptions.create('thread-1', source());
  const restarted = new SessionSubscriptions(f.store, f.backend, f.hooks);
  assert.equal(restarted.deliveryAllowed(row.id), false);
  f.backend.resumeHook = () => {
    assert.equal(restarted.deliveryAllowed(row.id), false);
    assert.equal(restarted.deliveryWaiting(row.id), true);
    f.store.transaction(s => restarted.emit(s, 'replay pending success', row.threadId, 'pending'));
  };
  f.backend.resumeFailure = true;
  await restarted.rejoin();
  assert.equal(restarted.deliveryAllowed(row.id), false);
  assert.equal(restarted.deliveryWaiting(row.id), false);
  assert.equal(f.store.state.outbox[0]!.status, 'failed');
  assert.equal(f.store.state.subscriptions![0]!.enabled, false);
});


test('eventAllowed shares replay enqueue gate without granting joining delivery authority', async () => {
  const f = setup();
  f.backend.resumeHook = () => {
    const row = f.store.state.subscriptions![0]!;
    assert.equal(f.subscriptions.eventAllowed(row.id), true);
    assert.equal(f.subscriptions.deliveryAllowed(row.id), false);
  };
  const row = await f.subscriptions.create('thread-1', source());
  assert.equal(f.subscriptions.eventAllowed(row.id), true);
  f.backend.connected = false; assert.equal(f.subscriptions.eventAllowed(row.id), false);
  f.backend.epoch = 'new-epoch'; f.backend.connected = true;
  assert.equal(f.subscriptions.eventAllowed(row.id), false);
  await f.subscriptions.rejoin(); assert.equal(f.subscriptions.eventAllowed(row.id), true);
  f.policy.authorized = false; assert.equal(f.subscriptions.eventAllowed(row.id), false);
  f.policy.authorized = true; f.subscriptions.cancel(row.id, source());
  assert.equal(f.subscriptions.eventAllowed(row.id), false);
  assert.equal(f.subscriptions.eventAllowed('missing'), false);
});
