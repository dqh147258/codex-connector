import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { containsSensitiveContent } from './files.js';
import { deliveryId, observeMessage, observeTurn, terminalExecution } from './session-delivery.js';
import type { Backend, Session, State, Work } from './types.js';

/** The caller establishes the authenticated principal and checks current project
 * grants/metadata. None of these fields (especially principal) are wire authority. */
export interface LocalEventScope { principal: string; project: string; sessionId: string; threadId: string }
const ACTION_NOTICE='This turn requested local interaction. Check the original Codex UI.';
type Body = { type:'local.action_required'; text:typeof ACTION_NOTICE } | { type: 'assistant.final'; itemId: string; text: string|null; truncated: boolean; withheld: boolean } |
  { type: 'turn.completed'; status: 'completed'|'failed'|'interrupted' };
export type LocalEvent = Body & { id: string; turnId: string; workId: string|null };
type Reason = 'observation_interrupted'|'history_unavailable'|'history_window_incomplete'|'ownership_uncertain';
export interface LocalEventPage {
  events: LocalEvent[]; nextCursor: string; hasMore: boolean;
  gap: null | { reason: Reason|'journal_retention'; historyRecovered: boolean };
}
interface Stream {
  scope: LocalEventScope; id: string; secret: string; seq: number; generation: number;
  gap: Reason|null; recovered: boolean; enabled: boolean;
  records: {seq:number;event:LocalEvent}[]; seen: string[];
}
interface Journal { version: 1; serverId: string; streams: Stream[] }
type EventState = State & { localEventJournal?: Journal };
interface EventStore { readonly state: Readonly<EventState>; transaction<T>(fn:(draft:EventState)=>T):T }
// Independent event confidentiality evidence. A mixed turn does NOT undo
// successful admission, exact start acknowledgement, or a terminal receipt.
// One boolean on the existing work record, no additional unbounded index.
type EventWork = Work & { localEventMixedInput?:true };
const mixed=(w:Work)=>(w as EventWork).localEventMixedInput===true;
// Pauses are small owner flags on the existing session, not journal slots. They
// preserve unwatch across restart without retaining payloads or old signing keys.
type Bound = Session & {localEventPausedOwners?:string[]};
const MAX_STREAMS=100, MAX_EVENTS=100, MAX_BYTES=256*1024, MAX_SEEN=512, MAX_WAITERS=100;
const positive = (x:unknown, min:number,max:number) => Number.isSafeInteger(x)&&Number(x)>=min&&Number(x)<=max;
const hashId=(x:unknown):x is string=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const validScope=(s:LocalEventScope)=>!!s && [s.principal,s.threadId,s.sessionId].every(deliveryId) && typeof s.project==='string' && /^[a-zA-Z0-9_-]{1,64}$/.test(s.project);
const exact=(v:object,keys:string)=>!!v&&Object.keys(v).sort().join(',')===keys;
const owners=(s:Bound)=>Array.isArray(s.localOwners)&&s.localOwners.every(deliveryId)?s.localOwners:[];
const paused=(s:Bound,principal:string)=>s.localEventPausedOwners?.includes(principal)===true;
function pause(s:Bound,principal:string) {
  if(!paused(s,principal))(s.localEventPausedOwners??=[]).push(principal);
}
function unpause(s:Bound,principal:string) {
  if(!paused(s,principal))return;
  const keep=s.localEventPausedOwners!.filter(owner=>owner!==principal);
  if(keep.length)s.localEventPausedOwners=keep;
  else delete s.localEventPausedOwners;
}
const key=(s:LocalEventScope)=>JSON.stringify([s.principal,s.project,s.sessionId,s.threadId]);
const fail=(code:string):never=>{throw Object.assign(Error(code),{code});};
const bytes=(v:unknown)=>Buffer.byteLength(JSON.stringify(v));
const reasons:Reason[]=['observation_interrupted','history_unavailable','history_window_incomplete','ownership_uncertain'];

