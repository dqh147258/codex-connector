import { createHash, randomUUID } from 'node:crypto';
import type { Backend, Delivery, Source, State } from './types.js';

/** Observation only. This is deliberately separate from control/approval bindings. */
export interface Subscription {
  id: string;
  threadId: string;
  cwd: string;
  project?: string;
  owner: Source;
  enabled: boolean;
  createdAt: string;
  policy: string;
  status: 'joining' | 'active' | 'disabled' | 'error';
  error?: string;
  seen: string[];
}
type SubscriptionState = State & { subscriptions?: Subscription[] };
type SubscriptionDelivery = Delivery & { subscriptionId?: string };
interface SubscriptionStore {
  readonly state: Readonly<SubscriptionState>;
  transaction<T>(change: (state: SubscriptionState) => T): T;
}
export interface SubscriptionHooks {
  /** Recheck the current authenticated actor and canonical session scope. No direct-input requirement. */
  validate(thread: any, owner: Source): { cwd: string; project?: string };
  /** Stable fingerprint of relevant local actor, channel, project and session policy. */
  policy(): string;
  /** Recheck actor, destination and canonical stored scope immediately before routing/delivery. */
  allow(subscription: Subscription): boolean;
  /** Append deliveries synchronously in this transaction; tag every one with subscriptionId. */
  output(state: State, text: string, subscription: Subscription): void;
}
function subscriptionPolicyError(error:unknown,fallback:string):string{
  if(error instanceof SubscriptionError)return error.code;
  const code=(error as {code?:unknown}|undefined)?.code;
  return code==='SUBAGENT_THREAD_NOT_SUPPORTED'||code==='NATIVE_THREAD_ROOT_UNVERIFIED'?code:fallback;
}
export class SubscriptionError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'SubscriptionError'; }
}
const MAX_SUBSCRIPTIONS = 100;
const MAX_SEEN = 500;
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const validTimestamp = (value: unknown): value is string => typeof value === 'string' && /^\d{1,20}\.\d{1,10}$/.test(value);
const sameOwner = (a: Source, b: Source) => a.kind === b.kind && a.userId === b.userId && a.channel === b.channel && a.threadTs === b.threadTs;
const keyFor = (threadId: string, owner: Source) => JSON.stringify([threadId, owner.kind, owner.userId, owner.channel, owner.threadTs]);
const fail = (code: string): never => { throw new SubscriptionError(code); };

export class SessionSubscriptions {
  private creating = new Map<string, Promise<Subscription>>();
  private restoring = new Map<string, Promise<void>>();
  private joining = new Map<string, Promise<void>>();
  private joined = new Map<string, string>();
  private validatedJoiningEpoch = new Map<string, string>();
  private reconnecting?: Promise<void>;
  constructor(private readonly store: SubscriptionStore, private readonly backend: Backend, private readonly hooks: SubscriptionHooks) {
    const events = store.state.subscriptionEvents;
    if (events !== undefined && (!events || typeof events !== 'object' || Array.isArray(events) ||
      Object.entries(events).some(([key, ids]) => !/^[a-f0-9]{64}$/.test(key) || !Array.isArray(ids) ||
        ids.length > MAX_SUBSCRIPTIONS || ids.some(id => !validId(id)) || new Set(ids).size !== ids.length))) fail('SUBSCRIPTION_STATE_INVALID');
    const rows = store.state.subscriptions;
    // Persisted disabled rows are tombstones: never evict them and revive legacy output silently.
    if (rows !== undefined && (!Array.isArray(rows) || rows.length > MAX_SUBSCRIPTIONS || rows.some(s =>
      !s || !validId(s.id) || !validId(s.threadId) || typeof s.cwd !== 'string' || !s.cwd ||
      !s.owner || !['human', 'bot'].includes(s.owner.kind) || !validId(s.owner.userId) || !validId(s.owner.channel) ||
      !validTimestamp(s.owner.threadTs) || typeof s.enabled !== 'boolean' || typeof s.createdAt !== 'string' ||
      typeof s.policy !== 'string' || !['joining', 'active', 'disabled', 'error'].includes(s.status) ||
      !Array.isArray(s.seen) || s.seen.length > MAX_SEEN || s.seen.some(k => typeof k !== 'string' || !/^[a-f0-9]{64}$/.test(k))) ||
      new Set(rows.map(s => s.id)).size !== rows.length)) fail('SUBSCRIPTION_STATE_INVALID');
  }

