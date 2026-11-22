import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync,fork } from 'node:child_process';
import { createHash,randomBytes } from 'node:crypto';
import { EventEmitter,once } from 'node:events';
import { createServer } from 'node:net';
import { existsSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { commandRequest } from '../src/client.js';
import { SlackLink } from '../src/slack-link.js';
const fixture=resolve('test/fixtures/app-server.cjs'),cli=resolve('dist/src/cli.js');
const slack={teamId:'TTEAM',inputChannel:'CIN',outputChannel:'COUT',allowedHumans:['UONE'],approvalUsers:['UONE'],trustedBots:[],dot:{name:'dot',userId:'UDOT'}};
const delay=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
async function freePort(){const srv=createServer();srv.listen(0,'127.0.0.1');await once(srv,'listening');const addr=srv.address();assert.ok(addr&&typeof addr!=='string');await new Promise<void>(r=>srv.close(()=>r()));return addr.port;}
async function boot(mode:'local'|'dual'|'slack'|'collision'|'slack-verified'|'dual-wrong-team'){
  const dir=mkdtempSync(join(tmpdir(),'dual-entry-')),log=join(dir,'wire'),port=await freePort(),project=join(dir,'repo'),namedHome=join(dir,'named-home');
  mkdirSync(project);mkdirSync(namedHome);
  const local=!mode.startsWith('slack'), stub=mode==='slack-verified'||mode==='dual-wrong-team';
  const token=randomBytes(32).toString('hex');
  const config={version:2,instanceId:'test',port,approvalTimeoutSec:30,projects:{repo:project},backend:{executable:fixture},
    backends:{named:{executable:fixture,codexHome:namedHome,aliases:['n']}},
    local:{enabled:local,agents:mode==='collision'?[{id:'client',tokenHash:createHash('sha256').update(token).digest('hex'),commands:[],projects:[],servers:[]}]:[]},
    slack:mode==='local'?undefined:slack};
  writeFileSync(join(dir,'config.json'),JSON.stringify(config));if(local)writeFileSync(join(dir,'api.token'),token);
  const env:NodeJS.ProcessEnv={...process.env,CONNECTOR_FIXTURE_LOG:log,CONNECTOR_DESKTOP_CHILD:'1'};
  delete env.CONNECTOR_TOKEN;delete env.SLACK_APP_TOKEN;delete env.SLACK_BOT_TOKEN;delete env.CONNECTOR_FIXTURE_REPORT_HOME;
  const slackLog=join(dir,'slack-log');
  if(stub)Object.assign(env,{SLACK_APP_TOKEN:'xapp-dummy-for-fixture',SLACK_BOT_TOKEN:'xoxb-dummy-for-fixture',CONNECTOR_FIXTURE_SLACK_LOG:slackLog,CONNECTOR_FIXTURE_SLACK_TEAM:mode==='dual-wrong-team'?'TOTHER':'TTEAM'});
  const child=fork(cli,['start','--home',dir],{env,silent:true,execArgv:stub?['--require',resolve('test/fixtures/local-slack-sdk.cjs')]:[]});
  const errors:string[]=[];child.stderr!.on('data',d=>errors.push(String(d)));child.stdout!.resume();
  const done=once(child,'exit');
  let timed:NodeJS.Timeout|undefined;
  const observed=await Promise.race([
    once(child,'message').then(([x])=>x as {type:string;code?:string}),
    done.then(()=>({type:'exit',code:undefined})),
    new Promise<never>((_,reject)=>{timed=setTimeout(()=>{child.kill();reject(Error('test daemon did not answer'));},10000);})
  ]).finally(()=>clearTimeout(timed));
  const close=async()=>{try{if(child.connected)child.send({type:'connector:stop'});await done;}finally{rmSync(dir,{recursive:true,force:true});}};
  return {observed,child,done,close,errors,log,slackLog,dir,port,token};
}
test('real local-only and dual/degraded processes serve loopback with no Slack secrets; two official proxy fixtures remain independent',async()=>{
  for(const mode of ['local','dual'] as const){
    const f=await boot(mode);
    try{
      assert.equal(f.observed.type,'connector:ready',f.errors.join(''));
      const get=async()=>((await commandRequest(f.port,f.token,{action:'servers'})) as {result:any[]}).result;
      let rows=await get();for(let i=0;i<150&&rows.some(x=>!x.connected);i++){await delay(20);rows=await get();}
      assert.deepEqual(rows.map(x=>[x.serverId,x.status]).sort(),[['default','online'],['named','online']]);
      const raw=JSON.stringify(rows);assert.ok(!raw.includes(f.dir));assert.ok(!raw.includes(f.token));
      const wire=readFileSync(f.log,'utf8');assert.ok(!wire.includes('daemon","start'));assert.ok(!wire.includes('"credentialPresent":true'));
      for(const r of rows){assert.ok(r.checkedAt);assert.equal(r.versionSource,'cli');assert.equal(r.homeVerified,r.serverId==='named');}
      assert.equal((await commandRequest(f.port,f.token,{action:'status'}) as any).result.slackConnected,false);
    }finally{await f.close();}
  }
});
test('Slack-only requires Slack credentials but does not read a local token, authorize local requests or start a backend; duplicate auth also fails closed',async()=>{
  for(const mode of ['slack','collision'] as const){
    const f=await boot(mode);
    try{
      assert.equal(f.observed.type,'connector:failure');if(mode==='slack')assert.equal(f.observed.code,'SLACK_AUTH_FAILED');
      assert.equal((await f.done)[0],1);assert.equal(existsSync(f.log),false);
      assert.equal(existsSync(join(f.dir,'runtime.lock')),false);assert.ok(!f.errors.join('').includes(f.token));
    }finally{await f.close();}
  }
});
test('actual Slack-only boot with fixture transport has no API listener; dual rejects wrong workspace but still serves local',async()=>{
  for(const mode of ['slack-verified','dual-wrong-team'] as const){
    const f=await boot(mode);
    try{
      assert.equal(f.observed.type,'connector:ready',f.errors.join(''));
      for(let i=0;i<100&&!existsSync(f.slackLog);i++)await delay(20);
      const wire=readFileSync(f.slackLog,'utf8').trim().split('\n').map(x=>JSON.parse(x));
      if(mode==='slack-verified'){
        assert.deepEqual(wire,['auth.test','socket.start','users.info']);
        assert.equal(existsSync(join(f.dir,'api.token')),false);
        await assert.rejects(commandRequest(f.port,f.token,{action:'servers'}),/Cannot reach/);
        assert.match(execFileSync(process.execPath,[cli,'doctor','--home',f.dir],{env:{...process.env,CONNECTOR_TOKEN:''},encoding:'utf8'}),/configuration valid/);
      }else{
        assert.deepEqual(wire,['auth.test']);
        assert.equal((await commandRequest(f.port,f.token,{action:'status'}) as any).result.slackConnected,false);
      }
    }finally{await f.close();}
  }
});
class FakeSocket extends EventEmitter {async start(){return{};}async disconnect(){this.emit('disconnected');}}
test('Slack only accepts events after verified team/socket/Dot, persists before ack, and disables after loss',async()=>{
  const log:string[]=[],socket=new FakeSocket();let fail=false;const runtime={accept(){log.push('persist');if(fail)throw Error('store failure');return true;},async enableSlack(u:string,b:string){log.push(u+':'+b);},disableSlack(){log.push('disabled');}};
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  const link=new SlackLink('TTEAM',runtime,async()=>{await gate;return{team_id:'TTEAM',user_id:'USELF',bot_id:'BSELF'};},()=>socket);
  const connecting=link.connect();const event=()=>socket.emit('message',{body:{},ack:async()=>{log.push('ack');}});
  event();assert.deepEqual(log,[]);release();await connecting;
  event();assert.deepEqual(log,['USELF:BSELF','persist','ack']);fail=true;event();assert.equal(log.at(-1),'persist');
  socket.emit('disconnected');event();assert.equal(log.at(-1),'disabled');await link.close();
  let attempts=0,launched=0;const wrong=new SlackLink('TTEAM',runtime,async()=>{attempts++;return{team_id:'TOTHER',bot_id:'BSELF',user_id:'USELF'};},()=>{launched++;return socket;});
  await assert.rejects(wrong.connect(),/WORKSPACE_MISMATCH/);await wrong.connect();assert.equal(attempts,1);assert.equal(launched,0);await wrong.close();
});
