import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer,request as httpRequest } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { apiServer } from '../src/server.js';
import { fixture,waitFor } from './helpers.js';
const exec=promisify(execFile);
test('real CLI↔authenticated API command+status, ambient proxy bypass, no remote approval',async()=>{
  const f=fixture(),token='t'.repeat(64),server=apiServer(f.connector,token);await f.connector.initialize();await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string');f.config.port=address.port;
  writeFileSync(join(f.dir,'config.json'),JSON.stringify(f.config));writeFileSync(join(f.dir,'api.token'),token);
  let proxyHits=0;const proxy=createServer((_q,r)=>{proxyHits++;r.writeHead(502);r.end();});proxy.on('connect',(_q,s)=>{proxyHits++;s.end();});await new Promise<void>(r=>proxy.listen(0,'127.0.0.1',r));const pa=proxy.address();assert.ok(pa&&typeof pa!=='string');
  const env:NodeJS.ProcessEnv={...process.env,CONNECTOR_HOME:f.dir,NODE_USE_ENV_PROXY:'1',HTTP_PROXY:`http://127.0.0.1:${pa.port}`,HTTPS_PROXY:`http://127.0.0.1:${pa.port}`,http_proxy:`http://127.0.0.1:${pa.port}`,NO_PROXY:'',no_proxy:''};delete env.CONNECTOR_TOKEN;
  const cli=async(...args:string[])=>JSON.parse((await exec(process.execPath,[resolve('dist/src/cli.js'),...args],{env})).stdout).result;
  try{
    const sent=await cli('command','--name','session.create','--params','{"project":"repo"}');await waitFor(()=>f.store.state.work.find(w=>w.id===sent.id)?.status==='completed');
    const status=await cli('status');assert.equal(status.sessions.length,1);assert.equal(proxyHits,0);
    const url=`http://127.0.0.1:${address.port}/v1/command`,headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
    assert.equal((await fetch(url,{method:'POST'})).status,401);
    assert.equal((await fetch(url,{method:'POST',headers:{...headers,Origin:'https://evil.invalid'},body:'{}'})).status,401);
    const wrongHost=await new Promise<number|undefined>((r,j)=>{const q=httpRequest(url,{method:'POST',headers:{...headers,Host:'evil.invalid'}},response=>{response.resume();response.on('end',()=>r(response.statusCode));});q.on('error',j);q.end('{}');});assert.equal(wrongHost,401);
    assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify({action:'command',envelope:{v:1,id:'a',target:'test',command:'approval.respond',params:{requestId:'r',epoch:'e',sessionId:'s',turnId:'t',decision:'accept'}}})})).status,400);
  }finally{await new Promise<void>(r=>proxy.close(()=>r()));await new Promise<void>(r=>server.close(()=>r()));await f.cleanup();}
});

test('init and example omit default version pin without rewriting an existing explicit pin',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'connector-init-no-pin-'));
  try {
    const cli=()=>exec(process.execPath,[resolve('dist/src/cli.js'),'init','--home',dir]);
    await cli();
    const path=join(dir,'config.json'),config=JSON.parse(readFileSync(path,'utf8'));
    assert.equal(Object.hasOwn(config.backend,'expectedVersion'),false);
    assert.equal(Object.hasOwn(JSON.parse(readFileSync('config.example.json','utf8')).backend,'expectedVersion'),false);
    config.backend.expectedVersion='operator-chosen-version';writeFileSync(path,JSON.stringify(config));
    await cli();
    assert.equal(JSON.parse(readFileSync(path,'utf8')).backend.expectedVersion,'operator-chosen-version');
  } finally {rmSync(dir,{recursive:true,force:true});}
});