  private source(source: Source) {
    if (!source || !['human', 'bot'].includes(source.kind) || !validId(source.userId) || !validId(source.channel) || !validTimestamp(source.threadTs)) {
      fail('SUBSCRIPTION_SLACK_THREAD_REQUIRED');
    }
  }
  private allowed(subscription: Subscription) {
    try { return subscription.enabled && subscription.policy === this.hooks.policy() && this.hooks.allow(subscription); }
    catch { return false; }
  }
  allow(subscription: Subscription) { return this.allowed(subscription); }
  private connectionReady(id: string) {
    return this.backend.connected &&
      (this.joined.get(id) === this.backend.epoch || this.validatedJoiningEpoch.get(id) === this.backend.epoch);
  }
  eventAllowed(id: string) {
    const subscription = this.store.state.subscriptions?.find(s => s.id === id);
    return !!subscription && this.allowed(subscription) && this.connectionReady(id);
  }
  deliveryAllowed(id: string) {
    const subscription = this.store.state.subscriptions?.find(s => s.id === id);
    return !!subscription && this.allowed(subscription) && this.backend.connected && this.joined.get(id) === this.backend.epoch;
  }
  /** Keep queued output pending while a fresh observation join is still unverified. */
  deliveryWaiting(id: string) {
    const subscription = this.store.state.subscriptions?.find(s => s.id === id);
    return !!subscription && this.allowed(subscription) &&
      (!this.backend.connected || this.joined.get(id) !== this.backend.epoch);
  }
  hasExplicitDestination(threadId: string, channel: string, threadTs: string) {
    return !!this.store.state.subscriptions?.some(s => s.threadId === threadId && s.owner.channel === channel && s.owner.threadTs === threadTs);
  }
  list(source: Source) {
    this.source(source);
    return (this.store.state.subscriptions || []).filter(s => sameOwner(s.owner, source));
  }

