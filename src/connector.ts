import { ScreenError, validateScreenImages, type ScreenPort } from './screens.js';
import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve,relative,isAbsolute,sep } from 'node:path';
import { RecentSessions, RecentError } from './session-recent.js';
import { deliveryId, deliveryStatus, deliveryView, observeMessage, observeTurn, terminalExecution, type MessageDelivery } from './session-delivery.js';
import { recordActivity } from './session-activity.js';
import { SessionContent, SessionContentError } from './session-content.js';
import { SessionSubscriptions, SubscriptionError, type Subscription } from './subscriptions.js';
import { Store } from './store.js';
import { compactResult, storeResult, readResult, nextResultQuery, nextResultCommand, resultPolicy, resultSensitive } from './slack-results.js';
import { ReadonlyFiles, FileAccessError, containsSensitiveContent } from './files.js';
import { parseEnvelope, validateCommand, ProtocolError, formatHelp, COMMANDS, START_MARKER, END_MARKER, type CommandEnvelope } from './protocol.js';
import { BackendError } from './codex.js';
import { formatRpcDiagnostic } from './rpc-diagnostics.js';
import { parseSlackEnvelope, isSlackAddressed, SlackTransportError, SLACK_TRANSPORT_REVISION } from './slack-envelope.js';
import type { Backend, Config, Delivery, Pending, Session, SlackPort, Source, State, Work } from './types.js';
export class ConnectorError extends Error { constructor(readonly code:string){super(code);} }
const codeOf=(e:unknown)=>e instanceof ScreenError||e instanceof RecentError||e instanceof SessionContentError||e instanceof SubscriptionError||e instanceof ConnectorError||e instanceof BackendError||e instanceof FileAccessError ? e.code : 'OPERATION_FAILED';
const decisionCommands=new Set(['approval.respond','input.respond']);
const boundCommands=new Set(['session.delivery','session.info','session.history','session.send','session.steer','session.queue','session.interrupt','session.reply']);
function short(value:unknown,max=20000){const text=typeof value==='string'?value:JSON.stringify(value,null,2);return text.length>max?text.slice(0,max)+'\n[truncated; request a smaller page]':text;}
export class Connector {
  private running=new Map<string,Promise<void>>();private delivering?:Promise<void>;private closing=false;private lastPost=0;
  private deliveryTurns=new Map<string,{threadId:string;turn:{id:string;status:string};conflict?:true}>();
  private events=Promise.resolve();private attached=new Set<string>();private items=new Map<string,any>();
  readonly files:ReadonlyFiles;
  readonly subscriptions:SessionSubscriptions;
  readonly content:SessionContent;
  readonly recent:RecentSessions;
  selfUserId='';selfBotId='';
  constructor(readonly config:Config,readonly store:Store,readonly backend:Backend,readonly slack:SlackPort,private postIntervalMs=1100,private screens?:ScreenPort){
    this.files=new ReadonlyFiles(config.projects,{},config.filePolicy?.allowAbsolutePaths===true);
    this.recent=new RecentSessions(backend,()=>this.store.state.activity||[],t=>this.threadSummary(t));
    this.content=new SessionContent(backend,thread=>{const cwd=this.canonicalCwd(thread?.cwd);if(!cwd||(!this.config.sessionPolicy?.allowAllSharedSessions&&!this.projectFor(cwd)))throw new ConnectorError('SESSION_SCOPE_NOT_ALLOWED');return this.threadSummary({...thread,cwd});});
    this.subscriptions=new SessionSubscriptions(store,backend,{
      policy:()=>resultPolicy(this.config),
      validate:(thread,owner)=>{this.subscriptionActor(owner);const cwd=this.canonicalCwd(thread?.cwd);if(!cwd||(!this.config.sessionPolicy?.allowAllSharedSessions&&!this.projectFor(cwd)))throw new ConnectorError('SESSION_SCOPE_NOT_ALLOWED');return{cwd,project:this.projectFor(cwd)};},
      allow:sub=>{try{this.subscriptionActor(sub.owner);return this.validCwd(sub.cwd)&&(this.config.sessionPolicy?.allowAllSharedSessions===true||Boolean(this.projectFor(sub.cwd)));}catch{return false;}},
      output:(state,text,sub)=>{const start=state.outbox.length;this.sessionText(state,text,'',sub.owner);for(const out of state.outbox.slice(start)){out.subscriptionId=sub.id;out.notificationThreadId=sub.threadId;}}
    });
    backend.on('notification',(method,params,epoch)=>this.event(()=>this.notification(method,params,epoch)));
    backend.on('request',request=>this.event(()=>this.serverRequest(request)));
    backend.on('disconnect',epoch=>this.event(()=>this.disconnected(epoch)));
  }
  private event(operation:()=>Promise<void>|void){this.events=this.events.then(operation).catch(()=>{/* Persisted state stays authoritative. No raw payload logs. */});}
  async initialize(){
    const saved=this.store.state.dot;const dot=await this.slack.resolveDot(this.config.slack.dot.name,this.config.slack.dot.userId||(saved?.selector===this.config.slack.dot.name?saved.userId:undefined));
    this.store.transaction(s=>{s.dot={...dot,selector:this.config.slack.dot.name};});
    await this.reconnect();
  }
  async reconnect(){
    if(this.closing)return;
    try{
      await this.backend.connect();
      await this.subscriptions.rejoin();
      for(const s of this.store.state.sessions){
        if(this.attached.has(s.threadId)||!this.authorizedSession(s))continue;
        try{const r=await this.backend.rpc('thread/read',{threadId:s.threadId,includeTurns:false});this.checkSessionThread(r.thread,s);await this.backend.rpc('thread/resume',{threadId:s.threadId,excludeTurns:true});this.attached.add(s.threadId);}catch{/* Capabilities/status exposes unavailable attachment; never starts a replacement thread. */}
      }
    }catch{/* Server remains usable for help/files/status. No independent fallback. */}
    this.pump();this.flush();
  }
  capabilities(){return{...this.backend.capabilities(),instanceId:this.config.instanceId,slackTransport:{revision:SLACK_TRANSPORT_REVISION,connectorUserId:this.selfUserId||null,connectorBotId:this.selfBotId||null},sessionPolicy:{allowAllSharedSessions:this.config.sessionPolicy?.allowAllSharedSessions===true},outputChannel:this.config.slack.outputChannel,dot:this.store.state.dot,attachedThreads:[...this.attached],screenCapture:{enabled:this.config.screenPolicy?.enabled===true,desktopAvailable:!!this.screens,commands:['screen.list','screen.capture'],oneShot:true,unredacted:true,slackThreadOnly:true,maxDisplays:8,maxImageDimension:2560},fileTools:{mode:this.files.absolutePathsEnabled?'absolute-readonly-and-project-roots':'project-roots-only',allowAbsolutePaths:this.files.absolutePathsEnabled,readOnly:true,osPermissions:true,sensitivePathsBlocked:true,enablement:'Local desktop Settings only; stop connector, explicitly enable full-system read-only access, save and restart. Never enabled by Slack.'},approvalAuthority:'direct configured humans or verified same-thread human envelope; bots alone cannot approve',sessionDelivery:{command:'session.delivery',correlation:'queue start turn ID or userMessage.clientId',automaticRetry:false,completion:'matched terminal turn only'},sessionRecent:{command:'session.recent',defaultLimit:5,maxLimit:20,globalTopN:false,observation:'Producer lifecycle timestamps only; no content or automatic subscriptions'},sessionContent:{overview:'session.overview',messages:'session.messages',batchMax:5,readOnly:true,semanticSummary:false},subscriptions:{commands:['session.subscribe','session.unsubscribe','session.subscriptions'],loadedOnly:true,localCancellationOnly:true},slackOutput:{mode:'compact',sessionDefaultView:'loaded',maxRowsPerSource:10,resultDetail:'result.page',nextPage:'result.next'},serviceManagement:'local template generation only'};}
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
    this.store.assertHealthy();const source=this.authorizeEvent(body);if(!source)return false;
    if(Object.hasOwn(this.store.state.seenEvents,source.eventId))return true;
    const mention=this.selfUserId?`<@${this.selfUserId}>`:'';const addressed=Boolean(mention&&isSlackAddressed(body.event.text,mention,source.kind==='bot'));
    if(!body.event.text.startsWith(START_MARKER)&&!addressed)return false;
    let request:CommandEnvelope;
    try{request=parseSlackEnvelope(body.event.text,body.event.blocks,this.config.instanceId,source.kind==='bot',addressed?mention:undefined);}catch(e){this.store.transaction(s=>{Object.defineProperty(s.seenEvents,source.eventId,{value:'rejected',enumerable:true,writable:true,configurable:true});this.output(s,`Command rejected: ${e instanceof ProtocolError?e.code:'invalid_envelope'}. Transport ${SLACK_TRANSPORT_REVISION}: ${e instanceof SlackTransportError?e.stage:'envelope'}. Use the generated help envelope exactly.`,undefined,source);});return true;}
    if(source.channel!==this.config.slack.inputChannel&&!decisionCommands.has(request.command)&&!['result.page','session.unsubscribe','session.subscriptions'].includes(request.command)){this.store.transaction(s=>{Object.defineProperty(s.seenEvents,source.eventId,{value:'rejected',enumerable:true,writable:true,configurable:true});this.output(s,'Command rejected: COMMAND_CHANNEL_NOT_ALLOWED. Use the configured command channel; no session operation executed.',undefined,source);});return true;}
    this.record(request,source);return true;
  }
  local(request:CommandEnvelope){
    if(request.target!==this.config.instanceId)throw new ConnectorError('WRONG_TARGET');request={...request,params:validateCommand(request.command,request.params)};
    if(decisionCommands.has(request.command))throw new ConnectorError('NEED_VERIFIABLE_HUMAN_DECISION');
    const id=this.record(request,{kind:'local',userId:'local',channel:this.config.slack.inputChannel,threadTs:'',ts:'',eventId:`local-${request.id}`});this.pump();return{id,requestId:request.id,status:'accepted',acceptance:'connector-inbox-only',deliveryConfirmed:false};
  }
  private record(request:CommandEnvelope,source:Source):string{
    return this.store.transaction(s=>{
      if(Object.hasOwn(s.seenEvents,source.eventId))return s.seenEvents[source.eventId]!;
      const existing=s.work.find(w=>w.request.id===request.id&&w.source.kind===source.kind&&w.source.userId===source.userId);
      const id=existing?.id||randomUUID();
      Object.defineProperty(s.seenEvents,source.eventId,{value:id,enumerable:true,writable:true,configurable:true});
      if(existing){if(JSON.stringify(existing.request)!==JSON.stringify(request))this.output(s,`REQUEST_ID_CONFLICT: ${request.id}; use a new ID for a different command.`,undefined,source);else this.output(s,`REQUEST_ALREADY_ACCEPTED: ${request.id}; work ${existing.id}; status ${existing.status}${existing.messageDelivery?`; message evidence ${deliveryView(existing).deliveryStatus}; check session.delivery with workId ${existing.id}`:''}. No operation was repeated.`,undefined,source);return id;}
      if(s.work.filter(w=>['queued','executing'].includes(w.status)).length>=500)throw new ConnectorError('QUEUE_FULL');
      s.work.push({id,eventId:source.eventId,request,source,status:'queued',createdAt:new Date().toISOString()});return id;
    });
  }
  private key(w:Work){
    if(COMMANDS[w.request.command].permission==='read')return `read:${w.request.command}:${w.request.params.sessionId||'global'}`;
    if(decisionCommands.has(w.request.command))return `decision:${w.request.params.requestId}`;
    return typeof w.request.params.sessionId==='string'?w.request.params.sessionId:`global:${w.request.command}`;
  }
  pump(){
    if(this.closing)return;try{this.store.assertHealthy();}catch{return;}
    for(const w of this.store.state.work.filter(w=>w.status==='queued')){
      const key=this.key(w);if(this.running.has(key))continue;
      if(w.request.command!=='screen.capture'&&this.store.state.work.some(x=>this.key(x)===key&&x.status==='uncertain'))continue;
      const task=this.drain(key).catch(()=>{}).finally(()=>{this.running.delete(key);queueMicrotask(()=>this.pump());});this.running.set(key,task);
    }
  }
  private async drain(key:string){
    while(!this.closing){
      const w=this.store.state.work.find(w=>w.status==='queued'&&this.key(w)===key);if(!w)return;
      this.store.transaction(s=>{s.work.find(x=>x.id===w.id)!.status='executing';});
      try{
        this.reauthorize(w);let result=await this.execute(w);
        this.store.transaction(s=>{const done=s.work.find(x=>x.id===w.id)!;done.status='completed';if(done.messageDelivery&&['session.send','session.queue'].includes(w.request.command))result=deliveryView(done);const snapshot=w.source.kind!=='local'&&w.request.command!=='result.page'?storeResult(s,w,result,this.config):undefined;done.resultRef={sessionId:this.outputSession(w,result),threadId:typeof result?.threadId==='string'?result.threadId:undefined,turnId:typeof result?.turnId==='string'?result.turnId:typeof result?.turn?.id==='string'?result.turn.id:undefined,resultId:snapshot?.id};const text=w.source.kind==='local'?`[request ${w.request.id}; work ${w.id}] ${short(result,w.request.command.startsWith('files.')||['session.list','session.recent','session.history'].includes(w.request.command)?500000:20000)}`:compactResult(w,result,snapshot);this.output(s,text+this.bindingNote(w,result),this.outputSession(w,result),w.source);});
      }catch(e){
        const code=codeOf(e),uncertain=code==='SCREEN_UPLOAD_UNCERTAIN'||code==='RPC_OUTCOME_UNCERTAIN'&&COMMANDS[w.request.command].permission!=='read';
        const reason=uncertain?(code==='SCREEN_UPLOAD_UNCERTAIN'?': inspect the Slack thread for partial or completed uploads; no automatic retry.':': inspect backend state; operation will not be replayed.'):code==='SCREEN_RESTART_REQUIRED'||code==='SCREEN_TIMEOUT'?': quit and reopen the desktop app before a new explicit capture request.':code==='SCREEN_PERMISSION_DENIED'?': grant Screen Recording permission in local OS settings, then restart the desktop app.':code==='SCREEN_UPLOAD_REJECTED'?': check Slack files:write scope, channel membership and rate limits; no automatic retry.':'';
        this.store.transaction(s=>{const current=s.work.find(x=>x.id===w.id)!;current.status=uncertain?'uncertain':'failed';current.error=code;this.output(s,`[${w.id}] ${code}${reason}${current.messageDelivery?` Message evidence: ${deliveryView(current).deliveryStatus}; admission=${current.messageDelivery.admission}; start=${current.messageDelivery.start}; execution=${current.messageDelivery.execution}.${current.messageDelivery.admissionError?` Admission request: ${current.messageDelivery.admissionError} (${formatRpcDiagnostic(current.messageDelivery.admissionDiagnostic)}).`:""}${current.messageDelivery.startError?` Start request: ${current.messageDelivery.startError} (${formatRpcDiagnostic(current.messageDelivery.startDiagnostic)}).`:""} Check session.delivery {"sessionId":"${current.request.params.sessionId}","workId":"${current.id}"}. Do not resend.`:''}`,typeof w.request.params.sessionId==='string'?w.request.params.sessionId:undefined,w.source);});
        if(uncertain)return;
      }finally{this.flush();}
    }
  }
  private reauthorize(w:Work){
    const s=this.config.slack,a=w.source;if(a.kind==='local')return;
    if(a.kind==='human'&&!s.allowedHumans.includes(a.userId))throw new ConnectorError('ACTOR_REVOKED');
    if(a.kind==='bot'&&!s.trustedBots.some(b=>b.userId===a.userId))throw new ConnectorError('ACTOR_REVOKED');
    if(![s.inputChannel,s.outputChannel].includes(a.channel))throw new ConnectorError('CHANNEL_REVOKED');
  }
  private outputSession(w:Work,result:any):string|undefined{return typeof w.request.params.sessionId==='string'?w.request.params.sessionId:typeof result?.sessionId==='string'?result.sessionId:undefined;}
  private bindingNote(w:Work,result:any){const session=this.store.state.sessions.find(s=>s.id===this.outputSession(w,result)&&this.authorizedSession(s));return session&&w.source.kind!=='local'&&(session.channel!==w.source.channel||session.threadTs!==w.source.threadTs)?`\nSession notifications remain in ${session.channel}, thread ${session.threadTs||'unavailable'}; this command did not move the binding.`:'';}
  private validTimestamp(value:unknown):value is string{return typeof value==='string'&&/^\d{1,20}\.\d{1,10}$/.test(value);}
  private validChannel(channel:string){return[this.config.slack.inputChannel,this.config.slack.outputChannel].includes(channel);}
  private originDestination(source?:Source){return source&&source.kind!=='local'&&this.validChannel(source.channel)&&this.validTimestamp(source.threadTs)?{channel:source.channel,threadTs:source.threadTs}:undefined;}
  private output(state:State,text:string,sessionId?:string,source?:Source){
    if(containsSensitiveContent(text))text='Sensitive-looking output withheld; inspect the original local Codex session. No credentials were sent.';
    const session=state.sessions.find(s=>s.id===sessionId&&this.authorizedSession(s));if(!session)sessionId=undefined;
    const origin=source?.kind!=='local'?source:undefined;
    const destination=origin?this.originDestination(origin):session&&this.validTimestamp(session.threadTs)?{channel:session.channel,threadTs:session.threadTs}:undefined;
    const points=[...text];for(let i=0;i<points.length||i===0;i+=2400){const chunk=points.slice(i,i+2400).join('');state.outbox.push({id:randomUUID(),sessionId,origin,channel:destination?.channel||'',threadTs:destination?.threadTs,root:false,text:chunk,mention:i===0,status:destination?'queued':'failed',error:destination?undefined:'THREAD_DESTINATION_REQUIRED',attempts:0,nextAttemptAt:0});}
  }
  private sessionText(state:State,text:string,sessionId:string,source?:Source){
    if(containsSensitiveContent(text)){this.output(state,'Sensitive-looking output withheld; inspect locally.',sessionId,source);return;}
    if([...text].length<=1800){this.output(state,text,sessionId,source);return;}
    const session=state.sessions.find(s=>s.id===sessionId&&this.authorizedSession(s));
    const dot=state.dot?.userId,owner=source&&source.kind!=='local'?source:session&&dot&&this.config.slack.trustedBots.some(b=>b.userId===dot)?{kind:'bot' as const,userId:dot,channel:session.channel,threadTs:session.threadTs||'',ts:'',eventId:'notification'}:undefined;
    const snapshot=owner?storeResult(state,{id:randomUUID(),eventId:owner.eventId,source:owner,request:{v:1,id:randomUUID(),target:this.config.instanceId,command:'session.reply',params:{sessionId}},status:'completed',createdAt:new Date().toISOString()},text,this.config):undefined;
    const footer=snapshot?`\nFull text: result.page {"resultId":"${snapshot.id}","page":1}; same recipient/thread, 15 min.`:'\nLong text shortened; inspect the local session/source for the full response.';
    this.output(state,[...text].slice(0,1600).join('')+'\n[Long response preview]'+footer,sessionId,source);
  }
  private subscriptionActor(source:Source){
    if(source.kind==='local'||!this.originDestination(source))throw new ConnectorError('SUBSCRIPTION_SLACK_THREAD_REQUIRED');
    const allowed=source.kind==='human'?this.config.slack.allowedHumans.includes(source.userId):this.config.slack.trustedBots.some(b=>b.userId===source.userId);
    if(!allowed)throw new ConnectorError('ACTOR_REVOKED');
  }
  private boundNotice(state:State,text:string,session:Session,preview=false){
    const before=state.outbox.length;
    const route=(source?:Source,id?:string)=>{const start=state.outbox.length;if(preview)this.sessionText(state,text,session.id,source);else this.output(state,text,session.id,source);for(const o of state.outbox.slice(start)){o.notificationThreadId=session.threadId;o.subscriptionId=id;}};
    if(!this.subscriptions.hasExplicitDestination(session.threadId,session.channel,session.threadTs||''))route();
    else for(const sub of state.subscriptions||[])if(sub.threadId===session.threadId&&sub.owner.channel===session.channel&&sub.owner.threadTs===session.threadTs&&this.subscriptions.eventAllowed(sub.id))route(sub.owner,sub.id);
    return state.outbox.length-before;
  }
  private subscriptionSummary(sub:Subscription){return{subscriptionId:sub.id,threadId:sub.threadId,enabled:sub.enabled,status:sub.status,error:sub.error,channel:sub.owner.channel,threadTs:sub.owner.threadTs};}
  private session(id:unknown):Session{const s=this.store.state.sessions.find(s=>s.id===id);if(!s)throw new ConnectorError('SESSION_NOT_FOUND');if(!this.authorizedSession(s))throw new ConnectorError('SESSION_SCOPE_REVOKED');return s;}
  private canonicalCwd(cwd:string){try{if(!this.validCwd(cwd))return undefined;const real=realpathSync(cwd);return this.validCwd(real)?real:undefined;}catch{return undefined;}}
  private within(root:string,cwd:string){const a=this.canonicalCwd(root),b=this.canonicalCwd(cwd);if(!a||!b)return false;const rel=relative(a,b);return rel===''||(!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel));}
  private projectFor(cwd:string){return Object.entries(this.config.projects).find(([,root])=>this.within(root,cwd))?.[0];}
  private validCwd(cwd:unknown):cwd is string{return typeof cwd==='string'&&isAbsolute(cwd)&&!/[\x00-\x1f]/.test(cwd)&&!/[\\/]\.codex[\\/]sessions(?:[\\/]|$)/i.test(cwd);}
  private authorizedSession(s:Session){const cwd=s.cwd||this.config.projects[s.project];return this.validChannel(s.channel)&&this.validCwd(cwd)&&(this.config.sessionPolicy?.allowAllSharedSessions===true||Boolean(this.projectFor(cwd)));}
  private checkSessionThread(thread:any,s:Session){const cwd=s.cwd||this.config.projects[s.project];if(!this.authorizedSession(s)||!this.validCwd(thread?.cwd)||(this.canonicalCwd(thread.cwd)||resolve(thread.cwd))!==(this.canonicalCwd(cwd!)||resolve(cwd!)))throw new ConnectorError('THREAD_PROJECT_MISMATCH');}
  private project(alias:unknown){if(typeof alias!=='string'||!Object.hasOwn(this.config.projects,alias))throw new ConnectorError('PROJECT_NOT_ALLOWED');return this.config.projects[alias]!;}
  private checkProject(thread:any,alias:string){if(!this.validCwd(thread?.cwd)||!this.within(this.project(alias),thread.cwd))throw new ConnectorError('THREAD_PROJECT_MISMATCH');}
  private async metadata(s:Session){const r=await this.backend.rpc('thread/read',{threadId:s.threadId,includeTurns:false});this.checkSessionThread(r.thread,s);return r.thread;}
  private threadSummary(t:any){const project=this.validCwd(t.cwd)?this.projectFor(t.cwd):undefined,allowed=this.validCwd(t.cwd)&&(Boolean(project)||this.config.sessionPolicy?.allowAllSharedSessions===true);return{id:t.id,name:typeof t.name==='string'?t.name.slice(0,200):null,cwd:typeof t.cwd==='string'?t.cwd.slice(0,1024):null,project:project||null,manageable:allowed&&t.canAcceptDirectInput===true,reason:!allowed?'SESSION_SCOPE_NOT_ALLOWED':t.canAcceptDirectInput===false?'DIRECT_INPUT_UNAVAILABLE':t.canAcceptDirectInput!==true?'ATTACH_TO_CHECK_CAPABILITY':null,canAcceptDirectInput:t.canAcceptDirectInput??null,status:{type:t.status?.type||'unknown'},model:typeof t.model==='string'?t.model.slice(0,100):null,reasoningEffort:t.reasoningEffort??null,source:typeof t.source==='string'?t.source:'structured-source',connectorSessionId:this.store.state.sessions.find(s=>s.threadId===t.id)?.id||null};}
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
    if(!original||(w.source.kind!=='local'&&(original.source.kind!==w.source.kind||original.source.userId!==w.source.userId||original.source.channel!==w.source.channel||original.source.threadTs!==w.source.threadTs)))throw new ConnectorError('DELIVERY_NOT_FOUND');
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
  private async execute(w:Work):Promise<any>{
    const p=w.request.params as any,c=w.request.command;
    if(c==='session.overview')return this.content.overview(p.threadIds,p.maxChars);
    if(c==='session.messages')return this.content.messages(p);
    if(c==='session.subscribe'){const sub=await this.subscriptions.create(p.threadId,w.source);this.store.transaction(state=>{for(const o of state.outbox)if(o.status==='queued'&&!o.subscriptionId&&o.notificationThreadId===sub.threadId&&o.channel===sub.owner.channel&&o.threadTs===sub.owner.threadTs){o.status='failed';o.error='SUBSCRIPTION_ROUTE_REPLACED';}});return this.subscriptionSummary(sub);}
    if(c==='session.unsubscribe'){const result=this.subscriptions.cancel(p.subscriptionId,w.source);const sub=this.store.state.subscriptions?.find(s=>s.id===p.subscriptionId);if(sub)this.store.transaction(state=>{for(const o of state.outbox)if(o.status==='queued'&&!o.subscriptionId&&o.notificationThreadId===sub.threadId&&o.channel===sub.owner.channel&&o.threadTs===sub.owner.threadTs){o.status='failed';o.error='SUBSCRIPTION_CANCELLED';}});return result;}
    if(c==='session.subscriptions')return this.subscriptions.list(w.source).map(s=>this.subscriptionSummary(s));
    if(c==='result.next'){let query;try{query=nextResultQuery(this.store.state,p.resultId,w.source,this.config);}catch{throw new ConnectorError('RESULT_UNAVAILABLE');}return nextResultCommand(this.store.state,p.resultId,w.source,this.config)==='session.messages'?this.content.messages(query as any):this.list(query);}
    if(c==='result.page'){try{return readResult(this.store.state,p.resultId,p.page,w.source,this.config);}catch(e){throw new ConnectorError((e as Error).message==='RESULT_PAGE_INVALID'?'RESULT_PAGE_INVALID':'RESULT_UNAVAILABLE');}}
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
    if(c==='approval.list')return this.store.state.pending.filter(r=>r.status==='pending'&&(!p.sessionId||r.sessionId===p.sessionId)).map(({rpcId,details,...r})=>r);
    if(decisionCommands.has(c))return this.answer(w);
    if(c==='session.recent')return this.recent.query(p.limit);
    if(c==='session.list')return this.list(w.source.kind==='local'?p:{...p,view:p.view||'loaded',limit:Math.min(p.limit||10,10)});
    if(c==='session.create'||c==='session.attach')return this.attachOrCreate(p,c==='session.create',w.source);
    if(!boundCommands.has(c))throw new ConnectorError('UNKNOWN_COMMAND');
    const s=this.session(p.sessionId);
    if(c==='session.delivery')return this.messageDelivery(w,s);
    if(c==='session.reply'){this.store.transaction(state=>this.sessionText(state,p.text,s.id,w.source));return{sessionId:s.id,queued:true};}
    if(c==='session.info'){const meta=await this.metadata(s);const turns=await this.backend.rpc('thread/turns/list',{threadId:s.threadId,limit:3,itemsView:'summary',sortDirection:'desc'});return{sessionId:s.id,threadId:s.threadId,outputThread:s.threadTs||null,attached:this.attached.has(s.threadId),...this.threadSummary(meta),recentTurns:(turns.data||[]).map((t:any)=>({id:t.id,status:t.status}))};}
    if(c==='session.history'){
      await this.metadata(s);const r=await this.backend.rpc('thread/items/list',{threadId:s.threadId,limit:p.limit||20,cursor:p.cursor,sortDirection:'desc'});
      return{items:(r.data||[]).filter((e:any)=>['userMessage','agentMessage'].includes((e.item||e).type)).map((e:any)=>{const item=e.item||e;const text=item.type==='agentMessage'?String(item.text||''):Array.isArray(item.content)?item.content.filter((c:any)=>c.type==='text').map((c:any)=>c.text).join('\n'):'';return{turnId:e.turnId,type:item.type,text:text.slice(0,2000),truncated:text.length>2000};}),nextCursor:r.nextCursor||null,note:'Only user/assistant text; raw tool output and reasoning withheld'};
    }
    const t=await this.direct(s);
    if(c==='session.interrupt')return this.backend.rpc('turn/interrupt',{threadId:s.threadId,turnId:p.turnId});
    const input=[{type:'text',text:p.text}];
    if(c==='session.steer')return this.backend.rpc('turn/steer',{threadId:s.threadId,expectedTurnId:p.turnId,input,clientUserMessageId:w.id});
    if(c==='session.queue')return this.submitMessage(w,s,p.resume===true);
    if(t.status?.type==='active')throw new ConnectorError('SESSION_BUSY_USE_STEER_OR_QUEUE');
    return this.submitMessage(w,s,true);
  }
  async sessionPage(params:unknown={}){if(!params||typeof params!=='object'||Array.isArray(params)||Object.keys(params).some(k=>!['limit','cursor','view'].includes(k)))throw new ConnectorError('INVALID_SESSION_QUERY');return this.list(validateCommand('session.list',params));}
  private async list(p:any){
    const view=p.view||'all',project=p.project||null,roots=project?[this.project(project)]:undefined,limit=p.limit||50;
    type Cursor={v?:number;view?:string;project?:string|null;stored?:string;loaded?:string;storedDone?:boolean;loadedDone?:boolean};
    let cursor:Cursor={};
    const validBackendCursor=(value:unknown)=>typeof value==='string'&&value.length>0&&value.length<=512&&!/[\x00-\x1f]/.test(value);
    if(p.cursor){try{
      if(typeof p.cursor!=='string'||p.cursor.length>2048||!/^[A-Za-z0-9_-]+$/.test(p.cursor))throw Error();
      cursor=JSON.parse(Buffer.from(p.cursor,'base64url').toString());
      if(!cursor||Array.isArray(cursor)||typeof cursor!=='object'||['storedDone','loadedDone'].some(k=>(cursor as any)[k]!==undefined&&typeof(cursor as any)[k]!=='boolean')||['stored','loaded'].some(k=>(cursor as any)[k]!==undefined&&!validBackendCursor((cursor as any)[k])))throw Error();
      if(cursor.v===undefined){
        // Old desktop cursors did not carry filter context. Never reinterpret them under a filter.
        if(view!=='all'||project!==null||Object.keys(cursor).some(k=>!['stored','loaded','storedDone','loadedDone'].includes(k)))throw Error();
      }else{
        if(cursor.v!==2||cursor.view!==view||cursor.project!==project||Object.keys(cursor).some(k=>!['v','view','project','stored','loaded','storedDone','loadedDone'].includes(k))||typeof cursor.storedDone!=='boolean'||typeof cursor.loadedDone!=='boolean')throw Error();
        if(cursor.storedDone===Boolean(cursor.stored)||cursor.loadedDone===Boolean(cursor.loaded))throw Error();
        if((view==='loaded'||view==='active')&&!cursor.storedDone||view==='history'&&!cursor.loadedDone)throw Error();
      }
      if(cursor.storedDone&&cursor.stored||cursor.loadedDone&&cursor.loaded||cursor.storedDone&&cursor.loadedDone)throw Error();
    }catch{throw new ConnectorError('INVALID_CURSOR');}}
    const stored=(view==='loaded'||view==='active'||cursor.storedDone)?{data:[],nextCursor:null}:await this.backend.rpc('thread/list',{limit,cursor:cursor.stored,useStateDbOnly:true});
    const loaded=(view==='history'||cursor.loadedDone)?{data:[],nextCursor:null}:await this.backend.rpc('thread/loaded/list',{limit,cursor:cursor.loaded});
    for(const [page,previous] of [[stored,cursor.stored],[loaded,cursor.loaded]] as const){
      if(!page||!Array.isArray(page.data)||page.data.length>limit||page.nextCursor!=null&&(!validBackendCursor(page.nextCursor)||page.nextCursor===previous))throw new ConnectorError('INVALID_SESSION_PAGE');
    }
    const byId=new Map<string,{thread:any;loaded:boolean|null;sources:string[];unavailable?:boolean}>();
    const visible=(t:any)=>!roots||this.validCwd(t?.cwd)&&roots.some(root=>this.within(root,t.cwd));
    for(const t of stored.data){if(!t||typeof t.id!=='string'||!t.id||t.id.length>512)throw new ConnectorError('INVALID_SESSION_PAGE');if(visible(t))byId.set(t.id,{thread:t,loaded:null,sources:['indexed-history']});}
    const unresolvedLoadedIds:string[]=[],unknownLoadedIds=new Set<string>();
    for(const id of new Set(loaded.data)){
      if(typeof id!=='string'||!id||id.length>512)throw new ConnectorError('INVALID_SESSION_PAGE');
      const previous=byId.get(id),sources=[...new Set([...(previous?.sources||[]),'loaded'])];
      try{
        const r=await this.backend.rpc('thread/read',{threadId:id,includeTurns:false});if(!r?.thread||r.thread.id!==id)throw Error('Invalid thread metadata');
        if(!r.thread.status?.type||r.thread.status.type==='unknown')unknownLoadedIds.add(id);
        if(visible(r.thread)&&(view!=='active'||r.thread.status?.type==='active'))byId.set(id,{thread:r.thread,loaded:true,sources});else byId.delete(id);
      }catch{
        unresolvedLoadedIds.push(id);unknownLoadedIds.add(id);
        if(view!=='active'&&(!roots||previous))byId.set(id,{thread:previous?.thread||{id},loaded:true,sources,unavailable:true});
      }
    }
    const next=stored.nextCursor||loaded.nextCursor?Buffer.from(JSON.stringify({v:2,view,project,stored:stored.nextCursor||undefined,loaded:loaded.nextCursor||undefined,storedDone:!stored.nextCursor,loadedDone:!loaded.nextCursor})).toString('base64url'):null;
    if(next&&next.length>2048)throw new ConnectorError('INVALID_SESSION_PAGE');
    const sessions=[...byId.values()].map(row=>{
      const summary=this.threadSummary(row.thread),binding=this.store.state.sessions.find(s=>s.threadId===summary.id&&this.authorizedSession(s));
      return{...summary,...(row.unavailable?{manageable:null,reason:'METADATA_UNAVAILABLE',canAcceptDirectInput:null,status:{type:'unknown'}}:{}),loaded:row.loaded,discoverySources:row.sources,binding:binding?{channel:binding.channel,threadTs:binding.threadTs}:null};
    });
    const sources=view==='all'?'Current shared-daemon loaded IDs plus indexed interactive history (default thread/list sources)':view==='history'?'Indexed interactive history (default thread/list sources)':view==='active'?'Current shared-daemon loaded IDs with freshly read active status':'Current shared-daemon loaded IDs';
    return{sessions,nextCursor:next,project,unresolvedLoadedIds,pageLimitPerSource:limit,view,returnedCount:sessions.length,scanned:{loaded:loaded.data.length,history:stored.data.length},unknownLoadedCount:unknownLoadedIds.size,hasMore:next!==null,scope:`${sources}; one bounded page per selected source, not a global session count or complete enumeration. Filters may return an empty page with a continuation cursor. Stored-only rows do not prove unloaded status. Metadata failures remain unknown. No resume, content preload, filesystem history scan, or control-policy filtering. Separate CODEX_HOME, standalone --no-daemon and other servers are not guaranteed visible.`};
  }

  private async attachOrCreate(p:any,create:boolean,source:Source){
    if(source.kind!=='local'&&p.outputThreadTs)throw new ConnectorError('SLACK_ORIGIN_REQUIRED');
    let destination=this.originDestination(source);
    if(source.kind==='local'&&p.outputThreadTs){let exists=false;try{exists=await this.slack.threadExists(this.config.slack.outputChannel,p.outputThreadTs);}catch{}if(!exists)throw new ConnectorError('THREAD_DESTINATION_UNVERIFIED');destination={channel:this.config.slack.outputChannel,threadTs:p.outputThreadTs};}
    if(create&&!destination)throw new ConnectorError('THREAD_DESTINATION_REQUIRED');
    let thread:any;let alias:string;
    if(create){const cwd=this.project(p.project);thread=(await this.backend.rpc('thread/start',{cwd})).thread;this.checkProject(thread,p.project);alias=p.project;}
    else{thread=(await this.backend.rpc('thread/read',{threadId:p.threadId,includeTurns:false})).thread;if(!this.validCwd(thread?.cwd))throw new ConnectorError('SESSION_SCOPE_NOT_ALLOWED');if(p.project){this.checkProject(thread,p.project);alias=p.project;}else{const known=this.projectFor(thread.cwd);if(!known&&!this.config.sessionPolicy?.allowAllSharedSessions)throw new ConnectorError('SESSION_SCOPE_NOT_ALLOWED');alias=known||'@shared';}}
    let s=this.store.state.sessions.find(s=>s.threadId===thread.id);
    if(s&&!this.authorizedSession(s))throw new ConnectorError('SESSION_SCOPE_REVOKED');
    if(!s){if(!destination)throw new ConnectorError('THREAD_DESTINATION_REQUIRED');s={id:randomUUID(),threadId:thread.id,project:alias,cwd:thread.cwd,channel:destination.channel,threadTs:destination.threadTs,createdAt:new Date().toISOString()};const saved=s;this.store.transaction(state=>{state.sessions.push(saved);this.output(state,`Codex session ${saved.id}\nThread ${saved.threadId}\nProject ${saved.project}\n${p.title||''}`,saved.id);});}
    if(!create)thread=(await this.backend.rpc('thread/resume',{threadId:thread.id,excludeTurns:true})).thread;
    this.attached.add(thread.id);this.flush();return{sessionId:s.id,threadId:thread.id,canAcceptDirectInput:thread.canAcceptDirectInput??null,status:thread.status,outputChannel:s.channel,outputThread:s.threadTs};
  }
  private async notification(method:string,p:any,epoch:string){
    if(epoch!==this.backend.epoch||!this.backend.connected)return;
    if(['turn/started','turn/completed','item/started','item/completed'].includes(method)){const activity=recordActivity(this.store.state.activity,method,p,Date.now());if(activity)this.store.transaction(s=>{s.activity=activity;});}
    if(['turn/started','turn/completed','item/started','item/completed'].includes(method))this.observeDelivery(method,p);
    if(method==='serverRequest/resolved'){
      this.store.transaction(s=>{for(const r of s.pending)if(r.epoch===epoch&&r.rpcId===p.requestId&&['pending','responding'].includes(r.status))r.status='resolved';});return;
    }
    const session=this.store.state.sessions.find(s=>s.threadId===p.threadId&&this.authorizedSession(s));
    if(!session&&!this.store.state.subscriptions?.some(s=>s.enabled&&s.threadId===p.threadId))return;
    if(session&&(method==='item/started'||method==='item/completed')&&p.item?.id){this.items.set(`${p.threadId}:${p.turnId}:${p.item.id}`,p.item);if(this.items.size>1000)this.items.delete(this.items.keys().next().value!);}
    if(method==='item/completed'&&p.item?.type==='agentMessage'&&(!p.item.phase||['commentary','partial_answer','final_answer'].includes(p.item.phase))&&typeof p.item.text==='string'){
      const key=`${p.threadId}:${p.turnId}:${p.item.id}`;
      this.store.transaction(state=>{if(Object.hasOwn(state.seenNotifications,key))return;const before=state.outbox.length;
        if(session&&(!p.item.phase||p.item.phase==='final_answer'))this.boundNotice(state,p.item.text,session,true);
        this.subscriptions.emit(state,`Session ${p.threadId}; turn ${p.turnId||'unknown'}; ${p.item.phase||'final_answer'}\n${p.item.text}`,p.threadId,key,sub=>!session||sub.owner.channel!==session.channel||sub.owner.threadTs!==session.threadTs||Boolean(p.item.phase&&p.item.phase!=='final_answer'));
        if(state.outbox.length>before)state.seenNotifications[key]=true;
      });this.flush();
    }
    if(method==='turn/completed'){
      const key=`turn:${p.threadId}:${p.turn?.id}:${p.turn?.status}`;
      this.store.transaction(state=>{for(const r of state.pending)if(r.threadId===p.threadId&&r.turnId===p.turn?.id&&r.status==='pending')r.status='stale';if(Object.hasOwn(state.seenNotifications,key))return;const before=state.outbox.length;
        const text=`Session ${p.threadId}; turn ${p.turn?.id||'unknown'}: ${p.turn?.status||'terminal'}.`;
        if(session&&p.turn?.status!=='completed')this.boundNotice(state,text+' Inspect session.info before continuing.',session);
        this.subscriptions.emit(state,text,p.threadId,key,sub=>!session||p.turn?.status==='completed'||sub.owner.channel!==session.channel||sub.owner.threadTs!==session.threadTs);
        if(state.outbox.length>before)state.seenNotifications[key]=true;
      });this.flush();
    }
    if(method==='error'&&p.willRetry===false){this.store.transaction(state=>this.subscriptions.emit(state,`Session ${p.threadId}; turn ${p.turnId||'unknown'}: execution error. Inspect the original local session.`,p.threadId,`error:${p.threadId}:${p.turnId}`));this.flush();}
  }
  private async serverRequest(r:any){
    if(r.epoch!==this.backend.epoch||!this.backend.connected||!['string','number'].includes(typeof r.id))return;
    const s=this.store.state.sessions.find(s=>s.threadId===r.params?.threadId&&this.authorizedSession(s));
    this.store.transaction(state=>this.subscriptions.emit(state,`Session ${r.params?.threadId}; turn ${r.params?.turnId||'unknown'}: local decision/input required. Use the original local Codex UI or its authorized bound approval thread. This observation does not grant approval authority.`,r.params?.threadId,`request:${r.epoch}:${r.id}`,sub=>!s||sub.owner.channel!==s.channel||sub.owner.threadTs!==s.threadTs));this.flush();
    if(!s)return;
    if(this.store.state.pending.some(p=>p.rpcId===r.id&&p.epoch===r.epoch))return;
    let kind:Pending['kind']='unsupported';if(r.method==='item/commandExecution/requestApproval')kind='command';if(r.method==='item/fileChange/requestApproval')kind='file';if(r.method==='item/tool/requestUserInput')kind='input';
    const details=structuredClone(r.params),decisions=Array.isArray(details.availableDecisions)?details.availableDecisions.filter((x:any)=>['accept','decline','cancel'].includes(x)):['accept','decline','cancel'];
    let local=kind==='unsupported'||typeof details.turnId!=='string'||kind==='input'&&(!Array.isArray(details.questions)||details.questions.some((q:any)=>q.isSecret));
    if(kind==='file'){
      const item=this.items.get(`${details.threadId}:${details.turnId}:${details.itemId}`);details.changes=item?.changes;
      if(details.grantRoot||!Array.isArray(details.changes)||!details.changes.length||details.changes.some((c:any)=>typeof c.path!=='string'||!c.path||typeof c.diff!=='string'||!c.diff||!['add','delete','update'].includes(c.kind?.type)))local=true;
    }
    if(kind==='command'&&((details.kind&&details.kind!=='command')||typeof details.command!=='string'||!details.command.trim()||typeof details.cwd!=='string'||!details.cwd))local=true;
    // Never offer accept for hidden/truncated scope or relay known credential-bearing data.
    const serialized=JSON.stringify(details);
    if(serialized.length>12000 || resultSensitive(details) || containsSensitiveContent(serialized) || containsSensitiveContent(String(details.command||'')) || /(?:Bearer\s+\S+|(?:xox[baprs]-|xapp-|github_pat_|sk-proj-)[A-Za-z0-9_-]{12,}|-----BEGIN .*PRIVATE KEY|(?:password|secret|token|api[_-]?key)\s*[=:]\s*[^\s,}]{6,}|[\\/]\.codex[\\/]|[\\/]\.env(?:[.\\/]|$))/i.test(serialized))local=true;
    const safeDetails=local?{notice:'Sensitive, oversized, unsupported, or broader-scope request; inspect locally',itemId:details.itemId}:details;
    const pending:Pending={id:randomUUID(),rpcId:r.id,epoch:r.epoch,sessionId:s.id,threadId:s.threadId,turnId:details.turnId||'unavailable',method:r.method,kind,status:local?'local-required':'pending',details:safeDetails,decisions,expiresAt:Date.now()+this.config.approvalTimeoutSec*1000};
    this.store.transaction(state=>{state.pending.push(pending);this.boundNotice(state,local?`LOCAL_ACTION_REQUIRED: ${r.method}\nrequestId=${pending.id}; sensitive, unsupported, or broader-scope request. No approval was granted. Use the original local Codex UI.`:this.prompt(pending),s);});this.flush();
  }
  private prompt(p:Pending){
    const params:any={requestId:p.id,epoch:p.epoch,sessionId:p.sessionId,turnId:p.turnId};
    if(p.kind==='input')params.answers=Object.fromEntries((p.details.questions||[]).map((q:any)=>[q.id,['YOUR ANSWER']]));else params.decision='decline';
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
    this.attached.clear();this.items.clear();this.deliveryTurns.clear();this.store.transaction(s=>{for(const w of s.work)if(w.messageDelivery)w.messageDelivery.observationGap=true;for(const p of s.pending)if(p.epoch===epoch&&['pending','responding'].includes(p.status))p.status='stale';});
  }
  async expire(){
    if(this.store.state.results?.some(r=>r.expiresAt<=Date.now()))this.store.transaction(s=>{s.results=(s.results||[]).filter(r=>r.expiresAt>Date.now());});
    for(const p of this.store.state.pending.filter(p=>p.status==='pending'&&p.expiresAt<=Date.now())){
      this.store.transaction(s=>{s.pending.find(x=>x.id===p.id)!.status='expired';const session=s.sessions.find(x=>x.id===p.sessionId);if(session)this.boundNotice(s,`Request ${p.id} expired; no approval granted.`,session);});
      if(this.backend.connected&&p.epoch===this.backend.epoch){try{if(p.kind==='command'||p.kind==='file')await this.backend.respond(p.rpcId,{decision:'decline'});else if(p.kind==='input')await this.backend.rpc('turn/interrupt',{threadId:p.threadId,turnId:p.turnId});}catch{/* never replay stale callbacks */}}
    }
    this.flush();
  }
  flush(){if(this.closing||this.delivering)return;try{this.store.assertHealthy();}catch{return;}this.delivering=this.deliver().catch(()=>{}).finally(()=>{this.delivering=undefined;if(!this.closing&&this.nextDelivery())queueMicrotask(()=>this.flush());});}
  private deliveryLane(o:Delivery,state:Readonly<State>){return `${o.channel}:${o.threadTs||state.sessions.find(s=>s.id===o.sessionId)?.threadTs||'missing'}`;}
  private nextDelivery(){
    const state=this.store.state;return state.outbox.find((o,index)=>o.status==='queued'&&o.nextAttemptAt<=Date.now()&&(!o.subscriptionId||!this.subscriptions.deliveryWaiting(o.subscriptionId))&&!state.outbox.slice(0,index).some(earlier=>this.deliveryLane(earlier,state)===this.deliveryLane(o,state)&&!['sent','failed'].includes(earlier.status)));
  }
  private async deliver(){
    while(!this.closing){
      const state=this.store.state,dot=state.dot;if(!dot)return;
      const next=this.nextDelivery();if(!next)return;
      const session=next.sessionId?state.sessions.find(s=>s.id===next.sessionId):undefined;
      const threadTs=next.threadTs||(!next.origin?session?.threadTs:undefined);
      let invalid=Boolean(next.subscriptionId&&!this.subscriptions.deliveryAllowed(next.subscriptionId))||Boolean(next.notificationThreadId&&!next.subscriptionId&&this.subscriptions.hasExplicitDestination(next.notificationThreadId,next.channel,threadTs||''))||next.root||!this.validChannel(next.channel)||!this.validTimestamp(threadTs);
      if(next.origin)invalid ||= !this.originDestination(next.origin)||next.origin.channel!==next.channel||next.origin.threadTs!==threadTs;
      else invalid ||= !session||!this.authorizedSession(session)||session.channel!==next.channel||session.threadTs!==threadTs;
      if(session&&!this.authorizedSession(session))invalid=true;
      if(invalid){this.store.transaction(s=>{const o=s.outbox.find(o=>o.id===next.id)!;o.status='failed';o.error='THREAD_DESTINATION_INVALID_OR_REVOKED';});continue;}
      await new Promise(r=>setTimeout(r,Math.max(0,this.lastPost+this.postIntervalMs-Date.now())));
      const current=this.store.state.outbox.find(o=>o.id===next.id);if(!current||current.status!=='queued')continue;
      if(current.subscriptionId&&this.subscriptions.deliveryWaiting(current.subscriptionId))continue;
      if(current.subscriptionId&&!this.subscriptions.deliveryAllowed(current.subscriptionId)||current.notificationThreadId&&!current.subscriptionId&&this.subscriptions.hasExplicitDestination(current.notificationThreadId,current.channel,current.threadTs||'')){this.store.transaction(s=>{const o=s.outbox.find(x=>x.id===next.id)!;o.status='failed';o.error='SUBSCRIPTION_CANCELLED_OR_REVOKED';});continue;}
      this.store.transaction(s=>{const o=s.outbox.find(o=>o.id===next.id)!;o.status='sending';o.attempts++;});
      try{
        const ts=await this.slack.post(next.channel,next.text,{threadTs,mentionUserId:next.mention===false?undefined:dot.userId,deliveryId:next.id});this.lastPost=Date.now();
        this.store.transaction(s=>{const o=s.outbox.find(o=>o.id===next.id)!;o.status='sent';o.ts=ts;});
      }catch(e:any){
        this.store.transaction(s=>{const o=s.outbox.find(o=>o.id===next.id)!;if(e?.code==='slack_webapi_rate_limited_error'&&o.attempts<10){o.status='queued';o.nextAttemptAt=Date.now()+Math.max(1000,Number(e.retryAfter||1)*1000);}else{o.status='uncertain';o.error='Slack delivery may have occurred; local recovery required, never rerun Codex';}});return;
      }
    }
  }
  status(){const s=this.store.state;return{capabilities:this.capabilities(),sessions:s.sessions,work:s.work.map(w=>{const {request,source,...safe}=w;return{...safe,command:request.command,...(['session.send','session.queue'].includes(request.command)?{commandStatus:w.status,deliveryStatus:deliveryStatus(w)}:{})};}),outbox:s.outbox.map(({text,...o})=>o),pending:s.pending.map(({details,rpcId,...p})=>p)};}
  recover(kind:'command'|'outbox',id:string,observedTs?:string){
    this.store.transaction(s=>{
      if(kind==='command'){const w=s.work.find(w=>w.id===id);if(!w||w.status!=='uncertain')throw new ConnectorError('NOT_UNCERTAIN');w.status='failed';w.error='Locally reviewed; not replayed';}
      else{const o=s.outbox.find(o=>o.id===id);if(!o||o.status!=='uncertain')throw new ConnectorError('NOT_UNCERTAIN');if(observedTs){if(!/^\d+\.\d+$/.test(observedTs))throw new ConnectorError('INVALID_TIMESTAMP');o.status='sent';o.ts=observedTs;}else{o.status='queued';o.error='Operator explicitly requested delivery retry; duplicate Slack post possible';}}
    });this.pump();this.flush();
  }
  async close(){this.closing=true;await this.backend.close();await Promise.all(this.running.values());await this.events;await this.delivering;}
}
