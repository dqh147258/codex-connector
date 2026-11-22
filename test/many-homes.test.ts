import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseConfig } from '../src/config.js';
import { BackendError, isBackendResourceExhaustion } from '../src/codex.js';
import { Runtime } from '../src/runtime.js';
import { configuredServers, listServers } from '../src/servers.js';
import { OPERATOR, type SlackPort } from '../src/types.js';
import { FakeBackend, request, waitFor } from './helpers.js';

const fixtureExecutable=resolve('test/fixtures/app-server.cjs');
const delay=(n:number)=>new Promise<void>(r=>setTimeout(r,n));
function deferred(){let release!:()=>void;const ready=new Promise<void>(r=>release=r);return{release,ready};}
function setup(count:number,executable=process.execPath){
  const dir=realpathSync.native(mkdtempSync(join(tmpdir(),'connector-many-homes-')));
  const root=join(dir,'project'),state=join(dir,'connector-state'),homeDir=join(dir,'homes');
  mkdirSync(root);mkdirSync(homeDir);
  const ids=Array.from({length:count},(_,i)=>'home-'+String(i+1).padStart(3,'0')),homes=new Map(ids.map(id=>[id,join(homeDir,id)]));
  const backends=Object.fromEntries(ids.map(id=>[id,{executable,codexHome:homes.get(id)!}]));
  const raw={version:2,instanceId:'test',port:18541,approvalTimeoutSec:30,projects:{demo:root},defaultServerId:ids[0],
    local:{enabled:true},slack:{enabled:false},backends};
  const never=async()=>{throw Error('synthetic local test never calls Slack');};
  const slack:SlackPort={post:never,resolveDot:never,humanMessage:never,threadExists:never};
  return{dir,root,state,homes,ids,raw,slack,cleanup:()=>rmSync(dir,{recursive:true,force:true})};
}
const terminal=new Set(['completed','failed','uncertain']);
async function command(runtime:Runtime,serverId:string,name:string,params:Record<string,unknown>,requestId?:string){
  const p=request(name,{...params,serverId},requestId),accepted=runtime.local(p);
  const result=()=>runtime.receipt({serverId,workId:accepted.id},OPERATOR);
  await waitFor(()=>terminal.has(result().status));return result();
}

test('registry has no fixed 32 or 128 Home cap; grants and cached list keep exact authorized IDs',()=>{
  const f=setup(137);try{
    const scoped=f.ids.filter((_,i)=>i%2===0);
    const hash=createHash('sha256').update('synthetic agent').digest('hex');
    const c=parseConfig({...f.raw,slack:{...f.raw.slack},local:{enabled:true,agents:[{id:'reader',tokenHash:hash,projects:['demo'],commands:['server.list'],servers:f.ids}]}});
    assert.equal(configuredServers(c).size,137);
    assert.equal(c.local?.agents?.[0]?.servers.length,137);
    const slackCfg=parseConfig({...f.raw,slack:{servers:f.ids,teamId:'TONE',inputChannel:'CIN',outputChannel:'COUT',
      allowedHumans:['UHUMAN'],approvalUsers:['UHUMAN'],trustedBots:[],dot:{name:'synthetic'}}});
    assert.equal(slackCfg.slack.servers?.length,137);
    const rows=listServers(c,scoped,new Map());assert.deepEqual(rows.map(x=>x.serverId),scoped);
    assert.ok(rows.every(x=>x.status==='unknown'&&x.checkedAt===null&&!x.connected));
    assert.ok(!JSON.stringify(rows).includes(f.dir));
    assert.throws(()=>parseConfig({...f.raw,backends:{}}),/at least one backend profile/);
  }finally{f.cleanup();}
});

