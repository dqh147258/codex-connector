import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,rmSync,readFileSync,existsSync } from 'node:fs';
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
 const createRuntime=()=>new Runtime(cfg,dir,slack,undefined,(_,id)=>{const f=new FakeBackend();f.threads.set('same-thread',{id:'same-thread',cwd:a,status:{type:'idle'},canAcceptDirectInput:true});f.threads.set('unallowed',{id:'unallowed',cwd:b,status:{type:'idle'},canAcceptDirectInput:true});native.set(id,f);return f;});
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
  await waitFor(()=>core.store.state.outbox.some(x=>x.text==='origin-only-final'));
  assert.deepEqual(core.store.state.outbox.filter(x=>x.text==='origin-only-final').map(x=>x.threadTs),['101.1']);
  b.emit('request',{epoch:b.epoch,id:64,method:'item/commandExecution/requestApproval',params:{threadId:'same-thread',turnId,command:'secret-ish action'}});
  await waitFor(()=>core.store.state.outbox.some(x=>x.text.startsWith('LOCAL_ACTION_REQUIRED')));
  assert.equal(core.store.state.pending.length,0);assert.equal(core.store.state.outbox.at(-1)!.threadTs,'101.1');
  assert.ok(!JSON.stringify(core.store.state.outbox).includes('secret-ish action'));assert.equal(b.responses.length,0);
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

test('Slack histories, search, snapshots and continuations cannot disclose local or unattributed turns, even after attach',async()=>{
 const f=fixture(),r=f.runtime,threadId='same-thread',b=f.native.get('default')!;
 try{
  await r.connectLocal();await r.enableSlack('USELF','BSELF');
  const a=await f.cmd('session.attach',{threadId}),sessionId=(a.result as any).sessionId;
  const privateText='LOCAL-ONLY SENTINEL',unattributed='DESKTOP-ONLY SENTINEL',publicText='SLACK ALLOWED SENTINEL';
  const add=await f.cmd('session.send',{sessionId,text:privateText});
  const call=b.rpc.bind(b);
  let visible:ReturnType<typeof msg>[]=[];
  b.threads.get(threadId).name=privateText;
  b.rpc=async(method,params)=>{
    if(method==='thread/items/list'&&params.threadId===threadId){
      if(params.turnId)return{data:visible.filter(v=>v.turnId===params.turnId),nextCursor:null};
      const i=params.cursor?Number(String(params.cursor).slice(5))-1:0;
      return{data:visible.slice(i,i+1),nextCursor:i+1<visible.length?'page-'+(i+2):null};
    }
    if(method==='thread/queue/start')return{turn:{id:'slack-turn',status:'inProgress'}};
    return call(method,params);
  };
  visible=[msg('turn-1','local-user',privateText,add.id),msg('turn-1','local-final',privateText),msg('native-turn','native-final',unattributed)];
  const direct=await slackWork(f,'session.messages',{threadId});
  const first=JSON.parse(direct.result!.text);assert.equal(first.returnedCount,0);assert.ok(first.nextCursor);
  assert.equal(first.metadata.name,null);assert.ok(!direct.result!.text.includes(privateText));
  const next=await slackWork(f,'result.next',{resultId:direct.result!.id});assert.equal(JSON.parse(next.result!.text).returnedCount,0);
  const unknown=await slackWork(f,'result.next',{resultId:next.result!.id});assert.equal(JSON.parse(unknown.result!.text).returnedCount,0);
  await slackWork(f,'result.page',{resultId:direct.result!.id,page:1});
  const stolen=await slackWork(f,'session.messages',{threadId,cursor:first.nextCursor},'101.1','failed');assert.equal(stolen.work.error,'INVALID_CURSOR');
  await slackWork(f,'session.attach',{threadId});
  const history=await slackWork(f,'session.history',{sessionId});assert.deepEqual(JSON.parse(history.result!.text).items,[]);
  for(const command of ['session.search','session.overview']){
    const args=command==='session.search'?{terms:['SENTINEL']}:{threadIds:[threadId]};
    const outcome=await slackWork(f,command,args);assert.ok(!outcome.result!.text.includes(privateText));assert.ok(!outcome.result!.text.includes(unattributed));
    if(command==='session.search')assert.equal(JSON.parse(outcome.result!.text).returnedCount,0);
  }
  const reply=await slackWork(f,'session.send',{sessionId,text:'public request'});
  visible=[msg('slack-turn','slack-model',publicText),msg('slack-turn','slack-user','public request',reply.work.id)];
  const own=await slackWork(f,'session.messages',{threadId});assert.equal(JSON.parse(own.result!.text).items[0].excerpt,publicText);
  const ownBound=await slackWork(f,'session.history',{sessionId});assert.equal(JSON.parse(ownBound.result!.text).items[0].text,publicText);
  const ownSearch=await slackWork(f,'session.search',{terms:['ALLOWED SENTINEL']});assert.equal(JSON.parse(ownSearch.result!.text).returnedCount,1);
  const ownNext=await slackWork(f,'result.next',{resultId:own.result!.id});assert.equal(JSON.parse(ownNext.result!.text).items[0].excerpt,'public request');
  const other=await slackWork(f,'session.messages',{threadId},'101.1');assert.deepEqual(JSON.parse(other.result!.text).items,[]);
  const cacheReplay=await slackWork(f,'result.page',{resultId:own.result!.id,page:1},'101.1','failed');assert.equal(cacheReplay.work.error,'RESULT_UNAVAILABLE');
  visible.push(msg('slack-turn','mixed-input','unrelated input','unowned-id'));
  const mixed=await slackWork(f,'session.messages',{threadId});assert.deepEqual(JSON.parse(mixed.result!.text).items,[]);
  const oldId=randomUUID();
  direct.core.store.transaction(d=>d.results!.push({id:oldId,createdAt:Date.now(),expiresAt:Date.now()+60000,policy:own.result!.policy,source:own.result!.source,command:'session.history',text:privateText}));
  const old=await slackWork(f,'result.page',{resultId:oldId,page:1},'100.1','failed');assert.equal(old.work.error,'RESULT_UNAVAILABLE');
  assert.ok(!JSON.stringify(direct.core.store.state.outbox).includes(privateText));assert.ok(!JSON.stringify(f.posts).includes(privateText));
  assert.ok(!JSON.stringify(direct.core.store.state.outbox).includes(unattributed));
 }finally{await f.cleanup();}
});