function bound(s:EventState, scope:LocalEventScope):Bound|undefined {
  const session=s.sessions.find(x=>x.id===scope.sessionId && x.threadId===scope.threadId && x.project===scope.project) as Bound|undefined;
  return session&&owners(session).includes(scope.principal)?session:undefined;
}
function atThread(w:Work,session:Session) {
  return w.messageDelivery?.threadId===session.threadId || w.request.params.sessionId===session.id || w.request.params.threadId===session.threadId;
}
/** Shared threads never infer an owner from the latest request, channel, or
 * timing. Native Desktop output is possible ONLY on an exclusive local binding. */
function exclusive(s:EventState,session:Bound,principal:string) {
  return session.channel==='' && session.localOwners?.length===1 && session.localOwners[0]===principal &&
    !s.sessions.some(x=>x.id!==session.id&&x.threadId===session.threadId) &&
    !s.subscriptions?.some(x=>x.threadId===session.threadId) &&
    !s.work.some(w=>atThread(w,session) && (w.source.kind!=='local'||w.source.userId!==principal));
}
function receipt(s:EventState,scope:LocalEventScope,turnId:string):string|null|undefined {
  const b=bound(s,scope); if(!b)return;
  const claims=s.work.filter(w=>w.messageDelivery?.threadId===scope.threadId && w.messageDelivery?.turnId===turnId);
  if(claims.length===0)return exclusive(s,b,scope.principal)?null:undefined;
  if(claims.length!==1)return;
  const w=claims[0]!,d=w.messageDelivery!;
  if(!mixed(w) && !d.correlationConflict && d.clientUserMessageId===w.id && w.source.kind==='local' && w.source.userId===scope.principal &&
    w.request.params.sessionId===scope.sessionId && ['session.send','session.queue'].includes(w.request.command) &&
    (d.start==='accepted'||['user-message','turn-lifecycle','queue-start-response'].includes(d.evidence)))return w.id;
}
function body(method:string,p:any):{turnId:string;body:Body}|undefined{
  if(method==='turn/completed' && deliveryId(p?.turn?.id) && terminalExecution(p.turn.status))
    return {turnId:p.turn.id,body:{type:'turn.completed',status:p.turn.status}};
  const a=p?.item;
  if(method!=='item/completed'||!deliveryId(p?.turnId)||a?.type!=='agentMessage'||!deliveryId(a.id)||
    a.phase!=null&&a.phase!=='final_answer'||typeof a.text!=='string')return;
  // Scan the whole selected text, not just the visible prefix. Never retain a
  // raw RPC payload, tool outputs, user input, reasoning, or nested diagnostics.
  const withheld=containsSensitiveContent(a.text), truncated=!withheld&&a.text.length>8192;
  let text=withheld?null:truncated?a.text.slice(0,8192):a.text;
  if(truncated&&/[\uD800-\uDBFF]$/.test(text))text=text.slice(0,-1);
  return {turnId:p.turnId,body:{type:'assistant.final',itemId:a.id,withheld,truncated,text}};
}
function eventId(server:string,scope:LocalEventScope,turnId:string,b:Body){
  return createHash('sha256').update(JSON.stringify([server,key(scope),turnId,b.type,b.type==='assistant.final'?b.itemId:null])).digest('hex');
}
function digest(stream:Stream,server:string,n:number,g:number) {
  return createHmac('sha256',Buffer.from(stream.secret,'hex')).update(JSON.stringify([server,key(stream.scope),stream.id,n,g])).digest('base64url');
}
function encode(stream:Stream,server:string,n:number,g=stream.generation){return `${n}.${g}.${digest(stream,server,n,g)}`;}
function decode(stream:Stream,server:string,cursor?:string){
  if(cursor===undefined)return {n:0,g:0};
  if(typeof cursor!=='string'||cursor.length>128)fail('INVALID_LOCAL_EVENT_CURSOR');
  const m=/^(0|[1-9][0-9]{0,15})\.(0|[1-9][0-9]{0,15})\.([a-zA-Z0-9_-]{43})$/.exec(cursor);
  if(!m)return fail('INVALID_LOCAL_EVENT_CURSOR');
  const n=Number(m[1]),g=Number(m[2]);
  if(!positive(n,0,stream.seq)||!positive(g,0,stream.generation)||
    !timingSafeEqual(Buffer.from(m[3]!),Buffer.from(digest(stream,server,n,g))))fail('INVALID_LOCAL_EVENT_CURSOR');
  return {n,g};
}
function newStream(scope:LocalEventScope):Stream {
  return {scope:{principal:scope.principal,project:scope.project,sessionId:scope.sessionId,threadId:scope.threadId},id:randomUUID(),secret:randomBytes(32).toString('hex'),seq:0,generation:0,
    gap:null,recovered:false,enabled:true,records:[],seen:[]};
}
function checkJournal(j:Journal|undefined, server:string){
  if(j===undefined)return;
  const invalid=()=>fail('INVALID_LOCAL_EVENT_STATE');
  if(!j||!exact(j,'serverId,streams,version')||j.version!==1||j.serverId!==server||!Array.isArray(j.streams)||j.streams.length>MAX_STREAMS)invalid();
  const scopes=new Set<string>(),ids=new Set<string>();
  for(const r of j.streams) {
    if(!r||!exact(r,'enabled,gap,generation,id,records,recovered,scope,secret,seen,seq')||!validScope(r.scope)||!exact(r.scope,'principal,project,sessionId,threadId')||scopes.has(key(r.scope))||!deliveryId(r.id)||ids.has(r.id)||!hashId(r.secret)||
      !positive(r.seq,0,Number.MAX_SAFE_INTEGER)||!positive(r.generation,0,Number.MAX_SAFE_INTEGER)||
      !(r.gap===null||reasons.includes(r.gap))||typeof r.enabled!=='boolean'||typeof r.recovered!=='boolean'||
      !Array.isArray(r.records)||r.records.length>MAX_EVENTS||bytes(r.records)>MAX_BYTES||!Array.isArray(r.seen)||
      r.seen.length>MAX_SEEN||r.seen.some(x=>!hashId(x))||new Set(r.seen).size!==r.seen.length)invalid();
    scopes.add(key(r.scope));ids.add(r.id);
    let last=r.seq-r.records.length;
    for(const {seq,event:e} of r.records){
      if(!e || !positive(seq,1,r.seq) || seq!==++last || !(e.workId===null||deliveryId(e.workId))||!deliveryId(e.turnId)||!r.seen.includes(e.id) ||
        (e.type==='turn.completed'?(!terminalExecution(e.status)||Object.keys(e).sort().join()!=='id,status,turnId,type,workId'):
         e.type==='local.action_required'?(e.text!==ACTION_NOTICE||Object.keys(e).sort().join()!=='id,text,turnId,type,workId'):
         e.type==='assistant.final'?(!deliveryId(e.itemId)||typeof e.withheld!=='boolean'||typeof e.truncated!=='boolean'||
           !(e.withheld?e.text===null:typeof e.text==='string'&&e.text.length<=8192&&!containsSensitiveContent(e.text))||
           Object.keys(e).sort().join()!=='id,itemId,text,truncated,turnId,type,withheld,workId'):true)||
        e.id!==eventId(server,r.scope,e.turnId,e))invalid();
    }
  }
}
export class LocalEvents {
  private listeners=new Map<string,Set<()=>void>>();
  private waiting=0;
  private jobs=new Map<string,Promise<void>>();
  private recoveredIn=new Map<string,{stamp:string;until:number}>();
  private stamp(scope:LocalEventScope,s:EventState,epoch:string){
    // Admission often precedes the acknowledgement identifying a native turn.
    // A later receipt invalidates an earlier negative same-epoch history read.
    return createHash('sha256').update(JSON.stringify([epoch,s.work.filter(w=>w.source.kind==='local'&&w.source.userId===scope.principal&&w.request.params.sessionId===scope.sessionId&&w.messageDelivery)
      .map(w=>[w.id,w.messageDelivery!.turnId,w.messageDelivery!.execution,!!w.messageDelivery!.correlationConflict,mixed(w)])])).digest('hex');
  }
  constructor(private store:EventStore,private backend:Backend,private serverId:string){
    if(!deliveryId(serverId))fail('INVALID_LOCAL_EVENT_SERVER');
    const state=store.state;checkJournal(state.localEventJournal,serverId);
    for(const w of state.work as EventWork[])if(w.localEventMixedInput!==undefined&&
      (w.localEventMixedInput!==true||w.source.kind!=='local'||!w.messageDelivery?.turnId))fail('INVALID_LOCAL_EVENT_STATE');
    for(const session of state.sessions as Bound[]) {
      const value=session.localEventPausedOwners;
      if(value!==undefined&&(!Array.isArray(value)||value.length>owners(session).length||
        new Set(value).size!==value.length||value.some(owner=>!owners(session).includes(owner))))fail('INVALID_LOCAL_EVENT_STATE');
    }
    // v1 journals used disabled rows to suppress automatic capture. Migrate
    // them to owner flags while keeping unrelated active IDs/cursors intact.
    if(state.localEventJournal?.streams.some(r=>!r.enabled))this.store.transaction(d=>{
      const j=d.localEventJournal!;
      for(const r of j.streams)if(!r.enabled){
        const session=bound(d,r.scope);
        if(session)pause(session,r.scope.principal);
      }
      j.streams=j.streams.filter(r=>r.enabled);
    });
    // A process restart itself is a potential gap, even without a clean disconnect.
    this.markDisconnected();
  }
  private checked(s:EventState,scope:LocalEventScope) {
    const session=validScope(scope)&&bound(s,scope);
    return session||fail('LOCAL_EVENT_SCOPE_UNAVAILABLE');
  }
  private row(s:EventState,scope:LocalEventScope,create=false):Stream|undefined{
    const j=s.localEventJournal;
    const r=j?.streams.find(x=>key(x.scope)===key(scope));
    if(r||!create)return r;
    const journal=s.localEventJournal??={version:1,serverId:this.serverId,streams:[]};
    if(journal.streams.length>=MAX_STREAMS)fail('LOCAL_EVENT_STREAM_LIMIT');
    const fresh=newStream(scope);journal.streams.push(fresh);return fresh;
  }
  private wake(id:string){for(const finish of [...(this.listeners.get(id)??[])])finish();}
  private gap(r:Stream,reason:Reason,recovered=false){
    if(r.gap!==reason||r.recovered!==recovered){r.gap=reason;r.recovered=recovered;r.generation++;}
  }
  subscribe(scope:LocalEventScope,cursor?:string){
    const s=this.store.state;this.checked(s,scope);
    const r=this.row(s,scope);
    if(cursor!==undefined){
      // A continuation is not an explicit new subscription. In particular,
      // a delayed poll carrying an old cursor cannot undo unwatch or consume capacity.
      if(!r?.enabled)return fail('INVALID_LOCAL_EVENT_CURSOR');
      decode(r,this.serverId,cursor);
      return {subscriptionId:r.id,cursor};
    }
    const stream=r??this.store.transaction(d=>{
      const session=this.checked(d,scope),fresh=this.row(d,scope,true)!;
      unpause(session,scope.principal);
      return fresh;
    });
    return {subscriptionId:stream.id,cursor:encode(stream,this.serverId,0,0)};
  }
  /** Internal listing for reconnect. The external caller filters by current grants. */
  list(principal?:string){
    const s=this.store.state;
    return (s.localEventJournal?.streams||[]).filter(r=>r.enabled && (principal===undefined||r.scope.principal===principal)&&bound(s,r.scope))
      .map(r=>({...r.scope,subscriptionId:r.id}));
  }
  cancel(scope:LocalEventScope,subscriptionId:string){
    this.store.transaction(s=>{
      const session=this.checked(s,scope),r=this.row(s,scope);
      if(!r||r.id!==subscriptionId)return fail('LOCAL_EVENT_SUBSCRIPTION_UNAVAILABLE');
      pause(session,scope.principal);
      const journal=s.localEventJournal!;
      journal.streams=journal.streams.filter(stream=>stream!==r);
    });
    this.recoveredIn.delete(subscriptionId);
    this.wake(subscriptionId);
    return {subscriptionId,enabled:false};
  }
  markDisconnected(){
    this.recoveredIn.clear();
    if(!this.store.state.localEventJournal?.streams.some(r=>r.enabled))return;
    const ids=this.store.transaction(s=>s.localEventJournal!.streams.filter(r=>r.enabled).map(r=>{
      r.gap='observation_interrupted';r.recovered=false;r.generation++;return r.id;
    }));for(const id of ids)this.wake(id);
  }
  private append(r:Stream,e:LocalEvent){
    if(r.seen.includes(e.id))return false;
    r.records.push({seq:++r.seq,event:e});r.seen.push(e.id);
    if(r.seen.length>MAX_SEEN)r.seen.shift();
    while(r.records.length>MAX_EVENTS||bytes(r.records)>MAX_BYTES-1024)r.records.shift();
    return true;
  }
  /** Passed only authenticated notifications from this server, after exact
   * clientId/queue correlation is recorded. Never infer origin from a session binding alone in shared mode. */
  observe(method:string,params:any,epoch:string){
    if(!this.backend.connected||epoch!==this.backend.epoch||!deliveryId(params?.threadId))return;
    if((method==='item/started'||method==='item/completed')&&params.item?.type==='userMessage'&&deliveryId(params.turnId)&&deliveryId(params.item.id)){
      // Unattributed or foreign secondary input weakens *event ownership*, not
      // the exact submission receipt for an already bound turn.
      const affected=(w:Work)=>w.source.kind==='local'&&!mixed(w)&&w.messageDelivery?.threadId===params.threadId&&
        w.messageDelivery?.turnId===params.turnId&&w.id!==params.item.clientId;
      if(this.store.state.work.some(affected)){
        const changed=this.store.transaction(d=>{
          const ids=new Set<string>();for(const w of d.work as EventWork[])if(affected(w)){
            w.localEventMixedInput=true;
            for(const r of d.localEventJournal?.streams??[])if(r.enabled&&r.scope.threadId===params.threadId&&r.scope.principal===w.source.userId&&r.scope.sessionId===w.request.params.sessionId){
              this.gap(r,'ownership_uncertain');ids.add(r.id);
            }
          }return ids;
        });for(const id of changed)this.wake(id);
      }
      return;
    }
    const value=body(method,params);if(!value)return;
    this.record(params.threadId,value);
  }
  /** Advisory only. Neither the RPC ID nor request parameters (commands, paths,
   * questions, choices, credentials) enter the journal. At most one notice per
   * turn; the native client is the authority on what still requires attention. */
  observeRequest(r:{method:string;params:any;epoch:string}){
    if(!this.backend.connected||r?.epoch!==this.backend.epoch||typeof r.method!=='string'||
      !deliveryId(r.params?.threadId)||!deliveryId(r.params?.turnId))return;
    if(!new Set(['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/tool/requestUserInput',
      'item/permissions/requestApproval','mcpServer/elicitation/request']).has(r.method))return;
    this.record(r.params.threadId,{turnId:r.params.turnId,body:{type:'local.action_required',text:ACTION_NOTICE}});
  }
  private record(threadId:string,value:{turnId:string;body:Body}){
    const snapshot=this.store.state, candidates:LocalEventScope[]=[];
    for(const s of snapshot.sessions as Bound[])if(s.threadId===threadId)
      for(const principal of owners(s)) {
        const scope={principal,project:s.project,sessionId:s.id,threadId:s.threadId};
        if(!paused(s,principal)&&validScope(scope)&&receipt(snapshot,scope,value.turnId)!==undefined)candidates.push(scope);
      }
    if(!candidates.length)return;
    const ids=this.store.transaction(state=>{
      const changed:string[]=[];
      for(const scope of candidates) {
        const session=bound(state,scope);
        if(!session||paused(session,scope.principal))continue;
        const workId=receipt(state,scope,value.turnId);if(workId===undefined)continue;
        // Exhausting local stream capacity must never interrupt Slack's handling
        // of the same notification. Explicit subscriptions still report the cap.
        if(!this.row(state,scope)&&(state.localEventJournal?.streams.length??0)>=MAX_STREAMS)continue;
        const r=this.row(state,scope,true)!;if(!r.enabled)continue;
        const id=eventId(this.serverId,scope,value.turnId,value.body);
        if(this.append(r,{...value.body,turnId:value.turnId,workId,id}))changed.push(r.id);
      }return changed;
    });for(const id of ids)this.wake(id);
  }
  /** Captured output is re-authorized at read time as bindings/receipts can
   * change after observation, especially a previously exclusive native turn. */
  private page(scope:LocalEventScope,subscriptionId:string,cursor:string|undefined,limit:number) {
    const s=this.store.state,session=this.checked(s,scope);
    const r=this.row(s,scope);if(!r?.enabled||r.id!==subscriptionId)return fail('LOCAL_EVENT_SUBSCRIPTION_UNAVAILABLE');
    const c=decode(r,this.serverId,cursor),first=r.records[0]?.seq??r.seq+1;
    const dropped=c.n<first-1;
    let last=Math.max(c.n,first-1),ambiguous=false;
    const events:LocalEvent[]=[];
    for(const entry of r.records) {
      if(entry.seq<=last)continue;
      if(events.length===limit)break;
      last=entry.seq;
      const current=receipt(s,scope,entry.event.turnId);
      // A formerly exclusive native observation was not proved by a receipt
      // when collected. A later receipt must not retroactively publish it into
      // a now-shared binding. Preserve it only while that exclusivity holds.
      if(current===undefined||(entry.event.workId===null?!exclusive(s,session,scope.principal):current!==entry.event.workId)){
        ambiguous=true;continue;
      }
      events.push(entry.event);
    }
    const gap:LocalEventPage['gap']=dropped?{reason:'journal_retention',historyRecovered:false}:ambiguous?{reason:'ownership_uncertain',historyRecovered:false}:
      r.gap?{reason:r.gap,historyRecovered:r.recovered}:null;
    const page:LocalEventPage={events,nextCursor:encode(r,this.serverId,last),hasMore:last<r.seq,gap};
    return {page,changed:events.length>0||dropped||ambiguous||c.g!==r.generation};
  }
  async poll(scope:LocalEventScope,q:{subscriptionId:string;cursor?:string;limit?:number;waitMs?:number},signal?:AbortSignal):Promise<LocalEventPage>{
    const {subscriptionId:id,cursor,limit=100,waitMs=0}=q;
    if(!positive(limit,1,MAX_EVENTS)||!positive(waitMs,0,30000))fail('INVALID_LOCAL_EVENT_QUERY');
    let entry=this.page(scope,id,cursor,limit);
    if(!waitMs||entry.changed||signal?.aborted)return entry.page;
    if(this.waiting>=MAX_WAITERS)fail('LOCAL_EVENT_WAIT_LIMIT');
    await new Promise<void>(resolve=>{
      const set=this.listeners.get(id)??new Set<()=>void>();
      const finish=()=>{clearTimeout(timer);signal?.removeEventListener('abort',finish);set.delete(finish);if(!set.size)this.listeners.delete(id);this.waiting--;resolve();};
      const timer=setTimeout(finish,waitMs);this.waiting++;set.add(finish);this.listeners.set(id,set);signal?.addEventListener('abort',finish,{once:true});
    });
    entry=this.page(scope,id,cursor,limit);return entry.page;
  }
  /** Bounded, read-only recovery; no resume, queue mutation, steer, retry of
   * interrupted work, or fallback to raw logs. Caller verifies current scope. */
  recover(scope:LocalEventScope,subscriptionId?:string):Promise<void>{
    const state=this.store.state;this.checked(state,scope);
    const stream=this.row(state,scope),epoch=this.backend.epoch;
    if(!stream?.enabled||(subscriptionId!==undefined&&stream.id!==subscriptionId))return Promise.resolve();
    const stamp=this.stamp(scope,state,epoch);
    const token=JSON.stringify([stream.id,epoch]);
    const cached=this.recoveredIn.get(stream.id);
    if(this.backend.connected&&cached?.stamp===stamp&&Date.now()<cached.until)return Promise.resolve();
    const job=this.jobs.get(token);if(job)return job;
    const op=this.recoverOne(scope,stream.id,epoch).finally(()=>this.jobs.delete(token));
    this.jobs.set(token,op);return op;
  }
  private async recoverOne(scope:LocalEventScope,id:string,epoch:string) {
    const available=()=>this.backend.connected&&epoch===this.backend.epoch;
    const state=this.store.state,b=bound(state,scope)!;
    const deadline=Date.now()+5000;
    let left=2*1024*1024; // shared across both traversals, not per RPC
    const read=async(method:string,extra:object)=>{
      const data:any[]=[],cursors=new Set<string>();let cursor:string|null=null;
      // Independent transport cursors; never send one method's cursor to the
      // other, and never reinterpret a client journal cursor as a native cursor.
      for(let n=0;n<4&&data.length<300;n++){
        const remaining=deadline-Date.now();if(!available()||remaining<=0||left<=0)throw Error('unavailable');
        const limit=Math.min(100,300-data.length);
        let timer:NodeJS.Timeout|undefined;
        try{
          const page:any=await Promise.race([this.backend.rpc(method,{threadId:scope.threadId,sortDirection:'desc',limit,...extra,...(cursor?{cursor}:{})}),
            new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),remaining);})]);
          if(!available()||!page||!Array.isArray(page.data)||page.data.length>limit||
            !(page.nextCursor===null||typeof page.nextCursor==='string'&&page.nextCursor.length>0&&page.nextCursor.length<=512&&!/[\x00-\x1f\x7f]/.test(page.nextCursor)))throw Error('unavailable');
          left-=bytes(page);if(left<0)throw Error('unavailable');
          data.push(...page.data);cursor=page.nextCursor;
          if(!cursor||cursors.has(cursor))break;
          cursors.add(cursor);
        }finally{clearTimeout(timer);}
      }
      // A repeated or not-yet-exhausted continuation is a gap, not end-of-log.
      return {data,nextCursor:cursor};
    };
    let issue:Reason|null=null;
    let turns:{data:any[];nextCursor:string|null}|undefined,items:typeof turns;
    // Read a consistent-enough pair or discard all content. History pages are
    // non-atomic; recheck epoch, receipt credentials and binding before commit.
    try{
      turns=await read('thread/turns/list',{itemsView:'notLoaded'});items=await read('thread/items/list',{});
      if(turns.nextCursor||items.nextCursor)issue='history_window_incomplete';
    }catch{issue='history_unavailable';}
    this.store.transaction(d=>{
      const r=this.row(d,scope);
      if(!r?.enabled||r.id!==id||!bound(d,scope))return;
      if(!available()||!items||!turns){
        this.gap(r,'history_unavailable');
        if(available())this.recoveredIn.set(id,{stamp:this.stamp(scope,d,epoch),until:Date.now()+5000});
        return;
      }
      const now=new Date().toISOString(),owned=d.work.filter(w=>w.source.kind==='local'&&w.source.userId===scope.principal&&
        w.request.params.sessionId===scope.sessionId&&w.messageDelivery?.threadId===scope.threadId);
      // Match all local *and foreign* claims before deciding who may see the
      // turn. Two clients can contribute to one turn while we are disconnected.
      // Read-only evidence, never user content, is retained on their ledgers.
      const byClient=new Map(d.work.filter(w=>w.messageDelivery?.threadId===scope.threadId).map(w=>[w.id,w]));
      const foreignInputs=new Map<string,Set<string|null>>();
      for(const entry of items.data){
        if(entry?.threadId!==undefined&&entry.threadId!==scope.threadId)continue;
        if(entry?.item?.type!=='userMessage'||!deliveryId(entry.turnId)||!deliveryId(entry.item.id))continue;
        const client=deliveryId(entry.item.clientId)?entry.item.clientId:null;
        const participants=foreignInputs.get(entry.turnId)??new Set<string|null>();participants.add(client);foreignInputs.set(entry.turnId,participants);
        const w=client?byClient.get(client):undefined;
        if(w)observeMessage(w.messageDelivery!,scope.threadId,entry.turnId,entry.item,now);
      }
      const knownTurns=new Map<string,any>();
      for(const t of turns.data)if(deliveryId(t?.id)&&(t.threadId===undefined||t.threadId===scope.threadId))knownTurns.set(t.id,t);
      for(const w of owned){
        const md=w.messageDelivery!,turn=md.turnId?knownTurns.get(md.turnId):undefined;
        if(turn)observeTurn(md,scope.threadId,turn,now);
        // A claimed turn with independently witnessed additional inputs has
        // ambiguous delivery ownership. Block publication even on later polls.
        if(md.turnId&&foreignInputs.get(md.turnId)?.size &&
          [...foreignInputs.get(md.turnId)!].some(client=>client!==md.clientUserMessageId))(w as EventWork).localEventMixedInput=true;
      }
      const add=(method:string,p:any,when:number)=>{
        if(p?.threadId!==undefined&&p.threadId!==scope.threadId)return;
        const v=body(method,p);if(!v)return;
        const workId=receipt(d,scope,v.turnId);if(workId===undefined)return;
        if(workId===null){
          // Do not import an earlier private conversation merely because this
          // session was attached later. Unknown producer time is not proof.
          const since=Date.parse(b.createdAt);
          if(!Number.isSafeInteger(when)||when<=0||!Number.isFinite(since)){issue='history_window_incomplete';return;}
          if(when<since)return;
        }
        this.append(r,{...v.body,id:eventId(this.serverId,scope,v.turnId,v.body),turnId:v.turnId,workId});
      };
      for(const e of [...items.data].reverse()){
        if(!e||!deliveryId(e.turnId)||typeof e.item?.type!=='string'){issue='history_window_incomplete';continue;}
        if(e.item.type!=='agentMessage')continue;
        const t=knownTurns.get(e.turnId);
        if(!(Number.isSafeInteger(e.completedAtMs)&&e.completedAtMs>0)&&!(t&&terminalExecution(t.status))){issue='history_window_incomplete';continue;}
        if(!deliveryId(e.item.id)||typeof e.item.text!=='string'){issue='history_window_incomplete';continue;}
        add('item/completed',e,e.completedAtMs??(t?.completedAt*1000));
      }
      for(const t of [...turns.data].reverse()){
        if(!deliveryId(t?.id)||typeof t.status!=='string'){issue='history_window_incomplete';continue;}
        add('turn/completed',{threadId:t.threadId,turn:t},t.completedAt*1000);
      }
      // Empty/missing historical evidence is a gap, never positive proof that a
      // possibly observed completion or expected final answer does not exist.
      if(r.gap && (!items.data.length&&!turns.data.length || owned.some(w=>{
        const md=w.messageDelivery!;
        if(!md.turnId||!terminalExecution(md.execution))return false;
        return !turns!.data.some(t=>t?.id===md.turnId&&t.status===md.execution&&(t.threadId===undefined||t.threadId===scope.threadId));
      })))issue??='history_window_incomplete';
      if(owned.some(w=>!w.messageDelivery!.turnId&&w.messageDelivery!.admission!=='rejected' || w.messageDelivery!.correlationConflict || mixed(w)))issue='ownership_uncertain';
      if(issue)this.gap(r,issue);
      else if(r.gap)this.gap(r,'observation_interrupted',true);
      // A fresh writer attachment is not assumed after reconnect. Periodic
      // caller-driven, coalesced readback also discovers later native activity.
      this.recoveredIn.set(id,{stamp:this.stamp(scope,d,epoch),until:Date.now()+5000});
    });
    this.wake(id);
  }
}
