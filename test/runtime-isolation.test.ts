import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,rmSync,readFileSync,existsSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';import { tmpdir } from 'node:os';import { createHash,randomUUID } from 'node:crypto';
import { FakeBackend,request,event,waitFor } from './helpers.js';
import { Runtime } from '../src/runtime.js';import { parseConfig } from '../src/config.js';
import { BackendError } from '../src/codex.js';
import { Store } from '../src/store.js';import { apiServer } from '../src/server.js';import { OPERATOR, type SlackPort } from '../src/types.js';
const tok='t'.repeat(48);
function fixture(options={slack:true}){
 const dir=mkdtempSync(join(tmpdir(),'known-servers-')),a=join(dir,'A'),b=join(dir,'B');mkdirSync(a);mkdirSync(b);
 const raw={version:2,instanceId:'test',port:18012,approvalTimeoutSec:30,local:{enabled:true,agents:[{id:'tool',tokenHash:createHash('sha256').update(tok).digest('hex'),servers:['default'],projects:['one'],commands:['server.list','session.attach','session.list','session.send','session.events']}]},projects:{one:a,two:b},backend:{executable:process.execPath},backends:{other:{executable:process.execPath,codexHome:b,aliases:['alt']}},
  slack:options.slack?{servers:['default'],teamId:'T1',inputChannel:'CIN',outputChannel:'COUT',allowedHumans:['UH'],approvalUsers:['UH'],trustedBots:[{botId:'BDOT',userId:'UDOT',appId:'ADOT'}],dot:{name:'dot',userId:'UDOT'}}:{enabled:false}};
 const cfg=parseConfig(raw),posts:any[]=[],native=new Map<string,FakeBackend>();
 const slack:SlackPort={async post(channel,text,opts){posts.push({channel,text,opts});return '91.3';},async resolveDot(){return{userId:'UDOT',name:'dot'};},async threadExists(){return true;},async humanMessage(){return undefined;}};
 const createRuntime=()=>{const rt=new Runtime(cfg,dir,slack,undefined,(_,id)=>{const f=new FakeBackend();f.threads.set('same-thread',{id:'same-thread',cwd:a,status:{type:'idle'},canAcceptDirectInput:true});f.threads.set('unallowed',{id:'unallowed',cwd:b,status:{type:'idle'},canAcceptDirectInput:true});native.set(id,f);return f;});
 for(const core of rt.cores.values())Object.assign(core,{postIntervalMs:0}); // Only omit production pacing in this trusted test adapter.
 return rt;};
 let runtime=createRuntime();
 const reopen=async(localEnabled:boolean)=>{await runtime.close();cfg.local!.enabled=localEnabled;runtime=createRuntime();await runtime.connectLocal();await runtime.enableSlack('USELF','BSELF');return runtime;};
 const cmd=async(name:string,params:Record<string,unknown>,p=OPERATOR)=>{const admitted=runtime.local(request(name,params),p);await waitFor(()=>runtime.receipt({serverId:admitted.serverId!,workId:admitted.id},p).status!=='executing'&&runtime.receipt({serverId:admitted.serverId!,workId:admitted.id},p).status!=='queued');return runtime.receipt({serverId:admitted.serverId!,workId:admitted.id},p);};
 const cleanup=async()=>{await runtime.close();rmSync(dir,{recursive:true,force:true});};return{dir,a,b,cfg,get runtime(){return runtime;},reopen,posts,native,cmd,cleanup};
}
test('local-only / dual physical backends: receipts, sessions, writes, destinations, conflicts and grants',async()=>{
 const f=fixture(),r=f.runtime,u=r.principal('agent:tool')!;
 try{
  assert.equal(r.servers().length,2);assert.equal(r.servers(u).length,1);assert.ok([...f.native.values()].every(x=>!x.connected&&!x.calls.length));await r.connectLocal();await r.enableSlack('USELF','BSELF');
  const a=await f.cmd('session.attach',{threadId:'same-thread'},u),b=await f.cmd('session.attach',{threadId:'same-thread',serverId:'alt'});assert.equal(a.status,'completed');assert.equal(b.serverId,'other');
  const sid=(a.result as any).sessionId;assert.notEqual(sid,(b.result as any).sessionId);
  assert.throws(()=>r.local(request('session.list',{serverId:'alt'}),u),/SERVER_UNAVAILABLE/);
  assert.throws(()=>r.receipt({serverId:'other',workId:a.id},OPERATOR),/RECEIPT_NOT_FOUND/);
  assert.throws(()=>r.receipt({workId:a.id},OPERATOR),/RECEIPT_NOT_FOUND/);
  assert.throws(()=>r.local(request('approval.list',{}),u),/LOCAL_SCOPE/);
  const rows=(await f.cmd('session.list',{},u)).result as any;assert.deepEqual(rows.sessions.map((x:any)=>x.id),['same-thread']);assert.deepEqual(rows.unresolvedLoadedIds,[]);
  const slackBind=request('session.attach',{threadId:'same-thread'});assert.ok(r.accept(event(slackBind)));await waitFor(()=>r.core('default').store.state.work.some(w=>w.request.id===slackBind.id&&w.status==='completed'));
  const req=request('session.send',{sessionId:sid,text:'only local'},'id-stable-123');const admitted=r.local(req,u);assert.equal(r.local({...req,params:{text:'only local',sessionId:sid}},u).id,admitted.id);
  assert.throws(()=>r.local({...req,params:{sessionId:sid,text:'different'}},u),/REQUEST_ID_CONFLICT/);
  await waitFor(()=>r.receipt({workId:admitted.id},u).status==='completed');
  const backend=f.native.get('default')!;assert.equal(backend.calls.filter(c=>c.method==='thread/queue/add').length,1);assert.equal(f.native.get('other')!.calls.filter(c=>c.method==='thread/queue/add').length,0);
  backend.emit('notification','item/completed',{threadId:'same-thread',turnId:'turn-1',item:{id:'O1',type:'agentMessage',phase:'final_answer',text:'only local answer'}},backend.epoch);
  backend.emit('notification','turn/completed',{threadId:'same-thread',turn:{id:'turn-1',status:'completed'}},backend.epoch);
  const page=await r.events({sessionId:sid,waitMs:1000},u);assert.ok(page.events.some(e=>e.type==='assistant.final'));
  assert.ok(!JSON.stringify(r.core('default').store.state.outbox).includes('only local'));assert.ok(!JSON.stringify(f.posts).includes('only local'));
  const miss=request('session.send',{sessionId:sid,text:'never',serverId:'other'});assert.equal(r.accept(event(miss)),true);assert.ok(!r.core('default').store.state.work.some(w=>w.request.id===miss.id));
  backend.connected=false;backend.emit('disconnect',backend.epoch);await new Promise(z=>setTimeout(z,5));await r.core('default').reconnect();
  assert.equal((await f.cmd('session.send',{sessionId:sid,text:'no automatic write'},u)).error,'SESSION_NOT_ATTACHED');assert.equal(backend.calls.filter(c=>c.method==='thread/queue/add').length,1);
 }finally{await f.cleanup();}
});
test('authenticated scoped API: cannot forge actor, recover, change server, or read global status',async()=>{
 const f=fixture({slack:false}),r=f.runtime,server=apiServer(r,'x'.repeat(64));await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const addr=server.address();assert.ok(addr&&typeof addr==='object');
 const post=async(body:unknown,token=tok)=>await fetch(`http://127.0.0.1:${addr.port}/v1/command`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
 try{let row=await post({action:'servers'});assert.equal(row.status,200);assert.deepEqual(((await row.json()) as any).result.map((x:any)=>x.serverId),['default']);
  assert.equal((await post({action:'status'})).status,403);assert.equal((await post({action:'recover',kind:'outbox',id:'x'})).status,403);
  assert.equal((await post({action:'servers',userId:'local'})).status,403);assert.equal((await post({action:'servers'},'wrong')).status,401);
 }finally{await new Promise<void>(done=>server.close(()=>done()));await f.cleanup();}
});
test('v2 migration backs up original, quarantines unproven operations and never rebinds after retarget',()=>{
 const dir=mkdtempSync(join(tmpdir(),'cc-migration-'));try{
  const old=new Store(dir);old.transaction(s=>s.outbox.push({id:randomUUID(),channel:'COUT',root:false,text:'past',status:'queued',attempts:0,nextAttemptAt:0}));old.close();
  const original=readFileSync(join(dir,'state.json'));assert.throws(()=>new Store(dir,{id:'default',fingerprint:'a',allowLegacy:false}),/LEGACY_TARGET_AMBIGUOUS/);
  const migrated=new Store(dir,{id:'default',fingerprint:'a',allowLegacy:true});assert.equal(migrated.state.outbox[0]!.status,'uncertain');migrated.close();
  assert.deepEqual(readFileSync(join(dir,'state.before-server-profiles.json')),original);
  const again=new Store(dir,{id:'default',fingerprint:'a',allowLegacy:true});again.close();assert.throws(()=>new Store(dir,{id:'default',fingerprint:'b',allowLegacy:true}),/TARGET_CHANGED/);assert.ok(!existsSync(join(dir,'daemon.lock')));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('change of project grant or root invalidates cached content and existing control binding',async()=>{
 const f=fixture(),r=f.runtime,p=r.principal('agent:tool')!;try{
  await r.connectLocal();const a=await f.cmd('session.attach',{threadId:'same-thread'},p),b=await f.cmd('session.list',{},p);
  const sid=(a.result as any).sessionId;
  const grant=f.cfg.local!.agents![0]!;grant.commands=grant.commands.filter(x=>x!=='session.events');
  assert.throws(()=>r.receipt({workId:b.id},r.principal('agent:tool')!),/LOCAL_GRANT_CHANGED/);
  f.cfg.projects.one=f.b;f.cfg.projects.two=f.a;
  assert.throws(()=>r.local(request('session.send',{sessionId:sid,text:'unavailable'}),r.principal('agent:tool')!),/LOCAL_BINDING_REQUIRED/);
  assert.equal(f.native.get('default')!.calls.filter(x=>x.method==='thread/queue/add').length,0);
 }finally{await f.cleanup();}
});
test('dual-bound Slack events use their proved sending thread, not a spectator, local holder or old binding',async()=>{
 const f=fixture(),r=f.runtime;try{
  await r.connectLocal();await r.enableSlack('USELF','BSELF');
  const a=await f.cmd('session.attach',{threadId:'same-thread'}),sessionId=(a.result as any).sessionId,core=r.core('default');
  const sl=(name:string,params:Record<string,unknown>,thread_ts:string)=>{const q=request(name,params);assert.ok(r.accept(event(q,{thread_ts})));return waitFor(()=>core.store.state.work.some(w=>w.request.id===q.id&&w.status==='completed'));};
  await sl('session.attach',{threadId:'same-thread'},'100.1');await sl('session.send',{sessionId,text:'public to owning thread'},'101.1');
  const b=f.native.get('default')!,turnId='turn-1';
  const origin=core.store.state.work.find(w=>w.request.command==='session.send')!;
  nativeInput(b,'same-thread',turnId,origin.id);
  const m={threadId:'same-thread',turnId,item:{id:'final-abc',type:'agentMessage',phase:'final_answer',text:'origin-only-final'}};
  b.emit('notification','item/completed',m,b.epoch);b.emit('notification','item/completed',m,b.epoch);
  await waitFor(()=>core.store.state.outbox.some(x=>x.text.includes('A Codex answer is ready')));
  assert.deepEqual(core.store.state.outbox.filter(x=>x.text.includes('A Codex answer is ready')).map(x=>x.threadTs),['101.1']);
  b.emit('request',{epoch:b.epoch,id:64,method:'item/commandExecution/requestApproval',params:{threadId:'same-thread',turnId,command:'secret-ish action'}});
  await waitFor(()=>core.store.state.outbox.some(x=>x.text.includes('LOCAL_ACTION_REQUIRED')));
  assert.equal(core.store.state.pending.length,0);assert.equal(core.store.state.outbox.at(-1)!.threadTs,'101.1');
  assert.ok(!JSON.stringify(core.store.state.outbox).includes('secret-ish action'));assert.ok(!JSON.stringify(core.store.state.outbox).includes('origin-only-final'));assert.equal(b.responses.length,0);
 }finally{await f.cleanup();}
});

function nativeInput(b:FakeBackend,threadId:string,turnId:string,clientId?:string,id='user-in'){
  b.emit('notification','item/completed',{threadId,turnId,item:{id,type:'userMessage',clientId,content:[{type:'text',text:'input text'}]}},b.epoch);
}
function assistant(b:FakeBackend,threadId:string,turnId:string,id:string,text:string,phase='commentary'){
  b.emit('notification','item/completed',{threadId,turnId,item:{id,type:'agentMessage',phase,text}},b.epoch);
}
async function slackWork(f:ReturnType<typeof fixture>,command:string,params:any,thread_ts='100.1',expected='completed'){
  const q=request(command,params),core=f.runtime.core('default');
  assert.ok(f.runtime.accept(event(q,{thread_ts})));
  await waitFor(()=>core.store.state.work.some(w=>w.request.id===q.id&&w.status===expected));
  const work=core.store.state.work.find(w=>w.request.id===q.id)!;
  return {work,result:core.store.state.results?.find(r=>r.id===work.resultRef?.resultId),core};
}
const msg=(turnId:string,id:string,text:string,clientId?:string)=>({turnId,item:clientId?{id,type:'userMessage',clientId,content:[{type:'text',text}]}:{id,type:'agentMessage',text}});

function persistedRows(f:ReturnType<typeof fixture>,rows:()=>ReturnType<typeof msg>[]){
  const backend=f.native.get('default')!,real=backend.rpc.bind(backend);
  backend.rpc=async (method,params)=>{
    if(method==='thread/items/list'&&params.threadId==='same-thread'){
      backend.calls.push({method,params});
      return{data:rows().filter(r=>!params.turnId||r.turnId===params.turnId),nextCursor:null};
    }
    return real(method,params);
  };
}
async function slackTurn(f:ReturnType<typeof fixture>){
  const control=await slackWork(f,'session.attach',{threadId:'same-thread'});
  const sessionId=control.work.resultRef!.sessionId!;
  const send=await slackWork(f,'session.send',{sessionId,text:'requested from this Slack thread'});
  const b=f.native.get('default')!,threadId='same-thread',turnId='turn-1';
  nativeInput(b,threadId,turnId,send.work.id);
  return {b,threadId,turnId,sessionId,send,core:send.core};
}
async function reached(predicate:()=>boolean){
  const deadline=Date.now()+12000;
  while(!predicate()&&Date.now()<deadline)await new Promise(r=>setTimeout(r,15));
  assert.ok(predicate());
}
const persistedOrigin={kind:'bot' as const,userId:'UDOT',channel:'CIN',ts:'100.1',threadTs:'100.1',eventId:'stored-for-recovery'};
function seedOutbox(f:ReturnType<typeof fixture>,id:string,text:string,status:'sending'|'uncertain'){
  f.runtime.core('default').store.transaction(s=>s.outbox.push({id,text,channel:persistedOrigin.channel,threadTs:persistedOrigin.threadTs,origin:persistedOrigin,root:false,status,attempts:1,nextAttemptAt:0}));
}

for(const localEnabled of [true,false])test(`shared Runtime local=${localEnabled}: never relay native body at same-epoch drift, but keep authorized fixed progress`,async()=>{
  const f=fixture();
  try{
    f.cfg.local!.enabled=localEnabled;await f.runtime.connectLocal();await f.runtime.enableSlack('USELF','BSELF');
    const {b,threadId,turnId,sessionId,core,send}=await slackTurn(f);
    const primary='PRIVATE DESKTOP CONTENT SENTINEL',mixed='MIXED OWNER BODY FRAGMENT',question='SECRET NATIVE QUESTION SENTINEL';
    b.threads.get(threadId).name=primary;b.threads.get(threadId).status={type:'idle',unapprovedBody:primary};
    await slackWork(f,'session.subscribe',{threadId});await slackWork(f,'session.subscribe',{threadId},'101.1');
    const rows=[msg(turnId,'known-input','Slack request',send.work.id),msg(turnId,'text-current',primary)];
    persistedRows(f,()=>rows);
    if(localEnabled){
      await f.cmd('session.attach',{threadId});
      const local=await f.cmd('session.history',{sessionId});
      assert.ok(JSON.stringify(local.result).includes(primary));
    }
    const before=b.calls.filter(x=>x.method==='thread/items/list').length;
    for(const [command,args] of [['session.messages',{threadId}],['session.overview',{threadIds:[threadId]}],['session.search',{terms:['SENTINEL']}],['session.history',{sessionId}]] as const){
      const commandResult=await slackWork(f,command,args,'100.1','failed');
      assert.equal(commandResult.work.error,'NATIVE_CONTENT_LOCAL_ONLY');assert.equal(commandResult.result,undefined);
    }
    assert.equal(b.calls.filter(x=>x.method==='thread/items/list').length,before);
    // Deliberately do not emit the external user's input notification. In the
    // previous implementation the adapter saw the mixed body in this epoch.
    rows.push(msg(turnId,'late-desktop-input','native interleaving', 'other-client'));
    assistant(b,threadId,turnId,'commentary-secret',mixed,'commentary');
    assistant(b,threadId,turnId,'partial-secret',mixed,'partial_answer');
    assistant(b,threadId,turnId,'final-secret',primary,'final_answer');
    b.emit('request',{epoch:b.epoch,id:203,method:'item/tool/requestUserInput',params:{threadId,turnId,questions:[{id:'choice',question,options:[{label:primary}]}]}});
    await waitFor(()=>core.store.state.outbox.some(x=>x.text.includes('LOCAL_ACTION_REQUIRED')));
    const fixed=core.store.state.outbox.filter(x=>x.visibility?.proof?.kind==='live');
    for(const label of ['reported progress','answer is ready','LOCAL_ACTION_REQUIRED'])assert.equal(fixed.filter(x=>x.text.includes(label)).length,1);
    assert.ok(fixed.every(x=>x.threadTs==='100.1'&&x.subscriptionId));
    assert.ok(core.store.state.pending.every(p=>JSON.stringify(p.details)==='{"notice":"Open the original Codex UI."}'));
    const info=await slackWork(f,'session.info',{sessionId});
    assert.equal(JSON.parse(info.result!.text).name,null);
    const meta=await slackWork(f,'session.list',{});
    assert.equal(JSON.parse(meta.result!.text).sessions.find((x:any)=>x.id===threadId).name,null);
    const epoch=b.epoch;
    await reached(()=>f.posts.some(x=>x.text.includes('LOCAL_ACTION_REQUIRED')));
    assert.equal(b.epoch,epoch);
    for(const marker of [primary,mixed,question]){
      assert.ok(!JSON.stringify(core.store.state.outbox).includes(marker));
      assert.ok(!JSON.stringify(core.store.state.results).includes(marker));
      assert.ok(!JSON.stringify(f.posts).includes(marker));
    }
    assert.equal(b.responses.length,0);
  }finally{await f.cleanup();}
});

test('native bodies from old cached results or queued and uncertain sends cannot cross the new policy or mode restart',async()=>{
 const f=fixture();try{
  f.cfg.local!.enabled=false;await f.runtime.connectLocal();await f.runtime.enableSlack('USELF','BSELF');
  const base=await slackWork(f,'help',{command:'server.list'});
  const id=randomUUID(),priorQueued=randomUUID(),priorUncertain=randomUUID(),text='OLD UNPROVEN NATIVE BODY';
  base.core.store.transaction(s=>{
    s.results!.push({...base.result!,scopeVersion:2,id,command:'session.messages',nextCommand:'session.messages',nextQuery:{threadId:'same-thread',cursor:'old'},text});
    for(const [key,status] of [[priorQueued,'queued'],[priorUncertain,'sending']] as const)s.outbox.push({id:key,scopeVersion:2,visibility:base.result!.visibility,text,origin:persistedOrigin,channel:'CIN',threadTs:'100.1',root:false,status,attempts:0,nextAttemptAt:0});
  });
  const r=await f.reopen(true),core=r.core('default');
  for(const [command,params] of [['result.page',{resultId:id,page:1}],['result.next',{resultId:id}]] as const)
    assert.equal((await slackWork(f,command,params,'100.1','failed')).work.error,'RESULT_UNAVAILABLE');
  assert.equal(core.store.state.outbox.find(o=>o.id===priorQueued)?.status,'failed');
  assert.equal(core.store.state.outbox.find(o=>o.id===priorUncertain)?.status,'uncertain');
  assert.throws(()=>r.recover('outbox',priorUncertain),/SLACK_DELIVERY_SCOPE_UNVERIFIED/);
  assert.equal(core.store.state.outbox.find(o=>o.id===priorUncertain)?.status,'failed');
  await f.reopen(false);
  assert.equal((await slackWork(f,'result.page',{resultId:id,page:1},'100.1','failed')).work.error,'RESULT_UNAVAILABLE');
  assert.ok(f.posts.every(x=>!x.text.includes(text)));
 }finally{await f.cleanup();}
});

test('old sending row becomes uncertain on restart; manual attestation is not a Slack API acknowledgment',async()=>{
 const f=fixture();try{
  const invalid=randomUUID(),attested=randomUUID(),sentinel='OLD PRIVATE LEGACY OUTBOX';
  await f.runtime.connectLocal();await f.runtime.enableSlack('USELF','BSELF');
  seedOutbox(f,invalid,sentinel,'sending');seedOutbox(f,attested,sentinel,'sending');
  const r=await f.reopen(true),core=r.core('default');
  assert.equal(core.store.state.outbox.find(o=>o.id===invalid)?.status,'uncertain');
  assert.throws(()=>r.recover('outbox',invalid),/SLACK_DELIVERY_SCOPE_UNVERIFIED/);
  r.recover('outbox',attested,'321.1');
  assert.equal(core.store.state.outbox.find(o=>o.id===attested)?.deliveryEvidence,'operator-attested');
  await slackWork(f,'help',{command:'server.list'});
  await waitFor(()=>f.posts.some(x=>x.text.includes('server.list')));
  assert.ok(f.posts.every(x=>!x.text.includes(sentinel)));
  assert.ok(core.store.state.outbox.some(o=>o.status==='sent'&&o.deliveryEvidence==='slack-api-ack'));
 }finally{await f.cleanup();}
});

test('final send and manual recovery both reject a malformed current-schema native notice including one free-form fragment',async()=>{
 const f=fixture();try{
   await f.runtime.connectLocal();await f.runtime.enableSlack('USELF','BSELF');
   const {b,threadId,turnId,core}=await slackTurn(f);
   const barrier=randomUUID();seedOutbox(f,barrier,'blocked in-flight record','uncertain');
   assistant(b,threadId,turnId,'synthetic-final','never expose this','final_answer');
   await waitFor(()=>core.store.state.outbox.some(x=>x.text.includes('A Codex answer is ready')));
   const orig=core.store.state.outbox.find(o=>o.text.includes('A Codex answer is ready'))!,id=randomUUID(),sentinel='UNEXPECTED FRAGMENT';
   core.store.transaction(s=>{
     const row=s.outbox.find(o=>o.id===orig.id)!;row.text+=' '+sentinel;
     s.outbox.push({...row,id,status:'uncertain',text:sentinel});
   });
   assert.throws(()=>f.runtime.recover('outbox',id),/SLACK_DELIVERY_SCOPE_UNVERIFIED/);
   f.runtime.recover('outbox',barrier,'160.5');
   await reached(()=>core.store.state.outbox.find(x=>x.id===orig.id)?.status==='failed');
   assert.ok(f.posts.every(x=>!x.text.includes(sentinel)));
 }finally{await f.cleanup();}
});

function expireRequest(row:any){row.expiresAt=Date.now()-1;}
function nativeRequests(f:ReturnType<typeof fixture>,data:Awaited<ReturnType<typeof slackTurn>>,turnId=data.turnId){
  const {b,threadId}=data;
  b.emit('request',{epoch:b.epoch,id:880,method:'item/commandExecution/requestApproval',params:{threadId,turnId,cwd:f.a,command:'private native command sentinel'}});
  b.emit('request',{epoch:b.epoch,id:881,method:'item/tool/requestUserInput',params:{threadId,turnId,questions:[{id:'q1',question:'private input question sentinel'}]}});
}
test('Slack-only native UI handoff restores only exact proved command decline and input interrupt at timeout',async()=>{
 const f=fixture();try{
  f.cfg.local!.enabled=false;await f.runtime.connectLocal();await f.runtime.enableSlack('USELF','BSELF');
  const data=await slackTurn(f),{b,sessionId,threadId,turnId,core,send}=data;
  persistedRows(f,()=>[msg(turnId,'own-input','requested from this Slack thread',send.work.id)]);
  nativeRequests(f,data);await waitFor(()=>core.store.state.pending.length===2);
  const [cmd,input]=core.store.state.pending;
  assert.equal(cmd?.status,'pending');assert.equal(input?.status,'pending');
  assert.equal((await slackWork(f,'approval.respond',{requestId:cmd!.id,sessionId,turnId,epoch:b.epoch,decision:'accept'},'100.1','failed')).work.error,'LOCAL_ACTION_REQUIRED');
  assert.equal((await slackWork(f,'input.respond',{requestId:input!.id,sessionId,turnId,epoch:b.epoch,answers:{q1:['yes']}},'100.1','failed')).work.error,'LOCAL_ACTION_REQUIRED');
  const index=await slackWork(f,'approval.list',{sessionId});
  assert.ok(JSON.parse(index.result!.text).every((row:any)=>row.status==='local-action-required'&&!row.details));
  assert.equal(b.responses.length,0);
  core.store.transaction(s=>s.pending.forEach(expireRequest));await Promise.all([core.expire(),core.expire()]);
  assert.deepEqual(b.responses,[{id:880,result:{decision:'decline'}}]);
  assert.deepEqual(b.calls.filter(x=>x.method==='turn/interrupt').map(x=>x.params),[{threadId,turnId}]);
  assert.deepEqual(core.store.state.pending.map(p=>p.deadlineOutcome),['decline-submitted','interrupt-submitted']);
  assert.ok(!JSON.stringify(core.store.state.outbox).includes('private native command sentinel'));
 }finally{await f.cleanup();}
});

test('no timeout mutation when inputs changed without notification, native request resolved, or native turn is not owned',async()=>{
 const f=fixture();try{
  await f.runtime.connectLocal();await f.runtime.enableSlack('USELF','BSELF');
  const data=await slackTurn(f),{b,core,turnId,send,threadId}=data;
  nativeRequests(f,data, 'foreign-turn');await new Promise(r=>setTimeout(r,20));assert.equal(core.store.state.pending.length,0);
  nativeRequests(f,data);await waitFor(()=>core.store.state.pending.length===2);
  const call=b.rpc.bind(b);
  b.rpc=async(method,params)=>{
    if(method==='thread/read'){
      // A request may resolve while awaiting an unrelated native read.
      b.emit('notification','serverRequest/resolved',{requestId:881},b.epoch);
      await waitFor(()=>core.store.state.pending.find(p=>p.rpcId===881)?.status==='resolved');
    }
    if(method==='thread/items/list')return{data:[msg(turnId,'known','requested from this Slack thread',send.work.id),msg(turnId,'mixed','foreign input without notification','foreign-client')],nextCursor:null};
    return call(method,params);
  };
  core.store.transaction(s=>s.pending.forEach(expireRequest));await core.expire();await core.expire();
  assert.deepEqual(core.store.state.pending.map(p=>[p.status,p.deadlineOutcome]),[['expired','not-attempted'],['resolved',undefined]]);
  assert.equal(b.responses.length,0);
  assert.ok(!b.calls.some(c=>c.method==='turn/interrupt'&&c.params.threadId===threadId));
 }finally{await f.cleanup();}
});

test('deadline cannot act on a native edit that retains the original correlated client ID',async()=>{
 const f=fixture();try{
  f.cfg.local!.enabled=false;await f.runtime.connectLocal();await f.runtime.enableSlack('USELF','BSELF');
  const data=await slackTurn(f),{b,core,turnId,send}=data;
  persistedRows(f,()=>[msg(turnId,'own-input','rewritten elsewhere but retained the ID',send.work.id)]);
  nativeRequests(f,data);await waitFor(()=>core.store.state.pending.length===2);
  core.store.transaction(s=>s.pending.forEach(expireRequest));await core.expire();
  assert.deepEqual(core.store.state.pending.map(r=>r.deadlineOutcome),['not-attempted','not-attempted']);
  assert.equal(b.responses.length,0);assert.ok(!b.calls.some(c=>c.method==='turn/interrupt'));
 }finally{await f.cleanup();}
});

test('file tool cannot read, list or search a configured nondefault Codex Home through a project alias',async()=>{
 const f=fixture();try{
  const sentinel='PRIVATE CUSTOM HOME FILE';writeFileSync(join(f.b,'native-message.log'),sentinel);
  await f.runtime.connectLocal();await f.runtime.enableSlack('USELF','BSELF');
  for(const [command,args] of [['files.list',{path:'.'}],['files.read',{path:'native-message.log'}],['files.search',{path:'.',query:'HOME FILE'}]] as const){
    const result=await slackWork(f,command,{root:'two',...args},'100.1','failed');assert.equal(result.work.error,'PATH_FORBIDDEN');
  }
  assert.ok(!JSON.stringify(f.runtime.core('default').store.state.outbox).includes(sentinel));
 }finally{await f.cleanup();}
});

for(const shape of ['missing-thread','wrong-project','lost-reply','existing-id'] as const)test(`thread/start ${shape}: native side effect is uncertain, no false binding or replay`,async()=>{
 const f=fixture(),r=f.runtime,b=f.native.get('default')!;
 try{
  await r.connectLocal();
  if(shape==='existing-id')await f.cmd('session.attach',{threadId:'same-thread'});
  const call=b.rpc.bind(b),before=r.core('default').store.state.sessions;let nativeCreates=0;
  b.rpc=async(method,params)=>{
    if(method!=='thread/start')return call(method,params);
    nativeCreates++;
    const made=await call(method,params);
    if(shape==='missing-thread')return{notThread:made.thread};
    if(shape==='wrong-project')return{thread:{...made.thread,cwd:f.b}};
    if(shape==='existing-id')return{thread:b.threads.get('same-thread')};
    throw new BackendError('RPC_OUTCOME_UNCERTAIN');
  };
  const q=request('session.create',{project:'one'}),admitted=r.local(q);
  await waitFor(()=>r.receipt({workId:admitted.id},OPERATOR).status==='uncertain');
  assert.equal(r.receipt({workId:admitted.id},OPERATOR).error,'RPC_OUTCOME_UNCERTAIN');assert.equal(r.receipt({workId:admitted.id},OPERATOR).result,undefined);
  assert.deepEqual(r.core('default').store.state.sessions,before);
  assert.equal(r.local(q).id,admitted.id);const another=r.local(request('session.create',{project:'one'}));
  await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(r.receipt({workId:another.id},OPERATOR).status,'queued');assert.equal(nativeCreates,1);
 }finally{await f.cleanup();}
});