test('commentary and visible input prompts stay in the original authorized Slack subscription after local attach',async()=>{
 const f=fixture(),r=f.runtime,b=f.native.get('default')!,threadId='same-thread',turnId='turn-1';
 try{
  await r.connectLocal();await r.enableSlack('USELF','BSELF');
  const attach=await slackWork(f,'session.attach',{threadId}),sessionId=attach.work.resultRef!.sessionId;
  await slackWork(f,'session.subscribe',{threadId});await slackWork(f,'session.subscribe',{threadId},'101.1');
  const sent=await slackWork(f,'session.send',{sessionId,text:'from slack'});
  nativeInput(b,threadId,turnId,sent.work.id);
  assistant(b,threadId,turnId,'comm-1','progress-before');
  await waitFor(()=>attach.core.store.state.outbox.some(o=>o.text.includes('progress-before')));
  await f.cmd('session.attach',{threadId});
  assistant(b,threadId,turnId,'comm-1','progress-before');
  assistant(b,threadId,turnId,'comm-2','progress-after','partial_answer');
  b.emit('request',{epoch:b.epoch,id:221,method:'item/tool/requestUserInput',params:{threadId,turnId,questions:[{id:'choice',header:'Decision',question:'visible-question',isSecret:false,options:[{label:'Continue',description:'Continue work'}]}]}});
  await waitFor(()=>attach.core.store.state.outbox.some(o=>o.text.includes('visible-question')));
  for(const marker of ['progress-before','progress-after','visible-question']){
    const rows=attach.core.store.state.outbox.filter(o=>o.text.includes(marker));
    assert.equal(rows.length,1);assert.equal(rows[0]!.threadTs,'100.1');assert.ok(rows[0]!.subscriptionId);
  }
  assert.equal(b.responses.length,0);
  nativeInput(b,threadId,turnId,undefined,'desktop-steer');
  assistant(b,threadId,turnId,'mixed-final','MIXED NATIVE OUTPUT','final_answer');
  await waitFor(()=>attach.core.store.state.work.find(w=>w.id===sent.work.id)?.slackMixedInput===true);
  assert.ok(!JSON.stringify(attach.core.store.state.outbox).includes('MIXED NATIVE OUTPUT'));
  assert.equal(attach.core.store.state.results?.some(o=>o.text.includes('from slack')),false);
 }finally{await f.cleanup();}
});

