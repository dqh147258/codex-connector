import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fork} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {DesktopRuntime,desktopChildEnvironment,probeCodex} from '../desktop/runtime.js';
import {fixture} from './helpers.js';
class FakeChild extends EventEmitter{stdout=new EventEmitter();stderr=new EventEmitter();connected=true;messages:any[]=[];send(m:any,cb?:()=>void){this.messages.push(m);cb?.();}kill(){throw Error('must never kill');}}
test('desktop child uses bundled executable and fixed IPC entry, never shell or inherited Node injection',async()=>{const f=fixture(),child=new FakeChild();let options:any,args:any;const runtime=new DesktopRuntime(f.dir,'/bundle/app.asar/dist/src/cli.js','/Applications/Codex Connector.app/Contents/MacOS/Codex Connector',((_exe:any,a:any,o:any)=>{args=a;options=o;return child;}) as any,100);
try{f.store.close();runtime.start(f.config,{appToken:'testapp',botToken:'testbot'});assert.deepEqual(args,['/bundle/app.asar/dist/src/cli.js','start','--home',f.dir]);assert.equal(options.env.ELECTRON_RUN_AS_NODE,'1');assert.equal(options.shell,false);assert.ok(options.stdio.includes('ipc'));assert.throws(()=>runtime.start(f.config,{appToken:'a',botToken:'b'}),/ALREADY_RUNNING/);child.emit('message',{type:'connector:ready'});assert.equal(runtime.snapshot().state,'running');const a=runtime.stop(),b=runtime.stop();assert.equal(a,b);assert.deepEqual(child.messages,[{type:'connector:stop'}]);child.emit('close',0);assert.equal((await a).owned,false);}finally{await f.cleanup();}});
test('desktop environment strips injection secrets and keeps explicit per-child runtime credentials',()=>{const e=desktopChildEnvironment('/private/home',{appToken:'A',botToken:'B'},{NODE_OPTIONS:'--require bad',NODE_PATH:'/bad',ELECTRON_NO_ASAR:'1',CONNECTOR_TOKEN:'localSecret',SLACK_BOT_TOKEN:'old',Slack_App_Token:'old-alternate-case',LOCAL_AGENT_BEARER_TOKEN:'old-agent',PATH:'/normal'});assert.equal(e.NODE_OPTIONS,undefined);assert.equal(e.NODE_PATH,undefined);assert.equal(e.CONNECTOR_TOKEN,undefined);assert.equal(e.SLACK_BOT_TOKEN,'B');assert.equal(e.Slack_App_Token,undefined);assert.equal(e.LOCAL_AGENT_BEARER_TOKEN,undefined);assert.equal(e.PATH,'/normal');});
test('unconfirmed stop retains process ownership and never force kills or removes a lock',async()=>{const f=fixture(),child=new FakeChild();const runtime=new DesktopRuntime(f.dir,'/fixed/cli','/fixed/runtime',(()=>child)as any,10);try{f.store.close();runtime.start(f.config,{appToken:'A',botToken:'B'});await assert.rejects(runtime.stop(),/STOP_UNCONFIRMED/);assert.equal(runtime.snapshot().owned,true);child.emit('close',0);}finally{await f.cleanup();}});
test('desktop refuses preexisting lock and unexpected child exit is visible without raw output',async()=>{const f=fixture(),child=new FakeChild();const runtime=new DesktopRuntime(f.dir,'/fixed/cli','/fixed/runtime',(()=>child)as any);try{writeFileSync(join(f.dir,'daemon.lock'),'42');assert.throws(()=>runtime.start(f.config,{appToken:'A',botToken:'B'}),/LOCK_EXISTS/);}finally{await f.cleanup();}});
test('Codex diagnostic has fixed version/help argv and no startup/session operation',async()=>{const seen:any[]=[];const r=await probeCodex('/configured/codex.js',(async(file:any,args:any,options:any)=>{seen.push({file,args,options});return{stdout:args.at(-1)==='--version'?'codex-cli 1.2.3-beta.4':'Usage',stderr:''};})as any);assert.equal(r.version,'1.2.3-beta.4');assert.equal(r.proxySupported,true);assert.equal(seen[0].file,process.execPath);assert.deepEqual(seen.map(x=>x.args.slice(1)),[['--version'],['app-server','proxy','--help'],['app-server','daemon','start','--help']]);assert.ok(seen.every(x=>x.options.env.ELECTRON_RUN_AS_NODE==='1'&&!x.options.env.SLACK_BOT_TOKEN));});
test('CLI desktop startup configuration failure disconnects IPC and exits instead of hanging',async()=>{const home=mkdtempSync(join(tmpdir(),'desktop-cli-fail-'));try{const child=fork(resolve('dist/src/cli.js'),['start','--home',home],{env:{...process.env,CONNECTOR_DESKTOP_CHILD:'1'},silent:true});const result=await Promise.race([once(child,'exit'),new Promise((_,reject)=>setTimeout(()=>{child.kill();reject(Error('child stayed alive after startup failure'));},3000).unref())]);assert.equal((result as any[])[0],1);}finally{rmSync(home,{recursive:true,force:true});}});

