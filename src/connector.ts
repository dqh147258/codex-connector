import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve,relative,isAbsolute,sep } from 'node:path';
import { Store } from './store.js';
import { ReadonlyFiles, FileAccessError, containsSensitiveContent } from './files.js';
import { parseEnvelope, validateCommand, ProtocolError, formatHelp, COMMANDS, START_MARKER, END_MARKER, type CommandEnvelope } from './protocol.js';
import { BackendError } from './codex.js';
import { parseSlackEnvelope } from './slack-envelope.js';
import type { Backend, Config, Delivery, Pending, Session, SlackPort, Source, State, Work } from './types.js';
export class ConnectorError extends Error { constructor(readonly code:string){super(code);} }
const codeOf=(e:unknown)=>e instanceof ConnectorError||e instanceof BackendError||e instanceof FileAccessError ? e.code : 'OPERATION_FAILED';
const decisionCommands=new Set(['approval.respond','input.respond']);
const boundCommands=new Set(['session.info','session.history','session.send','session.steer','session.queue','session.interrupt','session.reply']);
function short(value:unknown,max=20000){const text=typeof value==='string'?value:JSON.stringify(value,null,2);return text.length>max?text.slice(0,max)+'\n[truncated; request a smaller page]':text;}
export class Connector {
  private running=new Map<string,Promise<void>>();private delivering?:Promise<void>;private closing=false;private lastPost=0;
  private events=Promise.resolve();private attached=new Set<string>();private items=new Map<string,any>();
  readonly files:ReadonlyFiles;
  selfUserId='';selfBotId='';
  constructor(readonly config:Config,readonly store:Store,readonly backend:Backend,readonly slack:SlackPort,private postIntervalMs=1100){
    this.files=new ReadonlyFiles(config.projects);
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
      for(const s of this.store.state.sessions){
        if(this.attached.has(s.threadId)||!this.authorizedSession(s))continue;
        try{const r=await this.backend.rpc('thread/read',{threadId:s.threadId,includeTurns:false});this.checkSessionThread(r.thread,s);await this.backend.rpc('thread/resume',{threadId:s.threadId,excludeTurns:true});this.attached.add(s.threadId);}catch{/* Capabilities/status exposes unavailable attachment; never starts a replacement thread. */}
      }
    }catch{/* Server remains usable for help/files/status. No independent fallback. */}
    this.pump();this.flush();
  }
  capabilities(){return{...this.backend.capabilities(),instanceId:this.config.instanceId,sessionPolicy:{allowAllSharedSessions:this.config.sessionPolicy?.allowAllSharedSessions===true},outputChannel:this.config.slack.outputChannel,dot:this.store.state.dot,attachedThreads:[...this.attached],fileTools:'readonly configured roots',approvalAuthority:'direct configured humans or verified same-thread human envelope; bots alone cannot approve',serviceManagement:'local template generation only'};}
  private authorizeEvent(body:any):Source|undefined{
    const e=body?.event,s=this.config.slack;
    if(body?.team_id!==s.teamId||typeof body.event_id!=='string'||!e||e.type!=='message'||!['',undefined,'bot_message'].includes(e.subtype)||typeof e.text!=='string'||typeof e.user!=='string'||typeof e.ts!=='string')return;
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
    if(!body.event.text.startsWith(START_MARKER))return false;
    let request:CommandEnvelope;
    try{request=parseSlackEnvelope(body.event.text,body.event.blocks,this.config.instanceId,source.kind==='bot');}catch(e){this.store.transaction(s=>{Object.defineProperty(s.seenEvents,source.eventId,{value:'rejected',enumerable:true,writable:true,configurable:true});this.output(s,`Command rejected: ${e instanceof ProtocolError?e.code:'invalid_envelope'}. Use the generated help envelope exactly.`);});return true;}
    if(source.channel!==this.config.slack.inputChannel&&!decisionCommands.has(request.command))return false;
    this.record(request,source);return true;
  }
  local(request:CommandEnvelope){
    if(request.target!==this.config.instanceId)throw new ConnectorError('WRONG_TARGET');request={...request,params:validateCommand(request.command,request.params)};
    if(decisionCommands.has(request.command))throw new ConnectorError('NEED_VERIFIABLE_HUMAN_DECISION');
    const id=this.record(request,{kind:'local',userId:'local',channel:this.config.slack.inputChannel,threadTs:'',ts:'',eventId:`local-${request.id}`});this.pump();return{id,requestId:request.id,status:'accepted'};
  }
  private record(request:CommandEnvelope,source:Source):string{
    return this.store.transaction(s=>{
      if(Object.hasOwn(s.seenEvents,source.eventId))return s.seenEvents[source.eventId]!;
      const existing=s.work.find(w=>w.request.id===request.id&&w.source.kind===source.kind&&w.source.userId===source.userId);
      const id=existing?.id||randomUUID();
      Object.defineProperty(s.seenEvents,source.eventId,{value:id,enumerable:true,writable:true,configurable:true});
      if(existing){if(JSON.stringify(existing.request)!==JSON.stringify(request))this.output(s,`REQUEST_ID_CONFLICT: ${request.id}; use a new ID for a different command.`);return id;}
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
      if(this.store.state.work.some(x=>this.key(x)===key&&x.status==='uncertain'))continue;
      const task=this.drain(key).catch(()=>{}).finally(()=>{this.running.delete(key);queueMicrotask(()=>this.pump());});this.running.set(key,task);
    }
  }
  private async drain(key:string){
    while(!this.closing){
      const w=this.store.state.work.find(w=>w.status==='queued'&&this.key(w)===key);if(!w)return;
      this.store.transaction(s=>{s.work.find(x=>x.id===w.id)!.status='executing';});
      try{
        this.reauthorize(w);const result=await this.execute(w);
        this.store.transaction(s=>{const done=s.work.find(x=>x.id===w.id)!;done.status='completed';done.resultRef={sessionId:this.outputSession(w,result),threadId:typeof result?.threadId==='string'?result.threadId:undefined,turnId:typeof result?.turn?.id==='string'?result.turn.id:undefined};this.output(s,`[request ${w.request.id}; work ${w.id}] ${short(result,w.request.command.startsWith('files.')||['session.list','session.history'].includes(w.request.command)?500000:20000)}`,this.outputSession(w,result));});
      }catch(e){
        const code=codeOf(e),uncertain=code==='RPC_OUTCOME_UNCERTAIN'&&COMMANDS[w.request.command].permission!=='read';
        this.store.transaction(s=>{const current=s.work.find(x=>x.id===w.id)!;current.status=uncertain?'uncertain':'failed';current.error=code;this.output(s,`[${w.id}] ${code}${uncertain?': inspect backend state; operation will not be replayed.':''}`,typeof w.request.params.sessionId==='string'?w.request.params.sessionId:undefined);});
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
  private output(state:State,text:string,sessionId?:string,root=false){
    if(containsSensitiveContent(text))text='Sensitive-looking output withheld; inspect the original local Codex session. No credentials were sent.';
    if(sessionId&&!state.sessions.some(s=>s.id===sessionId&&this.authorizedSession(s)))sessionId=undefined;
    const points=[...text];for(let i=0;i<points.length||i===0;i+=2400){const chunk=points.slice(i,i+2400).join('');state.outbox.push({id:randomUUID(),sessionId,channel:this.config.slack.outputChannel,root:root&&i===0,text:chunk,status:'queued',attempts:0,nextAttemptAt:0});}
  }
  private session(id:unknown):Session{const s=this.store.state.sessions.find(s=>s.id===id);if(!s)throw new ConnectorError('SESSION_NOT_FOUND');if(!this.authorizedSession(s))throw new ConnectorError('SESSION_SCOPE_REVOKED');return s;}
  private canonicalCwd(cwd:string){try{if(!this.validCwd(cwd))return undefined;const real=realpathSync(cwd);return this.validCwd(real)?real:undefined;}catch{return undefined;}}
  private within(root:string,cwd:string){const a=this.canonicalCwd(root),b=this.canonicalCwd(cwd);if(!a||!b)return false;const rel=relative(a,b);return rel===''||(!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel));}
  private projectFor(cwd:string){return Object.entries(this.config.projects).find(([,root])=>this.within(root,cwd))?.[0];}
  private validCwd(cwd:unknown):cwd is string{return typeof cwd==='string'&&isAbsolute(cwd)&&!/[\x00-\x1f]/.test(cwd)&&!/[\\/]\.codex[\\/]sessions(?:[\\/]|$)/i.test(cwd);}
  private authorizedSession(s:Session){const cwd=s.cwd||this.config.projects[s.project];return s.channel===this.config.slack.outputChannel&&this.validCwd(cwd)&&(this.config.sessionPolicy?.allowAllSharedSessions===true||Boolean(this.projectFor(cwd)));}
  private checkSessionThread(thread:any,s:Session){const cwd=s.cwd||this.config.projects[s.project];if(!this.authorizedSession(s)||!this.validCwd(thread?.cwd)||(this.canonicalCwd(thread.cwd)||resolve(thread.cwd))!==(this.canonicalCwd(cwd!)||resolve(cwd!)))throw new ConnectorError('THREAD_PROJECT_MISMATCH');}
  private project(alias:unknown){if(typeof alias!=='string'||!Object.hasOwn(this.config.projects,alias))throw new ConnectorError('PROJECT_NOT_ALLOWED');return this.config.projects[alias]!;}
  private checkProject(thread:any,alias:string){if(!this.validCwd(thread?.cwd)||!this.within(this.project(alias),thread.cwd))throw new ConnectorError('THREAD_PROJECT_MISMATCH');}
  private async metadata(s:Session){const r=await this.backend.rpc('thread/read',{threadId:s.threadId,includeTurns:false});this.checkSessionThread(r.thread,s);return r.thread;}
  private threadSummary(t:any){const project=this.validCwd(t.cwd)?this.projectFor(t.cwd):undefined,allowed=this.validCwd(t.cwd)&&(Boolean(project)||this.config.sessionPolicy?.allowAllSharedSessions===true);return{id:t.id,name:typeof t.name==='string'?t.name.slice(0,200):null,cwd:typeof t.cwd==='string'?t.cwd.slice(0,1024):null,project:project||null,manageable:allowed&&t.canAcceptDirectInput===true,reason:!allowed?'SESSION_SCOPE_NOT_ALLOWED':t.canAcceptDirectInput===false?'DIRECT_INPUT_UNAVAILABLE':t.canAcceptDirectInput!==true?'ATTACH_TO_CHECK_CAPABILITY':null,canAcceptDirectInput:t.canAcceptDirectInput??null,status:{type:t.status?.type||'unknown'},model:typeof t.model==='string'?t.model.slice(0,100):null,reasoningEffort:t.reasoningEffort??null,source:typeof t.source==='string'?t.source:'structured-source',connectorSessionId:this.store.state.sessions.find(s=>s.threadId===t.id)?.id||null};}
  private async direct(s:Session){if(!this.attached.has(s.threadId))throw new ConnectorError('SESSION_NOT_ATTACHED');const t=await this.metadata(s);if(t.canAcceptDirectInput!==true)throw new ConnectorError('DIRECT_INPUT_UNAVAILABLE');return t;}
  private queuedId(value:any):string{const id=value?.queuedSubmission?.id;if(typeof id!=='string'||!id||id.length>200)throw new BackendError('RPC_OUTCOME_UNCERTAIN');return id;}
  private async execute(w:Work):Promise<any>{
    const p=w.request.params as any,c=w.request.command;
    if(c==='help')return formatHelp(p.command);if(c==='capabilities')return this.capabilities();
    if(c==='files.list')return this.files.list(p.root,p.path,{limit:p.limit});if(c==='files.stat')return this.files.stat(p.root,p.path);
    if(c==='files.read')return this.files.read(p.root,p.path,{offset:p.offset,maxBytes:p.maxBytes});if(c==='files.search')return this.files.search(p.root,p.path,p.query,{limit:p.limit,maxDepth:p.maxDepth});
    if(c==='approval.list')return this.store.state.pending.filter(r=>r.status==='pending'&&(!p.sessionId||r.sessionId===p.sessionId)).map(({rpcId,details,...r})=>r);
    if(decisionCommands.has(c))return this.answer(w);
    if(c==='session.list')return this.list(p);
    if(c==='session.create'||c==='session.attach')return this.attachOrCreate(p,c==='session.create');
    if(!boundCommands.has(c))throw new ConnectorError('UNKNOWN_COMMAND');
    const s=this.session(p.sessionId);
    if(c==='session.reply'){this.store.transaction(state=>this.output(state,p.text,s.id));return{sessionId:s.id,queued:true};}
    if(c==='session.info'){const meta=await this.metadata(s);const turns=await this.backend.rpc('thread/turns/list',{threadId:s.threadId,limit:3,itemsView:'summary',sortDirection:'desc'});return{sessionId:s.id,threadId:s.threadId,outputThread:s.threadTs||null,attached:this.attached.has(s.threadId),...this.threadSummary(meta),recentTurns:(turns.data||[]).map((t:any)=>({id:t.id,status:t.status}))};}
    if(c==='session.history'){
      await this.metadata(s);const r=await this.backend.rpc('thread/items/list',{threadId:s.threadId,limit:p.limit||20,cursor:p.cursor,sortDirection:'desc'});
      return{items:(r.data||[]).filter((e:any)=>['userMessage','agentMessage'].includes((e.item||e).type)).map((e:any)=>{const item=e.item||e;const text=item.type==='agentMessage'?String(item.text||''):Array.isArray(item.content)?item.content.filter((c:any)=>c.type==='text').map((c:any)=>c.text).join('\n'):'';return{turnId:e.turnId,type:item.type,text:text.slice(0,2000),truncated:text.length>2000};}),nextCursor:r.nextCursor||null,note:'Only user/assistant text; raw tool output and reasoning withheld'};
    }
    const t=await this.direct(s);
    if(c==='session.interrupt')return this.backend.rpc('turn/interrupt',{threadId:s.threadId,turnId:p.turnId});
    const input=[{type:'text',text:p.text}];
    if(c==='session.steer')return this.backend.rpc('turn/steer',{threadId:s.threadId,expectedTurnId:p.turnId,input,clientUserMessageId:w.id});
    if(c==='session.queue'){
      const queued=await this.backend.rpc('thread/queue/add',{threadId:s.threadId,input,clientUserMessageId:w.id});const queuedId=this.queuedId(queued);
      if(p.resume){try{return{queued,started:await this.backend.rpc('thread/queue/start',{threadId:s.threadId,queuedSubmissionId:queuedId})};}catch(e){if(codeOf(e)==='RPC_OUTCOME_UNCERTAIN')throw e;return{queued,startError:codeOf(e),note:'Queue add already succeeded; do not enqueue the same text again'};}}
      return queued;
    }
    if(t.status?.type==='active')throw new ConnectorError('SESSION_BUSY_USE_STEER_OR_QUEUE');
    const queued=await this.backend.rpc('thread/queue/add',{threadId:s.threadId,input,clientUserMessageId:w.id});const queuedId=this.queuedId(queued);
    try{return{queued,started:await this.backend.rpc('thread/queue/start',{threadId:s.threadId,queuedSubmissionId:queuedId})};}catch(e){if(codeOf(e)==='RPC_OUTCOME_UNCERTAIN')throw e;return{queued,startError:codeOf(e),note:'Message remains queued. Shared client may have become active; no fallback steering or duplicate enqueue.'};}
  }
  private async list(p:any){
    let cursor:{stored?:string;loaded?:string;storedDone?:boolean;loadedDone?:boolean}={};
    if(p.cursor){try{cursor=JSON.parse(Buffer.from(p.cursor,'base64url').toString());if(!cursor||Array.isArray(cursor)||typeof cursor!=='object'||['storedDone','loadedDone'].some(k=>(cursor as any)[k]!==undefined&&typeof(cursor as any)[k]!=='boolean')||Object.keys(cursor).some(k=>!['stored','loaded','storedDone','loadedDone'].includes(k))||['stored','loaded'].some(k=>(cursor as any)[k]!==undefined&&typeof(cursor as any)[k]!=='string'))throw Error();}catch{throw new ConnectorError('INVALID_CURSOR');}}
    const roots=p.project?[this.project(p.project)]:undefined,limit=p.limit||50;
    const stored=cursor.storedDone?{data:[],nextCursor:null}:await this.backend.rpc('thread/list',{limit,cursor:cursor.stored,useStateDbOnly:true});
    const loaded=cursor.loadedDone?{data:[],nextCursor:null}:await this.backend.rpc('thread/loaded/list',{limit,cursor:cursor.loaded});
    const byId=new Map<string,any>((stored.data||[]).filter((t:any)=>!roots||this.validCwd(t.cwd)&&roots.some(root=>this.within(root,t.cwd))).map((t:any)=>[t.id,t]));
    for(const id of loaded.data||[]){try{const r=await this.backend.rpc('thread/read',{threadId:id,includeTurns:false});if(!roots||this.validCwd(r.thread.cwd)&&roots.some(root=>this.within(root,r.thread.cwd)))byId.set(id,r.thread);}catch{/* A disappearing or uninspectable thread is not asserted manageable. */}}
    const next=stored.nextCursor||loaded.nextCursor?Buffer.from(JSON.stringify({stored:stored.nextCursor||undefined,loaded:loaded.nextCursor||undefined,storedDone:!stored.nextCursor,loadedDone:!loaded.nextCursor})).toString('base64url'):null;
    return{sessions:[...byId.values()].map(t=>this.threadSummary(t)),nextCursor:next,scope:'all shared-daemon visible metadata by default; control policy is separate from readonly file roots; standalone --no-daemon and unsupported inputs are not guaranteed manageable'};
  }
  private async attachOrCreate(p:any,create:boolean){
    let thread:any;let alias:string;
    if(create){const cwd=this.project(p.project);thread=(await this.backend.rpc('thread/start',{cwd})).thread;this.checkProject(thread,p.project);alias=p.project;}
    else{thread=(await this.backend.rpc('thread/read',{threadId:p.threadId,includeTurns:false})).thread;if(!this.validCwd(thread?.cwd))throw new ConnectorError('SESSION_SCOPE_NOT_ALLOWED');if(p.project){this.checkProject(thread,p.project);alias=p.project;}else{const known=this.projectFor(thread.cwd);if(!known&&!this.config.sessionPolicy?.allowAllSharedSessions)throw new ConnectorError('SESSION_SCOPE_NOT_ALLOWED');alias=known||'@shared';}}
    let s=this.store.state.sessions.find(s=>s.threadId===thread.id);
    if(s&&!this.authorizedSession(s))throw new ConnectorError('SESSION_SCOPE_REVOKED');
    if(!s){s={id:randomUUID(),threadId:thread.id,project:alias,cwd:thread.cwd,channel:this.config.slack.outputChannel,createdAt:new Date().toISOString()};const saved=s;this.store.transaction(state=>{state.sessions.push(saved);this.output(state,`Codex session ${saved.id}\nThread ${saved.threadId}\nProject ${saved.project}\n${p.title||''}`,saved.id,true);});}
    if(!create)thread=(await this.backend.rpc('thread/resume',{threadId:thread.id,excludeTurns:true})).thread;
    this.attached.add(thread.id);this.flush();return{sessionId:s.id,threadId:thread.id,canAcceptDirectInput:thread.canAcceptDirectInput??null,status:thread.status,outputChannel:s.channel};
  }
  private async notification(method:string,p:any,epoch:string){
    if(epoch!==this.backend.epoch||!this.backend.connected)return;
    if(method==='serverRequest/resolved'){
      this.store.transaction(s=>{for(const r of s.pending)if(r.epoch===epoch&&r.rpcId===p.requestId&&['pending','responding'].includes(r.status))r.status='resolved';});return;
    }
    const session=this.store.state.sessions.find(s=>s.threadId===p.threadId);if(!session||!this.authorizedSession(session))return;
    if((method==='item/started'||method==='item/completed')&&p.item?.id){this.items.set(`${p.threadId}:${p.turnId}:${p.item.id}`,p.item);if(this.items.size>1000)this.items.delete(this.items.keys().next().value!);}
    if(method==='item/completed'&&p.item?.type==='agentMessage'&&(!p.item.phase||p.item.phase==='final_answer')&&typeof p.item.text==='string'){
      const key=`${p.threadId}:${p.turnId}:${p.item.id}`;
      this.store.transaction(s=>{if(Object.hasOwn(s.seenNotifications,key))return;s.seenNotifications[key]=true;this.output(s,p.item.text,session.id);});this.flush();
    }
    if(method==='turn/completed'){
      this.store.transaction(s=>{for(const r of s.pending)if(r.threadId===p.threadId&&r.turnId===p.turn?.id&&r.status==='pending')r.status='stale';if(p.turn?.status!=='completed')this.output(s,`Turn ${p.turn?.id||''}: ${p.turn?.status||'terminal'}; inspect session.info before continuing.`,session.id);});this.flush();
    }
  }
  private async serverRequest(r:any){
    if(r.epoch!==this.backend.epoch||!this.backend.connected||!['string','number'].includes(typeof r.id))return;
    const s=this.store.state.sessions.find(s=>s.threadId===r.params?.threadId);if(!s||!this.authorizedSession(s))return;
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
    if(serialized.length>12000 || containsSensitiveContent(serialized) || containsSensitiveContent(String(details.command||'')) || /(?:Bearer\s+\S+|(?:xox[baprs]-|xapp-|github_pat_|sk-proj-)[A-Za-z0-9_-]{12,}|-----BEGIN .*PRIVATE KEY|(?:password|secret|token|api[_-]?key)\s*[=:]\s*[^\s,}]{6,}|[\\/]\.codex[\\/]|[\\/]\.env(?:[.\\/]|$))/i.test(serialized))local=true;
    const safeDetails=local?{notice:'Sensitive, oversized, unsupported, or broader-scope request; inspect locally',itemId:details.itemId}:details;
    const pending:Pending={id:randomUUID(),rpcId:r.id,epoch:r.epoch,sessionId:s.id,threadId:s.threadId,turnId:details.turnId||'unavailable',method:r.method,kind,status:local?'local-required':'pending',details:safeDetails,decisions,expiresAt:Date.now()+this.config.approvalTimeoutSec*1000};
    this.store.transaction(state=>{state.pending.push(pending);this.output(state,local?`LOCAL_ACTION_REQUIRED: ${r.method}\nrequestId=${pending.id}; sensitive, unsupported, or broader-scope request. No approval was granted. Use the original local Codex UI.`:this.prompt(pending),s.id);});this.flush();
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
    this.attached.clear();this.items.clear();this.store.transaction(s=>{for(const p of s.pending)if(p.epoch===epoch&&['pending','responding'].includes(p.status))p.status='stale';});
  }
  async expire(){
    for(const p of this.store.state.pending.filter(p=>p.status==='pending'&&p.expiresAt<=Date.now())){
      this.store.transaction(s=>{s.pending.find(x=>x.id===p.id)!.status='expired';this.output(s,`Request ${p.id} expired; no approval granted.`,p.sessionId);});
      if(this.backend.connected&&p.epoch===this.backend.epoch){try{if(p.kind==='command'||p.kind==='file')await this.backend.respond(p.rpcId,{decision:'decline'});else if(p.kind==='input')await this.backend.rpc('turn/interrupt',{threadId:p.threadId,turnId:p.turnId});}catch{/* never replay stale callbacks */}}
    }
    this.flush();
  }
  flush(){if(this.closing||this.delivering)return;try{this.store.assertHealthy();}catch{return;}this.delivering=this.deliver().catch(()=>{}).finally(()=>{this.delivering=undefined;if(!this.closing&&this.nextDelivery())queueMicrotask(()=>this.flush());});}
  private nextDelivery(){
    const state=this.store.state;return state.outbox.find((o,index)=>o.status==='queued'&&o.nextAttemptAt<=Date.now()&&(!o.sessionId||o.root||state.sessions.find(s=>s.id===o.sessionId)?.threadTs)&&!state.outbox.slice(0,index).some(earlier=>(earlier.sessionId||'global')===(o.sessionId||'global')&&!['sent','failed'].includes(earlier.status)));
  }
  private async deliver(){
    while(!this.closing){
      const state=this.store.state,dot=state.dot;if(!dot)return;
      const next=this.nextDelivery();if(!next)return;
      if(next.channel!==this.config.slack.outputChannel){this.store.transaction(s=>{s.outbox.find(o=>o.id===next.id)!.status='failed';});continue;}
      const session=next.sessionId?state.sessions.find(s=>s.id===next.sessionId):undefined;
      if(session&&(!this.authorizedSession(session)||session.channel!==next.channel)){this.store.transaction(s=>{s.outbox.find(o=>o.id===next.id)!.status='failed';});continue;}
      await new Promise(r=>setTimeout(r,Math.max(0,this.lastPost+this.postIntervalMs-Date.now())));
      this.store.transaction(s=>{const o=s.outbox.find(o=>o.id===next.id)!;o.status='sending';o.attempts++;});
      try{
        const ts=await this.slack.post(next.channel,next.text,{threadTs:next.root?undefined:session?.threadTs||next.threadTs,mentionUserId:dot.userId,deliveryId:next.id});this.lastPost=Date.now();
        this.store.transaction(s=>{const o=s.outbox.find(o=>o.id===next.id)!;o.status='sent';o.ts=ts;if(o.root&&o.sessionId)s.sessions.find(x=>x.id===o.sessionId)!.threadTs=ts;});
      }catch(e:any){
        this.store.transaction(s=>{const o=s.outbox.find(o=>o.id===next.id)!;if(e?.code==='slack_webapi_rate_limited_error'&&o.attempts<10){o.status='queued';o.nextAttemptAt=Date.now()+Math.max(1000,Number(e.retryAfter||1)*1000);}else{o.status='uncertain';o.error='Slack delivery may have occurred; local recovery required, never rerun Codex';}});return;
      }
    }
  }
  status(){const s=this.store.state;return{capabilities:this.capabilities(),sessions:s.sessions,work:s.work.map(({request,source,...w})=>({...w,command:request.command})),outbox:s.outbox.map(({text,...o})=>o),pending:s.pending.map(({details,rpcId,...p})=>p)};}
  recover(kind:'command'|'outbox',id:string,observedTs?:string){
    this.store.transaction(s=>{
      if(kind==='command'){const w=s.work.find(w=>w.id===id);if(!w||w.status!=='uncertain')throw new ConnectorError('NOT_UNCERTAIN');w.status='failed';w.error='Locally reviewed; not replayed';}
      else{const o=s.outbox.find(o=>o.id===id);if(!o||o.status!=='uncertain')throw new ConnectorError('NOT_UNCERTAIN');if(observedTs){if(!/^\d+\.\d+$/.test(observedTs))throw new ConnectorError('INVALID_TIMESTAMP');o.status='sent';o.ts=observedTs;if(o.root&&o.sessionId)s.sessions.find(x=>x.id===o.sessionId)!.threadTs=observedTs;}else{o.status='queued';o.error='Operator explicitly requested delivery retry; duplicate Slack post possible';}}
    });this.pump();this.flush();
  }
  async close(){this.closing=true;await this.backend.close();await Promise.all(this.running.values());await this.events;await this.delivering;}
}