function persistedRows(f:ReturnType<typeof fixture>,rows:()=>ReturnType<typeof msg>[]){
  const backend=f.native.get('default')!,real=backend.rpc.bind(backend);
  backend.rpc=async (method,params)=>{
    if(method==='thread/items/list'&&params.threadId==='same-thread')return{data:rows().filter(r=>!params.turnId||r.turnId===params.turnId),nextCursor:null};
    return real(method,params);
  };
}
async function recordSlackHistory(f:ReturnType<typeof fixture>,text:string){
  const control=await slackWork(f,'session.attach',{threadId:'same-thread'});
  const send=await slackWork(f,'session.send',{sessionId:control.work.resultRef!.sessionId,text:'requested from this Slack thread'});
  const rows=[msg('turn-1','known-user','requested from this Slack thread',send.work.id),msg('turn-1','known-final',text)];
  persistedRows(f,()=>rows);
  const history=await slackWork(f,'session.messages',{threadId:'same-thread'});
  assert.equal(JSON.parse(history.result!.text).items[1].excerpt,text);
  return{rows,history};
}
test('Slack-only preserves actually attributed history, never a Desktop turn with no same-origin proof',async()=>{
 const f=fixture(),r=f.runtime,localText='Unverified native messages remain private';
 try{
  f.cfg.local!.enabled=false;await r.connectLocal();await r.enableSlack('USELF','BSELF');
  persistedRows(f,()=>[msg('historic','historic-item',localText)]);
  const unknown=await slackWork(f,'session.messages',{threadId:'same-thread'});
  assert.deepEqual(JSON.parse(unknown.result!.text).items,[]);
  const {history}=await recordSlackHistory(f,'Confirmed same-origin Slack-visible text');
  const detail=await slackWork(f,'result.page',{resultId:history.result!.id,page:1});
  assert.equal(detail.work.status,'completed');
  assert.ok(!JSON.stringify(unknown.core.store.state.outbox).includes(localText));
 }finally{await f.cleanup();}
});

test('persisted Slack snapshots do not cross Slack-only to dual or open again after another mode switch',async()=>{
 const f=fixture();try{
  f.cfg.local!.enabled=false;await f.runtime.connectLocal();await f.runtime.enableSlack('USELF','BSELF');
  const allowed='same-origin answer recorded before mode switch',oldWrong='OLD UNATTRIBUTED BODY';
  const {rows,history}=await recordSlackHistory(f,allowed);
  const id=history.result!.id,past=history.result!.visibility?.generation;
  const previousFormat=randomUUID();
  history.core.store.transaction(s=>s.results!.push({...history.result!,scopeVersion:1,visibility:undefined,id:previousFormat,text:oldWrong}));
  await f.reopen(true);
  persistedRows(f,()=>rows);await f.cmd('session.attach',{threadId:'same-thread'});
  for(const resultId of [id,previousFormat])assert.equal((await slackWork(f,'result.page',{resultId,page:1},'100.1','failed')).work.error,'RESULT_UNAVAILABLE');
  const fresh=await slackWork(f,'session.messages',{threadId:'same-thread'});
  assert.notEqual(fresh.result!.visibility?.generation,past);
  assert.equal(JSON.parse(fresh.result!.text).items[1].excerpt,allowed);
  await f.reopen(false);persistedRows(f,()=>rows);
  assert.equal((await slackWork(f,'result.page',{resultId:id,page:1},'100.1','failed')).work.error,'RESULT_UNAVAILABLE');
  assert.ok(f.posts.every(x=>!x.text.includes(oldWrong)));
 }finally{await f.cleanup();}
});