  create(threadId: string, source: Source): Promise<Subscription> {
    this.source(source);
    if (!validId(threadId)) return Promise.reject(new SubscriptionError('SUBSCRIPTION_THREAD_INVALID'));
    const key = keyFor(threadId, source), pending = this.creating.get(key);
    if (pending) return pending;
    const operation = this.createOne(threadId, structuredClone(source)).finally(() => this.creating.delete(key));
    this.creating.set(key, operation);
    return operation;
  }
  /**
   * Called only from a positively acknowledged thread/start under durable
   * local consent. A metadata read verifies the identity, not its birth.
   * A supported warm observation join on this exact acknowledged thread then
   * asks the server to replay any request still pending (possibly post-ACK).
   */
  async adoptCreated(thread:any,source:Source,epoch:string,record:(state:State,sub:Subscription)=>void):Promise<Subscription>{
    this.source(source);
    if(!validId(thread?.id)||!this.backend.connected||this.backend.epoch!==epoch)fail('SUBSCRIPTION_BACKEND_CHANGED');
    const metadata=this.hooks.validate(thread,source),policy=this.hooks.policy();
    const sub:Subscription={id:randomUUID(),threadId:thread.id,...metadata,owner:structuredClone(source),enabled:true,createdAt:new Date().toISOString(),policy,status:'joining',seen:[]};
    if(!this.allowed(sub))fail('SUBSCRIPTION_SCOPE_REVOKED');
    this.store.transaction(state=>{
      const rows=state.subscriptions??=[];
      if(rows.length>=MAX_SUBSCRIPTIONS)fail('SUBSCRIPTION_LIMIT_REACHED');
      if(rows.some(s=>s.threadId===sub.threadId)||state.sessions.some(s=>s.threadId===sub.threadId))fail('SUBSCRIPTION_THREAD_INVALID');
      rows.push(sub);record(state,sub);
    });
    // The fresh identity is durable before yielding. Safe live request
    // candidates may arrive during this metadata read; no delivery can yet.
    const response=await this.backend.rpc('thread/read',{threadId:sub.threadId,includeTurns:false});
    const current=this.store.state.subscriptions?.find(s=>s.id===sub.id);
    if(!current?.enabled||!this.allowed(current)||!this.backend.connected||this.backend.epoch!==epoch)fail('SUBSCRIPTION_BACKEND_CHANGED');
    if(response?.thread?.id!==sub.threadId||response.thread.sessionId!==thread.sessionId||this.hooks.validate(response.thread,current!.owner).cwd!==current!.cwd) {
      this.disable(sub.id,'SUBSCRIPTION_SCOPE_REVOKED');fail('SUBSCRIPTION_SCOPE_REVOKED');
    }
    // The original thread/start listener can emit before its positive
    // acknowledgement. Do not capture arbitrary unknown-thread events.
    // Official warm resume replays callbacks for only this exact newly
    // proven thread, after its response; it does not submit/start a turn.
    await this.join(sub.id,epoch);
    return this.store.state.subscriptions!.find(s=>s.id===sub.id)!;
  }
  private async createOne(threadId: string, owner: Source) {
    const previous = this.store.state.subscriptions?.find(s => s.enabled && s.threadId === threadId && sameOwner(s.owner, owner));
    if (previous) {
      if (!this.allowed(previous)) { this.disable(previous.id, 'SUBSCRIPTION_SCOPE_REVOKED'); fail('SUBSCRIPTION_SCOPE_REVOKED'); }
      await this.restore(previous.id);
      return this.store.state.subscriptions!.find(s => s.id === previous.id)!;
    }
    if ((this.store.state.subscriptions?.length || 0) >= MAX_SUBSCRIPTIONS) fail('SUBSCRIPTION_LIMIT_REACHED');
    const epoch = this.backend.epoch, policy = this.hooks.policy();
    await this.confirmLoaded(threadId);
    const metadata = await this.metadata(threadId, owner);
    if (epoch !== this.backend.epoch || !this.backend.connected) fail('SUBSCRIPTION_BACKEND_CHANGED');
    if (policy !== this.hooks.policy()) fail('SUBSCRIPTION_SCOPE_REVOKED');
    const subscription: Subscription = { id: randomUUID(), threadId, ...metadata, owner, enabled: true, createdAt: new Date().toISOString(), policy, status: 'joining', seen: [] };
    if (!this.allowed(subscription)) fail('SUBSCRIPTION_SCOPE_REVOKED');
    this.store.transaction(state => {
      const rows = state.subscriptions ||= [];
      if (rows.length >= MAX_SUBSCRIPTIONS) fail('SUBSCRIPTION_LIMIT_REACHED');
      rows.push(subscription);
    });
    // Persist before joining: the server may replay notifications while resume is pending.
    await this.join(subscription.id, epoch);
    return this.store.state.subscriptions!.find(s => s.id === subscription.id)!;
  }

