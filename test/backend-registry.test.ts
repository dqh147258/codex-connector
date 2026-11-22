import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseConfig } from '../src/config.js';
import { configuredServers, defaultServer, listServers, resolveServerId, targetFingerprint } from '../src/servers.js';
import { proxyEnvironment, SharedAppServer, verifyHandshakeHome } from '../src/codex.js';
import type { Backend } from '../src/types.js';

const fixture=resolve('test/fixtures/app-server.cjs');
function setup(){
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'registry-test-')));
  const project=join(dir,'project'),p={executable:fixture};mkdirSync(project);
  const raw={version:2,instanceId:'test',port:17381,approvalTimeoutSec:30,projects:{repo:project},backend:p,local:{enabled:true}};
  return {dir,raw,p,close:()=>rmSync(dir,{recursive:true,force:true})};
}
test('legacy and extra profiles keep the official inherited default; aliased selection is exact, canonical and round-trips',()=>{
  const f=setup();try{
    const legacy=parseConfig(f.raw);assert.equal(defaultServer(legacy),'default');assert.equal(legacy.backend.socketPath,undefined);assert.equal(legacy.backend.codexHome,undefined);assert.equal(legacy.backend.autoStartDaemon,undefined);
    assert.deepEqual(legacy.slack,{enabled:false,teamId:'',inputChannel:'',outputChannel:'',allowedHumans:[],approvalUsers:[],trustedBots:[],dot:{name:''},servers:[]});
    const profiles={west:{...f.p,codexHome:join(f.dir,'home-west'),socketPath:join(f.dir,'west.sock'),aliases:['w']}};
    const c=parseConfig({...f.raw,backends:profiles});
    for(const config of [c,parseConfig(JSON.parse(JSON.stringify(c))),parseConfig(c)]){
      assert.deepEqual([...configuredServers(config).keys()].sort(),['default','west']);
      assert.equal(resolveServerId(config),'default');assert.equal(resolveServerId(config,'w'),'west');
      assert.throws(()=>resolveServerId(config,'other'),/SERVER_UNAVAILABLE/);assert.throws(()=>resolveServerId(config,'DEFAULT'),/SERVER_UNAVAILABLE/);
    }
    assert.equal(resolveServerId(parseConfig({...f.raw,backends:profiles,defaultServerId:'west'})),'west');
    const {backend,...raw}=f.raw;
    assert.equal(resolveServerId(parseConfig({...raw,backends:profiles})),'west');
    const ambiguous=parseConfig({...raw,backends:{...profiles,east:{...f.p,codexHome:join(f.dir,'home-east'),socketPath:join(f.dir,'east.sock')}}});
    assert.equal(defaultServer(ambiguous),undefined);assert.throws(()=>resolveServerId(ambiguous),/SERVER_SELECTION_REQUIRED/);
    assert.throws(()=>parseConfig({...f.raw,backends:profiles,defaultServerId:'w'}));
    assert.throws(()=>parseConfig({...f.raw,slack:{enabled:false},local:{enabled:false}}));
  }finally{f.close();}
});
test('duplicate sockets, home aliases and conflicting identity grants are rejected; hash pins include the inherited home',()=>{
  const f=setup(),before=process.env.CODEX_HOME;try{
    const home=join(f.dir,'home'),other=join(f.dir,'other'),alias=join(f.dir,'alias');mkdirSync(home);mkdirSync(other);symlinkSync(home,alias,process.platform==='win32'?'junction':'dir');
    process.env.CODEX_HOME=home;
    const fingerprint=targetFingerprint(f.p);assert.notEqual(targetFingerprint({...f.p,executable:join(f.dir,'another-cli')}),fingerprint);process.env.CODEX_HOME=alias;assert.equal(targetFingerprint(f.p),fingerprint);
    assert.equal(targetFingerprint({...f.p,codexHome:home,aliases:['new-name']}),fingerprint);
    process.env.CODEX_HOME=other;assert.notEqual(targetFingerprint(f.p),fingerprint);
    const sock=join(home,'missing.sock');
    assert.throws(()=>parseConfig({...f.raw,backends:{a:{...f.p,socketPath:sock}}}),/require codexHome/);
    assert.equal(defaultServer(parseConfig({...f.raw,backend:{...f.p,socketPath:sock}})),'default');
    assert.throws(()=>parseConfig({...f.raw,backends:{a:{...f.p,codexHome:other,socketPath:sock}}}),/Duplicate backend target/);
    assert.throws(()=>parseConfig({...f.raw,backends:{a:{...f.p,codexHome:home,socketPath:sock},b:{...f.p,codexHome:join(f.dir,'different-home'),socketPath:join(alias,'missing.sock')}}}),/Duplicate backend target/);

    for(const backends of [
      {a:{...f.p,codexHome:other}},
      {a:{...f.p,codexHome:home},b:{...f.p,codexHome:alias,socketPath:sock}},
      {a:{...f.p,socketPath:sock},b:{...f.p,codexHome:home,socketPath:join(alias,'missing.sock')}},
      {a:{...f.p,codexHome:home,socketPath:sock,aliases:['default']}},
      {default:{...f.p,socketPath:sock}},
      {constructor:{...f.p,socketPath:sock}},
      {a:{...f.p,codexHome:'relative'}},
      {a:{...f.p,socketPath:sock,autoStartDaemon:true}},
    ])assert.throws(()=>parseConfig({...f.raw,backends}));
    const hash=createHash('sha256').update('local-agent').digest('hex');
    const a={id:'robot',tokenHash:hash,servers:['default'],projects:['repo'],commands:['session.events','server.list']};
    assert.deepEqual(parseConfig({...f.raw,local:{enabled:true,agents:[a]}}).local?.agents,[a]);
    for(const agents of [[a,a],[a,{...a,id:'x'}],[{...a,tokenHash:'secret'}],[{...a,servers:['missing']}],[{...a,projects:['other']}],[{...a,commands:['recover']}],[{...a,commands:['approval.respond']}],[{...a,commands:['input.respond'] }],[{...a,token:'plaintext'}]])
      assert.throws(()=>parseConfig({...f.raw,local:{enabled:true,agents}}));
  }finally{if(before===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=before;f.close();}
});
test('server.list projects only granted IDs and inert cached metadata, including unknown/online/offline',()=>{
  const f=setup();try{
    const config=parseConfig({...f.raw,backends:{other:{...f.p,codexHome:join(f.dir,'other-home'),socketPath:join(f.dir,'private.sock'),aliases:['alias']}}});
    const stub=(connected:boolean)=>({connected,observation:{checkedAt:'2026-01-01T00:00:00.000Z',version:'1.2.3'},connect(){throw Error('must not connect');},rpc(){throw Error('must not rpc');},capabilities(){throw Error('must not probe');}} as unknown as Backend);
    for(const connected of [true,false]){
      const rows=listServers(config,['other'],new Map([['other',stub(connected)]]));
      assert.deepEqual(rows,[{serverId:'other',aliases:['alias'],isDefault:false,connected,status:connected?'online':'offline',checkedAt:'2026-01-01T00:00:00.000Z',version:'1.2.3',versionSource:'cli',homeVerified:false}]);
      assert.ok(!JSON.stringify(rows).includes(f.dir));
    }
    assert.deepEqual(listServers(config,['default'],new Map()),[{serverId:'default',aliases:[],isDefault:true,status:'unknown',connected:false,checkedAt:null,version:null,versionSource:'cli',homeVerified:false}]);
    assert.deepEqual(listServers(config,[],new Map()),[]);
  }finally{f.close();}
});
test('home pinned proxies isolate child env and pass verified initialize before any notification; mismatch yields no session traffic', async()=>{
  const f=setup(),a=join(f.dir,'a'),b=join(f.dir,'b');mkdirSync(a);mkdirSync(b);
  const saved={...process.env};
  const restore=['CONNECTOR_FIXTURE_LOG','CONNECTOR_FIXTURE_REPORT_HOME','CONNECTOR_FIXTURE_EARLY_EVENT','LOCAL_AGENT_BEARER_TOKEN','CONNECTOR_AGENT_TOKEN'];
  const log=join(f.dir,'wire');process.env.CONNECTOR_FIXTURE_LOG=log;process.env.LOCAL_AGENT_BEARER_TOKEN='sentinel';process.env.CONNECTOR_AGENT_TOKEN='sentinel';process.env.CONNECTOR_FIXTURE_EARLY_EVENT='1';
  const good=new SharedAppServer({...f.p,codexHome:a}),bad=new SharedAppServer({...f.p,codexHome:b});let emitted=0;
  for(const server of [good,bad])server.on('notification',()=>emitted++);
  try{
    const env=proxyEnvironment({...f.p,codexHome:b},{CODEX_HOME:a,SLACK_BOT_TOKEN:'no',MCP_BEARER_TOKEN:'no',OPENAI_API_KEY:'existing-provider',PATH:'p'});
    assert.deepEqual(env,{CODEX_HOME:b,OPENAI_API_KEY:'existing-provider',PATH:'p'});
    const parent=process.env.CODEX_HOME;
    await good.connect();assert.equal(good.connected,true);assert.equal(good.capabilities().homeVerified,true);assert.equal(good.capabilities().lastFailureStage,null);assert.equal(process.env.CODEX_HOME,parent);
    process.env.CONNECTOR_FIXTURE_REPORT_HOME=a;await assert.rejects(bad.connect(),/BACKEND_HOME_MISMATCH/);
    assert.equal(bad.connected,false);assert.equal(bad.capabilities().lastFailure,'BACKEND_HOME_MISMATCH');assert.equal(bad.capabilities().lastFailureStage,'home-verification');assert.equal(emitted,0);
    const lines=readFileSync(log,'utf8').trim().split('\n').map(x=>JSON.parse(x));
    assert.deepEqual(lines.filter(x=>x.kind==='launch').map(x=>[x.home,x.args,x.credentialPresent]),[[a,['--version'],false],[a,['app-server','proxy'],false],[b,['--version'],false],[b,['app-server','proxy'],false]]);
    assert.equal(lines.filter(x=>x.value?.method==='initialized').length,1);
    assert.ok(!lines.some(x=>x.value?.method?.startsWith('thread/')));
    assert.throws(()=>verifyHandshakeHome(b,{}),/BACKEND_HOME_UNVERIFIED/);
  }finally{await good.close();await bad.close();for(const k of restore)if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];f.close();}
});