test('same-mode restart rechecks a retained snapshot against foreign input received offline',async()=>{
 const f=fixture();try{
  await f.runtime.connectLocal();await f.runtime.enableSlack('USELF','BSELF');
  const {rows,history}=await recordSlackHistory(f,'formerly visible exact Slack answer');
  await f.cmd('session.attach',{threadId:'same-thread'});
  await f.reopen(true);
  const sent=f.runtime.core('default').store.state.work.find(w=>w.request.command==='session.send')!;
  assert.equal(f.runtime.core('default').store.state.results?.find(x=>x.id===history.result!.id)?.visibility?.generation,history.result!.visibility?.generation);
  persistedRows(f,()=>rows);
  assert.equal((await slackWork(f,'result.page',{resultId:history.result!.id,page:1})).work.status,'completed');
  rows.push(msg('turn-1','foreign-desktop','input arrived offline','some-unrelated-client'));
  persistedRows(f,()=>rows);
  assert.equal((await slackWork(f,'result.page',{resultId:history.result!.id,page:1},'100.1','failed')).work.error,'RESULT_UNAVAILABLE');
  assert.equal(f.runtime.core('default').store.state.work.find(w=>w.id===sent.id)?.slackMixedInput,true);
  rows.pop(); // Even if later omitted, evidence of mixed ownership stays durable.
  const fresh=await slackWork(f,'session.messages',{threadId:'same-thread'});
  assert.deepEqual(JSON.parse(fresh.result!.text).items,[]);
  assert.equal(f.runtime.core('default').store.state.work.find(w=>w.id===history.work.id)?.status,'completed');
 }finally{await f.cleanup();}
});
const persistedOrigin={kind:'bot' as const,userId:'UDOT',channel:'CIN',ts:'100.1',threadTs:'100.1',eventId:'stored-for-recovery'};
function seedOutbox(f:ReturnType<typeof fixture>,id:string,text:string,status:'sending'|'uncertain'){
  f.runtime.core('default').store.transaction(s=>s.outbox.push({id,text,channel:persistedOrigin.channel,threadTs:persistedOrigin.threadTs,origin:persistedOrigin,root:false,status,attempts:1,nextAttemptAt:0}));
}
test('old sending row becomes uncertain on restart; manual recovery never sends unstamped text',async()=>{
 const f=fixture();try{
  const invalid=randomUUID(),attested=randomUUID(),sentinel='OLD PRIVATE LEGACY OUTBOX';
  await f.runtime.connectLocal();await f.runtime.enableSlack('USELF','BSELF');
  seedOutbox(f,invalid,sentinel,'sending');seedOutbox(f,attested,sentinel,'sending');
  const r=await f.reopen(true),core=r.core('default');
  assert.equal(core.store.state.outbox.find(o=>o.id===invalid)?.status,'uncertain');
  assert.throws(()=>r.recover('outbox',invalid),/SLACK_DELIVERY_SCOPE_UNVERIFIED/);
  assert.equal(core.store.state.outbox.find(o=>o.id===invalid)?.status,'failed');
  r.recover('outbox',attested,'321.1');
  assert.equal(core.store.state.outbox.find(o=>o.id===attested)?.deliveryEvidence,'operator-attested');
  await slackWork(f,'help',{command:'server.list'});
  await waitFor(()=>f.posts.some(x=>x.text.includes('server.list')));
  assert.ok(f.posts.every(x=>!x.text.includes(sentinel)));
  assert.ok(core.store.state.outbox.some(o=>o.status==='sent'&&o.deliveryEvidence==='slack-api-ack'));
 }finally{await f.cleanup();}
});

test('queued native preview and result.page are verified again when the actual Slack send lane becomes available',async()=>{
 const f=fixture();try{
  await f.runtime.connectLocal();await f.runtime.enableSlack('USELF','BSELF');
  const barrier=randomUUID();seedOutbox(f,barrier,'blocking in-flight record','uncertain');
  const sensitiveAfterChange='OUTBOX SCOPE WITNESS SENTINEL';
  const {rows,history}=await recordSlackHistory(f,sensitiveAfterChange);
  const page=await slackWork(f,'result.page',{resultId:history.result!.id,page:1});
  const core=page.core;
  const blocked=core.store.state.outbox.filter(o=>o.text.includes(sensitiveAfterChange));
  assert.ok(blocked.length>=2);assert.ok(blocked.every(o=>o.status==='queued'&&o.visibility?.proof?.kind==='history'));
  rows.push(msg('turn-1','foreign-before-send','input received immediately before send','foreign-client'));
  f.runtime.recover('outbox',barrier,'142.5');
  const deadline=Date.now()+8000;
  while(Date.now()<deadline&&!blocked.every(x=>core.store.state.outbox.find(o=>o.id===x.id)?.status==='failed'))await new Promise(r=>setTimeout(r,10));
  assert.ok(blocked.every(x=>core.store.state.outbox.find(o=>o.id===x.id)?.error==='SLACK_DELIVERY_SCOPE_UNVERIFIED'));
  assert.ok(f.posts.every(x=>!x.text.includes(sensitiveAfterChange)));
  assert.equal(core.store.state.work.find(w=>w.id===page.work.id)?.status,'completed');
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
