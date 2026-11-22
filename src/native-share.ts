import { createHash, randomUUID } from 'node:crypto';
import { actionableQuestion,answerSpec,canOfferQuestion,closeQuestionEvidence,confirmQuestionPost,nativeAnswerPayload,newQuestionReference,
  observeQuestionEvidence,questionDigest,stageQuestionPost,type AnswerSpec } from './native-question-evidence.js';
import { deliveryId, terminalExecution } from './session-delivery.js';
import { waitForNativePersistence,type Subscription } from './subscriptions.js';
import { isThreadHistoryNotPersisted } from './rpc-diagnostics.js';
import type { Backend, Delivery, Source, State } from './types.js';
import type { Store } from './store.js';
import { projectNativeMessage, projectNativeItem, projectNativeInput, renderNativeProjection, type NativeProjection } from './shared-native-content.js';

export const nativeOutboxMarker = '[Native content record: matching Connector version and grant required]';
export const nativeBoundaryPolicy = 'owner-created-new-native-thread-v1' as const;
const supersededPolicy = 'first-verified-native-frontier-v1' as const;
const currentConsentVersion = 4 as const;
export const sharingDisclosure = 'Create a new, empty Codex session under the verified Home and project. Share its eligible replies and ordinary questions with readers of this exact Slack thread. No existing Codex session or history is shared. Input entered locally or through another client in the new session can influence shared replies. Once the new session exists, replies and still-open questions from it can be sent after setup, including work started while setup is running. Answer questions in the original Codex app.';
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
  state: 'pending' | 'active' | 'retired';
  consentVersion?: 2 | 3 | 4;
  boundaryPolicy?: typeof nativeBoundaryPolicy | typeof supersededPolicy;
  creationId?: string;
  activatedAt?: string;
  answerUsers?:string[];
  answerBirthEpoch?:string;
  // Only opaque item and original connection hashes, never a tool body.
  questionDeny?: {item:string;connection:string}[];
  questionDenySaturated?: true;
  reason?: string;
  observationalGap?: string;
  seenActive: string[];
}
export interface NativeShareCreation extends Route {
  id:string;
  project:string;
  recordedAt:string;
  policyKind:typeof nativeBoundaryPolicy;
  status:'preparing'|'creating'|'proven'|'failed'|'uncertain'|'revoked';
  reason?:string;
  resultSubscriptionId?:string;
  resultThreadId?:string;
  resultCreatedAt?:number;
  answerUsers?:string[];
  answerBirthEpoch?:string;
}
export interface NativeDelivery {
  grantId: string; key: string; projection: NativeProjection;
  part: number; parts: number;
  answerReplayEpoch?:string;
  request?: { epoch: string; rpcId: string | number };
}
type Callback = {
  route(sub: Subscription): Route | undefined;
  validateThread(sub: Subscription, thread: unknown): boolean;
  online(): boolean;
  joined(subId: string): boolean;
  provedPersistedTurn(subId:string,epoch:string):void;
  sameSlackConnection(): number;
  threadExists(channel: string, ts: string): Promise<boolean>;
  projectPath(alias:string):string|undefined;
  adoptFresh(thread:unknown,actor:Source,epoch:string,record:(state:State,sub:Subscription)=>void):Promise<Subscription>;
  queue(state: State, sub: Subscription, content: NativeDelivery, text: string): void;
  flush(): void;
  answerAllowed(userId:string):boolean;
  questionUIAvailable():boolean;
};
const MAX_PREVIEWS = 64, PREVIEW_TTL = 120_000, MAX_BYTES = 4 * 1024 * 1024;
const MAX_CREATIONS=100;
// Official Thread schema identifies Codex-created IDs as UUIDv7. Its fresh
// metadata can synthesize createdAt from the current clock; never use a
// changing wall-clock hint as identity or sharing authority.
const nativeUuid=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
// attachedToThreadId is experimental and omitted by the stable wire schema.
// Fresh birth is established by the positive thread/start RPC, not its absence.
const dedicatedIdentity=(thread:any,id:string)=>thread?.id===id&&nativeUuid(id)&&thread.sessionId===id&&thread.forkedFromId===null&&
  thread.parentThreadId===null&&(thread.attachedToThreadId===undefined||thread.attachedToThreadId===null)&&thread.ephemeral===false;
const PAGE = 8, MAX_PAGES = 5, MAX_ACTIVE_KEYS = 256, PENDING_LIMIT = 64, RESOLVED_LIMIT = 512, MAX_QUESTION_DENIALS = 512;
const hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const cursor = (x: unknown): x is string | null => x===null||typeof x==='string'&&x.length>0&&x.length<=1024&&!/[\x00-\x1f\x7f]/.test(x);
const fail = (reason: string): never => {throw new NativeShareError(reason);};
const validRequest = (x: unknown): x is string | number => deliveryId(x)||typeof x==='number'&&Number.isSafeInteger(x);
const reqKey = (r: {epoch: string; rpcId: string|number}) => JSON.stringify([r.epoch,r.rpcId]);
function hasCurrentConsent(row:NativeShare) {
  return row.consentVersion===currentConsentVersion&&row.boundaryPolicy===nativeBoundaryPolicy&&deliveryId(row.creationId)&&row.anchor===null;
}
const phraseFor=(r:Route,users?:readonly string[])=>'CREATE AND SHARE NEW CODEX SESSION TO '+r.workspaceId+'/'+r.channel+'/'+r.rootThreadTs+
  (users?.length?' WITH SLACK ANSWERS FROM '+users.join(','):'');
const answersValid=(list:unknown):list is string[]=>Array.isArray(list)&&list.length>=1&&list.length<=12&&
  list.every(x=>typeof x==='string'&&/^U[A-Z0-9]{1,39}$(?![\s\S])/.test(x))&&new Set(list).size===list.length;