  private async confirmLoaded(threadId: string) {
    let cursor: string | undefined;
    const cursors = new Set<string>();
    let scanned = 0;
    for (let page = 0; page < 20 && scanned < 1000; page++) {
      let response: any;
      try { response = await this.backend.rpc('thread/loaded/list', { limit: Math.min(100, 1000 - scanned), ...(cursor ? { cursor } : {}) }); }
      catch { return fail('SUBSCRIPTION_NOT_CONFIRMED_LOADED'); }
      if (!response || !Array.isArray(response.data) || response.data.length > Math.min(100, 1000 - scanned) || response.data.some((id: unknown) => !validId(id))) {
        fail('SUBSCRIPTION_NOT_CONFIRMED_LOADED');
      }
      const next = response.nextCursor;
      if (next !== undefined && next !== null && (typeof next !== 'string' || !next || next.length > 512 || /[\x00-\x1f]/.test(next) || cursors.has(next))) {
        fail('SUBSCRIPTION_NOT_CONFIRMED_LOADED');
      }
      scanned += response.data.length;
      if (response.data.includes(threadId)) return;
      if (next === undefined || next === null) break;
      cursors.add(next); cursor = next;
    }
    fail('SUBSCRIPTION_NOT_CONFIRMED_LOADED');
  }
  private async metadata(threadId: string, owner: Source) {
    let response: any;
    try { response = await this.backend.rpc('thread/read', { threadId, includeTurns: false }); }
    catch { return fail('SUBSCRIPTION_METADATA_UNAVAILABLE'); }
    if (!response?.thread || response.thread.id !== threadId) fail('SUBSCRIPTION_METADATA_UNAVAILABLE');
    try {
      const scope = this.hooks.validate(response.thread, owner);
      if (!scope || typeof scope.cwd !== 'string' || !scope.cwd) fail('SUBSCRIPTION_SCOPE_REVOKED');
      return scope;
    } catch (error) { return fail(subscriptionPolicyError(error,'SUBSCRIPTION_SCOPE_REVOKED')); }
  }
  private join(id: string, epoch: string): Promise<void> {
    const pending = this.joining.get(id);
    if (pending) return pending;
    const operation = this.joinOne(id, epoch).finally(() => {
      this.joining.delete(id); this.validatedJoiningEpoch.delete(id);
    });
    this.joining.set(id, operation);
    return operation;
  }
  private async joinOne(id: string, epoch: string) {
    const row = this.store.state.subscriptions?.find(s => s.id === id);
    if (!row?.enabled) return;
    if (!this.allowed(row)) { this.disable(id, 'SUBSCRIPTION_SCOPE_REVOKED'); fail('SUBSCRIPTION_SCOPE_REVOKED'); }
    if (epoch !== this.backend.epoch || !this.backend.connected) { this.disable(id, 'SUBSCRIPTION_BACKEND_CHANGED'); fail('SUBSCRIPTION_BACKEND_CHANGED'); }
    try {
      // Callers have just confirmed loaded state and fresh metadata in this epoch.
      // Replay may enqueue during resume. Delivery waits for the returned metadata validation.
      this.validatedJoiningEpoch.set(id, epoch);
      // This is the supported observation join. Never start/steer/interrupt a turn or unload a thread.
      const response = await this.backend.rpc('thread/resume', { threadId: row.threadId, excludeTurns: true });
      if (epoch !== this.backend.epoch || !this.backend.connected) fail('SUBSCRIPTION_BACKEND_CHANGED');
      if (!response?.thread || response.thread.id !== row.threadId) fail('SUBSCRIPTION_METADATA_UNAVAILABLE');
      const scope = this.hooks.validate(response.thread, row.owner);
      if (scope.cwd !== row.cwd || !this.allowed(row)) fail('SUBSCRIPTION_SCOPE_REVOKED');
      this.store.transaction(state => {
        const current = state.subscriptions?.find(s => s.id === id);
        if (current?.enabled) { current.status = 'active'; delete current.error; }
      });
      if (this.store.state.subscriptions?.find(s => s.id === id)?.enabled) this.joined.set(id, epoch);
      else this.joined.delete(id);

    } catch (error) {
      const code = subscriptionPolicyError(error,'SUBSCRIPTION_JOIN_FAILED');
      this.disable(id, code); throw new SubscriptionError(code);
    }
  }

  private disableIn(state: SubscriptionState, id: string, error?: string) {
    const row = state.subscriptions?.find(s => s.id === id);
    if (!row) return;
    row.enabled = false; row.status = error ? 'error' : 'disabled';
    this.joined.delete(id); this.validatedJoiningEpoch.delete(id);
    for (const [key, ids] of Object.entries(state.subscriptionEvents || {})) state.subscriptionEvents![key] = ids.filter(candidate => candidate !== id);
    if (error) row.error = error; else delete row.error;
    for (const delivery of state.outbox as SubscriptionDelivery[]) if (delivery.subscriptionId === id && delivery.status === 'queued') {
      delivery.status = 'failed'; delivery.error = error || 'SUBSCRIPTION_CANCELLED';
    }
  }
  private disable(id: string, error: string) {
    this.store.transaction(state => {
      // Do not change an explicit cancellation into an error after an in-flight RPC settles.
      if (state.subscriptions?.find(s => s.id === id)?.enabled) this.disableIn(state, id, error);
    });
  }
  cancel(id: string, source: Source) {
    this.source(source);
    const subscription = this.store.state.subscriptions?.find(s => s.id === id && sameOwner(s.owner, source));
    if (!subscription) fail('SUBSCRIPTION_NOT_FOUND');
    return this.store.transaction(state => {
      const inFlight = (state.outbox as SubscriptionDelivery[]).some(o => o.subscriptionId === id && ['sending', 'uncertain'].includes(o.status));
      this.disableIn(state, id);
      return { subscriptionId: id, enabled: false, inFlightMayStillArrive: inFlight };
    });
  }

