import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const exec=promisify(execFile), script=resolve('scripts/verify-default-owner.mjs'), fixture=resolve('test/fixtures/app-server.cjs');
async function failure(args:string[],env:NodeJS.ProcessEnv=process.env){
  try{await exec(process.execPath,[script,...args],{env});}catch(e){return e as Error&{code:number;stdout:string;stderr:string};}throw Error('Expected nonzero status');
}
test('candidate diagnostic offline mode uses a fixed fixture without output paths, real accounts or persistent state',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'owner-offline-')),log=join(dir,'unwanted.log');
  try{
    const env={...process.env,CODEX_HOME:join(dir,'private-home'),CONNECTOR_HOME:join(dir,'unused-connector-home'),CONNECTOR_FIXTURE_LOG:log,CONNECTOR_FIXTURE_VERSION:'should-not-be-used'};
    const {stdout,stderr}=await exec(process.execPath,[script,'--offline-fixture'],{env});assert.equal(stderr,'');
    const r=JSON.parse(stdout);assert.equal(r.mode,'offline-synthetic-fixture');assert.equal(r.ok,true);
    assert.equal(r.cachedBefore.health,'unknown');assert.equal(r.cachedAfter.health,'online');assert.equal(r.cachedAfter.executableVersion,'0.166.0-alpha.1');
    assert.equal(r.cachedAfter.serverVersion,null);assert.equal(r.cachedAfter.homeVerified,false);assert.equal(r.cachedAfter.daemonStartAttempted,false);assert.equal(r.cleanup,'close-returned');
    assert.ok(!stdout.includes(dir));assert.equal(existsSync(log),false);assert.equal(existsSync(env.CONNECTOR_HOME),false);
    const rejected=await failure(['--codex-exe','codex.exe','--sock','wherever'],env);assert.equal(rejected.code,2);assert.equal(rejected.stdout,'');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('candidate reports missing executable as a sanitized failed version probe without guessing another installation',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'owner-missing-'));
  try{
    const missing=join(dir,process.platform==='win32'?'codex.exe':'codex');
    const e=await failure(['--codex-exe',missing]);assert.equal(e.code,1);assert.equal(e.stderr,'');assert.ok(!e.stdout.includes(dir));
    const r=JSON.parse(e.stdout);assert.equal(r.ok,false);assert.equal(r.probePassed,false);assert.equal(r.cachedAfter.health,'unavailable');
    assert.equal(r.cachedAfter.executableVersion,null);assert.equal(r.cachedAfter.serverVersion,null);assert.ok(r.cachedAfter.lastFailure);
    assert.equal(r.cachedAfter.lastFailureStage,'version-probe');assert.equal(r.cachedAfter.daemonStartAttempted,false);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('production-argument path against synthetic executable: only --version, default proxy, initialize and initialized',{skip:process.platform==='win32'},async()=>{
  // On POSIX only, provide the same offline fixture through a temporary executable
  // named codex. This checks production argument routing, not a live installation.
  const dir=mkdtempSync(join(tmpdir(),'owner-routing-')),log=join(dir,'wire');
  try{
    const exe=join(dir,'codex'),home=join(dir,'explicit native home');mkdirSync(home);
    writeFileSync(exe,'#!'+process.execPath+'\nrequire('+JSON.stringify(fixture)+');\n',{mode:0o700});
    const {stdout}=await exec(process.execPath,[script,'--codex-exe',exe],{env:{...process.env,CODEX_HOME:home,CONNECTOR_HOME:join(dir,'private-state'),CONNECTOR_FIXTURE_LOG:log,SLACK_BOT_TOKEN:'sentinel',CONNECTOR_TOKEN:'sentinel'}});
    const r=JSON.parse(stdout);assert.equal(r.ok,true);assert.equal(r.mode,'default-owner-proxy');assert.equal(r.homeSelection,'inherits-CODEX_HOME');
    assert.ok(!stdout.includes(dir)&&!stdout.includes('sentinel'));assert.equal(existsSync(join(dir,'private-state')),false);
    const wire=readFileSync(log,'utf8').trim().split('\n').map(s=>JSON.parse(s));
    assert.deepEqual(wire.filter(x=>x.kind==='launch').map(x=>[x.args,x.home,x.credentialPresent]),[[['--version'],home,false],[['app-server','proxy'],home,false]]);
    assert.deepEqual(wire.filter(x=>x.kind==='message').map(x=>x.value.method),['initialize','initialized']);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
