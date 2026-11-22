import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { FileAccessError } from '../src/files.js';
import { parseConfig } from '../src/config.js';
import { Runtime, pinRuntimeHome } from '../src/runtime.js';
import { Store } from '../src/store.js';
import type { SlackPort } from '../src/types.js';
import { FakeBackend, event, request, waitFor } from './helpers.js';

const privateText='INTERNAL_MIGRATION_MARKER_ONLY';
const forbidden=(error:unknown)=>error instanceof FileAccessError&&error.code==='PATH_FORBIDDEN';
function fixture(){
  const dir=realpathSync.native(mkdtempSync(join(tmpdir(),'connector-private-files-')));
  const repo=join(dir,'project'), home=join(repo,'custom-home'), outside=join(dir,'outside');
  mkdirSync(home,{recursive:true});mkdirSync(outside);
  const raw={version:2,instanceId:'test',port:17418,approvalTimeoutSec:30,projects:{repo,private:home},backend:{executable:process.execPath},
    filePolicy:{allowAbsolutePaths:true},slack:{teamId:'T1',inputChannel:'CIN',outputChannel:'COUT',allowedHumans:['UHUMAN'],approvalUsers:['UHUMAN'],
      trustedBots:[{botId:'BDOT',userId:'UDOT',appId:'ADOT'}],dot:{name:'dot',userId:'UDOT'}}};
  const posts:{channel:string;text:string;threadTs?:string}[]=[],uploads:string[]=[];
  const slack:SlackPort={async uploadScreens(){uploads.push('captured');},async post(channel,text,{threadTs}){posts.push({channel,text,threadTs});return '99.1';},
    async resolveDot(){return{userId:'UDOT',name:'dot'};},async threadExists(){return true;},async humanMessage(){return undefined;}};
  return {dir,repo,home,outside,raw,posts,uploads,slack,cleanup(){rmSync(dir,{recursive:true,force:true});}};
}
test('real Connector migration keeps private configuration, backup and arbitrary Home contents outside every file view',async()=>{
  const f=fixture();let runtime:Runtime|undefined;
  try{
    const original=new Store(f.home);
    original.transaction(s=>s.outbox.push({id:'legacy-notice',channel:'CIN',root:false,text:privateText,status:'sent',attempts:1,nextAttemptAt:0}));
    original.close();
    // No marker here resembles a credential; the *path guard*, not a content
    // heuristic, must stop these files from appearing.
    writeFileSync(join(f.home,'config.json'),JSON.stringify(f.raw));
    for(const name of ['arbitrary-note.md','api.token','state.json.tmp','desktop-preferences.json','credentials.enc'])writeFileSync(join(f.home,name),privateText);
    writeFileSync(join(f.repo,'config.json'),'ordinary source config');
    const reserved=['state.before-server-profiles.json','state.json.tmp','credentials.enc','daemon.lock.stale.0.1234',
      'runtime.lock.stale.0.1234','.config.json.12345678-1234-1234-1234-123456789abc.tmp'];
    for(const name of reserved)writeFileSync(join(f.repo,name),privateText);
    const sibling=join(f.repo,'custom-home-public');mkdirSync(sibling);writeFileSync(join(sibling,'allowed.md'),'ordinary source file');
    const alias=join(f.repo,'directory-alias');symlinkSync(f.home,alias,process.platform==='win32'?'junction':'dir');
    const deep=join(f.home,'deep');mkdirSync(deep);writeFileSync(join(deep,'ordinary-looking.txt'),privateText);
    assert.equal(pinRuntimeHome(alias),f.home);
    runtime=new Runtime(parseConfig({...f.raw,projects:{...f.raw.projects,alias}}),alias,f.slack,undefined,()=>new FakeBackend());
    const core=runtime.core('default'),files=core.files;
    Object.assign(core,{postIntervalMs:0}); // No real Slack or production pacing in this synthetic adapter.
    const migrated='state.before-server-profiles.json',path=(n:string)=>join(f.home,n);
    assert.equal(core.store.dir,f.home);
    assert.ok(readFileSync(path(migrated),'utf8').includes(privateText));
    for(const name of reserved){
      await assert.rejects(files.read('repo',name),forbidden);
      await assert.rejects(files.stat(undefined,join(f.repo,name)),forbidden);
    }
    for(const name of [migrated,'config.json','api.token','state.json','state.json.tmp','credentials.enc','runtime.lock','daemon.lock','desktop-preferences.json','arbitrary-note.md','deep/ordinary-looking.txt','absent.txt']){
      const rel='custom-home/'+name;
      await assert.rejects(files.read('repo',rel),forbidden);
      await assert.rejects(files.stat('repo',rel),forbidden);
      await assert.rejects(files.read(undefined,path(name)),forbidden);
      await assert.rejects(files.stat(undefined,path(name)),forbidden);
    }
    for(const root of ['private','alias']){
      await assert.rejects(files.list(root),forbidden);
      await assert.rejects(files.stat(root),forbidden);
      await assert.rejects(files.search(root,'.',privateText),forbidden);
    }
    await assert.rejects(files.list('repo','custom-home'),forbidden);
    await assert.rejects(files.list(undefined,f.home),forbidden);
    await assert.rejects(files.search(undefined,f.home,privateText),forbidden);
    await assert.rejects(files.stat('repo','directory-alias/deep/ordinary-looking.txt'),forbidden);
    await assert.rejects(files.read(undefined,join(alias,'deep','ordinary-looking.txt')),forbidden);
    await assert.rejects(files.read('repo','custom-home-public/../custom-home/arbitrary-note.md'),forbidden);
    for(const [root,dir] of [['repo','.'],[undefined,f.repo]] as const){
      const list=await files.list(root,dir);
      assert.deepEqual(list.entries.map(e=>root===undefined?relative(f.repo,e.path):e.path),['config.json','custom-home-public']);
      assert.deepEqual((await files.search(root,dir,privateText)).matches,[]);
      assert.equal((await files.search(root,dir,'ordinary source')).matches.length,2);
    }
    // Actual Runtime binding, real Connector command/outbox and fake Slack port:
    // even an authenticated actor who can read ordinary project files cannot
    // use either route to transmit the migrated ledger or private note.
    await runtime.connectLocal();await runtime.enableSlack('USELF','BSELF');
    const expect=async()=>{for(const [cmd,params] of [
      ['files.read',{root:'repo',path:'custom-home/'+migrated}],
      ['files.read',{path:path('arbitrary-note.md')}],
      ['files.stat',{root:'private',path:'.'}],
      ['files.search',{root:'repo',path:'.',query:'INTERNAL_MIGRATION_MARKER'}],
      ['files.list',{root:'repo',path:'.'}],
    ] as const){
      const start=f.posts.length,r=request(cmd,params);
      assert.equal(runtime!.accept(event(r,{thread_ts:'55.1'})),true);
      await waitFor(()=>f.posts.length>start);
      const post=f.posts.at(-1)!;
      assert.equal(post.channel,'CIN');assert.equal(post.threadTs,'55.1');
      assert.doesNotMatch(post.text,/INTERNAL_MIGRATION_MARKER_ONLY|state\.before-server-profiles|arbitrary-note\.md|custom-home\/|directory-alias/);
      if(cmd==='files.read'||cmd==='files.stat')assert.match(post.text,/PATH_FORBIDDEN/);
    }};
    await expect();
    const call=async(command:string,params:Record<string,unknown>)=>{
      const size=f.posts.length;assert.equal(runtime!.accept(event(request(command,params),{thread_ts:'55.1'})),true);
      await waitFor(()=>f.posts.length>size);return f.posts.at(-1)!.text;
    };
    assert.match(await call('files.read',{root:'repo',path:'config.json'}),/ordinary source config/);
    assert.match(await call('screen.capture',{displayId:'all'}),/SCREEN_DISABLED/);
    assert.deepEqual(f.uploads,[]); // No arbitrary file upload; independent screen path is off by default.
  }finally{await runtime?.close();f.cleanup();}
});
test('managed server directories and file links do not send state or temporary writes outside Home',{skip:process.platform==='win32'},()=>{
  const f=fixture();
  try{
    const target=join(f.outside,'ordinary.txt');writeFileSync(target,'unchanged');
    for(const filename of ['config.json','api.token','state.json','state.json.tmp','state.before-server-profiles.json','runtime.lock','daemon.lock']){
      const fake=join(f.home,filename);symlinkSync(target,fake);
      assert.throws(()=>pinRuntimeHome(f.home),/UNSAFE_CONNECTOR_HOME/);
      assert.throws(()=>new Runtime(parseConfig(f.raw),f.home,f.slack,undefined,()=>new FakeBackend()),/UNSAFE_CONNECTOR_HOME/);
      assert.equal(readFileSync(target,'utf8'),'unchanged');rmSync(fake);
    }
    const backup=join(f.home,'state.before-server-profiles.json');linkSync(target,backup);
    assert.throws(()=>pinRuntimeHome(f.home),/UNSAFE_CONNECTOR_HOME/);rmSync(backup);
    const legacy=new Store(f.home);
    const temp=join(f.home,'state.json.tmp');symlinkSync(target,temp);
    try{assert.throws(()=>legacy.transaction(s=>{s.seenEvents.private=privateText;}),/UNSAFE_STATE_TEMP/);}
    finally{legacy.close();rmSync(temp);}
    assert.equal(readFileSync(target,'utf8'),'unchanged');
    const config=parseConfig({...f.raw,backend:undefined,backends:{named:{executable:process.execPath,codexHome:join(f.dir,'synthetic-codex')}}});
    const servers=join(f.home,'servers');symlinkSync(f.outside,servers,'dir');
    assert.throws(()=>new Runtime(config,f.home,f.slack,undefined,()=>new FakeBackend()),/UNSAFE_CONNECTOR_HOME/);
    assert.equal(existsSync(join(f.outside,'named')),false);
    assert.equal(existsSync(join(f.home,'runtime.lock')),false);
    rmSync(servers);mkdirSync(servers);symlinkSync(f.outside,join(servers,'named'),'dir');
    assert.throws(()=>new Runtime(config,f.home,f.slack,undefined,()=>new FakeBackend()),/UNSAFE_CONNECTOR_HOME/);
    for(const name of ['state.json','state.json.tmp','daemon.lock'])assert.equal(existsSync(join(f.outside,name)),false);
  }finally{f.cleanup();}
});
