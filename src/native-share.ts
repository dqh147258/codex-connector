import { createHash, randomUUID } from 'node:crypto';
import { deliveryId, terminalExecution } from './session-delivery.js';
import type { Subscription } from './subscriptions.js';
import type { Backend, Delivery, State } from './types.js';
import type { Store } from './store.js';
import { projectNativeMessage, projectNativeItem, projectNativeInput, renderNativeProjection, type NativeProjection } from './shared-native-content.js';

export const nativeOutboxMarker = '[Native content record: matching Connector version and grant required]';
export const sharingDisclosure = 'Share future eligible Codex replies and questions with readers of this exact Slack thread. Input entered locally or through another client can affect the shared replies. No earlier or currently running turn is shared. Answer requests in the original Codex app.';
export class NativeShareError extends Error {}
interface Route {
  serverId: string; backendFingerprint: string; workspaceId: string; channel: string; rootThreadTs: string;
  subscriptionId: string; nativeThreadId: string; policy: string; slackIdentity: string; scope: string;
}
export interface NativeShare extends Route {
  id: string;
  nativeCreatedAt: number;
  // An ordered turn ID, never a timestamp, event ID or client-side order.
  anchor: string | null;
  frontier: string | null;
  grantedAt: string;
  state: 'active' | 'retired';
  reason?: string;
  observationalGap?: string;
  seenActive: string[];
}
export interface NativeDelivery {
  grantId: string; key: string; projection: NativeProjection;
  part: number; parts: number;
  request?: { epoch: string; rpcId: string | number };
}
type Callback = {
  route(sub: Subscription): Route | undefined;
  validateThread(sub: Subscription, thread: unknown): boolean;
  online(): boolean;
  joined(subId: string): boolean;
  sameSlackConnection(): number;
  threadExists(channel: string, ts: string): Promise<boolean>;
  queue(state: State, sub: Subscription, content: NativeDelivery, text: string): void;
  flush(): void;
};
const MAX_PREVIEWS = 64, PREVIEW_TTL = 120_000, MAX_BYTES = 4 * 1024 * 1024;
const PAGE = 8, MAX_PAGES = 5, MAX_ACTIVE_KEYS = 256, PENDING_LIMIT = 64, RESOLVED_LIMIT = 512;
const hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const cursor = (x: unknown): x is string | null => x===null||typeof x==='string'&&x.length>0&&x.length<=1024&&!/[\x00-\x1f\x7f]/.test(x);
const fail = (reason: string): never => {throw new NativeShareError(reason);};
const validRequest = (x: unknown): x is string | number => deliveryId(x)||typeof x==='number'&&Number.isSafeInteger(x);
const reqKey = (r: {epoch: string; rpcId: string|number}) => JSON.stringify([r.epoch,r.rpcId]);
const equalRoute = (a: Route,b: Route) => a.serverId===b.serverId&&a.backendFingerprint===b.backendFingerprint&&a.workspaceId===b.workspaceId&&a.channel===b.channel&&a.rootThreadTs===b.rootThreadTs&&a.subscriptionId===b.subscriptionId&&a.nativeThreadId===b.nativeThreadId&&a.policy===b.policy&&a.slackIdentity===b.slackIdentity&&a.scope===b.scope;
const dedupe = (grant: string, p: NativeProjection) => hash([grant,p.kind,p.turnId,p.itemId]);
const parts = (p: NativeProjection): string[] => {
  const safe = renderNativeProjection(p);
  if (!safe) return [];
  const rows:string[]=[];
  let chunk='', bytes=0;
  for(const point of safe){
    const n=Buffer.byteLength(point==='&'?'&amp;':point==='<'?'&lt;':point==='>'?'&gt;':point);
    if(bytes+n>2300){rows.push(chunk);chunk='';bytes=0;}
    chunk+=point;bytes+=n;
  }
  if(chunk)rows.push(chunk);
  return rows.length<=4?rows:[];
};
const publicRoute=(r:Route)=>({serverId:r.serverId,workspaceId:r.workspaceId,channel:r.channel,rootThreadTs:r.rootThreadTs,subscriptionId:r.subscriptionId,nativeThreadId:r.nativeThreadId});
interface Window {started:number; epoch:string; bytes:number}
interface PendingNative {
  projection: NativeProjection; threadId: string;
  key: { epoch: string; rpcId: string | number };
  answerDeadline?:number;
}
interface Preview {expires:number; connection:number; revision:number; route:Route}
interface TurnRow {id:string;status:string;itemsView:string;items:any[]}
const revokedCodes = new Set(['NATIVE_SHARE_THREAD_CHANGED','NATIVE_SHARE_SCOPE_CHANGED','NATIVE_SHARE_DESTINATION_UNVERIFIED']);
export function validateNativeShareState(s:State){
  const list=s.nativeShares, digest=(x:unknown)=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
  if(list===undefined)return;
  if(!Array.isArray(list)||list.length>100||list.some(r=>!r||!deliveryId(r.id)||!deliveryId(r.serverId)||!deliveryId(r.subscriptionId)||
    !deliveryId(r.nativeThreadId)||!deliveryId(r.workspaceId)||!deliveryId(r.channel)||typeof r.rootThreadTs!=='string'||
    !/^\d{1,20}\.\d{1,10}$/.test(r.rootThreadTs)||!digest(r.backendFingerprint)||!digest(r.policy)||!digest(r.scope)||!digest(r.slackIdentity)||
    !Number.isSafeInteger(r.nativeCreatedAt)||r.nativeCreatedAt<=0||typeof r.grantedAt!=='string'||!Number.isFinite(Date.parse(r.grantedAt))||
    r.anchor!==null&&!deliveryId(r.anchor)||r.frontier!==null&&!deliveryId(r.frontier)||r.anchor!==null&&r.frontier===null||
    !['active','retired'].includes(r.state)||!Array.isArray(r.seenActive)||r.seenActive.length>MAX_ACTIVE_KEYS||!r.seenActive.every(digest))||
    new Set(list.map(r=>r.id)).size!==list.length||new Set(list.map(r=>r.subscriptionId)).size!==list.length)throw new NativeShareError('NATIVE_SHARE_STATE_INVALID');
}
export class NativeSharing {
  // Pending input is never reconstructed from historical item text. Only a
  // currently outstanding original request (or official live request replay)
  // can authorize a question. Transport callbacks invalidate synchronously.
  private pending = new Map<string,PendingNative>();
  private resolved = new Set<string>();
  private questionCoverageLost = false;
  private blocked = new Set<string>();
  private previews = new Map<string,Preview>();
  private consentRevision = new Map<string,number>();
  private ready = new Map<string,string>();
  private sweep?:Promise<void>;
  private dirty = false;
  private lastSweep = 0;
  private closed = false;
  constructor(private store:Store, private backend:Backend, private hooks:Callback) {}
  private window():Window{return{started:Date.now(),epoch:this.backend.epoch,bytes:0};}
  private current(w:Window) {return !this.closed&&this.backend.connected&&this.backend.epoch===w.epoch;}
  private async rpc(method:string,params:unknown,w:Window) {
    const left=6000-(Date.now()-w.started);
    if(!this.current(w)||left<=0)fail('NATIVE_SHARE_HISTORY_GAP');
    let timer:NodeJS.Timeout|undefined;
    try{
      const response=await Promise.race([this.backend.rpc(method,params),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new NativeShareError('NATIVE_SHARE_HISTORY_GAP')),Math.min(left,2200));})]);
      if(!this.current(w)||!response)fail('NATIVE_SHARE_HISTORY_GAP');
      w.bytes+=Buffer.byteLength(JSON.stringify(response),'utf8');
      if(w.bytes>MAX_BYTES)fail('NATIVE_SHARE_HISTORY_GAP');
      return response;
    }catch(e){if(e instanceof NativeShareError)throw e;return fail('NATIVE_SHARE_HISTORY_GAP');}
    finally{if(timer)clearTimeout(timer);}
  }
  private async metadata(sub:Subscription,w:Window){
    const {thread}=await this.rpc('thread/read',{threadId:sub.threadId,includeTurns:false},w);
    if(!thread||thread.id!==sub.threadId||!Number.isSafeInteger(thread.createdAt)||thread.createdAt<=0||!this.hooks.validateThread(sub,thread)){
      return fail('NATIVE_SHARE_THREAD_CHANGED');
    }
    return thread as {createdAt:number;status?:{type?:string;activeFlags?:string[]}};
  }
  private async turns(sub:Subscription,w:Window,view:'full'|'notLoaded',limit:number,after?:string) {
    const p=await this.rpc('thread/turns/list',{threadId:sub.threadId,sortDirection:'desc',limit,itemsView:view,...(after?{cursor:after}:{})},w);
    if(!Array.isArray(p.data)||p.data.length>limit||!cursor(p.nextCursor)||p.nextCursor===after||p.data.some((t:any)=>
      !deliveryId(t?.id)||!(t.threadId===undefined||t.threadId===sub.threadId)||t.itemsView!==view||!Array.isArray(t.items)||
      !['inProgress','completed','failed','interrupted'].includes(t.status)
    )||(!p.data.length&&p.nextCursor!==null))return fail('NATIVE_SHARE_HISTORY_GAP');
    return {data:p.data as TurnRow[],next:p.nextCursor as string|null};
  }
  private async items(sub:Subscription,turnId:string,w:Window){
    const all:any[]=[], ids=new Set<string>(), cursors=new Set<string>();
    let after:string|undefined;
    for(let count=0;count<MAX_PAGES;count++){
      const limit=100,p=await this.rpc('thread/items/list',{threadId:sub.threadId,turnId,sortDirection:'asc',limit,...(after?{cursor:after}:{})},w);
      if(!Array.isArray(p.data)||p.data.length>limit||!cursor(p.nextCursor)||p.data.some((entry:any)=>
        entry?.turnId!==turnId||!deliveryId(entry.item?.id)||typeof entry.item.type!=='string'||entry.threadId!==undefined&&entry.threadId!==sub.threadId||
        entry.completedAtMs!==null&&entry.completedAtMs!==undefined&&(!Number.isSafeInteger(entry.completedAtMs)||entry.completedAtMs<=0)
      )||(!p.data.length&&p.nextCursor!==null))return fail('NATIVE_SHARE_HISTORY_GAP');
      for(const entry of p.data){if(ids.has(entry.item.id))return fail('NATIVE_SHARE_HISTORY_GAP');ids.add(entry.item.id);all.push(entry);}
      if(p.nextCursor===null)return all;
      if(cursors.has(p.nextCursor))return fail('NATIVE_SHARE_HISTORY_GAP');
      cursors.add(p.nextCursor);after=p.nextCursor;
    }
    return fail('NATIVE_SHARE_HISTORY_GAP');
  }
  private findSub(state:Readonly<State>,id:string) {return state.subscriptions?.find(s=>s.id===id);}
  private currentRoute(r:NativeShare,state:Readonly<State>){
    const sub=this.findSub(state,r.subscriptionId);
    if(!sub||!this.hooks.online()||this.blocked.has(r.nativeThreadId))return;
    const route=this.hooks.route(sub);
    if(r.state==='active'&&route&&equalRoute(route,r))return sub;
  }
  view(id: string) {
    const d=this.store.state,sub=this.findSub(d,id);
    if(!sub) return fail('NATIVE_SHARE_SUBSCRIPTION_NOT_FOUND');
    const row=d.nativeShares?.find(r=>r.subscriptionId===id);
    const scope=this.hooks.route(sub);
    return {...(scope?publicRoute(scope):row?publicRoute(row):{subscriptionId:id,nativeThreadId:sub.threadId,channel:sub.owner.channel,rootThreadTs:sub.owner.threadTs}),
      status:!row?'unshared':row.state==='retired'?'retired':!scope||!equalRoute(scope,row)||!this.backend.connected||!this.hooks.online()||!this.hooks.joined(id)?'paused':row.observationalGap?'gap':this.ready.get(row.id)===this.backend.epoch?'active':'checking',
      reason:row?.reason??row?.observationalGap??null,
      questionsAfterReconnect:'Only if the official App Server provides a current outstanding request; historical question text is never replayed.',
      disclosure:sharingDisclosure};
  }
  preview(id: string){
    const d=this.store.state,sub=this.findSub(d,id);
    if(!sub)return fail('NATIVE_SHARE_SUBSCRIPTION_NOT_FOUND');
    if(!this.hooks.online()||!this.backend.connected||!this.hooks.joined(id))return fail('NATIVE_SHARE_NOT_READY');
    const route=this.hooks.route(sub);
    if(!route)return fail('NATIVE_SHARE_IDENTITY_UNVERIFIED');
    const prior=d.nativeShares?.find(r=>r.subscriptionId===id);
    if(prior?.state==='active'&&equalRoute(prior,route))return fail('NATIVE_SHARE_ALREADY_GRANTED');
    for(const [key,value] of this.previews)if(value.expires<Date.now())this.previews.delete(key);
    if(this.previews.size>=MAX_PREVIEWS)return fail('NATIVE_SHARE_PREVIEW_LIMIT');
    const confirmationId=randomUUID();
    this.previews.set(confirmationId,{expires:Date.now()+PREVIEW_TTL,connection:this.hooks.sameSlackConnection(),revision:this.consentRevision.get(id)??0,route});
    return {...publicRoute(route),confirmationId,confirmationPhrase:'SHARE FUTURE '+route.nativeThreadId+' TO '+route.workspaceId+'/'+route.channel+'/'+route.rootThreadTs,disclosure:sharingDisclosure};
  }
  private async destination(r:Route) {
    try{if(await this.hooks.threadExists(r.channel,r.rootThreadTs))return;}catch{return fail('NATIVE_SHARE_DESTINATION_CHECK_UNAVAILABLE');}
    return fail('NATIVE_SHARE_DESTINATION_UNVERIFIED');
  }
  async grant(id:string,challenge:string,phrase:string) {
    const approval=this.previews.get(challenge);this.previews.delete(challenge);
    const r=approval?.route;
    if(!approval||!r||r.subscriptionId!==id||approval.expires<Date.now()||!this.hooks.online()||approval.connection!==this.hooks.sameSlackConnection()||
      phrase!=='SHARE FUTURE '+r.nativeThreadId+' TO '+r.workspaceId+'/'+r.channel+'/'+r.rootThreadTs)return fail('NATIVE_SHARE_CONFIRMATION_REQUIRED');
    const sub=this.findSub(this.store.state,id),route=sub&&this.hooks.route(sub);
    if(!sub||!route||!equalRoute(route,r)||!this.hooks.joined(id))return fail('NATIVE_SHARE_SCOPE_CHANGED');
    const w=this.window();
    await this.destination(r);
    // An idle native thread before the ordered head read is essential: a
    // pre-consent active turn can otherwise appear in persistence after the
    // snapshot and be mistaken for a new turn. Do not auto-activate later.
    const meta=await this.metadata(sub,w);
    if(meta.status?.type!=='idle')return fail('NATIVE_SHARE_WAIT_UNTIL_IDLE');
    const {data}=await this.turns(sub,w,'notLoaded',1);
    if(data[0]&&!terminalExecution(data[0].status))return fail('NATIVE_SHARE_WAIT_UNTIL_IDLE');
    if(!data[0]&&!this.store.state.work.some(x=>x.source.kind==='local'&&x.source.userId==='local'&&x.request.command==='session.create'&&x.status==='completed'&&
      x.resultRef?.threadId===r.nativeThreadId&&Math.abs(meta.createdAt*1000-Date.parse(x.createdAt))<60_000&&Date.now()-Date.parse(x.createdAt)<15*60_000)){
      return fail('NATIVE_SHARE_USE_DEDICATED_THREAD');
    }
    const finalMeta=await this.metadata(sub,w);
    if(finalMeta.createdAt!==meta.createdAt)return fail('NATIVE_SHARE_THREAD_CHANGED');
    if(finalMeta.status?.type!=='idle')return fail('NATIVE_SHARE_WAIT_UNTIL_IDLE');
    const anchor=data[0]?.id??null;
    const created:NativeShare={...r,id:randomUUID(),nativeCreatedAt:meta.createdAt,anchor,frontier:anchor,grantedAt:new Date().toISOString(),state:'active',seenActive:[]};
    this.store.transaction(d=>{
      const current=this.findSub(d,id),bound=current&&this.hooks.route(current);
      if(!this.current(w)||!this.hooks.online()||approval.revision!==(this.consentRevision.get(id)??0)||approval.connection!==this.hooks.sameSlackConnection()||!bound||!equalRoute(bound,r)||!this.hooks.joined(id)||this.blocked.has(r.nativeThreadId))fail('NATIVE_SHARE_SCOPE_CHANGED');
      const old=d.nativeShares?.find(r=>r.subscriptionId===id);
      if(old?.state==='active'&&equalRoute(old,r))fail('NATIVE_SHARE_ALREADY_GRANTED');
      if(old)this.retire(d,old,'NATIVE_SHARE_REPLACED');
      d.nativeShares=(d.nativeShares??[]).filter(x=>x.subscriptionId!==id);
      d.nativeShares.push(created);
    });
    this.ready.set(created.id,w.epoch);
    this.kick();
    return this.view(id);
  }
  revoke(id:string){
    const inFlightMayStillArrive=this.store.transaction(d=>{
      if(!this.findSub(d,id))fail('NATIVE_SHARE_SUBSCRIPTION_NOT_FOUND');
      const row=d.nativeShares?.find(r=>r.subscriptionId===id);
      this.consentRevision.set(id,(this.consentRevision.get(id)??0)+1);
      for(const [key,p] of this.previews)if(p.route.subscriptionId===id)this.previews.delete(key);
      if(!row)return false;
      this.retire(d,row,'NATIVE_SHARE_REVOKED');
      return d.outbox.some(o=>o.nativeShare?.grantId===row.id&&['sending','uncertain'].includes(o.status));
    });
    this.hooks.flush();
    return {...this.view(id),inFlightMayStillArrive};
  }
  private retire(d:State,row:NativeShare,reason:string) {
    row.state='retired';row.reason=reason;
    // A revoked queued payload is no longer necessary. Keep only the receipt.
    for(const o of d.outbox)if(o.nativeShare?.grantId===row.id&&o.status==='queued'){
      o.status='failed';o.error=reason;o.text='';delete o.nativeShare;
    }
    this.ready.delete(row.id);
  }
  /** Hard invalidation on the frame callback, before any async event work. */
  observe(method:string,p:any,epoch:string){
    if(epoch!==this.backend.epoch)return;
    if(method==='serverRequest/resolved'&&validRequest(p?.requestId)){
      const key=reqKey({epoch,rpcId:p.requestId}),pending=this.pending.get(key);
      if(pending&&pending.threadId===p.threadId)this.pending.delete(key);
      // Delay/replay in the same connection cannot re-open an already resolved
      // request. Once this bound is exceeded, require a fresh observation epoch
      // rather than evicting the evidence that a request closed.
      if(deliveryId(p.threadId)&&this.store.state.nativeShares?.some(s=>s.state==='active'&&s.nativeThreadId===p.threadId)){
        if(this.resolved.size<RESOLVED_LIMIT)this.resolved.add(JSON.stringify([p.threadId,key]));
        else{this.questionCoverageLost=true;this.pending.clear();}
      }
      return;
    }
    if((method==='item/started'||method==='item/completed')&&typeof p?.item?.type==='string'&&!['agentMessage','userMessage'].includes(p.item.type)){
      for(const [k,q] of this.pending)if(q.threadId===p.threadId&&q.projection.turnId===p.turnId&&q.projection.itemId===p.item.id)this.pending.delete(k);
    }
    if(method==='turn/completed')for(const [k,q] of this.pending)if(q.threadId===p?.threadId&&q.projection.turnId===p?.turn?.id)this.pending.delete(k);
    if(['thread/rolledBack','thread/reverted','thread/archived','thread/closed'].includes(method)&&deliveryId(p?.threadId)){
      const affected=this.store.state.nativeShares?.filter(r=>r.state==='active'&&r.nativeThreadId===p.threadId);
      if(affected?.length){
        this.blocked.add(p.threadId);
        this.store.transaction(d=>{for(const row of d.nativeShares??[])if(row.state==='active'&&row.nativeThreadId===p.threadId)this.retire(d,row,'NATIVE_SHARE_THREAD_CHANGED');});
        this.blocked.delete(p.threadId);
      }
    }
    if(method==='turn/completed'||method==='item/completed'&&p?.item?.type==='agentMessage')this.kick(p?.threadId);
  }
  request(r:any){
    if(this.closed||this.questionCoverageLost||!this.backend.connected||r?.epoch!==this.backend.epoch||!validRequest(r.id)||!deliveryId(r.params?.threadId)||!this.store.state.nativeShares?.some(row=>row.state==='active'&&row.nativeThreadId===r.params.threadId))return;
    const projection=projectNativeInput(r.method,r.params);
    if(!projection)return;
    const key={epoch:r.epoch,rpcId:r.id},k=reqKey(key),prior=this.pending.get(k);
    if(this.resolved.has(JSON.stringify([r.params.threadId,k])))return;
    if(prior){
      if(prior.threadId!==r.params.threadId||hash(prior.projection)!==hash(projection))this.pending.delete(k);
      return;
    }
    if(this.pending.size>=PENDING_LIMIT){this.markGap(r.params.threadId,'NATIVE_SHARE_QUESTION_GAP');return;}
    const deadline=typeof r.params.autoResolutionMs==='number'&&r.params.autoResolutionMs>0?Date.now()+r.params.autoResolutionMs:undefined;
    this.pending.set(k,{key,projection,threadId:r.params.threadId,answerDeadline:deadline});
    this.kick(r.params.threadId);
  }
  disconnected(){this.ready.clear();this.pending.clear();this.previews.clear();this.resolved.clear();this.questionCoverageLost=false;}
  private markGap(threadId:string,error:string) {
    this.store.transaction(d=>{for(const row of d.nativeShares??[])if(row.state==='active'&&row.nativeThreadId===threadId)row.observationalGap=error;});
  }
  tick(){if(Date.now()-this.lastSweep>=5000)this.kick();}
  private kick(threadId?:string) {
    if(this.closed||!this.hooks.online()||!this.backend.connected||!this.store.state.nativeShares?.some(r=>r.state==='active'&&(!threadId||r.nativeThreadId===threadId)))return;
    if(this.sweep){this.dirty=true;return;}
    this.lastSweep=Date.now();
    this.sweep=Promise.resolve().then(async()=>{
      const rows=this.store.state.nativeShares?.filter(r=>r.state==='active')??[];
      // Small independent batches. A single unsupported history RPC cannot
      // block other registries or make unbounded in-flight calls.
      for(let i=0;i<rows.length&&!this.closed;i+=3)await Promise.all(rows.slice(i,i+3).map(r=>this.refresh(r)));
    }).catch(()=>{/* no raw backend errors in logs */}).finally(()=>{
      this.sweep=undefined;this.hooks.flush();
      if(this.dirty){this.dirty=false;this.kick();}
    });
  }
  private keyLive(q:PendingNative,sub:Subscription) {
    const current=this.pending.get(reqKey(q.key));
    return !this.questionCoverageLost&&!!current&&(current.answerDeadline===undefined||current.answerDeadline>Date.now())&&current.threadId===sub.threadId&&hash(current.projection)===hash(q.projection)&&q.key.epoch===this.backend.epoch;
  }
  private async refresh(row:NativeShare) {
    const w=this.window();
    // A native or Slack disconnect between scheduling and entering a sweep
    // pauses this grant. It must not turn a transient disconnect into revocation.
    if(!this.current(w)||!this.hooks.online())return;
    const d=this.store.state,sub=this.currentRoute(row,d);
    if(!sub)return this.failRefresh(row,'NATIVE_SHARE_SCOPE_CHANGED');
    if(!this.hooks.joined(sub.id))return;
    try{
      const meta=await this.metadata(sub,w);
      if(meta.createdAt!==row.nativeCreatedAt)fail('NATIVE_SHARE_THREAD_CHANGED');
      const frame:TurnRow[]=[], ids=new Set<string>(), pageCursors=new Set<string>();
      let known=false, after:string|undefined;
      for(let page=0;page<MAX_PAGES&&!known;page++){
        const upstream=await this.turns(sub,w,'notLoaded',PAGE,after);
        for(const t of upstream.data){
          if(ids.has(t.id))fail('NATIVE_SHARE_HISTORY_GAP');
          ids.add(t.id);
          if(t.id===row.frontier){known=true;break;}
          frame.push(t);
        }
        if(!upstream.next){if(row.frontier===null)known=true;break;}
        if(pageCursors.has(upstream.next))fail('NATIVE_SHARE_HISTORY_GAP');
        pageCursors.add(upstream.next);after=upstream.next;
      }
      if(!known)fail('NATIVE_SHARE_HISTORY_GAP');
      const active=frame.filter(t=>!terminalExecution(t.status));
      // One native active turn, and it must be the newest position. Do not
      // advance past an unresolved older turn or reinterpret out-of-order data.
      if(active.length>1||active[0]&&active[0].id!==frame[0]?.id)fail('NATIVE_SHARE_HISTORY_GAP');
      const projections: {p:NativeProjection; current?:PendingNative}[]=[];
      const chronological=frame.slice().reverse();
      let frontier=row.frontier,activeContinuity=true;
      const terminal=chronological.filter(t=>terminalExecution(t.status));
      // Only read bodies for eligible, post-frontier turns. Older rows in the
      // traversal are metadata only. Read chronological batches so a larger
      // offline window can progress without skipping untouched turn IDs.
      const batch=terminal.slice(0,8);
      for(const t of batch){
        const entries=await this.items(sub,t.id,w);
        const whole={...t,itemsView:'full',items:entries.map((e:any)=>e.item)};
        for(const entry of entries){
          const p=projectNativeItem(entry)||projectNativeMessage(whole,entry.item);
          if(p)projections.push({p});
        }
        frontier=t.id;
      }
      if(batch.length<terminal.length)this.dirty=true;
      const a=active[0];
      if(a){
        const nativeToolItems=new Set<string>();
        // Live completed assistant items (e.g. a plain-language question before
        // turn completion). No delta or raw notification is ever posted.
        try{
          for(const entry of await this.items(sub,a.id,w)){
            const p=projectNativeItem(entry);if(p)projections.push({p});
            if(!['agentMessage','userMessage'].includes(entry.item.type))nativeToolItems.add(entry.item.id);
          }
        }catch{activeContinuity=false;}
        // Official structured requests do not expose their text via readback.
        // This one was received for an eligible live turn and is still pending
        // on this connection. Absent native pending evidence means no body.
        for(const q of this.pending.values())if(q.threadId===sub.threadId&&q.projection.turnId===a.id&&!nativeToolItems.has(q.projection.itemId)&&this.keyLive(q,sub))projections.push({p:q.projection,current:q});
      }
      const fresh=await this.metadata(sub,w);
      if(fresh.createdAt!==row.nativeCreatedAt)fail('NATIVE_SHARE_THREAD_CHANGED');
      this.store.transaction(draft=>{
        const current=draft.nativeShares?.find(r=>r.id===row.id),actual=current&&this.currentRoute(current,draft);
        if(!current||!actual||!this.current(w)||!this.hooks.joined(sub.id)||current.frontier!==row.frontier)return;
        const activeSeen=new Set(current.seenActive);
        for(const {p,current:q} of projections){
          const key=dedupe(current.id,p);
          if(q&&!this.keyLive(q,actual))continue;
          const previous=draft.outbox.filter(o=>o.nativeShare?.grantId===current.id&&o.nativeShare.key===key);
          if(previous.length||activeSeen.has(key)){
            // An unattempted question may have been paused by a lost connection.
            // Only the exact same sanitized question, freshly replayed pending by
            // the server, can restore its original queued record. Never resend
            // a sent/uncertain record or transplant previous native text.
            if(q&&previous.length&&previous.every(o=>o.status==='queued'&&o.attempts===0&&hash(o.nativeShare!.projection)===hash(p)))for(const o of previous)o.nativeShare!.request=q.key;
            continue;
          }
          const chunks=parts(p);
          if(!chunks.length)continue;
          if(a?.id===p.turnId){
            if(activeSeen.size>=MAX_ACTIVE_KEYS){activeContinuity=false;continue;}
            activeSeen.add(key);
          }
          chunks.forEach((text,part)=>this.hooks.queue(draft,actual,{grantId:current.id,key,projection:p,part,parts:chunks.length,...(q?{request:q.key}:{})},text));
        }
        current.frontier=frontier;
        current.seenActive=[...activeSeen].filter(key=>draft.outbox.some(o=>o.nativeShare?.grantId===current.id&&o.nativeShare.key===key&&o.nativeShare.projection.turnId===a?.id));
        if(this.questionCoverageLost)current.observationalGap='NATIVE_SHARE_QUESTION_GAP';
        else if(activeContinuity)delete current.observationalGap;
        else current.observationalGap='NATIVE_SHARE_ACTIVE_ITEMS_GAP';
      });
      if(this.current(w)&&this.currentRoute(row,this.store.state))this.ready.set(row.id,w.epoch);
    }catch(e){this.failRefresh(row,e instanceof NativeShareError?e.message:'NATIVE_SHARE_HISTORY_GAP');}
  }
  private failRefresh(row:NativeShare,reason:string) {
    this.ready.delete(row.id);
    const saved=this.store.state.nativeShares?.find(r=>r.id===row.id);
    if(!saved||saved.state!=='active'||saved.observationalGap===reason)return;
    this.store.transaction(d=>{
      const current=d.nativeShares?.find(r=>r.id===row.id);
      if(current?.state!=='active')return;
      if(revokedCodes.has(reason))this.retire(d,current,reason);
      else current.observationalGap=reason;
    });
  }
  /** No async calls in this final predicate. Call after prepare() and immediately
   * before invoking the Slack adapter. Text must match the same projection, not
   * a cached arbitrary command result or a forged notification body. */
  deliveryAllowed(o:Delivery,d:Readonly<State>) {
    const n=o.nativeShare,row=n&&d.nativeShares?.find(r=>r.id===n.grantId),sub=row&&this.currentRoute(row,d);
    if(!n||!row||!sub||!this.backend.connected||this.ready.get(row.id)!==this.backend.epoch||!this.hooks.joined(sub.id)||
      o.subscriptionId!==sub.id||o.notificationThreadId!==row.nativeThreadId||o.channel!==row.channel||o.threadTs!==row.rootThreadTs||
      !o.origin||o.origin.kind!==sub.owner.kind||o.origin.userId!==sub.owner.userId||o.origin.channel!==sub.owner.channel||o.origin.threadTs!==sub.owner.threadTs||o.root)return false;
    const cols=parts(n.projection);
    if(o.text!==nativeOutboxMarker||!Number.isSafeInteger(n.part)||n.part<0||cols.length!==n.parts||!cols[n.part]||n.key!==dedupe(row.id,n.projection))return false;
    if(n.projection.kind==='input'){
      const pending=n.request&&this.pending.get(reqKey(n.request));
      return !!pending&&this.keyLive(pending,sub)&&hash(pending.projection)===hash(n.projection);
    }
    return !n.request;
  }
  wireBody(o:Delivery,d:Readonly<State>){
    if(!o.nativeShare||!this.deliveryAllowed(o,d))return;
    return parts(o.nativeShare.projection)[o.nativeShare.part];
  }
  recipientRejected(grantId:string){
    const row=this.store.state.nativeShares?.find(r=>r.id===grantId);
    if(row)this.failRefresh(row,'NATIVE_SHARE_DESTINATION_UNVERIFIED');
  }
  waiting(o:Delivery,d:Readonly<State>){
    const n=o.nativeShare,row=n&&d.nativeShares?.find(r=>r.id===n.grantId);
    if(!row||row.state!=='active')return false;
    return !this.backend.connected||!this.hooks.online()||this.ready.get(row.id)!==this.backend.epoch;
  }
  async prepare(o:Delivery) {
    const before=this.store.state,n=o.nativeShare,row=n&&before.nativeShares?.find(r=>r.id===n.grantId),sub=row&&this.currentRoute(row,before);
    if(!row||!sub||!this.deliveryAllowed(o,before))return 'refuse';
    const w=this.window(),connection=this.hooks.sameSlackConnection();
    try{
      await this.destination(row);
      const meta=await this.metadata(sub,w);
      if(meta.createdAt!==row.nativeCreatedAt)fail('NATIVE_SHARE_THREAD_CHANGED');
      if(n!.projection.kind==='input'){
        if(meta.status?.type!=='active'||!meta.status.activeFlags?.includes('waitingOnUserInput'))return 'refuse';
        // A matching tool item or unknown shape can arrive while the Slack
        // root read is in progress. Never mistake it for a regular question.
        const input=n!.projection;
        if((await this.items(sub,input.turnId,w)).some(entry=>entry.item.id===input.itemId&&!['agentMessage','userMessage'].includes(entry.item.type)))return 'refuse';
      }
      return this.current(w)&&connection===this.hooks.sameSlackConnection()?'ready':'pause';
    }catch(e){const code=e instanceof NativeShareError?e.message:'NATIVE_SHARE_HISTORY_GAP';this.failRefresh(row,code);return revokedCodes.has(code)?'refuse':'pause';}
  }
  async close(){this.closed=true;this.disconnected();await this.sweep;}
}
