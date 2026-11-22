/* Read-only-after-create Linux QA for the official version; no model turn,
 * secret, filesystem history read or Slack account. After npm run build:
 * node scripts/verify-blank-native-start.mjs /path/to/verified/pinned/codex
 */
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { spawn,spawnSync } from 'node:child_process';
import { mkdtempSync,mkdirSync,readFileSync,rmSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { EventEmitter,once } from 'node:events';
import { BackendError } from '../dist/src/codex.js';
import { classifyRpcError } from '../dist/src/rpc-diagnostics.js';
import { SessionSubscriptions,waitForNativePersistence } from '../dist/src/subscriptions.js';

const bin=resolve(process.argv[2]??'');
assert.equal(createHash('sha256').update(readFileSync(bin)).digest('hex'),'63279cf1860a285495fa0bad3c40f5eb38c3487f7425adb603bcbd49175fcaf8');
const version=spawnSync(bin,['--version'],{env:{PATH:process.env.PATH},encoding:'utf8',timeout:3000}).stdout.trim();
assert.equal(version,'codex-cli 0.171.0-alpha.13');
const dir=mkdtempSync(join(tmpdir(),'codex-blank-r11-')),home=join(dir,'codex');mkdirSync(home,{mode:0o700});
const child=spawn(bin,['app-server','--listen','stdio://'],{cwd:dir,env:{
  PATH:process.env.PATH,HOME:dir,CODEX_HOME:home,TMPDIR:dir,XDG_CONFIG_HOME:dir,XDG_CACHE_HOME:dir,XDG_DATA_HOME:dir,OPENAI_BASE_URL:'http://127.0.0.1:1/v1'
},stdio:['pipe','pipe','ignore']});
const lines=createInterface({input:child.stdout});
const pending=new Map();let counter=0;
const codes=[];
const calls=[];
const allowed=new Set(['initialize','thread/start','thread/read','thread/loaded/list','thread/resume','thread/turns/list']);
lines.on('line',line=>{
  let m;try{m=JSON.parse(line);}catch{return;}
  const p=pending.get(m.id);
  if(!p||m.method)return;
  pending.delete(m.id);clearTimeout(p.timer);
  if(m.error){
    const diagnostic=classifyRpcError(p.method,m.error.code,m.error.message,undefined,p.params.threadId);
    codes.push(diagnostic);
    p.reject(new BackendError('RPC_REJECTED',undefined,diagnostic));
  }else p.resolve(m.result);
});
const raw=(method,params)=>{
  assert.ok(allowed.has(method),'The QA harness must never initiate work');
  calls.push(method);
  const id=++counter;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(Error('Timed out waiting for approved metadata RPC'));},4000);
    pending.set(id,{resolve,reject,method,params,timer});
    child.stdin.write(JSON.stringify({id,method,params})+'\n');
  });
};
class NativeFixture extends EventEmitter {
  epoch=randomUUID();
  connected=true;
  rpc(method,params){return raw(method,params);}
}
try {
  const hello=await raw('initialize',{clientInfo:{name:'codex_connector',version:'0.2.0'},capabilities:{experimentalApi:true}});
  assert.equal(hello.codexHome,home);
  child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
  const {thread}=await raw('thread/start',{cwd:dir,ephemeral:false});
  assert.deepEqual(thread.turns,[]);
  assert.equal(thread.sessionId,thread.id);assert.equal(thread.parentThreadId,null);
  const backend=new NativeFixture();
  let state={version:2,outbox:[],sessions:[],work:[],pending:[],seenEvents:{},seenNotifications:{}};
  const store={get state(){return structuredClone(state);},transaction(change){const next=structuredClone(state),result=change(next);state=next;return result;}};
  const s=new SessionSubscriptions(store,backend,{
    validate(t){assert.equal(t.id,thread.id);assert.equal(t.sessionId,thread.id);assert.equal(t.parentThreadId,null);assert.equal(t.cwd,dir);return {cwd:dir,project:'fixture'};},
    policy:()=> 'fixture',allow:()=>true,output(){throw Error('No Slack output in this harness');},
  });
  const row=await s.adoptCreated(thread,{kind:'human',userId:'U1',channel:'C1',threadTs:'100.1',ts:'100.2',eventId:'fixture'},backend.epoch,(d,sub)=>{
    d.nativeShareCreations=[{id:'creation',status:'proven',resultThreadId:thread.id,resultSubscriptionId:sub.id,resultCreatedAt:thread.createdAt}];
    d.nativeShares=[{state:'pending',creationId:'creation',nativeThreadId:thread.id,subscriptionId:sub.id,nativeCreatedAt:thread.createdAt}];
  });
  assert.equal(row.enabled,true);assert.equal(row.status,'active');assert.equal(row.error,waitForNativePersistence);
  assert.equal(s.deliveryAllowed(row.id),true);
  assert.ok(codes.some(d=>d.rpcCode===-32600&&d.classification==='THREAD_HISTORY_NOT_PERSISTED'));
  const firstCount=calls.length;await s.retryFreshObservations();assert.equal(calls.length,firstCount,'live blank listener does not poll warm resume');
  backend.epoch=randomUUID();
  await s.rejoin();
  assert.equal(s.deliveryAllowed(row.id),false,'second logical Connector epoch must not inherit the old listener');
  assert.equal(store.state.subscriptions[0].enabled,true);
  assert.equal(store.state.subscriptions[0].status,'joining');
  assert.equal(store.state.subscriptions[0].error,waitForNativePersistence);
  assert.equal(calls.filter(m=>m==='thread/start').length,1);
  console.log(JSON.stringify({version,temporaryHomeVerified:true,blankNewRootVerified:true,rawNoRolloutVerified:true,
    originListenerPreserved:true,logicalEpochKeepsGrantPaused:true,modelTurnsSubmitted:0,externalSlackCalls:0}));
} finally {
  lines.close();
  if(child.exitCode===null&&child.signalCode===null){
    const exited=once(child,'exit');child.kill('SIGTERM');
    const hard=setTimeout(()=>child.kill('SIGKILL'),2000);
    try{await exited;}finally{clearTimeout(hard);}
  }
  rmSync(dir,{recursive:true,force:true});
}
