import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,rmSync,readFileSync,existsSync } from 'node:fs';
import { join } from 'node:path';import { tmpdir } from 'node:os';import { createHash,randomUUID } from 'node:crypto';
import { FakeBackend,request,event,waitFor } from './helpers.js';
import { Runtime } from '../src/runtime.js';import { parseConfig } from '../src/config.js';
import { Store } from '../src/store.js';import { apiServer } from '../src/server.js';import { OPERATOR, type SlackPort } from '../src/types.js';
const tok='t'.repeat(48);
function fixture(options={slack:true}){
 const dir=mkdtempSync(join(tmpdir(),'known-servers-')),a=join(dir,'A'),b=join(dir,'B');mkdirSync(a);mkdirSync(b);
 const raw={version:2,instanceId:'test',port:18012,approvalTimeoutSec:30,local:{enabled:true,agents:[{id:'tool',tokenHash:createHash('sha256').update(tok).digest('hex'),servers:['default'],projects:['one'],commands:['server.list','session.attach','session.list','session.send','session.events']}]},projects:{one:a,two:b},backend:{executable:process.execPath},backends:{other:{executable:process.execPath,codexHome:b,aliases:['alt']}},
  slack:options.slack?{servers:['default'],teamId:'T1',inputChannel:'CIN',outputChannel:'COUT',allowedHumans:['UH'],approvalUsers:['UH'],trustedBots:[{botId:'BDOT',userId:'UDOT',appId:'ADOT'}],dot:{name:'dot',userId:'UDOT'}}:{enabled:false}};
 const cfg=parseConfig(raw),posts:any[]=[],native=new Map<string,FakeBackend>();
 const slack:SlackPort={async post(channel,text,opts){posts.push({channel,text,opts});return '91.3';},async resolveDot(){return{userId:'UDOT',name:'dot'};},async threadExists(){return true;},async humanMessage(){return undefined;}};
 const runtime=new Runtime(cfg,dir,slack,undefined,(_,id)=>{const f=new FakeBackend();f.threads.set('same-thread',{id:'same-thread',cwd:a,status:{type:'idle'},canAcceptDirectInput:true});f.threads.set('unallowed',{id:'unallowed',cwd:b,status:{type:'idle'},canAcceptDirectInput:true});native.set(id,f);return f;});
 const cmd=async(name:string,params:Record<string,unknown>,p=OPERATOR)=>{const admitted=runtime.local(request(name,params),p);await waitFor(()=>runtime.receipt({serverId:admitted.serverId!,workId:admitted.id},p).status!=='executing'&&runtime.receipt({serverId:admitted.serverId!,workId:admitted.id},p).status!=='queued');return runtime.receipt({serverId:admitted.serverId!,workId:admitted.id},p);};
 const cleanup=async()=>{await runtime.close();rmSync(dir,{recursive:true,force:true});};return{dir,a,b,cfg,runtime,posts,native,cmd,cleanup};
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