test('desktop shows only allowlisted startup failure codes and retains them after exit',async()=>{const f=fixture(),child=new FakeChild();const runtime=new DesktopRuntime(f.dir,'/fixed/cli','/fixed/runtime',(()=>child)as any);try{f.store.close();runtime.start(f.config,{appToken:'A',botToken:'B'});child.emit('message',{type:'connector:failure',code:'raw-secret-value'});assert.equal(runtime.snapshot().lastError,undefined);child.emit('message',{type:'connector:failure',code:'LOCAL_PORT_IN_USE'});child.emit('close',1);assert.equal(runtime.snapshot().lastError,'LOCAL_PORT_IN_USE');assert.equal(runtime.snapshot().owned,false);}finally{await f.cleanup();}});

test('synchronous spawn failure leaves a retryable failed state without raw secret diagnostics',async()=>{const f=fixture();let attempts=0;const child=new FakeChild();const runtime=new DesktopRuntime(f.dir,'/fixed/cli','/fixed/runtime',(()=>{if(attempts++===0)throw Error('xoxb-private-secret');return child;})as any);try{f.store.close();assert.throws(()=>runtime.start(f.config,{appToken:'A',botToken:'B'}),/^Error: SERVER_START_FAILED$/);assert.equal(runtime.snapshot().state,'failed');assert.equal(runtime.snapshot().owned,false);assert.equal(runtime.snapshot().lastError,'SERVER_START_FAILED');runtime.start(f.config,{appToken:'A',botToken:'B'});assert.equal(runtime.snapshot().state,'starting');child.emit('close',0);}finally{await f.cleanup();}});

test('local-only runtime launches without inheriting Slack credentials; Slack-only never polls the local API',async()=>{
  const f=fixture(),child=new FakeChild();let env:any;
  const r=new DesktopRuntime(f.dir,'/fixed/cli','/fixed/runtime',((_:any,__:any,opts:any)=>{env=opts.env;return child;}) as any);
  try{
    f.store.close();r.start({...f.config,slack:{...f.config.slack,enabled:false}},{appToken:'TEST_APP',botToken:'TEST_BOT'});
    assert.equal(Object.hasOwn(env,'SLACK_APP_TOKEN'),false);assert.equal(Object.hasOwn(env,'SLACK_BOT_TOKEN'),false);child.emit('close',0);
    r.start({...f.config,local:{enabled:false}},{appToken:'TEST_APP',botToken:'TEST_BOT'});
    child.emit('message',{type:'connector:ready'});
    assert.equal((await r.refresh()).lastError,undefined);
    await assert.rejects(r.listSessions({}),/LOCAL_DISABLED/);
    child.emit('close',0);
  }finally{await f.cleanup();}
});

test('Desktop runtime projects all validated known Homes past the former 32-row cap',async()=>{
  const f=fixture(),child=new FakeChild(),token='S'.repeat(44);
  const valid=Array.from({length:42},(_,i)=>({serverId:'home-'+i,connected:i%2===0,extra:'PRIVATE_HOME'}));
  const http=createServer((req,res)=>{
    assert.equal(req.headers.authorization,'Bearer '+token);assert.equal(req.url,'/v1/command');
    req.resume();res.end(JSON.stringify({ok:true,result:{servers:[...valid,{serverId:'/invalid-private-path',connected:true},{serverId:'wrong-boolean',connected:'true'}]}}));
  });
  http.listen(0,'127.0.0.1');await once(http,'listening');
  const r=new DesktopRuntime(f.dir,'/fixed/cli','/fixed/runtime',(()=>child)as any);
  try{
    const address=http.address();assert.ok(address&&typeof address==='object');
    f.store.close();writeFileSync(join(f.dir,'api.token'),token);
    r.start({...f.config,port:address.port,local:{enabled:true}});child.emit('message',{type:'connector:ready'});
    const status=await r.refresh();
    assert.equal(status.servers?.length,42);assert.deepEqual(status.servers?.at(-1),{serverId:'home-41',connected:false});
    assert.doesNotMatch(JSON.stringify(status),/PRIVATE_HOME|invalid-private-path/);
    child.emit('close',0);
  }finally{await new Promise<void>(done=>http.close(()=>done()));await f.cleanup();}
});
