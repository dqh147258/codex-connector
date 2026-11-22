import { ScreenError, validateScreenImages, type ScreenPort } from './screens.js';
import { LocalEvents } from './local-events.js';
import { realpathSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve,relative,isAbsolute,sep } from 'node:path';
import { RecentSessions, RecentError } from './session-recent.js';
import { classifyNativeThread,nativeRootError } from './thread-classification.js';
import { deliveryId, deliveryStatus, deliveryView, observeMessage, observeTurn, terminalExecution, type MessageDelivery } from './session-delivery.js';
import { recordActivity } from './session-activity.js';
import { SessionSearch } from './session-search.js';
import { SessionContent, SessionContentError } from './session-content.js';
import { SessionSubscriptions, SubscriptionError, type Subscription } from './subscriptions.js';
import { NativeSharing, nativeOutboxMarker, type NativeDelivery } from './native-share.js';
import { Store } from './store.js';
import { compactResult, storeResult, readResult, nextResultQuery, nextResultCommand, resultPolicy, resultSensitive, SLACK_SCOPE_VERSION } from './slack-results.js';
import { ReadonlyFiles, FileAccessError, containsSensitiveContent } from './files.js';
import { parseEnvelope, validateCommand, ProtocolError, formatHelp, COMMANDS, START_MARKER, END_MARKER, type CommandEnvelope } from './protocol.js';
import { BackendError } from './codex.js';
import { formatRpcDiagnostic } from './rpc-diagnostics.js';
import { parseSlackEnvelope, isSlackAddressed, SlackTransportError, SLACK_TRANSPORT_REVISION } from './slack-envelope.js';
import { isSlackRootPermissionDenial } from './slack.js';
import type { Backend, Config, Delivery, LocalPrincipal, Pending, Session, SlackPort, SlackTurnProof, SlackVisibilityScope, Source, State, Work } from './types.js';
export class ConnectorError extends Error { constructor(readonly code:string){super(code);} }
const codeOf=(e:unknown)=>e instanceof ScreenError||e instanceof RecentError||e instanceof SessionContentError||e instanceof SubscriptionError||e instanceof ConnectorError||e instanceof BackendError||e instanceof FileAccessError ? e.code : 'OPERATION_FAILED';
const decisionCommands=new Set(['approval.respond','input.respond']);
const boundCommands=new Set(['session.delivery','session.info','session.history','session.send','session.steer','session.queue','session.interrupt','session.reply']);
function short(value:unknown,max=20000){const text=typeof value==='string'?value:JSON.stringify(value,null,2);return text.length>max?text.slice(0,max)+'\n[truncated; request a smaller page]':text;}
export interface RuntimeContext {
  id:string; backendFingerprint?:string; slackConnection?():number; protectedHomes?:readonly string[]; unknownHome?:boolean; slackReady():boolean; servers(source:Source):unknown; principal(id:string):LocalPrincipal|undefined;
  route(serverId:unknown,command:string):'accept'|'other'|'reject'; defaultRoute:boolean;
}
const stable=(v:unknown):string=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a<b?-1:a>b?1:0)):x);
interface OutputEvidence { proof?:SlackTurnProof }
const nativeContentCommands=new Set(['session.history','session.messages','session.overview','session.search']);
const nativeNotice={
  'progress':'Codex reported progress. Open the original Codex UI to read the output.',
  'final':'A Codex answer is ready. Open the original Codex UI to read it.',
  'completed':'The Codex turn completed.',
  'failed':'The Codex turn failed. Inspect the original Codex UI.',
  'interrupted':'The Codex turn was interrupted.',
  'error':'Codex reported an execution error. Inspect the original Codex UI.',
  'decision':'LOCAL_ACTION_REQUIRED: open the original Codex UI for this request.',
  'deadline':'The Connector reminder expired. Check the original Codex UI. No native action was taken.'
} as const;
type NativeNotice=keyof typeof nativeNotice;
const safeThreadStatus=(value:unknown)=>typeof value==='string'&&['active','idle','notLoaded','systemError','unknown'].includes(value)?value:'unknown';
const safeTurnStatus=(value:unknown)=>typeof value==='string'&&['inProgress','completed','failed','interrupted'].includes(value)?value:'unknown';
const localTools=new Set(['server.list','session.list','session.attach','session.create','session.history','session.info','session.send','session.queue','session.interrupt','session.steer','session.delivery']);
export class Connector {
  private running=new Map<string,Promise<void>>();private delivering?:Promise<void>;private closing=false;private lastPost=0;
  private deliveryTurns=new Map<string,{threadId:string;turn:{id:string;status:string};conflict?:true}>();
  private events=Promise.resolve();
  private slackInputs=new Map<string,{items:Map<string,string|null>;overflow:boolean}>();private attached=new Set<string>();private verifiedRoots=new Map<string,string>();private items=new Map<string,any>();
  readonly localEvents?:LocalEvents;
  readonly nativeSharing?:NativeSharing;
  readonly files:ReadonlyFiles;
  readonly subscriptions:SessionSubscriptions;
  readonly content:SessionContent;
  readonly search:SessionSearch;
  readonly recent:RecentSessions;
  selfUserId='';selfBotId='';
  constructor(readonly config:Config,readonly store:Store,readonly backend:Backend,readonly slack:SlackPort,private postIntervalMs=1100,private screens?:ScreenPort, readonly runtime?:RuntimeContext){
    if(runtime){
      this.localEvents=new LocalEvents(store,backend,runtime.id);
      // Existing ledgers can contain queued native text without origin proof.
      // Keep the audit record, but do not replay those bytes after this upgrade.
      if(store.state.slackVisibility?.policy!==this.visibilityPolicy()||store.state.outbox.some(o=>o.status==='queued'&&!this.scopeMatches(o,store.state)))
        store.transaction(s=>{
          this.stampVisibility(s);
          for(const o of s.outbox)if(o.status==='queued'&&!this.scopeMatches(o,s)){o.status='failed';o.error='SLACK_SCOPE_UPGRADE_REQUIRES_NEW_READ';}
          if(s.results)s.results=s.results.filter(r=>this.scopeMatches(r,s));
        });
    }
    this.files=new ReadonlyFiles(config.projects,{},config.filePolicy?.allowAbsolutePaths===true,runtime?.protectedHomes);
    this.recent=new RecentSessions(backend,()=>this.store.state.activity||[],t=>this.threadSummary(t));
    const authorizeContent=(thread:any)=>{this.requireNativeRoot(thread);const cwd=this.canonicalCwd(thread?.cwd);if(!cwd||(!this.config.sessionPolicy?.allowAllSharedSessions&&!this.projectFor(cwd)))throw new ConnectorError('SESSION_SCOPE_NOT_ALLOWED');return this.threadSummary({...thread,cwd});};
    this.content=new SessionContent(backend,authorizeContent);
    this.search=new SessionSearch(backend,authorizeContent);
    this.subscriptions=new SessionSubscriptions(store,backend,{
      policy:()=>resultPolicy(this.config),
      validate:(thread,owner)=>{this.subscriptionActor(owner);this.requireNativeRoot(thread);const cwd=this.canonicalCwd(thread?.cwd);if(!cwd||(!this.config.sessionPolicy?.allowAllSharedSessions&&!this.projectFor(cwd)))throw new ConnectorError('SESSION_SCOPE_NOT_ALLOWED');return{cwd,project:this.projectFor(cwd)};},
      allow:sub=>{try{this.subscriptionActor(sub.owner);return this.validCwd(sub.cwd)&&(this.config.sessionPolicy?.allowAllSharedSessions===true||Boolean(this.projectFor(sub.cwd)));}catch{return false;}},
      output:(state,text,sub)=>{const start=state.outbox.length;this.sessionText(state,text,'',sub.owner);for(const out of state.outbox.slice(start)){out.subscriptionId=sub.id;out.notificationThreadId=sub.threadId;}}
    });
    if(runtime)this.nativeSharing=new NativeSharing(store,backend,{
      route:sub=>{
        if(!runtime.backendFingerprint||!runtime.slackReady()||!backend.observation?.homeVerified||!this.selfUserId||!this.selfBotId||!this.store.state.dot?.userId||
          this.config.local?.enabled===false||!this.subscriptions.allow(sub)||this.projectFor(sub.cwd)!==sub.project)return;
        return {serverId:runtime.id,backendFingerprint:runtime.backendFingerprint,workspaceId:this.config.slack.teamId,channel:sub.owner.channel,rootThreadTs:sub.owner.threadTs,
          subscriptionId:sub.id,nativeThreadId:sub.threadId,policy:this.visibilityPolicy(),
          scope:createHash('sha256').update(stable([sub.cwd,sub.project,sub.owner.kind,sub.owner.userId,sub.owner.ts,sub.owner.eventId])).digest('hex'),
          slackIdentity:createHash('sha256').update(stable([this.selfUserId,this.selfBotId,this.store.state.dot.userId])).digest('hex')};
      },
      validateThread:(sub,raw)=>{const thread=raw as {cwd?:string}|undefined,cwd=thread?.cwd&&this.canonicalCwd(thread.cwd);return classifyNativeThread(thread)==='root'&&!!cwd&&cwd===sub.cwd&&this.projectFor(cwd)===sub.project;},
      projectPath:alias=>this.canonicalCwd(this.config.projects[alias]!),
      adoptFresh:(thread,actor,epoch,record)=>this.subscriptions.adoptCreated(thread,actor,epoch,record),
      online:()=>runtime.slackReady(),
      sameSlackConnection:()=>runtime.slackConnection?.()??0,
      joined:id=>this.subscriptions.deliveryAllowed(id),
      threadExists:(channel,ts)=>this.slack.verifySharedRoot?this.slack.verifySharedRoot(channel,ts):this.slack.threadExists(channel,ts),
      queue:(d,sub,projected,text)=>this.outputNative(d,sub,projected,text),
      flush:()=>this.flush()
    });
    backend.on('notification',(method,params,epoch)=>{try{this.nativeSharing?.observe(method,params,epoch);}catch{/* Healthy storage is required for delivery. */}this.event(()=>this.notification(method,params,epoch));});
    backend.on('request',request=>{try{this.nativeSharing?.request(request);}catch{/* No native reply or data logging. */}this.event(()=>this.serverRequest(request));});
    backend.on('disconnect',epoch=>{if(epoch===this.backend.epoch)this.nativeSharing?.disconnected();this.event(()=>this.disconnected(epoch));});
  }
  private event(operation:()=>Promise<void>|void){this.events=this.events.then(operation).catch(()=>{/* Persisted state stays authoritative. No raw payload logs. */});}
  async initialize(){await this.initializeSlack();await this.reconnect();}
  async initializeSlack(){
    const saved=this.store.state.dot;const dot=await this.slack.resolveDot(this.config.slack.dot.name,this.config.slack.dot.userId||(saved?.selector===this.config.slack.dot.name?saved.userId:undefined));
    this.store.transaction(s=>{s.dot={...dot,selector:this.config.slack.dot.name};});
  }
  async reconnect(){
    if(this.closing)return;
    try{
      await this.backend.connect();
      if(!this.runtime||this.runtime.slackReady())await this.subscriptions.rejoin();
      for(const s of this.store.state.sessions){
        if(this.attached.has(s.threadId)||!this.authorizedSession(s))continue;
        try{const r=await this.backend.rpc('thread/read',{threadId:s.threadId,includeTurns:false});this.checkSessionThread(r.thread,s);
          // A new connection does not prove continuity of the previous writer. Recover
          // observations read-only; require a fresh explicit attach before writes.
          if(this.runtime){for(const {principal:owner} of this.localEvents!.list().filter(row=>row.sessionId===s.id)){const p=this.runtime.principal(owner);if(p&&this.localBinding(p,s)&&(p.role==='operator'||p.servers?.includes(this.runtime.id)&&p.commands?.includes('session.events')))await this.localEvents!.recover({principal:owner,sessionId:s.id,project:s.project,threadId:s.threadId});}continue;}
          const resumed=await this.backend.rpc('thread/resume',{threadId:s.threadId,excludeTurns:true});this.checkSessionThread(resumed.thread,s);this.attached.add(s.threadId);}catch{/* Capabilities/status exposes unavailable attachment; never starts a replacement thread. */}
      }
    }catch{/* Server remains usable for help/files/status. No independent fallback. */}
    this.nativeSharing?.tick();this.pump();this.flush();
  }
  capabilities(){return{...this.backend.capabilities(),instanceId:this.config.instanceId,slackTransport:{revision:SLACK_TRANSPORT_REVISION,connectorUserId:this.selfUserId||null,connectorBotId:this.selfBotId||null},sessionPolicy:{allowAllSharedSessions:this.config.sessionPolicy?.allowAllSharedSessions===true},outputChannel:this.config.slack.outputChannel,dot:this.store.state.dot,attachedThreads:[...this.attached],screenCapture:{enabled:this.config.screenPolicy?.enabled===true,desktopAvailable:!!this.screens,commands:['screen.list','screen.capture'],oneShot:true,unredacted:true,slackThreadOnly:true,maxDisplays:8,maxImageDimension:2560},fileTools:{mode:this.files.absolutePathsEnabled?'absolute-readonly-and-project-roots':'project-roots-only',allowAbsolutePaths:this.files.absolutePathsEnabled,readOnly:true,osPermissions:true,sensitivePathsBlocked:true,enablement:'Local desktop Settings only; stop connector, explicitly enable full-system read-only access, save and restart. Never enabled by Slack.'},approvalAuthority:this.runtime?'Original Codex UI only. Expiry only changes the reminder; no decision or interruption.':'direct configured humans or verified same-thread human envelope; bots alone cannot approve',sessionDelivery:{command:'session.delivery',correlation:'queue start turn ID or userMessage.clientId',automaticRetry:false,completion:'matched terminal turn only'},sessionRecent:{command:'session.recent',defaultLimit:5,maxLimit:20,globalTopN:false,observation:'Producer lifecycle timestamps only; no content or automatic subscriptions'},sessionSearch:{command:'session.search',defaultSessionLimit:10,maxSessionLimit:20,roles:['all','user','assistant'],modes:['and','or'],recentBy:'backend updated_at, not execution activity',matching:'case-insensitive literal terms within one message',readOnly:true,continuation:'result.next'},sessionContent:{overview:'session.overview',messages:'session.messages',slackNativeText:this.runtime===undefined,batchMax:5,readOnly:true,semanticSummary:false},subscriptions:{commands:['session.subscribe','session.unsubscribe','session.subscriptions'],loadedOnly:true,localCancellationOnly:true,slackFutureContent:'Only a fresh dedicated session created after local operator consent. Existing sessions offer status only; answer in original Codex.'},slackOutput:{mode:'compact',sessionDefaultView:'loaded',maxRowsPerSource:10,resultDetail:'result.page',nextPage:'result.next'},serviceManagement:'local template generation only'};}
  private authorizeEvent(body:any):Source|undefined{
    const e=body?.event,s=this.config.slack;
    if(body?.team_id!==s.teamId||typeof body.event_id!=='string'||!e||e.type!=='message'||!['',undefined,'bot_message'].includes(e.subtype)||typeof e.text!=='string'||typeof e.user!=='string'||typeof e.ts!=='string'||!this.validTimestamp(e.ts)||(e.thread_ts!==undefined&&!this.validTimestamp(e.thread_ts)))return;
    if(e.user===this.selfUserId||(this.selfBotId&&e.bot_id===this.selfBotId)||![s.inputChannel,s.outputChannel].includes(e.channel))return;
    let kind:Source['kind'];
    if(e.bot_id||e.app_id||e.bot_profile){const appId=e.app_id||e.bot_profile?.app_id;if(!s.trustedBots.some(b=>b.botId===e.bot_id&&b.userId===e.user&&b.appId===appId))return;kind='bot';}
    else{if(!s.allowedHumans.includes(e.user))return;kind='human';}
    return{kind,userId:e.user,channel:e.channel,ts:e.ts,threadTs:e.thread_ts||e.ts,eventId:body.event_id};
  }
  /** Persist-before-ack. Returns false for irrelevant/unauthorized events, never executes here. */
  accept(body:any):boolean{
    if(this.runtime&&!this.runtime.slackReady())return false;this.store.assertHealthy();const source=this.authorizeEvent(body);if(!source)return false;
    if(Object.hasOwn(this.store.state.seenEvents,source.eventId))return true;
    const mention=this.selfUserId?`<@${this.selfUserId}>`:'';const addressed=Boolean(mention&&isSlackAddressed(body.event.text,mention,source.kind==='bot'));
    if(!body.event.text.startsWith(START_MARKER)&&!addressed)return false;
    let request:CommandEnvelope;
    try{request=parseSlackEnvelope(body.event.text,body.event.blocks,this.config.instanceId,source.kind==='bot',addressed?mention:undefined);}catch(e){if(this.runtime&&!this.runtime.defaultRoute)return false;this.store.transaction(s=>{Object.defineProperty(s.seenEvents,source.eventId,{value:'rejected',enumerable:true,writable:true,configurable:true});this.output(s,`Command rejected: ${e instanceof ProtocolError?e.code:'invalid_envelope'}. Transport ${SLACK_TRANSPORT_REVISION}: ${e instanceof SlackTransportError?e.stage:'envelope'}. Use the generated help envelope exactly.`,undefined,source);});return true;}
    if(this.runtime){
      const route=this.runtime.route(request.params.serverId,request.command);if(route==='other')return false;
      if(route==='reject'){this.store.transaction(state=>{Object.defineProperty(state.seenEvents,source.eventId,{value:'rejected',enumerable:true,writable:true,configurable:true});this.output(state,'Command rejected: SERVER_UNAVAILABLE. Select an authorized, configured server; no operation was executed.',undefined,source);});return true;}
      request={...request,params:{...request.params,serverId:this.runtime.id}};
    }
    if(source.channel!==this.config.slack.inputChannel&&!decisionCommands.has(request.command)&&!['result.page','session.unsubscribe','session.subscriptions'].includes(request.command)){this.store.transaction(s=>{Object.defineProperty(s.seenEvents,source.eventId,{value:'rejected',enumerable:true,writable:true,configurable:true});this.output(s,'Command rejected: COMMAND_CHANNEL_NOT_ALLOWED. Use the configured command channel; no session operation executed.',undefined,source);});return true;}
    this.record(request,source);return true;
  }
  local(request:CommandEnvelope,principal:LocalPrincipal={id:'local',role:'operator'}){
    if(this.runtime){this.localAuthority(principal,request);}
    if(request.target!==this.config.instanceId)throw new ConnectorError('WRONG_TARGET');request={...request,params:validateCommand(request.command,request.params)};
    if(decisionCommands.has(request.command))throw new ConnectorError('NEED_VERIFIABLE_HUMAN_DECISION');
    const id=this.record(request,{kind:'local',userId:principal.id,channel:this.runtime?'':this.config.slack.inputChannel,threadTs:'',ts:'',eventId:`local-${principal.id}:${request.id}`});this.pump();return{id,requestId:request.id,...(this.runtime?{serverId:this.runtime.id}:{}),status:'accepted',acceptance:'connector-inbox-only',deliveryConfirmed:false};
  }
  private record(request:CommandEnvelope,source:Source):string{
    return this.store.transaction(s=>{
      if(Object.hasOwn(s.seenEvents,source.eventId)){const id=s.seenEvents[source.eventId]!;if(source.kind==='local'){const previous=s.work.find(x=>x.id===id);if(!previous||stable(previous.request)!==stable(request))throw new ConnectorError('REQUEST_ID_CONFLICT');}return id;}
      const existing=s.work.find(w=>w.request.id===request.id&&w.source.kind===source.kind&&w.source.userId===source.userId);
      const id=existing?.id||randomUUID();
      Object.defineProperty(s.seenEvents,source.eventId,{value:id,enumerable:true,writable:true,configurable:true});
      if(existing){if(source.kind==="local"){if(stable(existing.request)!==stable(request))throw new ConnectorError("REQUEST_ID_CONFLICT");return id;}if(stable(existing.request)!==stable(request))this.output(s,`REQUEST_ID_CONFLICT: ${request.id}; use a new ID for a different command.`,undefined,source);else this.output(s,`REQUEST_ALREADY_ACCEPTED: ${request.id}; work ${existing.id}; status ${existing.status}${existing.messageDelivery?`; message evidence ${deliveryView(existing).deliveryStatus}; check session.delivery with workId ${existing.id}`:''}. No operation was repeated.`,undefined,source);return id;}
      if(s.work.filter(w=>['queued','executing'].includes(w.status)).length>=500)throw new ConnectorError('QUEUE_FULL');
      const principal=source.kind==='local'&&this.runtime?this.runtime.principal(source.userId):undefined;
      s.work.push({id,...(principal?{localGrant:this.grantFingerprint(principal)}:{}),eventId:source.eventId,request,source,status:'queued',createdAt:new Date().toISOString()});return id;
    });
  }
  private key(w:Work){
    if(COMMANDS[w.request.command].permission==='read')return `read:${w.request.command}:${w.request.params.sessionId||'global'}`;
    if(decisionCommands.has(w.request.command))return `decision:${w.request.params.requestId}`;
    return typeof w.request.params.sessionId==='string'?w.request.params.sessionId:`global:${w.request.command}`;
  }
  pump(){
    if(this.closing)return;try{this.store.assertHealthy();}catch{return;}
    for(const w of this.store.state.work.filter(w=>w.status==='queued'&&(!this.runtime||w.source.kind==='local'||this.runtime.slackReady()))){
      const key=this.key(w);if(this.running.has(key))continue;
      if(w.request.command!=='screen.capture'&&this.store.state.work.some(x=>this.key(x)===key&&x.status==='uncertain'))continue;
      const task=this.drain(key).catch(()=>{}).finally(()=>{this.running.delete(key);queueMicrotask(()=>this.pump());});this.running.set(key,task);
    }
  }
  private async drain(key:string){
    while(!this.closing){
      const w=this.store.state.work.find(w=>w.status==='queued'&&this.key(w)===key&&(!this.runtime||w.source.kind==='local'||this.runtime.slackReady()));if(!w)return;
      this.store.transaction(s=>{s.work.find(x=>x.id===w.id)!.status='executing';});
      try{
        const evidence:OutputEvidence={}, initialPolicy=this.visibilityPolicy();
        this.reauthorize(w);let result=await this.execute(w,evidence);
        if(w.source.kind!=='local'&&COMMANDS[w.request.command].permission==='read'){
          this.reauthorize(w);
          if(initialPolicy!==this.visibilityPolicy())throw new ConnectorError('SESSION_SCOPE_CHANGED');
        }
        const proof=evidence.proof;
        this.store.transaction(s=>{const done=s.work.find(x=>x.id===w.id)!;done.status='completed';if(done.messageDelivery&&['session.send','session.queue'].includes(w.request.command))result=deliveryView(done);if(this.runtime&&w.source.kind==='local'){const str=JSON.stringify(result??null);done.localResult=Buffer.byteLength(str)>256*1024?{truncated:true,note:'Result exceeds 256 KiB. Request a smaller page.'}:containsSensitiveContent(str)||resultSensitive(result)?{withheld:true}:result;}const snapshot=w.source.kind!=='local'&&w.request.command!=='result.page'?storeResult(s,w,result,this.config,Date.now(),this.stampVisibility(s,proof)):undefined;done.resultRef={sessionId:this.outputSession(w,result),threadId:typeof result?.threadId==='string'?result.threadId:undefined,turnId:typeof result?.turnId==='string'?result.turnId:typeof result?.turn?.id==='string'?result.turn.id:undefined,resultId:snapshot?.id};const text=w.source.kind==='local'?`[request ${w.request.id}; work ${w.id}] ${short(result,w.request.command.startsWith('files.')||['session.list','session.recent','session.history','session.search'].includes(w.request.command)||result?.kind==='session.search'?500000:20000)}`:compactResult(w,result,snapshot);this.output(s,text+this.bindingNote(w,result),this.outputSession(w,result),w.source,proof);});
      }catch(e){
        const code=codeOf(e),uncertain=code==='SCREEN_UPLOAD_UNCERTAIN'||code==='RPC_OUTCOME_UNCERTAIN'&&COMMANDS[w.request.command].permission!=='read';
        const reason=uncertain?(code==='SCREEN_UPLOAD_UNCERTAIN'?': inspect the Slack thread for partial or completed uploads; no automatic retry.':': inspect backend state; operation will not be replayed.'):code==='SCREEN_RESTART_REQUIRED'||code==='SCREEN_TIMEOUT'?': quit and reopen the desktop app before a new explicit capture request.':code==='SCREEN_PERMISSION_DENIED'?': grant Screen Recording permission in local OS settings, then restart the desktop app.':code==='SCREEN_UPLOAD_REJECTED'?': check Slack files:write scope, channel membership and rate limits; no automatic retry.':code==='NATIVE_CONTENT_LOCAL_ONLY'?': open the original Codex UI or use authorized local history; native text is not forwarded to Slack.':code==='LOCAL_ACTION_REQUIRED'?': open the original Codex UI; no decision was sent.':'';
        this.store.transaction(s=>{const current=s.work.find(x=>x.id===w.id)!;current.status=uncertain?'uncertain':'failed';current.error=code;this.output(s,`[${w.id}] ${code}${reason}${current.messageDelivery?` Message evidence: ${deliveryView(current).deliveryStatus}; admission=${current.messageDelivery.admission}; start=${current.messageDelivery.start}; execution=${current.messageDelivery.execution}.${current.messageDelivery.admissionError?` Admission request: ${current.messageDelivery.admissionError} (${formatRpcDiagnostic(current.messageDelivery.admissionDiagnostic)}).`:""}${current.messageDelivery.startError?` Start request: ${current.messageDelivery.startError} (${formatRpcDiagnostic(current.messageDelivery.startDiagnostic)}).`:""} Check session.delivery {"sessionId":"${current.request.params.sessionId}","workId":"${current.id}"}. Do not resend.`:''}`,typeof w.request.params.sessionId==='string'?w.request.params.sessionId:undefined,w.source);});
        if(uncertain)return;
      }finally{this.flush();}
    }
  }
  private grantFingerprint(p:LocalPrincipal){
    const projects=Object.keys(this.config.projects).filter(a=>this.localProject(p,a)).sort().map(a=>[a,this.canonicalCwd(this.config.projects[a]!)??null]);
    return createHash('sha256').update(stable([p.id,p.role,[...(p.servers??[])].sort(),projects,[...(p.commands??[])].sort()])).digest('hex');
  }
  private localBinding(p:LocalPrincipal,s:Session){return this.localProject(p,s.project)&&!!s.cwd&&this.within(this.config.projects[s.project]!,s.cwd)&&s.localOwners?.includes(p.id)===true;}
  private localProject(p:LocalPrincipal,project:string){return Object.hasOwn(this.config.projects,project)&&(p.role==='operator'||p.projects?.includes(project)===true);}
  private localAuthority(principal:LocalPrincipal,req:CommandEnvelope){
    if(!this.runtime)return;
    if(this.runtime.principal(principal.id)?.role!==principal.role)throw new ConnectorError('ACTOR_REVOKED');
    if(principal.role==='agent'&&(!localTools.has(req.command)||!principal.commands?.includes(req.command)||!principal.servers?.includes(this.runtime.id)))throw new ConnectorError('LOCAL_SCOPE_DENIED');
    if(!localTools.has(req.command)&&!(principal.role==='operator'&&['help','capabilities','files.list','files.stat','files.read','files.search','session.reply'].includes(req.command)))throw new ConnectorError('LOCAL_ACTION_REQUIRED');
    const p=req.params;
    if(p.project!==undefined&&(typeof p.project!=='string'||!this.localProject(principal,p.project)))throw new ConnectorError('LOCAL_SCOPE_DENIED');
    if(p.outputThreadTs!==undefined&&(principal.role!=='operator'||!this.runtime.slackReady()))throw new ConnectorError('SLACK_EXPLICIT_BINDING_UNAVAILABLE');
    if(typeof p.sessionId==='string'){
      const session=this.session(p.sessionId);
      if(!this.localBinding(principal,session))throw new ConnectorError('LOCAL_BINDING_REQUIRED');
    }
  }
  receipt(workId:string,principal:LocalPrincipal){
    const w=this.store.state.work.find(x=>x.id===workId&&x.source.kind==='local'&&x.source.userId===principal.id);if(!w)throw new ConnectorError('RECEIPT_NOT_FOUND');
    this.localAuthority(principal,w.request);if(w.localGrant!==this.grantFingerprint(principal))throw new ConnectorError('LOCAL_GRANT_CHANGED');return{id:w.id,requestId:w.request.id,serverId:this.runtime?.id,status:w.status,result:w.localResult,error:w.error,delivery:w.messageDelivery?deliveryView(w):undefined};
  }
  async readEvents(params:{sessionId:string,cursor?:string,waitMs?:number,limit?:number},p:LocalPrincipal,signal?:AbortSignal){
    if(!this.localEvents)throw new ConnectorError('LOCAL_EVENTS_UNAVAILABLE');
    if(p.role==='agent'&&(!p.servers?.includes(this.runtime!.id)||!p.commands?.includes('session.events')))throw new ConnectorError('LOCAL_SCOPE_DENIED');
    const check=()=>{const current=this.runtime!.principal(p.id),s=this.session(params.sessionId);if(!current||!this.localBinding(current,s)||current.role==='agent'&&(!current.servers?.includes(this.runtime!.id)||!current.commands?.includes('session.events')))throw new ConnectorError('LOCAL_BINDING_REQUIRED');return s;};
    const s=check(),scope={principal:p.id,project:s.project,sessionId:s.id,threadId:s.threadId};
    const epoch=this.backend.epoch;if(!this.backend.connected)throw new ConnectorError('SERVER_UNAVAILABLE');
    await this.metadata(s);check();if(epoch!==this.backend.epoch)throw new ConnectorError('SERVER_UNAVAILABLE');
    const sub=this.localEvents.subscribe(scope,params.cursor);await this.localEvents.recover(scope,sub.subscriptionId);
    await this.localEvents.poll(scope,{subscriptionId:sub.subscriptionId,cursor:params.cursor,waitMs:params.waitMs,limit:params.limit},signal);
    check();if(!this.backend.connected||epoch!==this.backend.epoch)throw new ConnectorError('SERVER_UNAVAILABLE');await this.metadata(s);check();
    if(!this.backend.connected||epoch!==this.backend.epoch)throw new ConnectorError('SERVER_UNAVAILABLE');
    // Cancel or ownership changes while metadata is in flight invalidate the earlier projection.
    const page=await this.localEvents.poll(scope,{subscriptionId:sub.subscriptionId,cursor:params.cursor,limit:params.limit},signal);
    return{...page,subscriptionId:sub.subscriptionId,serverId:this.runtime!.id};
  }
  unwatch(params:{sessionId:string;subscriptionId:string},p:LocalPrincipal){
    if(!this.localEvents||p.role==='agent'&&(!p.servers?.includes(this.runtime!.id)||!p.commands?.includes('session.events')))throw new ConnectorError('LOCAL_SCOPE_DENIED');
    const s=this.session(params.sessionId);if(!this.localBinding(p,s))throw new ConnectorError('LOCAL_BINDING_REQUIRED');
    return this.localEvents.cancel({project:s.project,sessionId:s.id,threadId:s.threadId,principal:p.id},params.subscriptionId);
  }
  private reauthorize(w:Work){
    const s=this.config.slack,a=w.source;if(a.kind==='local'){if(this.runtime){const principal=this.runtime.principal(a.userId);if(!principal)throw new ConnectorError('ACTOR_REVOKED');this.localAuthority(principal,w.request);if(w.localGrant!==this.grantFingerprint(principal))throw new ConnectorError('LOCAL_GRANT_CHANGED');}return;}if(this.runtime&&!this.runtime.slackReady())throw new ConnectorError('SLACK_UNAVAILABLE');
    if(a.kind==='human'&&!s.allowedHumans.includes(a.userId))throw new ConnectorError('ACTOR_REVOKED');
    if(a.kind==='bot'&&!s.trustedBots.some(b=>b.userId===a.userId))throw new ConnectorError('ACTOR_REVOKED');
    if(![s.inputChannel,s.outputChannel].includes(a.channel))throw new ConnectorError('CHANNEL_REVOKED');
  }
  private outputSession(w:Work,result:any):string|undefined{return typeof w.request.params.sessionId==='string'?w.request.params.sessionId:typeof result?.sessionId==='string'?result.sessionId:undefined;}
  private bindingNote(w:Work,result:any){const session=this.store.state.sessions.find(s=>s.id===this.outputSession(w,result)&&this.authorizedSession(s));return session&&w.source.kind!=='local'&&(session.channel!==w.source.channel||session.threadTs!==w.source.threadTs)?`\nSession notifications remain in ${session.channel}, thread ${session.threadTs||'unavailable'}; this command did not move the binding.`:'';}
  private validTimestamp(value:unknown):value is string{return typeof value==='string'&&/^\d{1,20}\.\d{1,10}$/.test(value);}
  private validChannel(channel:string){return[this.config.slack.inputChannel,this.config.slack.outputChannel].includes(channel);}
  private originDestination(source?:Source){return source&&source.kind!=='local'&&this.validChannel(source.channel)&&this.validTimestamp(source.threadTs)?{channel:source.channel,threadTs:source.threadTs}:undefined;}
  private visibilityPolicy(){
    return this.runtime?createHash('sha256').update(stable([SLACK_SCOPE_VERSION,this.runtime.id,this.config.instanceId,
      this.config.local?.enabled!==false,resultPolicy(this.config)])).digest('hex'):'';
  }
  private stampVisibility(state:State,proof?:SlackTurnProof):SlackVisibilityScope|undefined{
    if(!this.runtime)return;
    const policy=this.visibilityPolicy();
    if(state.slackVisibility?.policy!==policy||!deliveryId(state.slackVisibility.generation))state.slackVisibility={policy,generation:randomUUID()};
    return {...state.slackVisibility,proof};
  }
  private scopeMatches(row:{scopeVersion?:number;visibility?:SlackVisibilityScope},state:Readonly<State>){
    if(!this.runtime)return true;
    const v=row.visibility,current=state.slackVisibility;
    return row.scopeVersion===SLACK_SCOPE_VERSION&&!!v&&(!v.proof||v.proof.kind==='live')&&!!current&&deliveryId(current.generation)&&v.generation===current.generation&&v.policy===current.policy&&v.policy===this.visibilityPolicy();
  }
  private output(state:State,text:string,sessionId?:string,source?:Source,proof?:SlackTurnProof){
    if(this.runtime&&(source?.kind==='local'||!this.runtime.slackReady()))return;
    if(containsSensitiveContent(text))text='Sensitive-looking output withheld; inspect the original local Codex session. No credentials were sent.';
    const session=state.sessions.find(s=>s.id===sessionId&&this.authorizedSession(s));if(!session)sessionId=undefined;
    const origin=source?.kind!=='local'?source:undefined;
    const destination=origin?this.originDestination(origin):session&&this.validTimestamp(session.threadTs)?{channel:session.channel,threadTs:session.threadTs}:undefined;
    const visibility=this.stampVisibility(state,proof),points=[...text];for(let i=0;i<points.length||i===0;i+=2400){const chunk=points.slice(i,i+2400).join('');state.outbox.push({scopeVersion:SLACK_SCOPE_VERSION,visibility,id:randomUUID(),sessionId,origin,channel:destination?.channel||'',threadTs:destination?.threadTs,root:false,text:chunk,mention:i===0,status:destination?'queued':'failed',error:destination?undefined:'THREAD_DESTINATION_REQUIRED',attempts:0,nextAttemptAt:0});}
  }
  private outputNative(state:State,sub:Subscription,projected:NativeDelivery,text:string){
    if(!this.runtime?.slackReady()||containsSensitiveContent(text)||!this.originDestination(sub.owner))return;
    const visibility=this.stampVisibility(state);
    state.outbox.push({scopeVersion:SLACK_SCOPE_VERSION,id:randomUUID(),visibility,origin:sub.owner,channel:sub.owner.channel,threadTs:sub.owner.threadTs,
      subscriptionId:sub.id,notificationThreadId:sub.threadId,nativeShare:projected,root:false,text:nativeOutboxMarker,mention:false,status:'queued',attempts:0,nextAttemptAt:0});
  }
  private sessionText(state:State,text:string,sessionId:string,source?:Source,proof?:SlackTurnProof){
    if(containsSensitiveContent(text)){this.output(state,'Sensitive-looking output withheld; inspect locally.',sessionId,source,proof);return;}
    if([...text].length<=1800){this.output(state,text,sessionId,source,proof);return;}
    const session=state.sessions.find(s=>s.id===sessionId&&this.authorizedSession(s));
    const dot=state.dot?.userId,owner=source&&source.kind!=='local'?source:session&&dot&&this.config.slack.trustedBots.some(b=>b.userId===dot)?{kind:'bot' as const,userId:dot,channel:session.channel,threadTs:session.threadTs||'',ts:'',eventId:'notification'}:undefined;
    const snapshot=owner?storeResult(state,{id:randomUUID(),eventId:owner.eventId,source:owner,request:{v:1,id:randomUUID(),target:this.config.instanceId,command:'session.reply',params:{sessionId}},status:'completed',createdAt:new Date().toISOString()},text,this.config,Date.now(),this.stampVisibility(state,proof)):undefined;
    const footer=snapshot?`\nFull text: result.page {"resultId":"${snapshot.id}","page":1}; same recipient/thread, 15 min.`:'\nLong text shortened; inspect the local session/source for the full response.';
    this.output(state,[...text].slice(0,1600).join('')+'\n[Long response preview]'+footer,sessionId,source,proof);
  }
  private subscriptionActor(source:Source){
    if(source.kind==='local'||!this.originDestination(source))throw new ConnectorError('SUBSCRIPTION_SLACK_THREAD_REQUIRED');
    const allowed=source.kind==='human'?this.config.slack.allowedHumans.includes(source.userId):this.config.slack.trustedBots.some(b=>b.userId===source.userId);
    if(!allowed)throw new ConnectorError('ACTOR_REVOKED');
  }
  private boundNotice(state:State,text:string,session:Session,preview=false,eventKey?:string){
    const before=state.outbox.length;
    const route=(source?:Source,id?:string)=>{const start=state.outbox.length;if(preview)this.sessionText(state,text,session.id,source);else this.output(state,text,session.id,source);for(const o of state.outbox.slice(start)){o.notificationThreadId=session.threadId;o.subscriptionId=id;}};
    if(!this.subscriptions.hasExplicitDestination(session.threadId,session.channel,session.threadTs||'')){
      if(!eventKey||!Object.hasOwn(state.seenNotifications,eventKey)){route();if(eventKey)state.seenNotifications[eventKey]=true;}
    }
    else if(eventKey)this.subscriptions.emit(state,text,session.threadId,eventKey,
      sub=>sub.owner.channel===session.channel&&sub.owner.threadTs===session.threadTs,
      (_state,_text,sub)=>route(sub.owner,sub.id));
    else for(const sub of state.subscriptions||[])if(sub.threadId===session.threadId&&sub.owner.channel===session.channel&&sub.owner.threadTs===session.threadTs&&this.subscriptions.eventAllowed(sub.id))route(sub.owner,sub.id);
    return state.outbox.length-before;
  }
  private subscriptionSummary(sub:Subscription){return{subscriptionId:sub.id,threadId:sub.threadId,enabled:sub.enabled,status:sub.status,observationReady:this.subscriptions.deliveryAllowed(sub.id),...(this.nativeSharing?{nativeContent:this.nativeSharing.view(sub.id).status}:{}),error:sub.error,channel:sub.owner.channel,threadTs:sub.owner.threadTs};}
  private session(id:unknown):Session{const s=this.store.state.sessions.find(s=>s.id===id);if(!s)throw new ConnectorError('SESSION_NOT_FOUND');if(!this.authorizedSession(s))throw new ConnectorError('SESSION_SCOPE_REVOKED');return s;}
  private canonicalCwd(cwd:string){try{if(!this.validCwd(cwd))return undefined;const real=realpathSync(cwd);return this.validCwd(real)?real:undefined;}catch{return undefined;}}
  private within(root:string,cwd:string){const a=this.canonicalCwd(root),b=this.canonicalCwd(cwd);if(!a||!b)return false;const rel=relative(a,b);return rel===''||(!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel));}
  private projectFor(cwd:string){return Object.entries(this.config.projects).find(([,root])=>this.within(root,cwd))?.[0];}
  private validCwd(cwd:unknown):cwd is string{return typeof cwd==='string'&&isAbsolute(cwd)&&!/[\x00-\x1f]/.test(cwd)&&!/[\\/]\.codex[\\/]sessions(?:[\\/]|$)/i.test(cwd);}
  private authorizedSession(s:Session){const cwd=s.cwd||this.config.projects[s.project];return (this.validChannel(s.channel)||Boolean(this.runtime&&!s.channel&&s.localOwners?.length))&&this.validCwd(cwd)&&(this.config.sessionPolicy?.allowAllSharedSessions===true||Boolean(this.projectFor(cwd)));}
  private requireNativeRoot(thread:any,acknowledgedThreadId?:string){
    const kind=classifyNativeThread(thread,acknowledgedThreadId?{acknowledgedThreadId}:undefined);
    if(kind!=='root'){
      if(typeof thread?.id==='string'){this.verifiedRoots.delete(thread.id);this.attached.delete(thread.id);}
      throw new ConnectorError(nativeRootError(kind));
    }
    // Only positive fresh metadata is cached, local process + backend epoch.
    // This lets normal observation stay cheap without restoring old bindings
    // based on a persisted thread ID or a title.
    if(this.backend.connected){
      if(this.verifiedRoots.size>=4096&&!this.verifiedRoots.has(thread.id))this.verifiedRoots.delete(this.verifiedRoots.keys().next().value!);
      this.verifiedRoots.set(thread.id,this.backend.epoch);
    }
  }
  private rootObserved(id:unknown){return typeof id==='string'&&this.backend.connected&&this.verifiedRoots.get(id)===this.backend.epoch;}
  private async canObserveRoot(id:unknown,epoch:string){
    if(this.rootObserved(id))return this.backend.epoch===epoch;
    const binding=this.store.state.sessions.find(s=>s.threadId===id&&this.authorizedSession(s));
    if(!binding||!this.backend.connected||this.backend.epoch!==epoch)return false;
    try{await this.metadata(binding);return this.rootObserved(id)&&this.backend.epoch===epoch;}catch{return false;}
  }
  private checkSessionThread(thread:any,s:Session){
    const cwd=s.cwd||this.config.projects[s.project];
    if(thread?.id!==s.threadId||!this.authorizedSession(s)||!this.validCwd(thread?.cwd)||(this.canonicalCwd(thread.cwd)||resolve(thread.cwd))!==(this.canonicalCwd(cwd!)||resolve(cwd!)))throw new ConnectorError('THREAD_PROJECT_MISMATCH');
    this.requireNativeRoot(thread);
  }
  private project(alias:unknown){if(typeof alias!=='string'||!Object.hasOwn(this.config.projects,alias))throw new ConnectorError('PROJECT_NOT_ALLOWED');return this.config.projects[alias]!;}
  private checkProject(thread:any,alias:string){if(!this.validCwd(thread?.cwd)||!this.within(this.project(alias),thread.cwd))throw new ConnectorError('THREAD_PROJECT_MISMATCH');}
  private async metadata(s:Session){const epoch=this.backend.epoch,r=await this.backend.rpc('thread/read',{threadId:s.threadId,includeTurns:false});if(!this.backend.connected||this.backend.epoch!==epoch)throw new ConnectorError('SERVER_UNAVAILABLE');this.checkSessionThread(r.thread,s);return r.thread;}
  private threadSummary(t:any){const project=this.validCwd(t.cwd)?this.projectFor(t.cwd):undefined,allowed=this.validCwd(t.cwd)&&(Boolean(project)||this.config.sessionPolicy?.allowAllSharedSessions===true);return{id:t.id,name:typeof t.name==='string'?t.name.slice(0,200):null,cwd:typeof t.cwd==='string'?t.cwd.slice(0,1024):null,project:project||null,manageable:allowed&&t.canAcceptDirectInput===true,reason:!allowed?'SESSION_SCOPE_NOT_ALLOWED':t.canAcceptDirectInput===false?'DIRECT_INPUT_UNAVAILABLE':t.canAcceptDirectInput!==true?'ATTACH_TO_CHECK_CAPABILITY':null,canAcceptDirectInput:t.canAcceptDirectInput??null,status:{type:t.status?.type||'unknown'},model:typeof t.model==='string'?t.model.slice(0,100):null,reasoningEffort:t.reasoningEffort??null,source:typeof t.source==='string'?t.source:'structured-source',connectorSessionId:this.store.state.sessions.find(s=>s.threadId===t.id)?.id||null};}
  private safeSlackMetadata(raw:any){
    return {name:null,cwd:null,model:null,reasoningEffort:null,source:'shared',
      canAcceptDirectInput:typeof raw?.canAcceptDirectInput==='boolean'?raw.canAcceptDirectInput:null,
      status:{type:safeThreadStatus(raw?.status?.type)}};
  }
  private async direct(s:Session){if(!this.attached.has(s.threadId))throw new ConnectorError('SESSION_NOT_ATTACHED');const t=await this.metadata(s);if(t.canAcceptDirectInput!==true)throw new ConnectorError('DIRECT_INPUT_UNAVAILABLE');return t;}
  private deliveryWork(workId:string){return this.store.state.work.find(w=>w.id===workId)!;}
  private updateDelivery(workId:string,change:(d:MessageDelivery)=>void){this.store.transaction(state=>{const d=state.work.find(w=>w.id===workId)!.messageDelivery!;change(d);if(d.turnId){const cached=this.deliveryTurns.get(`${d.threadId}:${d.turnId}`);if(cached){if(cached.conflict)d.correlationConflict=true;observeTurn(d,cached.threadId,cached.turn,new Date().toISOString());}}});}
  private mutationError(e:unknown){const code=codeOf(e);return code==='OPERATION_FAILED'?'RPC_OUTCOME_UNCERTAIN':code;}
  private async submitMessage(w:Work,s:Session,resume:boolean){
    this.store.transaction(state=>{state.work.find(x=>x.id===w.id)!.messageDelivery={threadId:s.threadId,clientUserMessageId:w.id,admission:'pending',start:'not-requested',execution:'unknown',evidence:'submission-attempt',observedAt:new Date().toISOString(),observationGap:false};});
    let queued:any;
    try{queued=await this.backend.rpc('thread/queue/add',{threadId:s.threadId,input:[{type:'text',text:w.request.params.text}],clientUserMessageId:w.id});}
    catch(e){const code=this.mutationError(e),uncertain=!['METHOD_UNSUPPORTED','BACKEND_UNAVAILABLE','RPC_FORBIDDEN'].includes(code);this.updateDelivery(w.id,d=>{if(d.admission!=='accepted')d.admission=uncertain?'uncertain':'rejected';d.admissionError=code;if(e instanceof BackendError&&e.diagnostic)d.admissionDiagnostic=e.diagnostic;});throw new BackendError(uncertain?'RPC_OUTCOME_UNCERTAIN':code);}
    const queuedId=queued?.queuedSubmission?.id,validAck=deliveryId(queuedId)&&queued?.queuedSubmission?.clientUserMessageId===w.id;
    // Persist admission and the exact queue ID before requesting start. Concurrent
    // autonomous consumption may already have produced stronger lifecycle evidence.
    this.updateDelivery(w.id,d=>{if(validAck)d.admission='accepted';else if(d.admission!=='accepted')d.admission='uncertain';if(validAck){if(d.queuedSubmissionId&&d.queuedSubmissionId!==queuedId)d.correlationConflict=true;else d.queuedSubmissionId=queuedId;}if(d.execution==='unknown'){d.evidence='queue-add-response';d.observedAt=new Date().toISOString();}if(!validAck)d.admissionError='INVALID_QUEUE_ACK';});
    if(!validAck||this.deliveryWork(w.id).messageDelivery?.correlationConflict)throw new BackendError('RPC_OUTCOME_UNCERTAIN');
    // Autonomous consumption can beat the add acknowledgement. Once exact
    // execution evidence exists, a redundant start could only add risk.
    if(resume&&this.deliveryWork(w.id).messageDelivery?.execution==='unknown'){
      this.updateDelivery(w.id,d=>{d.start='pending';});
      let started:any;
      try{started=await this.backend.rpc('thread/queue/start',{threadId:s.threadId,queuedSubmissionId:queuedId});}
      catch(e){const code=this.mutationError(e);this.updateDelivery(w.id,d=>{d.start=code==='RPC_OUTCOME_UNCERTAIN'?'uncertain':'rejected';d.startError=code;if(e instanceof BackendError&&e.diagnostic)d.startDiagnostic=e.diagnostic;});if(code==='RPC_OUTCOME_UNCERTAIN')throw new BackendError(code);return deliveryView(this.deliveryWork(w.id));}
      if(!deliveryId(started?.turn?.id)||!['inProgress','completed','failed','interrupted'].includes(started.turn.status)){
        this.updateDelivery(w.id,d=>{d.start='uncertain';d.startError='INVALID_START_ACK';});throw new BackendError('RPC_OUTCOME_UNCERTAIN');
      }
      this.updateDelivery(w.id,d=>{d.start='accepted';if(d.turnId&&d.turnId!==started.turn.id)d.correlationConflict=true;else{d.turnId=started.turn.id;observeTurn(d,s.threadId,started.turn,new Date().toISOString());if(d.evidence==='turn-lifecycle'&&d.execution==='processing')d.evidence='queue-start-response';}});
    }
    return deliveryView(this.deliveryWork(w.id));
  }
  private observeDelivery(method:string,p:any){
    const tracked=this.store.state.work.filter(w=>w.messageDelivery?.threadId===p.threadId);
    if(!tracked.length)return;
    const now=new Date().toISOString();
    if(method==='turn/completed'&&deliveryId(p.threadId)&&deliveryId(p.turn?.id)&&terminalExecution(p.turn?.status)){
      const key=`${p.threadId}:${p.turn.id}`,previous=this.deliveryTurns.get(key);
      if(previous){if(previous.turn.status!==p.turn.status)previous.conflict=true;}else this.deliveryTurns.set(key,{threadId:p.threadId,turn:{id:p.turn.id,status:p.turn.status}});
      if(this.deliveryTurns.size>500)this.deliveryTurns.delete(this.deliveryTurns.keys().next().value!);
    }
    const updates=new Map<string,MessageDelivery>();
    for(const w of tracked){const d=w.messageDelivery!;let changed=false;
      if(method==='item/started'||method==='item/completed')changed=observeMessage(d,p.threadId,p.turnId,p.item,now)||changed;
      if(method==='turn/started'&&p.turn?.status==='inProgress'||method==='turn/completed'&&terminalExecution(p.turn?.status))changed=observeTurn(d,p.threadId,p.turn,now)||changed;
      if(d.turnId){const cached=this.deliveryTurns.get(`${d.threadId}:${d.turnId}`);if(cached){if(cached.conflict&&!d.correlationConflict){d.correlationConflict=true;changed=true;}changed=observeTurn(d,cached.threadId,cached.turn,now)||changed;}}
      if(changed)updates.set(w.id,d);
    }
    if(updates.size)this.store.transaction(state=>{for(const w of state.work){const d=updates.get(w.id);if(d)w.messageDelivery=d;}});
  }
  private async messageDelivery(w:Work,s:Session){
    const p=w.request.params as any,original=this.store.state.work.find(x=>x.id===p.workId&&x.request.params.sessionId===s.id&&['session.send','session.queue'].includes(x.request.command));
    if(!original||(this.runtime&&w.source.kind==='local'&&(original.source.kind!=='local'||original.source.userId!==w.source.userId))||(w.source.kind!=='local'&&(original.source.kind!==w.source.kind||original.source.userId!==w.source.userId||original.source.channel!==w.source.channel||original.source.threadTs!==w.source.threadTs)))throw new ConnectorError('DELIVERY_NOT_FOUND');
    const coverage:any={mode:p.refresh===false?'cached':'bounded-readback',queue:'not-read',items:'not-read',turns:'not-read',errors:[]};
    if(p.refresh!==false&&original.messageDelivery){
      const epoch=this.backend.epoch;
      const rpc=async(method:string,params:any)=>{
        if(!this.backend.connected||this.backend.epoch!==epoch)throw new ConnectorError('DELIVERY_CONNECTION_CHANGED');
        let timer:ReturnType<typeof setTimeout>|undefined;
        try{
          const value=await Promise.race([this.backend.rpc(method,params),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new ConnectorError('DELIVERY_READ_TIMEOUT')),5000);})]);
          if(!this.backend.connected||this.backend.epoch!==epoch)throw new ConnectorError('DELIVERY_CONNECTION_CHANGED');
          if(Buffer.byteLength(JSON.stringify(value)??'','utf8')>1024*1024)throw new ConnectorError('DELIVERY_READ_TOO_LARGE');
          return value;
        }finally{if(timer)clearTimeout(timer);}
      };
      const metadata=async()=>{const r=await rpc('thread/read',{threadId:s.threadId,includeTurns:false});if(r?.thread?.id!==s.threadId)throw new ConnectorError('INVALID_THREAD_METADATA');this.checkSessionThread(r.thread,s);};
      const page=async(method:string,extra:any={})=>{const r=await rpc(method,{threadId:s.threadId,limit:20,...extra});if(!r||!Array.isArray(r.data)||r.data.length>20||!(r.nextCursor===null||typeof r.nextCursor==='string'&&r.nextCursor.length>0&&r.nextCursor.length<=2048))throw new ConnectorError('INVALID_DELIVERY_PAGE');return r;};
      const errors=(part:string,e:unknown)=>{coverage.errors.push({part,code:codeOf(e)});};
      let authorized=false;
      try{await metadata();authorized=true;}catch(e){if(['THREAD_PROJECT_MISMATCH','SESSION_SCOPE_REVOKED'].includes(codeOf(e)))throw e;errors('metadata',e);}
      if(authorized){
        // Collect into a temporary record. Commit only after revalidating epoch
        // and scope; a missing entry in any bounded page is never non-delivery.
        const candidate=structuredClone(this.deliveryWork(original.id).messageDelivery!);
        let queueObservation:any,queueId:string|undefined,queueConflict=false;const messageEvidence:any[]=[],turnEvidence:any[]=[];
        try{const r=await page('thread/queue/list');
          if(r.data.some((q:any)=>!q||!deliveryId(q.id)||!deliveryId(q.clientUserMessageId)))throw new ConnectorError('INVALID_DELIVERY_PAGE');
          const matches=r.data.filter((q:any)=>q.clientUserMessageId===candidate.clientUserMessageId);
          const ids=[...new Set<string>(matches.map((q:any)=>q.id))];
          queueConflict=ids.length>1||Boolean(ids.length&&candidate.queuedSubmissionId&&ids[0]!==candidate.queuedSubmissionId);
          if(ids.length===1&&!queueConflict)queueId=ids[0];
          coverage.queue={scanned:r.data.length,hasMore:r.nextCursor!==null};queueObservation={state:matches.length?'present':'not-observed',observedAt:new Date().toISOString(),note:'One non-atomic bounded page; presence can overlap processing, absence does not prove delivery.'};
        }catch(e){errors('queue',e);}
        try{const r=await page('thread/items/list',{sortDirection:'desc'});coverage.items={scanned:r.data.length,hasMore:r.nextCursor!==null};for(const row of r.data)if(row?.item?.type==='userMessage'&&row.item.clientId===candidate.clientUserMessageId&&deliveryId(row.turnId)&&deliveryId(row.item.id)){messageEvidence.push({turnId:row.turnId,item:{type:'userMessage',id:row.item.id,clientId:row.item.clientId}});observeMessage(candidate,s.threadId,row.turnId,row.item,new Date().toISOString());}}catch(e){errors('items',e);}
        if(candidate.turnId)try{const r=await page('thread/turns/list',{itemsView:'notLoaded',sortDirection:'desc'});coverage.turns={scanned:r.data.length,hasMore:r.nextCursor!==null};for(const turn of r.data)if(turn?.id===candidate.turnId&&['inProgress','completed','failed','interrupted'].includes(turn.status)){turnEvidence.push({id:turn.id,status:turn.status});observeTurn(candidate,s.threadId,turn,new Date().toISOString());}}catch(e){errors('turns',e);}
        try{await metadata();this.reauthorize(w);
          this.updateDelivery(original.id,d=>{
            const now=new Date().toISOString();
            if(queueConflict)d.correlationConflict=true;
            if(queueId){if(d.queuedSubmissionId&&d.queuedSubmissionId!==queueId)d.correlationConflict=true;else d.queuedSubmissionId=queueId;d.admission='accepted';if(d.execution==='unknown'){d.evidence='queue-readback';d.observedAt=now;}}
            for(const row of messageEvidence)observeMessage(d,s.threadId,row.turnId,row.item,now);
            for(const turn of turnEvidence)observeTurn(d,s.threadId,turn,now);
          });
          if(queueObservation)coverage.queueObservation=queueObservation;
        }catch(e){if(['THREAD_PROJECT_MISMATCH','SESSION_SCOPE_REVOKED','ACTOR_REVOKED','CHANNEL_REVOKED'].includes(codeOf(e)))throw e;errors('revalidation',e);coverage.readbackCommitted=false;}
      }
    }
    this.reauthorize(w);this.session(s.id);
    return{...deliveryView(this.deliveryWork(original.id)),backendConnected:this.backend.connected,coverage,scope:'Persisted evidence plus at most one queue, item and turn page on explicit refresh. Missing evidence remains unknown. No resend, start, resume or steering.'};
  }
  private freshSnapshot(id:string,source:Source){
    const state=this.store.state,row=state.results?.find(r=>r.id===id);
    if(!row||row.expiresAt<=Date.now()||!this.samePrincipal(row.source,source)||!this.scopeMatches(row,state))throw new ConnectorError('RESULT_UNAVAILABLE');
    return row;
  }
  private async searchSessions(w:Work,params:any){
    const policy=resultPolicy(this.config),scope=JSON.stringify({kind:w.source.kind,userId:w.source.userId,channel:w.source.channel,threadTs:w.source.threadTs,policy});
    const result=await this.search.query(params,scope);
    this.reauthorize(w);if(resultPolicy(this.config)!==policy)throw new ConnectorError('SESSION_SCOPE_CHANGED');
    return result;
  }
  private async execute(w:Work,evidence:OutputEvidence):Promise<any>{
    const p=w.request.params as any,c=w.request.command;
    if(c==='server.list')return this.runtime?.servers(w.source)??[];
    // The shared App Server does not provide an atomic/exclusive provenance
    // guarantee. A later read cannot make native text safe to send. This gate
    // applies to both Slack modes and does not affect authorized local history.
    const slackCommand=!!this.runtime&&w.source.kind!=='local';
    if(slackCommand&&(nativeContentCommands.has(c)||this.runtime!.unknownHome&&c.startsWith('files.')))throw new ConnectorError('NATIVE_CONTENT_LOCAL_ONLY');
    if(c==='session.search')return this.searchSessions(w,p);
    if(c==='session.overview')return this.content.overview(p.threadIds,p.maxChars);
    if(c==='session.messages')return this.content.messages(p);
    if(c==='session.subscribe'){const sub=await this.subscriptions.create(p.threadId,w.source);this.store.transaction(state=>{for(const o of state.outbox)if(o.status==='queued'&&!o.subscriptionId&&o.notificationThreadId===sub.threadId&&o.channel===sub.owner.channel&&o.threadTs===sub.owner.threadTs){o.status='failed';o.error='SUBSCRIPTION_ROUTE_REPLACED';}});return this.subscriptionSummary(sub);}
    if(c==='session.unsubscribe'){const result=this.subscriptions.cancel(p.subscriptionId,w.source);const sub=this.store.state.subscriptions?.find(s=>s.id===p.subscriptionId);if(sub)this.store.transaction(state=>{for(const o of state.outbox)if(o.status==='queued'&&!o.subscriptionId&&o.notificationThreadId===sub.threadId&&o.channel===sub.owner.channel&&o.threadTs===sub.owner.threadTs){o.status='failed';o.error='SUBSCRIPTION_CANCELLED';}});return result;}
    if(c==='session.subscriptions')return this.subscriptions.list(w.source).map(s=>this.subscriptionSummary(s));
    if(c==='result.next'){
      const row=this.freshSnapshot(p.resultId,w.source);
      if(slackCommand&&(nativeContentCommands.has(row.command)||row.nextCommand&&nativeContentCommands.has(row.nextCommand)))throw new ConnectorError('NATIVE_CONTENT_LOCAL_ONLY');
      let query;try{query=nextResultQuery(this.store.state,p.resultId,w.source,this.config);}catch{throw new ConnectorError('RESULT_UNAVAILABLE');}
      const command=nextResultCommand(this.store.state,p.resultId,w.source,this.config);
      return command==='session.search'?this.searchSessions(w,query as any):command==='session.messages'?this.content.messages(query as any):this.list(query,undefined,undefined,w.source);
    }
    if(c==='result.page'){
      const row=this.freshSnapshot(p.resultId,w.source);
      if(slackCommand&&(nativeContentCommands.has(row.command)||row.nextCommand&&nativeContentCommands.has(row.nextCommand)))throw new ConnectorError('NATIVE_CONTENT_LOCAL_ONLY');
      if(this.runtime&&row.visibility?.proof&&!this.liveProofAllowed(row.visibility.proof,w.source))throw new ConnectorError('RESULT_UNAVAILABLE');
      this.freshSnapshot(p.resultId,w.source);
      try{
        const page=readResult(this.store.state,p.resultId,p.page,w.source,this.config);
        evidence.proof=row.visibility?.proof;
        return page;
      }catch(e){throw new ConnectorError((e as Error).message==='RESULT_PAGE_INVALID'?'RESULT_PAGE_INVALID':'RESULT_UNAVAILABLE');}
    }
    if(c==='help')return formatHelp(p.command);if(c==='capabilities')return this.capabilities();
    if(c==='screen.list'||c==='screen.capture'){
      if(this.config.screenPolicy?.enabled!==true)throw new ScreenError('SCREEN_DISABLED');
      if(!this.screens)throw new ScreenError('SCREEN_DESKTOP_REQUIRED');
      if(c==='screen.list')return this.screens.list();
      if(!Number.isFinite(Date.parse(w.createdAt))||Date.now()-Date.parse(w.createdAt)>60000)throw new ScreenError('SCREEN_REQUEST_EXPIRED');
      const destination=this.originDestination(w.source);
      if(!destination)throw new ScreenError('SCREEN_SLACK_THREAD_REQUIRED');
      if(!this.slack.uploadScreens)throw new ScreenError('SCREEN_UPLOAD_UNAVAILABLE');
      if(!await this.slack.threadExists(destination.channel,destination.threadTs))throw new ScreenError('SCREEN_SLACK_THREAD_REQUIRED');
      const images=validateScreenImages(await this.screens.capture(p.displayId),p.displayId);
      try{
        this.reauthorize(w);if(this.closing||this.config.screenPolicy?.enabled!==true)throw new ScreenError('SCREEN_CANCELLED');
        await this.slack.uploadScreens(destination.channel,destination.threadTs,images,w.request.id);
        return{uploaded:images.map(i=>({displayId:i.displayId,width:i.width,height:i.height})),channel:destination.channel,threadTs:destination.threadTs,note:'One-shot unredacted JPEGs; bytes were not saved in connector state. Slack retention applies.'};
      }finally{for(const image of images)image.jpeg.fill(0);}
    }
    if(c==='files.list')return this.files.list(p.root,p.path,{limit:p.limit});if(c==='files.stat')return this.files.stat(p.root,p.path);
    if(c==='files.read')return this.files.read(p.root,p.path,{offset:p.offset,maxBytes:p.maxBytes});if(c==='files.search')return this.files.search(p.root,p.path,p.query,{limit:p.limit,maxDepth:p.maxDepth});
    if(c==='approval.list'){
      const pending=this.store.state.pending.filter(r=>(r.status==='pending'||slackCommand&&r.status==='local-required')&&r.expiresAt>Date.now()&&(!p.sessionId||r.sessionId===p.sessionId));
      if(slackCommand)return pending.filter(r=>r.slackOwner&&this.samePrincipal(r.slackOwner,w.source)&&this.sameCurrentPending(r))
        .map(r=>({id:r.id,sessionId:r.sessionId,turnId:r.turnId,kind:r.kind,expiresAt:r.expiresAt,status:'local-action-required'}));
      return pending.map(({rpcId,details,...r})=>r);
    }
    if(decisionCommands.has(c)){
      if(this.runtime)throw new ConnectorError('LOCAL_ACTION_REQUIRED');
      return this.answer(w);
    }
    if(c==='session.recent'){
      const result=await this.recent.query(p.limit);
      if(slackCommand)for(const row of [...result.sessions,...result.updatedCandidates])Object.assign(row,this.safeSlackMetadata(row),{currentState:safeThreadStatus(row.currentState),activityTurnId:null});
      return result;
    }
    if(c==='session.list'&&this.runtime&&w.source.kind==='local'){
      const principal=this.runtime.principal(w.source.userId)!;return this.list(p, Object.keys(this.config.projects).filter(a=>this.localProject(principal,a)),principal.id);
    }
    if(c==='session.list')return this.list(w.source.kind==='local'?p:{...p,view:p.view||'loaded',limit:Math.min(p.limit||10,10)},undefined,undefined,w.source);
    if(c==='session.create'||c==='session.attach')return this.attachOrCreate(p,c==='session.create',w);
    if(!boundCommands.has(c))throw new ConnectorError('UNKNOWN_COMMAND');
    const s=this.session(p.sessionId);
    if(this.runtime&&w.source.kind!=='local'&&!s.channel)throw new ConnectorError('SLACK_EXPLICIT_BINDING_REQUIRED');
    if(c==='session.delivery')return this.messageDelivery(w,s);
    if(c==='session.reply'){await this.metadata(s);if(this.runtime&&(!s.channel||!this.runtime.slackReady()))throw new ConnectorError('SLACK_EXPLICIT_BINDING_UNAVAILABLE');this.store.transaction(state=>this.sessionText(state,p.text,s.id,w.source.kind==='local'&&this.runtime?undefined:w.source));return{sessionId:s.id,queued:true};}
    if(c==='session.info'){
      const meta=await this.metadata(s),protectedSlack=slackCommand;
      const turns=await this.backend.rpc('thread/turns/list',{threadId:s.threadId,limit:3,itemsView:'notLoaded',sortDirection:'desc'});
      return{sessionId:s.id,threadId:s.threadId,outputThread:w.source.kind==='local'&&this.runtime?null:s.threadTs||null,attached:this.attached.has(s.threadId),...this.threadSummary(meta),...(protectedSlack?this.safeSlackMetadata(meta):{}),recentTurns:(turns.data||[]).filter((t:any)=>!protectedSlack||deliveryId(t.id)&&!!this.slackClaim(s.threadId,t.id,w.source)).map((t:any)=>({id:t.id,status:protectedSlack?safeTurnStatus(t.status):t.status}))};
    }
    if(c==='session.history'){
      await this.metadata(s);
      const principal=this.runtime&&w.source.kind==='local'?this.runtime.principal(w.source.userId):undefined;
      const identity=this.runtime?stable([this.runtime.id,s.id,s.threadId,w.source.kind,w.source.userId,w.source.channel,w.source.threadTs,principal?this.grantFingerprint(principal):null]):'';
      const scopeKey=identity&&createHash('sha256').update(identity).digest('hex');
      let cursor=p.cursor;
      if(cursor&&this.runtime){try{const [bound,native]=JSON.parse(Buffer.from(cursor,'base64url').toString());if(bound!==scopeKey||typeof native!=='string'||!native||native.length>1024)throw Error();cursor=native;}catch{throw new ConnectorError('INVALID_CURSOR');}}
      const r=await this.backend.rpc('thread/items/list',{threadId:s.threadId,limit:p.limit||20,cursor,sortDirection:'desc'});
      if(!Array.isArray(r?.data)||r.data.length>(p.limit||20)||(r.nextCursor!=null&&(typeof r.nextCursor!=='string'||!r.nextCursor||r.nextCursor===cursor||r.nextCursor.length>1024)))throw new ConnectorError('INVALID_SESSION_PAGE');
      const next=this.runtime&&r.nextCursor?Buffer.from(JSON.stringify([scopeKey,r.nextCursor])).toString('base64url'):r.nextCursor||null;
      // A project-level history grant authorizes discovery, not broadcasting other
      // principals' turns from a session deliberately bound to multiple entries.
      const shared=principal?.role==='agent'&&(!!s.channel||(s.localOwners?.length??0)>1);
      const mine=(turnId:unknown)=>{const evidence=this.store.state.work.filter(x=>typeof turnId==='string'&&x.messageDelivery?.threadId===s.threadId&&x.messageDelivery?.turnId===turnId);return evidence.length>0&&evidence.every(x=>x.source.kind==='local'&&x.source.userId===principal!.id&&this.usableEvidence(x));};
      return{items:r.data.filter((e:any)=>(!shared||mine(e.turnId))&&['userMessage','agentMessage'].includes((e.item||e).type)).map((e:any)=>{const item=e.item||e;const text=item.type==='agentMessage'?String(item.text||''):Array.isArray(item.content)?item.content.filter((c:any)=>c.type==='text').map((c:any)=>c.text).join('\n'):'';return{turnId:e.turnId,type:item.type,text:containsSensitiveContent(text)?'[sensitive text withheld]':text.slice(0,2000),truncated:text.length>2000};}),nextCursor:next,note:'Only user/assistant text; raw tool output and reasoning withheld'};
    }
    const t=await this.direct(s);
    if(this.runtime&&s.localOwners?.length&&(s.channel||s.localOwners.length>1)&&['session.interrupt','session.steer'].includes(c)){
      const rows=this.turnEvidence(s,p.turnId);if(!rows.length||!rows.every(row=>this.usableEvidence(row)&&this.samePrincipal(row.source,w.source)))throw new ConnectorError('TURN_OWNER_UNVERIFIED');
    }
    if(c==='session.interrupt'){
      const result=await this.backend.rpc('turn/interrupt',{threadId:s.threadId,turnId:p.turnId});
      return slackCommand?{threadId:s.threadId,turnId:p.turnId,interrupt:'submitted'}:result;
    }
    const input=[{type:'text',text:p.text}];
    if(c==='session.steer'){
      const result=await this.backend.rpc('turn/steer',{threadId:s.threadId,expectedTurnId:p.turnId,input,clientUserMessageId:w.id});
      return slackCommand?{threadId:s.threadId,turnId:p.turnId,steer:'submitted'}:result;
    }
    if(c==='session.queue')return this.submitMessage(w,s,p.resume===true);
    if(t.status?.type==='active')throw new ConnectorError('SESSION_BUSY_USE_STEER_OR_QUEUE');
    return this.submitMessage(w,s,true);
  }
  async sessionPage(params:unknown={}){if(!params||typeof params!=='object'||Array.isArray(params)||Object.keys(params).some(k=>!['limit','cursor','view'].includes(k)))throw new ConnectorError('INVALID_SESSION_QUERY');return this.list(validateCommand('session.list',params));}
  private async list(p:any,allowedProjects?:string[],scope?:string,source?:Source){
    const view=p.view||'all',project=p.project||null,roots=project?[this.project(project)]:allowedProjects?.map(a=>this.project(a)),limit=p.limit||50;
    type Cursor={v?:number;view?:string;project?:string|null;stored?:string;loaded?:string;storedDone?:boolean;loadedDone?:boolean};
    let cursor:Cursor={};
    const validBackendCursor=(value:unknown)=>typeof value==='string'&&value.length>0&&value.length<=512&&!/[\x00-\x1f]/.test(value);
    if(p.cursor){try{
      if(typeof p.cursor!=='string'||p.cursor.length>2048||!/^[A-Za-z0-9_-]+$/.test(p.cursor))throw Error();
      cursor=JSON.parse(Buffer.from(p.cursor,'base64url').toString());
      if(!cursor||Array.isArray(cursor)||typeof cursor!=='object'||['storedDone','loadedDone'].some(k=>(cursor as any)[k]!==undefined&&typeof(cursor as any)[k]!=='boolean')||['stored','loaded'].some(k=>(cursor as any)[k]!==undefined&&!validBackendCursor((cursor as any)[k])))throw Error();
      if(this.runtime&&(cursor as any).server!==this.runtime.id||((cursor as any).scope??undefined)!==scope)throw Error();
      if(cursor.v===undefined){
        // Old desktop cursors did not carry filter context. Never reinterpret them under a filter.
        if(view!=='all'||project!==null||Object.keys(cursor).some(k=>!['stored','loaded','storedDone','loadedDone','scope','server'].includes(k)))throw Error();
      }else{
        if(cursor.v!==2||cursor.view!==view||cursor.project!==project||Object.keys(cursor).some(k=>!['v','view','project','stored','loaded','storedDone','loadedDone','scope','server'].includes(k))||typeof cursor.storedDone!=='boolean'||typeof cursor.loadedDone!=='boolean')throw Error();
        if(cursor.storedDone===Boolean(cursor.stored)||cursor.loadedDone===Boolean(cursor.loaded))throw Error();
        if((view==='loaded'||view==='active')&&!cursor.storedDone||view==='history'&&!cursor.loadedDone)throw Error();
      }
      if(cursor.storedDone&&cursor.stored||cursor.loadedDone&&cursor.loaded||cursor.storedDone&&cursor.loadedDone)throw Error();
    }catch{throw new ConnectorError('INVALID_CURSOR');}}
    const byId=new Map<string,{thread:any;loaded:boolean|null;sources:string[]}>();
    const visible=(t:any)=>!roots||this.validCwd(t?.cwd)&&roots.some(root=>this.within(root,t.cwd));
    const unresolvedLoadedIds=new Set<string>(),unknownLoadedIds=new Set<string>(),skippedChildIds=new Set<string>(),unverifiedIds=new Set<string>();
    const classify=(thread:any)=>{
      const kind=classifyNativeThread(thread);
      if(kind==='child')skippedChildIds.add(thread.id);
      if(kind==='unknown')unverifiedIds.add(thread.id);
      return kind;
    };
    // Keep each raw upstream cursor. Request only remaining capacity so no
    // admitted root is discarded if children filled previous pages. Each
    // source is bounded to four pages and at most four times the row limit.
    const scan=async(mode:'stored'|'loaded',start:string|undefined,done:boolean)=>{
      const seen=new Set<string>(),accepted=new Set<string>(),visited=new Set<string>();
      if(start)visited.add(start);
      let nextCursor:string|undefined=start,scanned=0;
      if(done)return {nextCursor:undefined,scanned};
      for(let i=0;i<4&&accepted.size<limit;i++){
        const step=limit-accepted.size;
        const page=mode==='stored'?await this.backend.rpc('thread/list',{limit:step,cursor:nextCursor,useStateDbOnly:true}):
          await this.backend.rpc('thread/loaded/list',{limit:step,cursor:nextCursor});
        if(!page||!Array.isArray(page.data)||page.data.length>step||page.nextCursor!=null&&(!validBackendCursor(page.nextCursor)||visited.has(page.nextCursor)))throw new ConnectorError('INVALID_SESSION_PAGE');
        scanned+=page.data.length;
        for(const entry of page.data){
          const id=mode==='stored'?entry?.id:entry;
          if(typeof id!=='string'||!id||id.length>512)throw new ConnectorError('INVALID_SESSION_PAGE');
          if(seen.has(id))continue;
          seen.add(id);
          if(mode==='stored'){
            if(classify(entry)==='root'&&visible(entry)){byId.set(id,{thread:entry,loaded:null,sources:['indexed-history']});accepted.add(id);}
          }else{
            const previous=byId.get(id);
            try{
              const r=await this.backend.rpc('thread/read',{threadId:id,includeTurns:false});
              if(!r?.thread||r.thread.id!==id)throw Error('Invalid thread metadata');
              if(classify(r.thread)!=='root'){byId.delete(id);unknownLoadedIds.add(id);continue;}
              if(!r.thread.status?.type||r.thread.status.type==='unknown')unknownLoadedIds.add(id);
              if(visible(r.thread)&&(view!=='active'||r.thread.status?.type==='active')){
                byId.set(id,{thread:r.thread,loaded:true,sources:[...new Set([...(previous?.sources||[]),'loaded'])]});accepted.add(id);
              }else byId.delete(id);
            }catch{
              unresolvedLoadedIds.add(id);unknownLoadedIds.add(id);
              // No fabricated {id} row. A separate successfully indexed
              // root, if present, remains stored-only with loaded unknown.
            }
          }
        }
        nextCursor=page.nextCursor??undefined;
        if(!nextCursor)break;
        visited.add(nextCursor);
      }
      return {nextCursor,scanned};
    };
    const stored=await scan('stored',cursor.stored,view==='loaded'||view==='active'||cursor.storedDone===true);
    const loaded=await scan('loaded',cursor.loaded,view==='history'||cursor.loadedDone===true);
    const next=stored.nextCursor||loaded.nextCursor?Buffer.from(JSON.stringify({v:2,view,project,scope,server:this.runtime?.id,stored:stored.nextCursor||undefined,loaded:loaded.nextCursor||undefined,storedDone:!stored.nextCursor,loadedDone:!loaded.nextCursor})).toString('base64url'):null;
    if(next&&next.length>2048)throw new ConnectorError('INVALID_SESSION_PAGE');
    const sessions=[...byId.values()].map(row=>{
      const summary=this.threadSummary(row.thread),binding=this.store.state.sessions.find(s=>s.threadId===summary.id&&this.authorizedSession(s));
      return{...summary,...(this.runtime&&source&&source.kind!=='local'?{...this.safeSlackMetadata(summary),connectorSessionId:binding?.channel?summary.connectorSessionId:null}:{}),...(scope!==undefined&&!binding?.localOwners?.includes(scope)?{connectorSessionId:null}:{}),loaded:row.loaded,discoverySources:row.sources,binding:binding&&scope===undefined&&(!source||source.kind==='local'||!!binding.channel)?{channel:binding.channel,threadTs:binding.threadTs}:null};
    });
    const sources=view==='all'?'Current shared-daemon loaded IDs plus indexed interactive history (default thread/list sources)':view==='history'?'Indexed interactive history (default thread/list sources)':view==='active'?'Current shared-daemon loaded IDs with freshly read active status':'Current shared-daemon loaded IDs';
    return{sessions,nextCursor:next,project,unresolvedLoadedIds:allowedProjects?[]:[...unresolvedLoadedIds],lineageDiagnostics:{childThreads:skippedChildIds.size,unverifiedThreads:unverifiedIds.size,unreadableLoaded:unresolvedLoadedIds.size},pageLimitPerSource:limit,view,returnedCount:sessions.length,scanned:{loaded:loaded.scanned,history:stored.scanned},unknownLoadedCount:unknownLoadedIds.size,hasMore:next!==null,scope:`${sources}; root sessions only; up to four upstream pages per selected source, not a global session count or complete enumeration. Filters may return an empty page with a continuation cursor. Stored-only rows do not prove unloaded status. Children, unverified lineage and unreadable loaded IDs are diagnostics, not ordinary session rows. No resume, content preload, filesystem history scan, or control-policy filtering. Separate CODEX_HOME, standalone --no-daemon and other servers are not guaranteed visible.`};
  }

  private async attachOrCreate(p:any,create:boolean,work:Work){
    const source=work.source;
    if(source.kind!=='local'&&p.outputThreadTs)throw new ConnectorError('SLACK_ORIGIN_REQUIRED');
    let destination=this.originDestination(source);
    if(source.kind==='local'&&p.outputThreadTs){let exists=false;try{exists=await this.slack.threadExists(this.config.slack.outputChannel,p.outputThreadTs);}catch{}if(!exists)throw new ConnectorError('THREAD_DESTINATION_UNVERIFIED');destination={channel:this.config.slack.outputChannel,threadTs:p.outputThreadTs};}
    if(create&&!destination&&!(this.runtime&&source.kind==='local'))throw new ConnectorError('THREAD_DESTINATION_REQUIRED');
    let thread:any;let alias:string;let s:Session|undefined,created=false;
    try{
      if(create){
        const cwd=this.project(p.project),epoch=this.backend.epoch;
        if(!this.backend.connected)throw new BackendError('BACKEND_UNAVAILABLE');
        let reply:any;
        try{reply=await this.backend.rpc('thread/start',{cwd});}
        catch(e){
          const code=codeOf(e);
          if(['BACKEND_UNAVAILABLE','METHOD_UNSUPPORTED','RPC_FORBIDDEN'].includes(code))throw e;
          throw new BackendError('RPC_OUTCOME_UNCERTAIN');
        }
        created=true;thread=reply?.thread;alias=p.project;
        if(!this.backend.connected||this.backend.epoch!==epoch||!deliveryId(thread?.id))throw new ConnectorError('INVALID_THREAD_METADATA');
        this.requireNativeRoot(thread,thread.id);
        this.checkProject(thread,alias);
        if(this.canonicalCwd(thread.cwd)!==this.canonicalCwd(cwd))throw new ConnectorError('THREAD_PROJECT_MISMATCH');
      }
      else{const epoch=this.backend.epoch;thread=(await this.backend.rpc('thread/read',{threadId:p.threadId,includeTurns:false})).thread;if(!this.backend.connected||this.backend.epoch!==epoch||thread?.id!==p.threadId)throw new ConnectorError('INVALID_THREAD_METADATA');this.requireNativeRoot(thread);if(!this.validCwd(thread?.cwd))throw new ConnectorError('SESSION_SCOPE_NOT_ALLOWED');if(p.project){this.checkProject(thread,p.project);alias=p.project;}else{const known=this.projectFor(thread.cwd);if(!known&&!this.config.sessionPolicy?.allowAllSharedSessions)throw new ConnectorError('SESSION_SCOPE_NOT_ALLOWED');alias=known||'@shared';}}
      if(!deliveryId(thread?.id)||(!create&&p.threadId!==thread.id))throw new ConnectorError('INVALID_THREAD_METADATA');
      this.reauthorize(work);
      if(this.runtime&&source.kind==='local'&&!this.localProject(this.runtime.principal(source.userId)!,alias))throw new ConnectorError('LOCAL_SCOPE_DENIED');
      s=this.store.state.sessions.find(s=>s.threadId===thread.id);
      if(s){if(create)throw new ConnectorError('THREAD_ID_ALREADY_BOUND');this.checkSessionThread(thread,s);if(this.runtime&&source.kind==='local'&&(s.project!==alias||!s.cwd||!this.within(this.config.projects[alias]!,s.cwd)))throw new ConnectorError('LOCAL_SCOPE_DENIED');}
      if(!create){
        const initial=thread,epoch=this.backend.epoch;thread=(await this.backend.rpc('thread/resume',{threadId:initial.id,excludeTurns:true})).thread;
        if(!this.backend.connected||this.backend.epoch!==epoch||thread?.id!==initial.id||this.canonicalCwd(thread?.cwd)!==this.canonicalCwd(initial.cwd))throw new ConnectorError('THREAD_PROJECT_MISMATCH');
        this.requireNativeRoot(thread);
        this.reauthorize(work);
        s=this.store.state.sessions.find(s=>s.threadId===thread.id);
        if(s)this.checkSessionThread(thread,s);
      }
      if(!s){
        if(!destination&&!this.runtime)throw new ConnectorError('THREAD_DESTINATION_REQUIRED');
        s={id:randomUUID(),threadId:thread.id,project:alias,cwd:thread.cwd,channel:destination?.channel||'',threadTs:destination?.threadTs,createdAt:new Date().toISOString(),...(this.runtime&&source.kind==='local'?{localOwners:[source.userId]}:{})};
        const saved=s;this.store.transaction(state=>{state.sessions.push(saved);if(destination)this.output(state,`Codex session ${saved.id}\nThread ${saved.threadId}\nProject ${saved.project}\n${p.title||''}`,saved.id);});
      }else if(this.runtime){
        const id=s.id;this.store.transaction(state=>{const row=state.sessions.find(x=>x.id===id)!;if(source.kind==='local'&&!row.localOwners?.includes(source.userId))(row.localOwners??=[]).push(source.userId);if(destination&&!row.channel){row.channel=destination.channel;row.threadTs=destination.threadTs;}});s=this.session(id);
      }
    }catch(e){if(created)throw new BackendError('RPC_OUTCOME_UNCERTAIN');throw e;}
    this.attached.add(thread.id);this.flush();return{sessionId:s.id,threadId:thread.id,canAcceptDirectInput:this.runtime&&source.kind!=='local'?(typeof thread.canAcceptDirectInput==='boolean'?thread.canAcceptDirectInput:null):thread.canAcceptDirectInput??null,status:this.runtime&&source.kind!=='local'?{type:safeThreadStatus(thread.status?.type)}:thread.status,outputChannel:this.runtime&&source.kind==='local'&&!destination?null:s.channel,outputThread:this.runtime&&source.kind==='local'&&!destination?null:s.threadTs,observation:{attachCreatesSubscription:false,note:'Control binding only; attach does not subscribe to commentary or partial answers (including ordinary questions). Use session.subscribe in the desired Slack thread, then session.subscriptions to check status. Existing sessions cannot share native bodies. The local owner can explicitly create a separate dedicated sharing session. Existing explicit subscriptions and cancellation remain unchanged.',subscribe:{command:'session.subscribe',params:{threadId:thread.id}}}};
  }
  private async notification(method:string,p:any,epoch:string){
    if(epoch!==this.backend.epoch||!this.backend.connected)return;
    if(['turn/started','turn/completed','item/started','item/completed'].includes(method)){const activity=recordActivity(this.store.state.activity,method,p,Date.now());if(activity)this.store.transaction(s=>{s.activity=activity;});}
    if(method!=='serverRequest/resolved'&&!await this.canObserveRoot(p?.threadId,epoch))return;
    if(['turn/started','turn/completed','item/started','item/completed'].includes(method))this.observeDelivery(method,p);
    if(this.localEvents){
      this.localEvents.observe(method,p,epoch);
      if(method==='item/started'||method==='item/completed')this.noteSlackInput(p);
      if(!this.runtime!.slackReady()&&method!=='serverRequest/resolved')return;
      if(method!=='serverRequest/resolved'){
        const turnId=p.turnId||p.turn?.id,source=this.slackTurnSource(p.threadId,turnId);
        const session=this.store.state.sessions.find(s=>s.threadId===p.threadId&&this.authorizedSession(s));
        if(method==='turn/completed')this.staleTurnRequests(p.threadId,p.turn?.id);
        if(source&&session)this.scopedNotice(method,p,session,source);
        return;
      }
    }
    if(method==='serverRequest/resolved'){
      this.store.transaction(s=>{for(const r of s.pending)if(r.epoch===epoch&&r.rpcId===p.requestId&&['pending','responding','local-required'].includes(r.status))r.status='resolved';});return;
    }
    const session=this.store.state.sessions.find(s=>s.threadId===p.threadId&&this.authorizedSession(s));
    if(!session&&!this.store.state.subscriptions?.some(s=>s.enabled&&s.threadId===p.threadId))return;
    if(session&&(method==='item/started'||method==='item/completed'))this.rememberItem(p);
    if(method==='item/completed'&&p.item?.type==='agentMessage'&&(!p.item.phase||['commentary','partial_answer','final_answer'].includes(p.item.phase))&&typeof p.item.text==='string'){
      const key=`${p.threadId}:${p.turnId}:${p.item.id}`;
      this.store.transaction(state=>{const seen=Object.hasOwn(state.seenNotifications,key),before=state.outbox.length;
        const boundFinal=session&&(!p.item.phase||p.item.phase==='final_answer');
        if(boundFinal){
          if(!seen&&!this.subscriptions.hasExplicitDestination(session.threadId,session.channel,session.threadTs||''))this.boundNotice(state,p.item.text,session,true);
          this.subscriptions.emit(state,p.item.text,p.threadId,key,sub=>sub.owner.channel===session.channel&&sub.owner.threadTs===session.threadTs);
        }
        this.subscriptions.emit(state,`Session ${p.threadId}; turn ${p.turnId||'unknown'}; ${p.item.phase||'final_answer'}\n${p.item.text}`,p.threadId,key,sub=>!session||sub.owner.channel!==session.channel||sub.owner.threadTs!==session.threadTs||Boolean(p.item.phase&&p.item.phase!=='final_answer'));
        if(state.outbox.length>before)state.seenNotifications[key]=true;
      });this.flush();
    }
    if(method==='turn/completed'){
      const key=`turn:${p.threadId}:${p.turn?.id}:${p.turn?.status}`;
      this.store.transaction(state=>{for(const r of state.pending)if(r.threadId===p.threadId&&r.turnId===p.turn?.id&&['pending','local-required'].includes(r.status))r.status='stale';const seen=Object.hasOwn(state.seenNotifications,key),before=state.outbox.length;
        const text=`Session ${p.threadId}; turn ${p.turn?.id||'unknown'}: ${p.turn?.status||'terminal'}.`;
        if(session&&p.turn?.status!=='completed'){
          const boundText=text+' Inspect session.info before continuing.';
          if(!seen&&!this.subscriptions.hasExplicitDestination(session.threadId,session.channel,session.threadTs||''))this.boundNotice(state,boundText,session);
          this.subscriptions.emit(state,boundText,p.threadId,key,sub=>sub.owner.channel===session.channel&&sub.owner.threadTs===session.threadTs);
        }
        this.subscriptions.emit(state,text,p.threadId,key,sub=>!session||p.turn?.status==='completed'||sub.owner.channel!==session.channel||sub.owner.threadTs!==session.threadTs);
        if(state.outbox.length>before)state.seenNotifications[key]=true;
      });this.flush();
    }
    if(method==='error'&&p.willRetry===false){this.store.transaction(state=>this.subscriptions.emit(state,`Session ${p.threadId}; turn ${p.turnId||'unknown'}: execution error. Inspect the original local session.`,p.threadId,`error:${p.threadId}:${p.turnId}`));this.flush();}
  }
  private samePrincipal(a:Source,b:Source){return a.kind===b.kind&&a.userId===b.userId&&a.channel===b.channel&&a.threadTs===b.threadTs;}
  private turnEvidence(session:Session,turnId:unknown){
    return typeof turnId==='string'?this.store.state.work.filter(w=>w.messageDelivery?.threadId===session.threadId&&w.messageDelivery?.turnId===turnId):[];
  }
  private usableEvidence(w:Work){return !w.messageDelivery?.correlationConflict&&!(w as Work & {localEventMixedInput?:true}).localEventMixedInput;}
  private inputKey(threadId:string,turnId:string){return stable([threadId,turnId]);}
  private rememberItem(p:any){
    if(deliveryId(p.threadId)&&deliveryId(p.turnId)&&deliveryId(p.item?.id)){
      this.items.set(stable([p.threadId,p.turnId,p.item.id]),p.item);
      if(this.items.size>1000)this.items.delete(this.items.keys().next().value!);
    }
  }
  private slackClaim(threadId:string,turnId:string,source?:Source,state=this.store.state){
    const session=state.sessions.find(s=>s.threadId===threadId&&s.channel&&this.authorizedSession(s));
    if(!session)return;
    const claims=state.work.filter(w=>w.messageDelivery?.threadId===threadId&&w.messageDelivery?.turnId===turnId);
    if(!claims.length)return;
    const base=claims[0]!;
    if(base.source.kind==='local'||source&&!this.samePrincipal(source,base.source))return;
    if(!claims.every(w=>w.request.params.sessionId===session.id&&w.messageDelivery!.clientUserMessageId===w.id&&
      this.usableEvidence(w)&&!w.slackMixedInput&&this.samePrincipal(w.source,base.source)))return;
    try{this.subscriptionActor(base.source);return base;}catch{return;}
  }
  private inputsBelong(threadId:string,turnId:string,items:Map<string,string|null>,source:Source,state=this.store.state){
    const base=this.slackClaim(threadId,turnId,source,state);
    if(!base)return false;
    const clients=[...items.values()];
    // A queue/start acknowledgement alone does not prove who supplied all
    // inputs. Require the native user item's exact client ID as well.
    return clients.includes(base.id)&&clients.every(id=>id!==null&&this.matchSlackInput(threadId,turnId,id,base,state));
  }
  private matchSlackInput(threadId:string,turnId:string,id:string,base:Work,state:Readonly<State>){
    const w=state.work.find(x=>x.id===id);
    return !!w&&this.samePrincipal(w.source,base.source)&&w.request.params.sessionId===base.request.params.sessionId&&
      (w.messageDelivery?.clientUserMessageId===id&&w.messageDelivery?.threadId===threadId&&w.messageDelivery?.turnId===turnId&&this.usableEvidence(w)&&!w.slackMixedInput||
        w.request.command==='session.steer'&&w.request.params.turnId===turnId&&['executing','completed','uncertain'].includes(w.status));
  }
  private noteSlackInput(p:any){
    if(p.item?.type!=='userMessage'||!deliveryId(p.threadId)||!deliveryId(p.turnId))return;
    const key=this.inputKey(p.threadId,p.turnId);
    const row=this.slackInputs.get(key)??{items:new Map<string,string|null>(),overflow:false};
    const client=deliveryId(p.item.clientId)?p.item.clientId:null;
    if(!deliveryId(p.item.id)||row.items.size>=64&&!row.items.has(p.item.id))row.overflow=true;
    else if(row.items.has(p.item.id)&&row.items.get(p.item.id)!==client)row.overflow=true;
    else row.items.set(p.item.id,client);
    this.slackInputs.set(key,row);
    if(this.slackInputs.size>500)this.slackInputs.delete(this.slackInputs.keys().next().value!);
    const affected=(w:Work,state:Readonly<State>)=>w.source.kind!=='local'&&!w.slackMixedInput&&
      w.messageDelivery?.threadId===p.threadId&&w.messageDelivery?.turnId===p.turnId&&
      (row.overflow||[...row.items.values()].some(id=>id===null||!this.matchSlackInput(p.threadId,p.turnId,id,w,state)));
    const state=this.store.state;
    if(state.work.some(w=>affected(w,state)))this.store.transaction(draft=>{
      const bad=draft.work.filter(w=>affected(w,draft));
      for(const w of bad)w.slackMixedInput=true;
      // Retire only snapshots that depended on this now mixed turn. The outbox
      // revalidates the same witnesses immediately before posting.
      if(draft.results)draft.results=draft.results.filter(r=>{
        if(!bad.some(w=>this.samePrincipal(r.source,w.source)))return true;
        const proof=r.visibility?.proof;
        return !proof||proof.threadId!==p.threadId||proof.turnId!==p.turnId;
      });
    });
  }
  private slackTurnSource(threadId:unknown,turnId:unknown):Source|undefined{
    if(!deliveryId(threadId)||!deliveryId(turnId))return;
    const state=this.store.state,base=this.slackClaim(threadId,turnId,undefined,state);
    const entries=this.slackInputs.get(this.inputKey(threadId,turnId));
    if(base&&!base.messageDelivery?.observationGap&&entries&&!entries.overflow&&this.inputsBelong(threadId,turnId,entries.items,base.source,state))return base.source;
  }
  private staleTurnRequests(threadId:unknown,turnId:unknown){
    if(this.store.state.pending.some(r=>r.threadId===threadId&&r.turnId===turnId&&['pending','local-required'].includes(r.status)))
      this.store.transaction(st=>{for(const r of st.pending)if(r.threadId===threadId&&r.turnId===turnId&&['pending','local-required'].includes(r.status))r.status='stale';});
  }
  private scopedEvent(state:State,s:Session,source:Source,turnId:string,key:string,notice:NativeNotice,automatic=false){
    // Only closed enum values can reach this path; no native strings, not even
    // truncated fragments of commentary, finals, errors, diff or question text.
    const proof:SlackTurnProof={kind:'live',threadId:s.threadId,turnId,epoch:this.backend.epoch,owner:source};
    const text=`Session ${s.threadId}; turn ${turnId}. ${nativeNotice[notice]}`;
    const post=(destination:Source,subscriptionId?:string)=>{
      const from=state.outbox.length;
      this.output(state,text,s.id,destination,proof);
      for(const o of state.outbox.slice(from)){o.notificationThreadId=s.threadId;o.subscriptionId=subscriptionId;}
    };
    const existing=this.subscriptions.hasExplicitDestination(s.threadId,source.channel,source.threadTs);
    if(automatic&&!existing&&!Object.hasOwn(state.seenNotifications,key))post(source);
    this.subscriptions.emit(state,text,s.threadId,key,sub=>this.samePrincipal(sub.owner,source),(_state,_text,sub)=>post(sub.owner,sub.id));
    state.seenNotifications[key]=true;
  }
  private scopedNotice(method:string,p:any,s:Session,source:Source){
    const turnId=p.turnId||p.turn?.id;
    if(!deliveryId(turnId))return;
    let key:string|undefined,notice:NativeNotice|undefined,automatic=false;
    if(method==='item/completed'&&p.item?.type==='agentMessage'&&(!p.item.phase||['commentary','partial_answer','final_answer'].includes(p.item.phase))&&deliveryId(p.item.id)){
      automatic=!p.item.phase||p.item.phase==='final_answer';
      notice=automatic?'final':'progress';key=stable(['native-notice',s.threadId,turnId,notice]);
    }
    if(method==='turn/completed'&&terminalExecution(p.turn?.status)){
      notice=p.turn.status as 'completed'|'failed'|'interrupted';automatic=notice!=='completed';
      key=stable(['native-notice',s.threadId,turnId,notice]);
    }
    if(method==='error'&&p.willRetry===false){notice='error';key=stable(['native-notice',s.threadId,turnId,notice]);}
    if(!key||!notice)return;
    this.store.transaction(st=>this.scopedEvent(st,s,source,turnId,key!,notice!,automatic));this.flush();
  }
  private async serverRequest(r:any){
    if(r.epoch!==this.backend.epoch||!this.backend.connected||!['string','number'].includes(typeof r.id))return;
    if(!await this.canObserveRoot(r.params?.threadId,r.epoch))return;
    this.localEvents?.observeRequest(r);
    if(this.runtime){
      if(this.runtime.slackReady())this.scopedServerRequest(r);
      return;
    }
    const previous=this.store.state.pending.find(p=>p.rpcId===r.id&&p.epoch===r.epoch);
    if(previous&&(!['pending','local-required'].includes(previous.status)||previous.expiresAt<=Date.now()||
      previous.threadId!==r.params?.threadId||previous.turnId!==(r.params?.turnId||'unavailable')||previous.method!==r.method))return;
    const s=this.store.state.sessions.find(s=>s.threadId===r.params?.threadId&&this.authorizedSession(s));
    const notice=(state:State,text:string)=>{if(s)this.boundNotice(state,text,s,false,`request:${r.epoch}:${r.id}`);};
    this.store.transaction(state=>this.subscriptions.emit(state,`Session ${r.params?.threadId}; turn ${r.params?.turnId||'unknown'}: local decision/input required. Use the original local Codex UI or its authorized bound approval thread. This observation does not grant approval authority.`,r.params?.threadId,`request:${r.epoch}:${r.id}`,sub=>!s||sub.owner.channel!==s.channel||sub.owner.threadTs!==s.threadTs));this.flush();
    if(!s)return;
    if(previous){
      if(previous.threadId===s.threadId&&previous.sessionId===s.id&&['pending','local-required'].includes(previous.status)&&previous.expiresAt>Date.now())this.store.transaction(state=>notice(state,this.requestNotice(previous)));
      this.flush();return;
    }
    let kind:Pending['kind']='unsupported';if(r.method==='item/commandExecution/requestApproval')kind='command';if(r.method==='item/fileChange/requestApproval')kind='file';if(r.method==='item/tool/requestUserInput')kind='input';
    const details=structuredClone(r.params),decisions=Array.isArray(details.availableDecisions)?details.availableDecisions.filter((x:any)=>['accept','decline','cancel'].includes(x)):['accept','decline','cancel'];
    let local=kind==='unsupported'||typeof details.turnId!=='string'||kind==='input'&&(!Array.isArray(details.questions)||details.questions.some((q:any)=>q.isSecret));
    if(kind==='file'){
      const item=this.items.get(stable([details.threadId,details.turnId,details.itemId]));details.changes=item?.changes;
      if(details.grantRoot||!Array.isArray(details.changes)||!details.changes.length||details.changes.some((c:any)=>typeof c.path!=='string'||!c.path||typeof c.diff!=='string'||!c.diff||!['add','delete','update'].includes(c.kind?.type)))local=true;
    }
    if(kind==='command'&&((details.kind&&details.kind!=='command')||typeof details.command!=='string'||!details.command.trim()||typeof details.cwd!=='string'||!details.cwd))local=true;
    // Never offer accept for hidden/truncated scope or relay known credential-bearing data.
    const serialized=JSON.stringify(details);
    if(serialized.length>12000 || resultSensitive(details) || containsSensitiveContent(serialized) || containsSensitiveContent(String(details.command||'')) || /(?:Bearer\s+\S+|(?:xox[baprs]-|xapp-|github_pat_|sk-proj-)[A-Za-z0-9_-]{12,}|-----BEGIN .*PRIVATE KEY|(?:password|secret|token|api[_-]?key)\s*[=:]\s*[^\s,}]{6,}|[\\/]\.codex[\\/]|[\\/]\.env(?:[.\\/]|$))/i.test(serialized))local=true;
    const safeDetails=local?{notice:'Sensitive, oversized, unsupported, or broader-scope request; inspect locally',itemId:details.itemId}:details;
    const pending:Pending={id:randomUUID(),rpcId:r.id,epoch:r.epoch,sessionId:s.id,threadId:s.threadId,turnId:details.turnId||'unavailable',method:r.method,kind,status:local?'local-required':'pending',details:safeDetails,decisions,expiresAt:Date.now()+this.config.approvalTimeoutSec*1000};
    this.store.transaction(state=>{state.pending.push(pending);notice(state,this.requestNotice(pending));});this.flush();
  }
  private scopedServerRequest(r:any){
    if((typeof r.id==='number'&&!Number.isSafeInteger(r.id))||(typeof r.id==='string'&&!deliveryId(r.id)))return;
    const details=r.params,threadId=details?.threadId,turnId=details?.turnId;
    if(!deliveryId(threadId)||!deliveryId(turnId))return;
    const owner=this.slackTurnSource(threadId,turnId),state=this.store.state;
    const s=state.sessions.find(x=>x.threadId===threadId&&this.authorizedSession(x));
    if(!owner||!s)return;
    const known=new Map<string,Pending['kind']>([['item/commandExecution/requestApproval','command'],['item/fileChange/requestApproval','file'],['item/tool/requestUserInput','input'],['item/permissions/requestApproval','unsupported'],['mcpServer/elicitation/request','unsupported']]);
    const kind=known.get(r.method);
    if(!kind)return;
    const key=stable(['native-request',r.epoch,r.id]);
    const previous=state.pending.find(p=>p.rpcId===r.id&&p.epoch===r.epoch);
    if(previous&&(!['pending','local-required'].includes(previous.status)||previous.expiresAt<=Date.now()||
      previous.sessionId!==s.id||previous.threadId!==threadId||previous.turnId!==turnId||previous.method!==r.method||
      !previous.slackOwner||!this.samePrincipal(previous.slackOwner,owner)))return;
    this.store.transaction(draft=>{
      // Reminders are never a control lease. Preserve identity and deadline
      // for reporting; no raw question, command, options or permission data.
      if(!previous&&owner.channel===s.channel&&owner.threadTs===s.threadTs){
        const pending:Pending={id:randomUUID(),rpcId:r.id,epoch:r.epoch,sessionId:s.id,threadId,turnId,method:r.method,kind,
          status:'local-required',details:{notice:'Open the original Codex UI.'},decisions:[],slackOwner:owner,
          expiresAt:Date.now()+this.config.approvalTimeoutSec*1000};
        draft.pending.push(pending);
      }
      this.scopedEvent(draft,s,owner,turnId,key,'decision',true);
    });
    this.flush();
  }
  private requestNotice(p:Pending){return p.status==='local-required'?`LOCAL_ACTION_REQUIRED: ${p.method}\nrequestId=${p.id}; sensitive, unsupported, or broader-scope request. No approval was granted. Use the original local Codex UI.`:this.prompt(p);}
  private prompt(p:Pending){
    const params:any={requestId:p.id,epoch:p.epoch,sessionId:p.sessionId,turnId:p.turnId};
    if(p.kind==='input')params.answers=Object.fromEntries((p.details.questions||[]).map((q:any)=>[q.id,['YOUR ANSWER']]));else params.decision='decline';
    if(this.runtime)params.serverId=this.runtime.id;
    const sample={v:1,id:randomUUID(),target:this.config.instanceId,command:p.kind==='input'?'input.respond':'approval.respond',params};
    return `Human decision required (expires ${new Date(p.expiresAt).toISOString()}). Exact scope only; no session/global grant.\n${short(p.details,16000)}\nReply in THIS thread as an authorized human with:\n${START_MARKER}\n${JSON.stringify(sample)}\n${END_MARKER}`;
  }
  private async verifiedHuman(w:Work,pending:Pending){
    const s=this.session(pending.sessionId),source=w.source,params=w.request.params as any;
    if(source.kind==='human'&&this.config.slack.approvalUsers.includes(source.userId)&&source.channel===s.channel&&source.threadTs===s.threadTs)return;
    if(source.kind!=='bot'||!params.humanMessageTs||!s.threadTs)throw new ConnectorError('NEED_VERIFIABLE_HUMAN_DECISION');
    let message:any;try{message=await this.slack.humanMessage(s.channel,s.threadTs,params.humanMessageTs);}catch{throw new ConnectorError('NEED_VERIFIABLE_HUMAN_DECISION');}
    if(!message||message.bot_id||message.app_id||message.edited||message.subtype||!this.config.slack.approvalUsers.includes(message.user)||message.thread_ts!==s.threadTs)throw new ConnectorError('NEED_VERIFIABLE_HUMAN_DECISION');
    let proof:CommandEnvelope;try{proof=parseEnvelope(message.text,this.config.instanceId);}catch{throw new ConnectorError('NEED_VERIFIABLE_HUMAN_DECISION');}
    if(proof.command!==w.request.command)throw new ConnectorError('HUMAN_PROOF_MISMATCH');
    const wanted={...params};delete wanted.humanMessageTs;
    const actual={...proof.params};delete actual.humanMessageTs;
    if(JSON.stringify(Object.entries(wanted).sort())!==JSON.stringify(Object.entries(actual).sort()))throw new ConnectorError('HUMAN_PROOF_MISMATCH');
  }
  private async answer(w:Work){
    const p=w.request.params as any;let pending=this.store.state.pending.find(r=>r.id===p.requestId);
    if(!pending||pending.status!=='pending'||pending.epoch!==this.backend.epoch||p.epoch!==pending.epoch||p.sessionId!==pending.sessionId||p.turnId!==pending.turnId||pending.expiresAt<=Date.now())throw new ConnectorError('STALE_OR_MISROUTED_REQUEST');
    await this.verifiedHuman(w,pending);
    let result:any;
    if(w.request.command==='approval.respond'){
      if(!['command','file'].includes(pending.kind)||!pending.decisions.includes(p.decision))throw new ConnectorError('DECISION_NOT_AVAILABLE');result={decision:p.decision};
    }else{
      if(pending.kind!=='input')throw new ConnectorError('WRONG_REQUEST_KIND');const questions=pending.details.questions||[],keys=questions.map((q:any)=>q.id);
      if(Object.keys(p.answers).length!==keys.length||Object.keys(p.answers).some(k=>!keys.includes(k)))throw new ConnectorError('INPUT_QUESTIONS_MISMATCH');
      for(const q of questions){const answers=p.answers[q.id];if(q.isSecret||!answers?.length||answers.some((a:string)=>a.length>2000))throw new ConnectorError('INPUT_NOT_ALLOWED');if(q.options?.length&&!q.isOther&&answers.some((a:string)=>!q.options.some((o:any)=>o.label===a)))throw new ConnectorError('INPUT_OPTION_INVALID');}
      result={answers:Object.fromEntries(Object.entries(p.answers).map(([k,v])=>[k,{answers:v}]))};
    }
    // Recheck after async proof fetch; a reconnect/resolution may have invalidated it.
    pending=this.store.state.pending.find(r=>r.id===p.requestId)!;
    if(pending.status!=='pending'||pending.epoch!==this.backend.epoch||pending.expiresAt<=Date.now())throw new ConnectorError('STALE_OR_MISROUTED_REQUEST');
    this.store.transaction(s=>{s.pending.find(r=>r.id===pending!.id)!.status='responding';});
    try{await this.backend.respond(pending.rpcId,result);}catch{throw new BackendError('RPC_OUTCOME_UNCERTAIN');}
    return{requestId:pending.id,status:'submitted; awaiting server resolution notification'};
  }
  private disconnected(epoch:string){
    this.localEvents?.markDisconnected();this.attached.clear();this.verifiedRoots.clear();this.items.clear();this.slackInputs.clear();this.deliveryTurns.clear();this.store.transaction(s=>{for(const w of s.work)if(w.messageDelivery)w.messageDelivery.observationGap=true;for(const p of s.pending)if(p.epoch===epoch&&(['pending','responding'].includes(p.status)||p.status==='local-required'&&!!p.slackOwner))p.status='stale';});
  }
  private sameCurrentPending(original:Pending){
    if(!this.runtime?.slackReady()||this.closing||!this.backend.connected||this.backend.epoch!==original.epoch||!original.slackOwner)return;
    const state=this.store.state,current=state.pending.find(p=>p.id===original.id);
    if(!current||!['pending','local-required'].includes(current.status)||current.rpcId!==original.rpcId||current.threadId!==original.threadId||
      current.turnId!==original.turnId||current.epoch!==original.epoch||current.sessionId!==original.sessionId||
      current.method!==original.method||current.kind!==original.kind||current.expiresAt!==original.expiresAt||
      !current.slackOwner||!this.samePrincipal(original.slackOwner,current.slackOwner))return;
    const s=state.sessions.find(s=>s.id===current.sessionId&&s.threadId===current.threadId&&this.authorizedSession(s));
    const owner=this.slackTurnSource(current.threadId,current.turnId);
    if(!s||!owner||!this.samePrincipal(owner,current.slackOwner)||s.channel!==owner.channel||s.threadTs!==owner.threadTs)return;
    return s;
  }
  async expire(){
    const now=Date.now();
    if(this.store.state.results?.some(r=>r.expiresAt<=now))this.store.transaction(s=>{s.results=(s.results||[]).filter(r=>r.expiresAt>now);});
    for(const p of this.store.state.pending.filter(p=>['pending','local-required'].includes(p.status)&&p.expiresAt<=now)){
      const route=this.runtime?this.sameCurrentPending(p):undefined;
      this.store.transaction(s=>{
        const current=s.pending.find(x=>x.id===p.id);
        if(!current||!['pending','local-required'].includes(current.status)||current.expiresAt>now)return;
        current.status='expired';current.deadlineOutcome='not-attempted';
        // The protocol has no conditional pending-request interrupt. The
        // deadline only expires our bookkeeping, regardless of ownership;
        // no readback, callback refusal, answer or native interruption.
        if(route&&p.slackOwner)this.scopedEvent(s,route,p.slackOwner,p.turnId,stable(['native-deadline',p.epoch,p.rpcId]),'deadline',true);
        else if(!this.runtime){
          const session=s.sessions.find(x=>x.id===p.sessionId);
          if(session)this.boundNotice(s,'The Connector reminder expired. Check the original Codex UI. No native action was taken.',session);
        }
      });
    }
    this.flush();
  }
  flush(){if(this.closing||this.delivering||this.runtime&&!this.runtime.slackReady())return;try{this.store.assertHealthy();}catch{return;}this.delivering=this.deliver().catch(()=>{}).finally(()=>{this.delivering=undefined;if(!this.closing&&this.nextDelivery())queueMicrotask(()=>this.flush());});}
  private deliveryLane(o:Delivery,state:Readonly<State>){return `${o.channel}:${o.threadTs||state.sessions.find(s=>s.id===o.sessionId)?.threadTs||'missing'}`;}
  private nextDelivery(){
    const state=this.store.state;return state.outbox.find((o,index)=>o.status==='queued'&&o.nextAttemptAt<=Date.now()&&(!o.subscriptionId||!this.subscriptions.deliveryWaiting(o.subscriptionId))&&(!o.nativeShare||!this.nativeSharing?.waiting(o,state))&&!state.outbox.slice(0,index).some(earlier=>this.deliveryLane(earlier,state)===this.deliveryLane(o,state)&&!['sent','failed'].includes(earlier.status)));
  }
  private liveProofAllowed(proof:SlackTurnProof,source:Source){
    if(proof.kind!=='live'||proof.epoch!==this.backend.epoch||!this.backend.connected||!this.samePrincipal(source,proof.owner))return false;
    const owner=this.slackTurnSource(proof.threadId,proof.turnId);
    return !!owner&&this.samePrincipal(owner,source);
  }
  private validFixedNotice(text:string,proof:SlackTurnProof){
    const prefix=`Session ${proof.threadId}; turn ${proof.turnId}. `;
    return (Object.values(nativeNotice) as string[]).some(notice=>text===prefix+notice);
  }
  private deliveryTarget(o:Delivery,state:Readonly<State>){
    if(!this.scopeMatches(o,state)||o.root||!this.validChannel(o.channel)||containsSensitiveContent(o.text))return;
    const session=o.sessionId?state.sessions.find(s=>s.id===o.sessionId):undefined;
    if(o.sessionId&&(!session||!this.authorizedSession(session)))return;
    if(o.notificationThreadId&&!this.rootObserved(o.notificationThreadId))return;
    const threadTs=o.threadTs||(!o.origin?session?.threadTs:undefined);
    if(!this.validTimestamp(threadTs))return;
    if(o.subscriptionId&&!this.subscriptions.deliveryAllowed(o.subscriptionId)||o.notificationThreadId&&!o.subscriptionId&&this.subscriptions.hasExplicitDestination(o.notificationThreadId,o.channel,threadTs))return;
    if(o.origin){
      const dest=this.originDestination(o.origin);
      if(!dest||dest.channel!==o.channel||dest.threadTs!==threadTs)return;
      if(this.runtime)try{this.subscriptionActor(o.origin);}catch{return;}
    }else if(!session||session.channel!==o.channel||session.threadTs!==threadTs)return;
    const proof=o.visibility?.proof;
    const text=o.nativeShare&&!proof?this.nativeSharing?.wireBody(o,state):o.nativeShare?undefined:o.text;
    if(!text)return;
    if(proof&&!o.origin)return;
    if(proof&&(!this.liveProofAllowed(proof,o.origin!)||!this.validFixedNotice(o.text,proof)))return;
    return{threadTs,text};
  }
  private refuseDelivery(id:string){
    this.store.transaction(s=>{const o=s.outbox.find(x=>x.id===id);if(o?.status==='queued'){o.status='failed';o.error='SLACK_DELIVERY_SCOPE_UNVERIFIED';}});
  }
  private async deliver(){
    while(!this.closing&&(!this.runtime||this.runtime.slackReady())){
      const next=this.nextDelivery();if(!next||!this.store.state.dot)return;
      if(!this.deliveryTarget(next,this.store.state)){this.refuseDelivery(next.id);continue;}
      await new Promise(r=>setTimeout(r,Math.max(0,this.lastPost+this.postIntervalMs-Date.now())));
      if(this.closing||this.runtime&&!this.runtime.slackReady())return;
      let state=this.store.state,current=state.outbox.find(o=>o.id===next.id);
      if(!current||current.status!=='queued')continue;
      if(current.subscriptionId&&this.subscriptions.deliveryWaiting(current.subscriptionId))continue;
      if(current.nativeShare){
        if(this.nativeSharing?.waiting(current,state))continue;
        const prepared=await this.nativeSharing?.prepare(current);
        state=this.store.state;current=state.outbox.find(o=>o.id===next.id);
        if(!current||current.status!=='queued'||this.closing||!this.runtime?.slackReady())continue;
        if(prepared==='pause'){this.store.transaction(d=>{const o=d.outbox.find(x=>x.id===next.id);if(o?.status==='queued')o.nextAttemptAt=Date.now()+15000;});continue;}
        if(prepared!=='ready'){this.refuseDelivery(next.id);continue;}
      }
      if(!this.deliveryTarget(current,state)){this.refuseDelivery(next.id);continue;}
      const destination=this.deliveryTarget(current,state),dot=state.dot;
      if(!destination||!dot){this.refuseDelivery(next.id);continue;}
      // No await between these final current checks and invoking the adapter.
      this.store.transaction(s=>{const o=s.outbox.find(o=>o.id===next.id)!;o.status='sending';o.attempts++;});
      try{
        const ts=await this.slack.post(current.channel,destination.text,{threadTs:destination.threadTs,mentionUserId:current.mention===false?undefined:dot.userId,deliveryId:current.id});this.lastPost=Date.now();
        this.store.transaction(s=>{const o=s.outbox.find(o=>o.id===next.id)!;o.status='sent';o.ts=ts;o.deliveryEvidence='slack-api-ack';});
      }catch(e:any){
        if(current.nativeShare&&isSlackRootPermissionDenial(e)){
          this.store.transaction(s=>{const o=s.outbox.find(o=>o.id===next.id)!;o.status='failed';o.error='NATIVE_SHARE_DESTINATION_UNVERIFIED';});
          this.nativeSharing?.recipientRejected(current.nativeShare.grantId);
          continue;
        }
        this.store.transaction(s=>{const o=s.outbox.find(o=>o.id===next.id)!;if(e?.code==='slack_webapi_rate_limited_error'&&o.attempts<10){o.status='queued';o.nextAttemptAt=Date.now()+Math.max(1000,Number(e.retryAfter||1)*1000);}else{o.status='uncertain';o.error='Slack delivery may have occurred; local recovery required, never rerun Codex';}});return;
      }
    }
  }
  status(){const s=this.store.state;return{capabilities:this.capabilities(),sessions:s.sessions,work:s.work.map(w=>{const {request,source,localResult,localGrant,...safe}=w;return{...safe,command:request.command,...(['session.send','session.queue'].includes(request.command)?{commandStatus:w.status,deliveryStatus:deliveryStatus(w)}:{})};}),outbox:s.outbox.map(({text,nativeShare,...o})=>({...o,...(nativeShare?{sharedNativeContent:true}:{})})),pending:s.pending.map(({details,rpcId,...p})=>p)};}
  recover(kind:'command'|'outbox',id:string,observedTs?:string){
    let blocked=false;
    this.store.transaction(s=>{
      if(kind==='command'){const w=s.work.find(w=>w.id===id);if(!w||w.status!=='uncertain')throw new ConnectorError('NOT_UNCERTAIN');w.status='failed';w.error='Locally reviewed; not replayed';}
      else{
        const o=s.outbox.find(o=>o.id===id);if(!o||o.status!=='uncertain')throw new ConnectorError('NOT_UNCERTAIN');
        if(observedTs!==undefined){if(!this.validTimestamp(observedTs))throw new ConnectorError('INVALID_TIMESTAMP');o.status='sent';o.ts=observedTs;o.deliveryEvidence='operator-attested';}
        else if(o.nativeShare||this.runtime&&!this.deliveryTarget(o,s)){
          o.status='failed';o.error='SLACK_DELIVERY_SCOPE_UNVERIFIED';blocked=true;
        }
        else{o.status='queued';o.error='Operator explicitly requested delivery retry; duplicate Slack post possible';}
      }
    });this.pump();this.flush();
    if(blocked)throw new ConnectorError('SLACK_DELIVERY_SCOPE_UNVERIFIED');
  }
  async close(){this.closing=true;const sharing=this.nativeSharing?.close();await this.backend.close();await sharing;await Promise.all(this.running.values());await this.events;await this.delivering;}
}