test('41 profiles initialize with a bounded launch pool; maintenance is not blocked and shutdown cancels queued launches',async()=>{
  const f=setup(41);let runtime:Runtime|undefined;const gate=deferred();
  let active=0,peak=0,starts=0;
  class Gated extends FakeBackend{
    async connect(){if(this.connected)return;starts++;peak=Math.max(peak,++active);try{await gate.ready;this.connected=true;}finally{active--;}}
  }
  try{
    runtime=new Runtime(parseConfig(f.raw),f.state,f.slack,undefined,()=>new Gated());
    assert.equal(runtime.servers().length,41);assert.equal(starts,0);
    const first=runtime.connectLocal();
    await waitFor(()=>active===4);
    // Pending startup work is deduplicated across explicit startup and ticks.
    await runtime.tick();await runtime.tick();assert.equal(starts,4);
    gate.release();await first;
    assert.equal(starts,41);assert.equal(peak,4);assert.ok(runtime.servers().every(x=>x.connected));
    await runtime.close();
    const finish=deferred();starts=0;peak=0;
    class Cancellable extends FakeBackend{
      async connect(){if(this.connected)return;starts++;await finish.ready;this.connected=true;}
    }
    runtime=new Runtime(parseConfig(f.raw),f.state,f.slack,undefined,()=>new Cancellable());
    const waiting=runtime.connectLocal();await waitFor(()=>starts===4);
    runtime.stopConnecting();finish.release();await waiting;
    assert.equal(starts,4);assert.equal(runtime.servers().filter(x=>x.connected).length,4);
    await runtime.tick();assert.equal(starts,4);
  }finally{gate.release();await runtime?.close();f.cleanup();}
});

test('three ledger namespaces isolate same native IDs, cursor, command key, and one Home outage/reconnect',async()=>{
  const f=setup(3),[a,b,c]=f.ids as [string,string,string];
  let runtime:Runtime|undefined;const gate=deferred();
  const native=new Map<string,FakeBackend>();
  let failB=true;
  class Independent extends FakeBackend{
    constructor(readonly server:string){super();this.threads.set('same-native-thread',{id:'same-native-thread',cwd:f.root,status:{type:'idle'},canAcceptDirectInput:true});}
    async connect(){
      if(this.connected)return;
      if(this.server===b&&failB){await gate.ready;throw new BackendError('SHARED_DAEMON_UNAVAILABLE');}
      if(this.server===b)this.epoch='reconnected-b';
      this.connected=true;
    }
    async rpc(method:string,params:any){
      if(method==='thread/items/list'){
        this.calls.push({method,params});
        return{data:[{turnId:'same-native-turn',item:{id:'same-native-item',type:'agentMessage',text:'note from '+this.server}}],nextCursor:params.cursor?null:'same-native-cursor'};
      }
      return super.rpc(method,params);
    }
  }
  try{
    runtime=new Runtime(parseConfig(f.raw),f.state,f.slack,undefined,(_,id)=>{const backend=new Independent(id);native.set(id,backend);return backend;});
    const connecting=runtime.connectLocal();
    await waitFor(()=>native.get(a)!.connected&&native.get(c)!.connected);
    assert.equal(native.get(b)!.connected,false);
    const attach=(id:string)=>command(runtime!,id,'session.attach',{threadId:'same-native-thread',project:'demo'},'same-attach-key');
    const aa=await attach(a),cc=await attach(c);
    assert.equal(aa.status,'completed');assert.equal(cc.status,'completed');assert.notEqual(aa.id,cc.id);
    const aSid=(aa.result as any).sessionId,cSid=(cc.result as any).sessionId;
    assert.notEqual(aSid,cSid);
    assert.throws(()=>runtime!.receipt({serverId:c,workId:aa.id},OPERATOR),/RECEIPT_NOT_FOUND/);
    const history=(id:string,sid:string,cursor?:string)=>command(runtime!,id,'session.history',{sessionId:sid,...(cursor?{cursor}:{})});
    const ap=(await history(a,aSid)).result as any,cp=(await history(c,cSid)).result as any;
    assert.notEqual(ap.nextCursor,cp.nextCursor);
    assert.match(ap.items[0].text,new RegExp(a));assert.match(cp.items[0].text,new RegExp(c));
    assert.equal((await history(c,cSid,ap.nextCursor)).error,'INVALID_CURSOR');
    assert.equal((await history(a,aSid,ap.nextCursor)).status,'completed');
    const streamA=await runtime.events({serverId:a,sessionId:aSid},OPERATOR),streamC=await runtime.events({serverId:c,sessionId:cSid},OPERATOR);
    assert.notEqual(streamA.nextCursor,streamC.nextCursor);
    await assert.rejects(runtime.events({serverId:c,sessionId:cSid,cursor:streamA.nextCursor},OPERATOR),/INVALID_LOCAL_EVENT_CURSOR/);
    await assert.rejects(runtime.events({serverId:b,sessionId:aSid,cursor:streamA.nextCursor},OPERATOR),/SESSION_NOT_FOUND/);
    gate.release();await connecting;assert.equal(native.get(b)!.connected,false);
    failB=false;await runtime.tick();await waitFor(()=>native.get(b)!.connected);
    const bb=await attach(b),bSid=(bb.result as any).sessionId;assert.equal(bb.status,'completed');
    assert.notEqual(bSid,aSid);assert.notEqual(bSid,cSid);assert.equal(native.get(b)!.epoch,'reconnected-b');
    assert.equal((await history(b,bSid,ap.nextCursor)).error,'INVALID_CURSOR');
    assert.equal((await history(c,cSid,cp.nextCursor)).status,'completed');
    assert.ok([a,b,c].every(id=>existsSync(join(f.state,'servers',id,'state.json'))));
  }finally{gate.release();await runtime?.close();f.cleanup();}
});