const answerDisclosure='Only these exact Slack humans can submit the listed options of a still-open ordinary question from the dedicated new session. Free text, Other, tool requests, approvals and credentials stay in the original Codex window.';
const nativeAnswerKey=(row:NativeShare,p:NativeProjection)=>questionDigest([row.backendFingerprint,row.id,row.nativeThreadId,p.turnId,p.itemId]);
const epochStamp=(epoch:string)=>questionDigest(['observation-epoch',epoch]);
const requestStamp=(k:{epoch:string;rpcId:string|number})=>questionDigest(['server-request',k.epoch,k.rpcId]);
const inputDedup=(key:string,stamp:string)=>questionDigest([key,stamp]);
export interface NativeAnswerOrigin {teamId:string;appId:string;userId:string;channel:string;rootThreadTs:string;messageTs:string;reference:string}
export type NativeAnswerOutcome='submitted'|'closed'|'unconfirmed'|'denied';
const sameDestination=(a:Route,b:Route)=>a.serverId===b.serverId&&a.backendFingerprint===b.backendFingerprint&&a.workspaceId===b.workspaceId&&
  a.channel===b.channel&&a.rootThreadTs===b.rootThreadTs&&a.policy===b.policy&&a.slackIdentity===b.slackIdentity&&a.scope===b.scope;
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
  answer?:{key:string;spec:AnswerSpec};
}
interface Preview {expires:number; connection:number; revision:number; nativeEpoch:string; project:string;cwd:string;route:Route;answerUsers?:string[]}
interface TurnRow {id:string;status:string;itemsView:string;items:any[]}
const revokedCodes = new Set(['NATIVE_SHARE_THREAD_CHANGED','NATIVE_SHARE_SCOPE_CHANGED','NATIVE_SHARE_DESTINATION_UNVERIFIED']);
export function validateNativeShareState(s:State){
  const list=s.nativeShares,creations=s.nativeShareCreations;
  const digest=(x:unknown)=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
  const validAnswerGate=(x:NativeShare|NativeShareCreation)=> x.answerUsers===undefined&&x.answerBirthEpoch===undefined||
    answersValid(x.answerUsers)&&digest(x.answerBirthEpoch);
  const validRoute=(r:Route)=>!!r&&deliveryId(r.serverId)&&deliveryId(r.subscriptionId)&&deliveryId(r.nativeThreadId)&&
    deliveryId(r.workspaceId)&&deliveryId(r.channel)&&typeof r.rootThreadTs==='string'&&/^\d{1,20}\.\d{1,10}$/.test(r.rootThreadTs)&&
    digest(r.backendFingerprint)&&digest(r.policy)&&digest(r.scope)&&digest(r.slackIdentity);
  if(creations!==undefined&&(!Array.isArray(creations)||creations.length>MAX_CREATIONS||creations.some(c=>!validRoute(c)||!validAnswerGate(c)||!deliveryId(c.id)||
    typeof c.project!=='string'||!c.project||c.policyKind!==nativeBoundaryPolicy||typeof c.recordedAt!=='string'||!Number.isFinite(Date.parse(c.recordedAt))||
    !['preparing','creating','proven','failed','uncertain','revoked'].includes(c.status)||
    c.status==='proven'&&(!deliveryId(c.resultSubscriptionId)||!nativeUuid(c.resultThreadId)||!Number.isSafeInteger(c.resultCreatedAt)||(c.resultCreatedAt??0)<=0))||
    new Set(creations.map(c=>c.id)).size!==creations.length))throw new NativeShareError('NATIVE_SHARE_STATE_INVALID');
  if(list===undefined)return;
  if(!Array.isArray(list)||list.length>100||list.some(r=>!validRoute(r)||!validAnswerGate(r)||!deliveryId(r.id)||
    !Number.isSafeInteger(r.nativeCreatedAt)||r.nativeCreatedAt<=0||typeof r.grantedAt!=='string'||!Number.isFinite(Date.parse(r.grantedAt))||
    r.anchor!==null&&!deliveryId(r.anchor)||r.frontier!==null&&!deliveryId(r.frontier)||r.anchor!==null&&r.frontier===null||
    !['active','pending','retired'].includes(r.state)||!Array.isArray(r.seenActive)||r.seenActive.length>MAX_ACTIVE_KEYS||!r.seenActive.every(digest)||
    r.consentVersion!==undefined&&r.consentVersion!==2&&r.consentVersion!==3&&r.consentVersion!==currentConsentVersion||
    (r.consentVersion===currentConsentVersion?!hasCurrentConsent(r):r.consentVersion===3?r.boundaryPolicy!==supersededPolicy:r.boundaryPolicy!==undefined)||
    r.state==='pending'&&(r.consentVersion===undefined||r.anchor!==null||r.frontier!==null||r.activatedAt!==undefined||r.seenActive.length!==0)||
    r.state==='active'&&r.consentVersion!==undefined&&(typeof r.activatedAt!=='string'||!Number.isFinite(Date.parse(r.activatedAt)))||
    r.questionDenySaturated!==undefined&&r.questionDenySaturated!==true||
    r.questionDeny!==undefined&&(!Array.isArray(r.questionDeny)||r.questionDeny.length>MAX_QUESTION_DENIALS||
      r.questionDeny.some(e=>!e||!digest(e.item)||!digest(e.connection))||new Set(r.questionDeny.map(e=>e.item)).size!==r.questionDeny.length))||
    new Set(list.map(r=>r.id)).size!==list.length||new Set(list.map(r=>r.subscriptionId)).size!==list.length)throw new NativeShareError('NATIVE_SHARE_STATE_INVALID');
}
function verifiedCreation(row:NativeShare,state:Readonly<State>){
  return hasCurrentConsent(row)&&state.nativeShareCreations?.some(c=>c.id===row.creationId&&c.status==='proven'&&c.resultThreadId===row.nativeThreadId&&
    c.resultCreatedAt===row.nativeCreatedAt&&c.resultSubscriptionId===row.subscriptionId&&sameDestination(c,row)&&
    c.answerBirthEpoch===row.answerBirthEpoch&&JSON.stringify(c.answerUsers)===JSON.stringify(row.answerUsers));
}
export function retirePreGateSharing(s:State) {
  for(const c of s.nativeShareCreations??[]){
    // The preceding process may have dispatched exactly once; never replay
    // thread/start from an intent that did not record a positive response.
    if(c.status==='creating'){c.status='uncertain';c.reason='NATIVE_SHARE_CREATE_OUTCOME_UNCERTAIN';}
    else if(c.status==='preparing'){c.status='failed';c.reason='NATIVE_SHARE_CREATE_NOT_STARTED';}
  }
  for(const grant of s.nativeShares??[])if(!verifiedCreation(grant,s)&&grant.state!=='retired'){
    grant.state='retired';grant.reason='NATIVE_SHARE_EXPLICIT_REAUTHORIZATION_REQUIRED';
  }
  for(const o of s.outbox)if(o.nativeShare&&!s.nativeShares?.some(r=>r.id===o.nativeShare!.grantId&&verifiedCreation(r,s))&&o.status==='queued'){
    o.status='failed';o.error='NATIVE_SHARE_EXPLICIT_REAUTHORIZATION_REQUIRED';o.text='';delete o.nativeShare;
  }
}
export class NativeSharing {
  // Pending input is never reconstructed from historical item text. Only a
  // currently outstanding original request (or official live request replay)
  // can authorize a question. Transport callbacks invalidate synchronously.
  private pending = new Map<string,PendingNative>();
  private resolved = new Set<string>();
  private questionCounters=new Map<string,Record<string,number>>();
  private countQuestion(grantId:string,reason:string){
    const c=(this.questionCounters.get(grantId)??{});
    c[reason]=Math.min((c[reason]??0)+1,1_000_000);
    this.questionCounters.set(grantId,c);
  }
  private questionCoverageLost = false;
  private blocked = new Set<string>();
  private previews = new Map<string,Preview>();
  private consentRevision = new Map<string,number>();
  private ready = new Map<string,string>();
  private activating = new Map<string,Promise<void>>();
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
    }catch(e){
      if(e instanceof NativeShareError)throw e;
      if(method==='thread/turns/list'&&isThreadHistoryNotPersisted(e))return fail('NATIVE_SHARE_HISTORY_NOT_PERSISTED');
      return fail('NATIVE_SHARE_HISTORY_GAP');
    }
    finally{if(timer)clearTimeout(timer);}
  }
  private async metadata(sub:Subscription,w:Window){
    const {thread}=await this.rpc('thread/read',{threadId:sub.threadId,includeTurns:false},w);
    if(!thread||thread.id!==sub.threadId||!Number.isSafeInteger(thread.createdAt)||thread.createdAt<=0||!this.hooks.validateThread(sub,thread)){
      return fail('NATIVE_SHARE_THREAD_CHANGED');
    }
    return thread as {id:string;createdAt:number;sessionId?:string;status?:{type?:string;activeFlags?:string[]}};
  }
  private async dedicatedMetadata(sub:Subscription,w:Window){
    const thread=await this.metadata(sub,w);
    if(!dedicatedIdentity(thread,sub.threadId))return fail('NATIVE_SHARE_THREAD_CHANGED');
    return thread;
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
    if(verifiedCreation(r,state)&&r.state!=='retired'&&route&&equalRoute(route,r))return sub;
  }
  view(id: string) {
    const d=this.store.state,sub=this.findSub(d,id);
    if(!sub) return fail('NATIVE_SHARE_SUBSCRIPTION_NOT_FOUND');
    const row=d.nativeShares?.find(r=>r.subscriptionId===id);
    const scope=this.hooks.route(sub),recent=d.nativeShareCreations?.filter(c=>c.subscriptionId===id).at(-1);
    return {...(scope?publicRoute(scope):row?publicRoute(row):{subscriptionId:id,nativeThreadId:sub.threadId,channel:sub.owner.channel,rootThreadTs:sub.owner.threadTs}),
      dedicatedCreation:recent?this.creationView(recent):null,
      questionAnswerMode:row?.answerUsers?.length?'named-humans-choice-only':'original-codex-only',
      questionDiagnostics:row?structuredClone(this.questionCounters.get(row.id)??{}):{},
      status:!row?'unshared':row.state==='retired'?'retired':row.state==='pending'?'pending':!scope||!equalRoute(scope,row)||!this.backend.connected||!this.hooks.online()||!this.hooks.joined(id)?'paused':row.observationalGap?'gap':this.ready.get(row.id)===this.backend.epoch?'active':'checking',
      reason:row?.reason??sub.error??row?.observationalGap??null,
      observation:sub.error===waitForNativePersistence?
        this.hooks.joined(id)?'live-awaiting-persistence':'waiting-for-persisted-connection':
        this.hooks.joined(id)?'connected':'not-confirmed',
      activation:row?{consentRecordedAt:row.grantedAt,deliveryEnabledAt:row.activatedAt??null,
        boundaryPolicy:row.boundaryPolicy??null,
        nativeBoundary:verifiedCreation(row,d)?{kind:'positive-new-thread-response',threadId:row.nativeThreadId}:null}:null,
      questionsAfterReconnect:'Only if the official App Server provides a current outstanding request; historical question text is never replayed.',
      disclosure:sharingDisclosure};
  }
  private creationView(c:NativeShareCreation){
    return {creationId:c.id,status:c.status,reason:c.reason??null,project:c.project,workspaceId:c.workspaceId,channel:c.channel,rootThreadTs:c.rootThreadTs,
      newSubscriptionId:c.resultSubscriptionId??null,newNativeThreadId:c.resultThreadId??null};
  }
  async previewCreate(id: string,answerUsers?:string[]){
    if(answerUsers!==undefined&&(!answersValid(answerUsers)||answerUsers.some(user=>!this.hooks.answerAllowed(user))))return fail('NATIVE_QUESTION_ANSWER_USER_UNVERIFIED');
    const users=answerUsers?.slice().sort();
    const d=this.store.state,sub=this.findSub(d,id);
    if(!sub)return fail('NATIVE_SHARE_SUBSCRIPTION_NOT_FOUND');
    if(!this.hooks.online()||!this.backend.connected||!this.hooks.joined(id))return fail('NATIVE_SHARE_NOT_READY');
    const route=this.hooks.route(sub);
    if(!route)return fail('NATIVE_SHARE_IDENTITY_UNVERIFIED');
    const cwd=sub.project&&this.hooks.projectPath(sub.project)&&sub.cwd;
    if(!cwd)return fail('NATIVE_SHARE_DEDICATED_PROJECT_REQUIRED');
    for(const [key,value] of this.previews)if(value.expires<Date.now())this.previews.delete(key);
    if(this.previews.size>=MAX_PREVIEWS)return fail('NATIVE_SHARE_PREVIEW_LIMIT');
    const w=this.window(),connection=this.hooks.sameSlackConnection(),revision=this.consentRevision.get(id)??0;
    // This is only to identify the thread presented for consent. No history
    // or cursor obtained before consent can become an activation anchor.
    await this.metadata(sub,w);
    const current=this.findSub(this.store.state,id),latest=current&&this.hooks.route(current);
    if(!this.current(w)||!latest||!equalRoute(latest,route)||!this.hooks.joined(id)||connection!==this.hooks.sameSlackConnection()||revision!==(this.consentRevision.get(id)??0))return fail('NATIVE_SHARE_SCOPE_CHANGED');
    if(this.previews.size>=MAX_PREVIEWS)return fail('NATIVE_SHARE_PREVIEW_LIMIT');
    const confirmationId=randomUUID();
    this.previews.set(confirmationId,{expires:Date.now()+PREVIEW_TTL,connection,revision,nativeEpoch:w.epoch,project:sub.project!,cwd,route,answerUsers:users});
    return {...publicRoute(route),project:sub.project,action:'create-new-dedicated-session',confirmationId,confirmationPhrase:phraseFor(route,users),boundaryPolicy:nativeBoundaryPolicy,answerUsers:users??[],disclosure:users?sharingDisclosure.replace('Answer questions in the original Codex app.',answerDisclosure+' Authorized users: '+users.join(', ')+'.'):sharingDisclosure};
  }
  private async destination(r:Route) {
    try{if(await this.hooks.threadExists(r.channel,r.rootThreadTs))return;}catch{return fail('NATIVE_SHARE_DESTINATION_CHECK_UNAVAILABLE');}
    return fail('NATIVE_SHARE_DESTINATION_UNVERIFIED');
  }
  grantExisting():never{return fail('NATIVE_SHARE_EXISTING_SESSION_UNSUPPORTED');}
  async create(id:string,challenge:string,phrase:string) {
    const approval=this.previews.get(challenge);this.previews.delete(challenge);
    const r=approval?.route;
    if(!approval||!r||r.subscriptionId!==id||approval.expires<Date.now()||!this.hooks.online()||approval.connection!==this.hooks.sameSlackConnection()||
      phrase!==phraseFor(r,approval.answerUsers)||approval.answerUsers?.some(user=>!this.hooks.answerAllowed(user)))return fail('NATIVE_SHARE_CONFIRMATION_REQUIRED');
    const approved={...r,id:randomUUID(),project:approval.project,recordedAt:new Date().toISOString(),policyKind:nativeBoundaryPolicy,status:'preparing',...(approval.answerUsers?{answerUsers:approval.answerUsers,answerBirthEpoch:epochStamp(approval.nativeEpoch)}:{})} as const;
    const w=this.window();
    const scope=(d:Readonly<State>)=>{
      const sub=this.findSub(d,id),current=sub&&this.hooks.route(sub);
      return this.current(w)&&approval.nativeEpoch===w.epoch&&approval.revision===(this.consentRevision.get(id)??0)&&
        approval.connection===this.hooks.sameSlackConnection()&&sub&&current&&equalRoute(current,r)&&this.hooks.joined(id)&&
        sub.project===approval.project&&sub.cwd===approval.cwd&&this.hooks.projectPath(approval.project)?sub:undefined;
    };
    // First operation after the typed confirmation: durable consent for a
    // new session at this destination. There is no existing-thread cut.
    this.store.transaction(d=>{
      if(!scope(d))fail('NATIVE_SHARE_SCOPE_CHANGED');
      const rows=d.nativeShareCreations??=[];
      if(rows.length>=MAX_CREATIONS||(d.subscriptions?.length??0)>=100)fail('NATIVE_SHARE_CREATE_LIMIT');
      if(rows.some(x=>x.subscriptionId===id&&['preparing','creating','uncertain'].includes(x.status)))fail('NATIVE_SHARE_CREATE_ALREADY_PENDING');
      rows.push(approved);
    });
    let attempted=false;
    try {
      await this.destination(r);
      const source=this.findSub(this.store.state,id);
      if(!source||!scope(this.store.state))fail('NATIVE_SHARE_SCOPE_CHANGED');
      await this.metadata(source!,w);
      const previousIds=this.store.transaction(d=>{
        const intent=d.nativeShareCreations!.find(x=>x.id===approved.id);
        if(!intent||intent.status!=='preparing'||!scope(d))fail('NATIVE_SHARE_SCOPE_CHANGED');
        intent!.status='creating';
        return new Set([r.nativeThreadId,...(d.subscriptions??[]).map(x=>x.threadId),...d.sessions.map(x=>x.threadId),...(d.activity??[]).map(x=>x.threadId),...(d.nativeShareCreations??[]).map(x=>x.resultThreadId)]);
      });
      // Official v0.171.0-alpha.13: thread/start creates StartThreadOptions
      // with InitialHistory::New and allocates a new native ID. This is not
      // resume, fork, a notification, a timer or a persisted index snapshot.
      attempted=true;
      const {thread}=await this.backend.rpc('thread/start',{cwd:approval.cwd,ephemeral:false});
      if(!dedicatedIdentity(thread,thread?.id)||previousIds.has(thread.id)||!Number.isSafeInteger(thread.createdAt)||thread.createdAt<=0||
        !Array.isArray(thread.turns)||thread.turns.length!==0||!scope(this.store.state))fail('NATIVE_SHARE_CREATE_OUTCOME_UNCERTAIN');
      const joined=await this.hooks.adoptFresh(thread,source!.owner,w.epoch,(d,sub)=>{
        const intent=d.nativeShareCreations!.find(x=>x.id===approved.id),target=this.hooks.route(sub);
        if(!intent||intent.status!=='creating'||!scope(d)||!target||!sameDestination(target,r)||!this.hooks.validateThread(sub,thread))fail('NATIVE_SHARE_CREATE_OUTCOME_UNCERTAIN');
        intent!.status='proven';intent!.resultSubscriptionId=sub.id;intent!.resultThreadId=sub.threadId;intent!.resultCreatedAt=thread.createdAt;
        // Only now can pending structured questions for this fresh identity
        // be held in memory. There is still no delivery during observer setup.
        (d.nativeShares??=[]).push({...target!,id:randomUUID(),nativeCreatedAt:thread.createdAt,creationId:approved.id,
          ...(approved.answerUsers?{answerUsers:approved.answerUsers,answerBirthEpoch:approved.answerBirthEpoch}:{}),anchor:null,frontier:null,grantedAt:approved.recordedAt,consentVersion:currentConsentVersion,boundaryPolicy:nativeBoundaryPolicy,
          state:'pending',seenActive:[],observationalGap:'NATIVE_SHARE_SETUP_IN_PROGRESS'});
      });
      const created=this.store.state.nativeShares?.find(x=>x.subscriptionId===joined.id);
      if(created)await this.activate(created);
    }catch(e){
      this.store.transaction(d=>{
        const current=d.nativeShareCreations?.find(x=>x.id===approved.id);
        if(!current||current.status==='revoked')return;
        if(current.status==='proven'){
          const grant=d.nativeShares?.find(x=>x.creationId===current.id);
          if(grant?.state==='pending'){
            current.reason='NATIVE_SHARE_OBSERVATION_JOIN_FAILED';
            grant.observationalGap='NATIVE_SHARE_OBSERVATION_JOIN_FAILED';
          }
          return;
        }
        current.status=attempted?'uncertain':'failed';
        current.reason=attempted?'NATIVE_SHARE_CREATE_OUTCOME_UNCERTAIN':e instanceof NativeShareError?e.message:'NATIVE_SHARE_CREATE_NOT_STARTED';
      });
    }
    const result=this.store.state.nativeShareCreations!.find(c=>c.id===approved.id)!;
    return {...this.creationView(result),sharing:result.resultSubscriptionId?this.view(result.resultSubscriptionId):null};
  }
  private activate(row:NativeShare){
    const existing=this.activating.get(row.id);if(existing)return existing;
    const next=this.activateOne(row).finally(()=>this.activating.delete(row.id));
    this.activating.set(row.id,next);return next;
  }
  private async activateOne(row:NativeShare) {
    const d=this.store.state,w=this.window();
    if(!this.current(w)||!this.hooks.online())return;
    const actual=d.nativeShares?.find(x=>x.id===row.id&&x.state==='pending');
    if(!actual)return;
    const sub=this.currentRoute(actual,d);
    if(!sub)return this.failRefresh(row,'NATIVE_SHARE_SCOPE_CHANGED');
    if(!this.hooks.joined(sub.id))return;
    const slackConnection=this.hooks.sameSlackConnection();
    try{
      await this.destination(actual);
      await this.dedicatedMetadata(sub,w);
      // The positively confirmed new thread is the boundary. Ordered pages
      // may omit native active turns and are never used to authorize.
      if(!this.current(w)||slackConnection!==this.hooks.sameSlackConnection())return;
      const didActivate=this.store.transaction(draft=>{
        const latest=draft.nativeShares?.find(x=>x.id===row.id&&x.state==='pending');
        if(!latest||!this.currentRoute(latest,draft)||!this.hooks.joined(latest.subscriptionId))return false;
        latest.state='active';latest.activatedAt=new Date().toISOString();
        delete latest.observationalGap;
        return true;
      });
      if(didActivate){this.ready.set(row.id,w.epoch);this.kick(row.nativeThreadId);}
    }catch(e){
      if(this.current(w)&&slackConnection===this.hooks.sameSlackConnection())this.failRefresh(row,e instanceof NativeShareError?e.message:'NATIVE_SHARE_HISTORY_GAP');
    }
  }
  revoke(id:string){
    const inFlight=this.store.transaction(d=>{
      if(!this.findSub(d,id))fail('NATIVE_SHARE_SUBSCRIPTION_NOT_FOUND');
      const row=d.nativeShares?.find(r=>r.subscriptionId===id);
      this.consentRevision.set(id,(this.consentRevision.get(id)??0)+1);
      for(const [key,p] of this.previews)if(p.route.subscriptionId===id)this.previews.delete(key);
      let mayCreate=false;
      for(const c of d.nativeShareCreations??[])if(c.subscriptionId===id){
        const grant=d.nativeShares?.find(x=>x.creationId===c.id&&x.state==='pending');
        if(c.status==='preparing'||c.status==='creating'||c.status==='uncertain'||c.status==='proven'&&grant){
          mayCreate||=c.status==='creating'||c.status==='uncertain';
          c.status='revoked';c.reason='NATIVE_SHARE_REVOKED';
          if(grant)this.retire(d,grant,'NATIVE_SHARE_REVOKED');
        }
      }
      if(row)this.retire(d,row,'NATIVE_SHARE_REVOKED');
      return {inFlightMayStillCreate:mayCreate,inFlightMayStillArrive:!!row&&d.outbox.some(o=>o.nativeShare?.grantId===row.id&&['sending','uncertain'].includes(o.status))};
    });
    this.hooks.flush();
    return {...this.view(id),...inFlight};
  }
  private retire(d:State,row:NativeShare,reason:string) {
    row.state='retired';row.reason=reason;
    // A revoked queued payload is no longer necessary. Keep only the receipt.
    for(const o of d.outbox)if(o.nativeShare?.grantId===row.id&&o.status==='queued'){
      o.status='failed';o.error=reason;o.text='';delete o.nativeShare;
    }
    this.ready.delete(row.id);
  }
  private questionKey(row:NativeShare,turnId:string,itemId:string){
    // A freshly joined transport has its own RPC IDs, but the verified native
    // thread incarnation and its item IDs survive transport reconnects.
    return hash([row.backendFingerprint,row.nativeThreadId,row.nativeCreatedAt,turnId,itemId]);
  }
  private questionAllowed(row:NativeShare,turnId:string,itemId:string){
    return !row.questionDenySaturated&&!row.questionDeny?.some(e=>e.item===this.questionKey(row,turnId,itemId));
  }
  private rememberNonQuestions(threadId:unknown,turnId:unknown,itemIds:readonly unknown[],epoch:string){
    if(epoch!==this.backend.epoch||!this.backend.connected||!deliveryId(threadId)||!deliveryId(turnId))return;
    const ids=new Set(itemIds.filter(deliveryId));
    if(!ids.size)return;
    for(const [key,q] of this.pending)if(q.threadId===threadId&&q.projection.turnId===turnId&&ids.has(q.projection.itemId))this.pending.delete(key);
    const applicable=(r:NativeShare)=>hasCurrentConsent(r)&&r.state!=='retired'&&r.nativeThreadId===threadId&&r.frontier!==turnId&&!r.questionDenySaturated;
    if(!this.store.state.nativeShares?.some(r=>applicable(r)&&[...ids].some(id=>this.questionAllowed(r,turnId,id))))return;
    const connection=hash(epoch);
    this.store.transaction(d=>{
      for(const row of d.nativeShares??[])if(applicable(row)){
        const observed=row.questionDeny??=[];
        const keys=new Set(observed.map(e=>e.item));
        for(const id of ids){
          const item=this.questionKey(row,turnId,id);
          if(keys.has(item))continue;
          if(observed.length>=MAX_QUESTION_DENIALS){
            // Never forget a known deny to make room for an ambiguous request.
            // Reply bodies stay available; structured input is closed until
            // an operator explicitly starts a new verified boundary.
            row.questionDenySaturated=true;
            break;
          }
          keys.add(item);observed.push({item,connection});
        }
      }
    });
  }
  /** Hard invalidation on the frame callback, before any async event work. */
  observe(method:string,p:any,epoch:string){
    if(epoch!==this.backend.epoch)return;
    if(method==='serverRequest/resolved'&&validRequest(p?.requestId)){
      const key=reqKey({epoch,rpcId:p.requestId}),pending=this.pending.get(key);
      if(pending&&pending.threadId===p.threadId){
        this.finishObservedQuestion(pending);
        this.pending.delete(key);
      }
      // Delay/replay in the same connection cannot re-open an already resolved
      // request. Once this bound is exceeded, require a fresh observation epoch
      // rather than evicting the evidence that a request closed.
      if(deliveryId(p.threadId)&&this.store.state.nativeShares?.some(s=>s.state!=='retired'&&s.nativeThreadId===p.threadId)){
        if(this.resolved.size<RESOLVED_LIMIT)this.resolved.add(JSON.stringify([p.threadId,key]));
        else{this.questionCoverageLost=true;this.pending.clear();}
      }
      return;
    }
    if((method==='item/started'||method==='item/completed')&&typeof p?.item?.type==='string'&&!['agentMessage','userMessage'].includes(p.item.type)){
      this.rememberNonQuestions(p.threadId,p.turnId,[p.item.id],epoch);
    }
    if(method==='turn/completed')for(const [k,q] of this.pending)if(q.threadId===p?.threadId&&q.projection.turnId===p?.turn?.id){this.finishObservedQuestion(q);this.pending.delete(k);}
    if(['thread/rolledBack','thread/reverted','thread/archived','thread/closed'].includes(method)&&deliveryId(p?.threadId)){
      const affected=this.store.state.nativeShares?.filter(r=>r.state!=='retired'&&r.nativeThreadId===p.threadId);
      if(affected?.length){
        this.blocked.add(p.threadId);
        this.store.transaction(d=>{for(const row of d.nativeShares??[])if(row.state!=='retired'&&row.nativeThreadId===p.threadId)this.retire(d,row,'NATIVE_SHARE_THREAD_CHANGED');});
        this.blocked.delete(p.threadId);
      }
    }
    if(method==='turn/completed'||method==='item/completed'&&p?.item?.type==='agentMessage')this.kick(p?.threadId);
  }
  private finishObservedQuestion(q:PendingNative){
    if(q.answer)this.store.transaction(d=>{
      const proof=d.nativeQuestionAnswers?.find(a=>a.key===q.answer!.key);
      if(proof&&proof.digest===q.answer!.spec.digest)closeQuestionEvidence(proof,Date.now());
    });
  }
  request(r:any){
    if(this.closed||!this.backend.connected||r?.epoch!==this.backend.epoch||!validRequest(r.id)||!deliveryId(r.params?.threadId))return;
    const state=this.store.state;
    const possible=state.nativeShares?.filter(row=>row.nativeThreadId===r.params.threadId&&this.currentRoute(row,state));
    if(possible?.length!==1)return;
    const grant=possible[0]!;
    if(r.method!=='item/tool/requestUserInput')return;
    this.countQuestion(grant.id,'received');
    if(this.questionCoverageLost){this.countQuestion(grant.id,'coverageGap');return;}
    const projection=projectNativeInput(r.method,r.params);
    if(!projection){this.countQuestion(grant.id,'unsupportedOrSensitive');return;}
    if(!this.questionAllowed(grant,projection.turnId,projection.itemId)){this.countQuestion(grant.id,'toolOrUnsafeItem');return;}
    const key={epoch:r.epoch,rpcId:r.id},k=reqKey(key),prior=this.pending.get(k);
    if(this.resolved.has(JSON.stringify([r.params.threadId,k]))){this.countQuestion(grant.id,'alreadyClosed');return;}
    const spec=grant.answerUsers?.some(user=>this.hooks.answerAllowed(user))?answerSpec(r.params,projection):undefined;
    const stamp=epochStamp(r.epoch),qkey=nativeAnswerKey(grant,projection);
    if(prior){
      if(prior.threadId!==r.params.threadId||hash(prior.projection)!==hash(projection)||prior.answer?.spec.digest!==spec?.digest){
        this.finishObservedQuestion(prior);this.pending.delete(k);
        if(prior.answer)this.store.transaction(d=>{const row=d.nativeQuestionAnswers?.find(x=>x.key===prior.answer!.key);if(row?.status==='observed'||row?.status==='posted'||row?.status==='posting')row.status='changed';});
        this.countQuestion(grant.id,'changedRequest');
      }
      return;
    }
    if(this.pending.size>=PENDING_LIMIT){this.countQuestion(grant.id,'capacityGap');this.markGap(r.params.threadId,'NATIVE_SHARE_QUESTION_GAP');return;}
    const now=Date.now();
    const proof=spec&&this.store.transaction(d=>observeQuestionEvidence(d,qkey,spec.digest,stamp,now,r.params.autoResolutionMs,grant.answerBirthEpoch===stamp));
    const deadline=typeof r.params.autoResolutionMs==='number'&&r.params.autoResolutionMs>0?now+r.params.autoResolutionMs:undefined;
    const answer=proof&&spec?{key:qkey,spec}:undefined;
    this.pending.set(k,{key,projection,threadId:r.params.threadId,answerDeadline:deadline,...(answer?{answer}:{})});
    this.kick(r.params.threadId);
  }
  disconnected(){this.ready.clear();this.pending.clear();this.previews.clear();this.resolved.clear();this.questionCoverageLost=false;}
  private markGap(threadId:string,error:string) {
    this.store.transaction(d=>{for(const row of d.nativeShares??[])if(row.state==='active'&&row.nativeThreadId===threadId)row.observationalGap=error;});
  }
  tick(){if(Date.now()-this.lastSweep>=5000)this.kick();}
  private kick(threadId?:string) {
    if(this.closed||!this.hooks.online()||!this.backend.connected||!this.store.state.nativeShares?.some(r=>r.state!=='retired'&&(!threadId||r.nativeThreadId===threadId)))return;
    if(this.sweep){this.dirty=true;return;}
    this.lastSweep=Date.now();
    this.sweep=Promise.resolve().then(async()=>{
      const rows=this.store.state.nativeShares?.filter(r=>r.state!=='retired')??[];
      // Small independent batches. A single unsupported history RPC cannot
      // block other registries or make unbounded in-flight calls.
      for(let i=0;i<rows.length&&!this.closed;i+=3)await Promise.all(rows.slice(i,i+3).map(r=>r.state==='pending'?this.activate(r):this.refresh(r)));
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
    const d=this.store.state,actual=d.nativeShares?.find(x=>x.id===row.id&&x.state==='active'),sub=actual&&this.currentRoute(actual,d);
    if(!actual)return;
    if(!sub)return this.failRefresh(row,'NATIVE_SHARE_SCOPE_CHANGED');
    if(!this.hooks.joined(sub.id))return;
    try{
      const meta=await this.dedicatedMetadata(sub,w);
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
        if(!upstream.next){if(row.frontier===null)known=true;else if(!known)fail('NATIVE_SHARE_THREAD_CHANGED');break;}
        if(pageCursors.has(upstream.next))fail('NATIVE_SHARE_HISTORY_GAP');
        pageCursors.add(upstream.next);after=upstream.next;
      }
      if(!known)fail('NATIVE_SHARE_HISTORY_GAP');
      if(frame.length&&this.current(w))this.hooks.provedPersistedTurn(sub.id,w.epoch);
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
        this.rememberNonQuestions(sub.threadId,a.id,[...nativeToolItems],w.epoch);
      }
      // The official ordered index can lag a live request. Causal creation
      // already proves all turns of this dedicated thread are post-consent;
      // the exact same-connection request is held only while unresolved.
      // Delivery still rechecks native waiting status, matching tool evidence,
      // and the current grant. Never reconstruct a question from history.
      const waitingOnInput=meta.status?.type==='active'&&meta.status.activeFlags?.includes('waitingOnUserInput');
      let eligibleQuestion=false;
      if(waitingOnInput){
        for(const q of this.pending.values())if(q.threadId===sub.threadId&&(!a||q.projection.turnId===a.id)&&
          q.projection.turnId!==row.frontier&&!terminal.some(t=>t.id===q.projection.turnId)&&this.keyLive(q,sub)&&this.questionAllowed(row,q.projection.turnId,q.projection.itemId)){
          eligibleQuestion=true;projections.push({p:q.projection,current:q});
        }
      }
      await this.dedicatedMetadata(sub,w);
      this.store.transaction(draft=>{
        const current=draft.nativeShares?.find(r=>r.id===row.id),actual=current&&this.currentRoute(current,draft);
        if(!current||current.state!=='active'||!actual||!this.current(w)||!this.hooks.joined(sub.id)||current.frontier!==row.frontier)return;
        const activeSeen=new Set(current.seenActive);
        for(const {p,current:q} of projections){
          const baseKey=dedupe(current.id,p);
          if(q&&(!this.keyLive(q,actual)||!this.questionAllowed(current,p.turnId,p.itemId)))continue;
          const original=draft.outbox.filter(o=>o.nativeShare?.grantId===current.id&&o.nativeShare.key===baseKey);
          const answerProof=q?.answer&&draft.nativeQuestionAnswers?.find(x=>x.key===q.answer!.key);
          const stamp=q&&this.answerConnection(q.key.epoch);
          // An open, freshly replayed callback may get a replacement card in
          // the same Slack thread only if the original post was definite and
          // no answer was attempted. The previous card's ref never follows it.
          const renewal=stamp&&q?.answer&&original.length===1&&original[0]?.status==='sent'&&(original[0].nativeShare?.request?.epoch!==q.key.epoch||answerProof?.status==='observed'||answerProof?.epoch!==stamp)&&
            canOfferQuestion(answerProof,stamp,q.answer.spec.digest,Date.now())&&this.hooks.questionUIAvailable()&&parts(p).length===1?stamp:undefined;
          const key=renewal?inputDedup(baseKey,renewal):baseKey;
          const previous=renewal?draft.outbox.filter(o=>o.nativeShare?.grantId===current.id&&o.nativeShare.key===key):original;
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
          chunks.forEach((text,part)=>this.hooks.queue(draft,actual,{grantId:current.id,key,projection:p,part,parts:chunks.length,...(q?{request:q.key}:{}),...(renewal?{answerReplayEpoch:renewal}:{})},text));
        }
        current.frontier=frontier;
        current.seenActive=[...activeSeen].filter(key=>draft.outbox.some(o=>o.nativeShare?.grantId===current.id&&o.nativeShare.key===key&&o.nativeShare.projection.turnId===a?.id));
        if(this.questionCoverageLost||current.questionDenySaturated)current.observationalGap='NATIVE_SHARE_QUESTION_GAP';
        else if(waitingOnInput&&!eligibleQuestion)current.observationalGap='NATIVE_SHARE_QUESTION_REPLAY_UNCONFIRMED';
        else if(activeContinuity)delete current.observationalGap;
        else current.observationalGap='NATIVE_SHARE_ACTIVE_ITEMS_GAP';
      });
      if(this.current(w)&&this.currentRoute(row,this.store.state))this.ready.set(row.id,w.epoch);
    }catch(e){this.failRefresh(row,e instanceof NativeShareError?e.message:'NATIVE_SHARE_HISTORY_GAP');}
  }
  private failRefresh(row:NativeShare,reason:string) {
    this.ready.delete(row.id);
    const saved=this.store.state.nativeShares?.find(r=>r.id===row.id);
    if(!saved||saved.state==='retired'||saved.observationalGap===reason)return;
    this.store.transaction(d=>{
      const current=d.nativeShares?.find(r=>r.id===row.id);
      if(!current||current.state==='retired')return;
      if(revokedCodes.has(reason))this.retire(d,current,reason);
      else current.observationalGap=reason;
    });
  }
  /** No async calls in this final predicate. Call after prepare() and immediately
   * before invoking the Slack adapter. Text must match the same projection, not
   * a cached arbitrary command result or a forged notification body. */
  deliveryAllowed(o:Delivery,d:Readonly<State>) {
    const n=o.nativeShare,row=n&&d.nativeShares?.find(r=>r.id===n.grantId),sub=row&&this.currentRoute(row,d);
    if(!n||!row||row.state!=='active'||!sub||!this.backend.connected||this.ready.get(row.id)!==this.backend.epoch||!this.hooks.joined(sub.id)||
      o.subscriptionId!==sub.id||o.notificationThreadId!==row.nativeThreadId||o.channel!==row.channel||o.threadTs!==row.rootThreadTs||
      !o.origin||o.origin.kind!==sub.owner.kind||o.origin.userId!==sub.owner.userId||o.origin.channel!==sub.owner.channel||o.origin.threadTs!==sub.owner.threadTs||o.root)return false;
    const cols=parts(n.projection);
    const baseKey=dedupe(row.id,n.projection);
    const expectedKey=n.answerReplayEpoch&&n.projection.kind==='input'&&n.request&&n.answerReplayEpoch===this.answerConnection(n.request.epoch)?
      inputDedup(baseKey,n.answerReplayEpoch):baseKey;
    if(o.text!==nativeOutboxMarker||!Number.isSafeInteger(n.part)||n.part<0||cols.length!==n.parts||!cols[n.part]||n.key!==expectedKey)return false;
    if(n.projection.kind==='input'){
      if(!this.questionAllowed(row,n.projection.turnId,n.projection.itemId))return false;
      const pending=n.request&&this.pending.get(reqKey(n.request));
      return !!pending&&this.keyLive(pending,sub)&&hash(pending.projection)===hash(n.projection);
    }
    return !n.request;
  }
  wireBody(o:Delivery,d:Readonly<State>){
    if(!o.nativeShare||!this.deliveryAllowed(o,d))return;
    return parts(o.nativeShare.projection)[o.nativeShare.part];
  }
  private answerConnection(epoch:string){return questionDigest(['answer-connection',epoch,this.hooks.sameSlackConnection()]);}
  private answerParts(o:Delivery,d:Readonly<State>){
    const n=o.nativeShare,row=n&&d.nativeShares?.find(g=>g.id===n.grantId);
    if(!n||!row||n.projection.kind!=='input'||n.part!==0||n.parts!==1||!n.request||!row.answerUsers?.length)return;
    const q=this.pending.get(reqKey(n.request));if(!q?.answer||q.threadId!==row.nativeThreadId||hash(q.projection)!==hash(n.projection))return;
    const evidence=d.nativeQuestionAnswers?.find(a=>a.key===q.answer!.key);
    return{n,row,q,evidence};
  }
  /** Called in the same durable transaction as claiming the Slack outbox POST. */
  stageAnswerCard(o:Delivery,d:State){
    if(!this.hooks.questionUIAvailable()||!this.deliveryAllowed(o,d))return;
    const parts=this.answerParts(o,d);
    if(!parts)return;
    const {row,q,evidence}=parts;
    const stamp=this.answerConnection(q.key.epoch);
    if(!row.answerUsers?.some(user=>this.hooks.answerAllowed(user))||!evidence||
      !canOfferQuestion(evidence,stamp,q.answer!.spec.digest,Date.now())){
      this.countQuestion(row.id,'nativeOnly');return;
    }
    const reference=newQuestionReference();
    stageQuestionPost(evidence,{epoch:stamp,request:requestStamp(q.key),deliveryId:o.id,reference:questionDigest(reference)});
    return {reference,questionCount:q.answer!.spec.questions.length};
  }
  acknowledgeQuestionPost(o:Delivery,d:State,ts:string){
    const r=o.nativeShare&&d.nativeShares?.find(g=>g.id===o.nativeShare!.grantId);
    if(!r||o.nativeShare!.projection.kind!=='input')return;
    this.countQuestion(r.id,'posted');
    const evidence=d.nativeQuestionAnswers?.find(a=>a.deliveryId===o.id);
    if(evidence&&ts!==r.rootThreadTs&&confirmQuestionPost(evidence,o.id,ts))this.countQuestion(r.id,'answerCardPosted');
  }
  hasQuestionReference(reference:string){
    if(typeof reference!=='string'||!/^[A-Za-z0-9_-]{32}$(?![\s\S])/.test(reference))return false;
    return this.store.state.nativeQuestionAnswers?.some(x=>x.reference===questionDigest(reference))===true;
  }
  private answerLookup(origin:NativeAnswerOrigin,d:Readonly<State>){
    if(typeof origin?.reference!=='string'||!/^[A-Za-z0-9_-]{32}$(?![\s\S])/.test(origin.reference)||
      !this.hooks.questionUIAvailable()||!this.hooks.answerAllowed(origin.userId))return;
    const refHash=questionDigest(origin.reference);
    const evidence=d.nativeQuestionAnswers?.find(a=>a.reference===refHash);
    const card=evidence?.deliveryId&&d.outbox.find(o=>o.id===evidence.deliveryId);
    if(!evidence||!card||card.status!=='sent'||card.deliveryEvidence!=='slack-api-ack'||card.ts!==origin.messageTs||evidence.messageTs!==card.ts||
      card.threadTs!==origin.rootThreadTs||card.channel!==origin.channel)return;
    const n=card.nativeShare,row=n&&d.nativeShares?.find(g=>g.id===n.grantId),sub=row&&this.currentRoute(row,d);
    if(!n||!row||!sub||row.state!=='active'||row.workspaceId!==origin.teamId||row.channel!==origin.channel||
      row.rootThreadTs!==origin.rootThreadTs||!row.answerUsers?.includes(origin.userId)||!this.hooks.joined(row.subscriptionId)||
      n.projection.kind!=='input'||nativeAnswerKey(row,n.projection)!==evidence.key)return;
    return{card,row,sub,evidence,refHash,actor:questionDigest(['answer-actor',origin.teamId,origin.userId])};
  }
  private writableQuestion(origin:NativeAnswerOrigin,d:Readonly<State>){
    const item=this.answerLookup(origin,d);
    if(!item||!this.deliveryAllowed(item.card,d))return;
    const q=this.answerParts(item.card,d)?.q;
    if(!q?.answer||!actionableQuestion(item.evidence,{refHash:item.refHash,epoch:this.answerConnection(q.key.epoch),
      request:requestStamp(q.key),messageTs:origin.messageTs,digest:q.answer.spec.digest},Date.now()))return;
    // A usable card requires no current ambiguous native evidence. A missed
    // live callback may be displayed as a gap but cannot be answered.
    if(item.row.observationalGap||item.row.questionDenySaturated)return;
    return{...item,q};
  }
  async openQuestion(origin:NativeAnswerOrigin){
    const initial=this.writableQuestion(origin,this.store.state);
    if(!initial||await this.prepare(initial.card)!=='ready')return;
    const exact=this.writableQuestion(origin,this.store.state);
    if(!exact||exact.evidence.key!==initial.evidence.key||exact.q.projection.kind!=='input')return;
    return {questions:exact.q.projection.questions};
  }
  private rememberedOutcome(origin:NativeAnswerOrigin,d:Readonly<State>):NativeAnswerOutcome|undefined{
    const old=this.answerLookup(origin,d);
    if(!old||old.evidence.claimedBy!==old.actor)return;
    if(old.evidence.status==='submitted')return 'submitted';
    if(['submitting','uncertain'].includes(old.evidence.status))return 'unconfirmed';
  }
  async submitQuestion(origin:NativeAnswerOrigin,choices:readonly number[]):Promise<NativeAnswerOutcome>{
    const latest=this.store.state;
    const known=this.rememberedOutcome(origin,latest);if(known)return known;
    const prior=this.writableQuestion(origin,latest);
    if(!prior)return this.answerLookup(origin,latest)?'closed':'denied';
    if(!nativeAnswerPayload(prior.q.answer!.spec,choices))return 'denied';
    if(await this.prepare(prior.card)!=='ready')return 'closed';
    // No await from the final exact checks through consuming the receipt and
    // invoking the epoch-bound native write. The server's callback registry
    // is the only authority on who wins a simultaneous native submission.
    const claimed=this.store.transaction(d=>{
      const same=this.writableQuestion(origin,d);
      if(!same||same.evidence.key!==prior.evidence.key||same.refHash!==prior.refHash||reqKey(same.q.key)!==reqKey(prior.q.key))return;
      const payload=nativeAnswerPayload(same.q.answer!.spec,choices);if(!payload)return;
      same.evidence.status='submitting';same.evidence.claimedBy=same.actor;
      return {key:same.evidence.key,ref:same.refHash,payload,native:same.q.key};
    });
    if(!claimed)return this.rememberedOutcome(origin,this.store.state)??'closed';
    let submitted=false;
    try{
      await this.backend.respond(claimed.native.rpcId,claimed.payload,claimed.native.epoch);
      submitted=this.backend.connected&&this.backend.epoch===claimed.native.epoch;
    }catch{/* Dispatch may have happened; never retry it. */}
    this.store.transaction(d=>{
      const row=d.nativeQuestionAnswers?.find(q=>q.key===claimed.key&&q.reference===claimed.ref);
      if(row?.status==='submitting')row.status=submitted?'submitted':'uncertain';
    });
    return submitted?'submitted':'unconfirmed';
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
      const meta=await this.dedicatedMetadata(sub,w);
      if(n!.projection.kind==='input'){
        if(meta.status?.type!=='active'||!meta.status.activeFlags?.includes('waitingOnUserInput'))return 'refuse';
        // A matching tool item or unknown shape can arrive while the Slack
        // root read is in progress. Never mistake it for a regular question.
        const input=n!.projection;
        const nonQuestions=(await this.items(sub,input.turnId,w)).filter(entry=>!['agentMessage','userMessage'].includes(entry.item.type)).map(entry=>entry.item.id);
        this.rememberNonQuestions(sub.threadId,input.turnId,nonQuestions,w.epoch);
        if(nonQuestions.includes(input.itemId))return 'refuse';
      }
      return this.current(w)&&connection===this.hooks.sameSlackConnection()?'ready':'pause';
    }catch(e){const code=e instanceof NativeShareError?e.message:'NATIVE_SHARE_HISTORY_GAP';this.failRefresh(row,code);return revokedCodes.has(code)?'refuse':'pause';}
  }
  async close(){this.closed=true;this.disconnected();await this.sweep;await Promise.allSettled(this.activating.values());}
}