  /** Called after backend reconnect. Revalidate loaded state and metadata, never silently reactivate. */
  rejoin(): Promise<void> {
    if (this.reconnecting) return this.reconnecting;
    this.reconnecting = this.rejoinAll().finally(() => { this.reconnecting = undefined; });
    return this.reconnecting;
  }
  private restore(id: string): Promise<void> {
    const pending = this.restoring.get(id);
    if (pending) return pending;
    const operation = this.restoreOne(id).finally(() => this.restoring.delete(id));
    this.restoring.set(id, operation);
    return operation;
  }
  private async restoreOne(id: string) {
    const row = this.store.state.subscriptions?.find(s => s.id === id);
    if (!row?.enabled) return;
    try {
      if (!this.allowed(row)) fail('SUBSCRIPTION_SCOPE_REVOKED');
      if (this.backend.connected && this.joined.get(id) === this.backend.epoch) return;
      const epoch = this.backend.epoch;
      await this.confirmLoaded(row.threadId);
      const scope = await this.metadata(row.threadId, row.owner);
      if (scope.cwd !== row.cwd) fail('SUBSCRIPTION_SCOPE_REVOKED');
      const current = this.store.state.subscriptions?.find(s => s.id === id);
      if (!current?.enabled) return;
      this.store.transaction(state => { const s = state.subscriptions!.find(s => s.id === id)!; if (s.enabled) s.status = 'joining'; });
      await this.join(id, epoch);
    } catch (error) {
      const code = subscriptionPolicyError(error,'SUBSCRIPTION_JOIN_FAILED');
      this.disable(id, code); throw new SubscriptionError(code);
    }
  }
  private async rejoinAll() {
    for (const row of this.store.state.subscriptions || []) {
      if (!row.enabled) continue;
      try { await this.restore(row.id); } catch { /* Persisted error remains visible; do not revive. */ }
    }
  }

  /** Transactional per-event recipient ledger. Capture only subscriptions present on first
   * observation; a replay may fill a still-unjoined recipient, never backfill a new one.
   * Empty entries are durable tombstones, just like the parent's global replay guard.
   * No content is buffered before fresh scope validation. */
  emit(state: State, text: string, threadId: string, eventKey: string, predicate?: (subscription: Subscription) => boolean, output = this.hooks.output) {
    if (!eventKey) fail('SUBSCRIPTION_EVENT_KEY_REQUIRED');
    const key = createHash('sha256').update(eventKey).digest('hex');
    const events = state.subscriptionEvents ||= {};
    if (!Object.hasOwn(events, key)) {
      // Pre-upgrade events have only the global guard. Preserve its no-backfill behavior.
      events[key] = Object.hasOwn(state.seenNotifications, eventKey) ? [] :
        (state.subscriptions || []).filter(row => row.threadId === threadId && this.allowed(row)).map(row => row.id);
    }
    let routed = 0;
    for (const row of (state as SubscriptionState).subscriptions || []) {
      if (row.threadId !== threadId || !row.enabled) continue;
      if (!this.allowed(row)) { this.disableIn(state, row.id, 'SUBSCRIPTION_SCOPE_REVOKED'); continue; }
      if (!events[key]!.includes(row.id) || !this.connectionReady(row.id)) continue;
      if (predicate && !predicate(row)) continue;
      if (row.seen.includes(key)) { events[key] = events[key]!.filter(id => id !== row.id); continue; }
      output(state, text, structuredClone(row));
      events[key] = events[key]!.filter(id => id !== row.id);
      row.seen.push(key); row.seen = row.seen.slice(-MAX_SEEN); routed++;
    }
    return routed;
  }
}