test('three endpoints: duplicate physical path aliases reject, and a distinct addressed proxy reporting another Home never connects',async()=>{
  const f=setup(3,fixtureExecutable),[a,b,c]=f.ids as [string,string,string];
  const keys=['CONNECTOR_FIXTURE_LOG','CONNECTOR_FIXTURE_SOCKET_HOME','CONNECTOR_FIXTURE_REPORT_HOME','CONNECTOR_FIXTURE_NO_HOME'] as const;
  const saved=new Map(keys.map(k=>[k,process.env[k]]));
  let runtime:Runtime|undefined;
  try{
    for(const p of f.homes.values())mkdirSync(p);
    const alias=join(f.dir,'same-physical-home');symlinkSync(f.homes.get(a)!,alias,process.platform==='win32'?'junction':'dir');
    assert.throws(()=>parseConfig({...f.raw,backends:{...f.raw.backends,[b]:{executable:fixtureExecutable,codexHome:alias}}}),/Duplicate backend target/);
    const socket=join(f.dir,'declared-distinct.sock'),log=join(f.dir,'wire');
    delete process.env.CONNECTOR_FIXTURE_REPORT_HOME;delete process.env.CONNECTOR_FIXTURE_NO_HOME;
    process.env.CONNECTOR_FIXTURE_LOG=log;process.env.CONNECTOR_FIXTURE_SOCKET_HOME=f.homes.get(a)!;
    runtime=new Runtime(parseConfig({...f.raw,backends:{...f.raw.backends,[b]:{...f.raw.backends[b],socketPath:socket}}}),f.state,f.slack);
    await runtime.connectLocal();
    const rows=runtime.servers();assert.deepEqual(rows.map(x=>[x.serverId,x.status,x.homeVerified]),[[a,'online',true],[b,'offline',false],[c,'online',true]]);
    assert.equal(runtime.backends.get(b)!.capabilities().lastFailure,'BACKEND_HOME_MISMATCH');
    await assert.rejects(runtime.backends.get(b)!.rpc('thread/list',{}),/BACKEND_UNAVAILABLE/);
    for(const id of [a,c])await runtime.backends.get(id)!.rpc('thread/list',{});
    await delay(20);
    const native=readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line));
    assert.deepEqual(native.filter(row=>row.kind==='message'&&row.home===f.homes.get(b)).map(row=>row.value.method),['initialize']);
    assert.equal(native.filter(row=>row.kind==='message'&&row.value.method==='thread/list').length,2);
  }finally{
    await runtime?.close();for(const [k,v] of saved)if(v===undefined)delete process.env[k];else process.env[k]=v;
    f.cleanup();
  }
});

test('resource failures have only a fixed classification; malformed or unrecognized errors are not echoed',()=>{
  for(const code of ['EMFILE','ENFILE','ENOMEM','ENOBUFS','EAGAIN','ENOSPC','EDQUOT'])assert.equal(isBackendResourceExhaustion(Object.assign(Error('private path must not appear'),{code})),true);
  for(const x of [null,'ENOMEM',Error('ENOMEM'),{code:'EACCES'},{code:1}])assert.equal(isBackendResourceExhaustion(x),false);
});
