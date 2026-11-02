import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { DesktopRuntime } from '../desktop/runtime.js';
import { sessionListParams, safeError } from '../desktop/ipc-policy.js';
const { JSDOM } = createRequire(import.meta.url)('jsdom');
const html=readFileSync('desktop/ui/index.html','utf8'),script=readFileSync('desktop/ui/sessions.js','utf8');
const settle=async()=>{for(let i=0;i<4;i++)await new Promise<void>(r=>setImmediate(r));};
class FakeChild extends EventEmitter {stdout=new EventEmitter();stderr=new EventEmitter();connected=true;send(_m:any,cb?:()=>void){cb?.();}kill(){throw Error('No process kill permitted');}}
async function runtimeFixture(handler:(body:any,response:ServerResponse)=>void){
  const home=mkdtempSync(join(tmpdir(),'desktop-sessions-')),child=new FakeChild(),token='t'.repeat(64),requests:any[]=[];
  writeFileSync(join(home,'api.token'),token);
  const server=createServer((req,res)=>{assert.equal(req.headers.authorization,`Bearer ${token}`);let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{const parsed=JSON.parse(body);requests.push(parsed);handler(parsed,res);});});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string');
  const runtime=new DesktopRuntime(home,'/bundle/dist/src/cli.js','/bundle/runtime',(()=>child) as any);
  const config:any={port:address.port,backend:{executable:'/fixture/codex'}};
  const start=()=>{runtime.start(config,{appToken:'dummy-app',botToken:'dummy-bot'});child.emit('message',{type:'connector:ready'});};
  return{runtime,child,start,requests,close:async()=>{child.emit('close',0);await new Promise<void>(r=>server.close(()=>r()));rmSync(home,{recursive:true,force:true});}};
}
function uiFixture(handler:(params:any)=>any){
  const dom=new JSDOM(html,{url:'file:///fixture/desktop/ui/index.html',runScripts:'outside-only'}),window=dom.window,calls:any[]=[];
  window.connector={listSessions:async(params:any)=>{calls.push(params);return handler(params);}};
  window.eval(script);
  return{window,calls,$:(id:string)=>window.document.getElementById(id),close:()=>window.close()};
}
const page=(sessions:any[],nextCursor:string|null=null)=>({ok:true,value:{sessions,nextCursor,scope:'shared metadata only'}});

test('desktop session IPC accepts only bounded read-only cursor and per-source limit',()=>{
  assert.deepEqual(sessionListParams({}),{limit:50});assert.deepEqual(sessionListParams({limit:100,cursor:'opaque'}),{limit:100,cursor:'opaque'});
  for(const value of [null,[],{}, {limit:0},{limit:101},{limit:1.5},{limit:'50'},{cursor:''},{cursor:'x'.repeat(2049)},{cursor:'a\nb'},{method:'turn/start'},{project:'/outside'},{params:{}}]){
    if(value&&Object.keys(value).length===0&&!Array.isArray(value))continue;
    assert.throws(()=>sessionListParams(value),/INVALID_ARGUMENT/);
  }
  assert.throws(()=>sessionListParams(JSON.parse('{"__proto__":{}}')),/INVALID_ARGUMENT/);
});
test('runtime session list is authenticated and fixed-action, returns metadata only',async()=>{
  const f=await runtimeFixture((_body,res)=>res.end(JSON.stringify({ok:true,result:{sessions:[{id:'thread-1',name:'A',loaded:true,status:{type:'idle'},history:'not forwarded',token:'not forwarded',binding:{channel:'CONE',threadTs:'1.2'}}],nextCursor:'next-page',scope:'shared'}})));
  try{f.start();const result=await f.runtime.listSessions({limit:20,cursor:'old-page'});assert.deepEqual(f.requests,[{action:'sessions',params:{limit:20,cursor:'old-page'}}]);assert.equal(result.sessions[0]!.id,'thread-1');assert.equal(result.sessions[0]!.history,undefined);assert.equal(result.sessions[0]!.token,undefined);assert.equal(result.nextCursor,'next-page');}finally{await f.close();}
});
test('runtime refuses a session read while stopped or invalid before HTTP dispatch',async()=>{
  const f=await runtimeFixture((_body,res)=>res.end('{}'));try{await assert.rejects(f.runtime.listSessions({}),/SESSION_SERVER_NOT_RUNNING/);f.start();await assert.rejects(f.runtime.listSessions({command:'session.resume'}),/INVALID_ARGUMENT/);assert.equal(f.requests.length,0);}finally{await f.close();}
});
test('runtime discards an in-flight list after owned child exits',async()=>{
  let response!:ServerResponse,seen!:()=>void;const arrived=new Promise<void>(r=>seen=r);
  const f=await runtimeFixture((_body,res)=>{response=res;seen();});try{f.start();const result=f.runtime.listSessions({});await arrived;f.child.emit('close',0);response.end(JSON.stringify({ok:true,result:page([{id:'old-thread'}]).value}));await assert.rejects(result,/SESSION_LIST_STALE/);}finally{await f.close();}
});
test('runtime rejects malformed list response and sanitizes backend transport errors',async()=>{
  let malformed=true;const f=await runtimeFixture((_body,res)=>{if(malformed)res.end(JSON.stringify({ok:true,result:{sessions:[{id:42}],nextCursor:null}}));else{res.writeHead(400);res.end(JSON.stringify({error:'private upstream diagnostic'}));}});
  try{f.start();await assert.rejects(f.runtime.listSessions({}),/INVALID_SESSION_RESPONSE/);malformed=false;await assert.rejects(f.runtime.listSessions({}),/SESSIONS_UNAVAILABLE/);assert.match(safeError(Error('SESSIONS_UNAVAILABLE')).message,/不会自动创建或恢复/);}finally{await f.close();}
});
test('session tab is metadata-only and never automatically queries on creation or navigation',async()=>{
  const f=uiFixture(()=>page([]));try{await settle();assert.equal(f.calls.length,0);f.window.dispatchEvent(new f.window.CustomEvent('connector:view',{detail:{view:'sessions'}}));await settle();assert.equal(f.calls.length,0);assert.ok(!/session\.history|thread\/resume|turn\/start|\.innerHTML|localStorage|sessionStorage/.test(script));assert.equal(f.$('sessions-more').hidden,true);}finally{f.close();}
});
test('session pages dedupe thread ids and preserve observed loaded state across stored pages',async()=>{
  const f=uiFixture((params:any)=>params.cursor?page([{id:'one',name:'Loaded one',loaded:true,status:{type:'idle'},discoverySources:['loaded'],manageable:true},{id:'two',name:'Historical',loaded:false,status:{type:'active'},manageable:false,reason:'scope restriction'}]):page([{id:'one',name:'Stored one',loaded:null,status:{type:'notLoaded'},discoverySources:['stored']}],'next'));
  try{f.$('sessions-refresh').click();await settle();assert.match(f.$('sessions-pagination').textContent,/不是全部/);f.$('sessions-more').click();await settle();assert.equal(f.$('sessions-list').children.length,2);assert.equal(f.calls.length,2);assert.deepEqual(JSON.parse(JSON.stringify(f.calls[1])),{limit:50,cursor:'next'});const one=f.window.document.querySelector('[data-thread-id="one"]');assert.match(one.textContent,/stored \/ loaded/);assert.match(one.querySelector('.badge').textContent,/idle.*空闲/);assert.ok(!one.querySelector('.badge').textContent.includes('执行中'));const two=f.window.document.querySelector('[data-thread-id="two"]');assert.match(two.querySelector('.badge').textContent,/非当前运行状态/);assert.ok(!two.querySelector('.badge').textContent.includes('执行中'));assert.equal(f.$('sessions-more').hidden,true);}finally{f.close();}
});
test('refresh resets pagination and does not leave disappeared records behind',async()=>{
  let count=0;const f=uiFixture(()=>++count===1?page([{id:'old'}],'old-next'):page([{id:'new'}]));try{f.$('sessions-refresh').click();await settle();f.$('sessions-refresh').click();await settle();assert.equal(f.$('sessions-list').children.length,1);assert.match(f.$('sessions-list').textContent,/new/);assert.ok(!f.$('sessions-list').textContent.includes('old'));assert.equal(f.$('sessions-more').hidden,true);}finally{f.close();}
});
test('session rendering treats names, paths and source as text and explains bindings',async()=>{
  const f=uiFixture(()=>page([{id:'constructor',name:'<img src=x onerror=bad()>',cwd:'<script>bad()</script>',source:{cli:'<svg onload=bad()>'},loaded:true,status:{type:'active'},model:'example-model',manageable:true,connectorSessionId:'bound-one',binding:{channel:'CROOM',threadTs:'123.456'}}]));try{f.$('sessions-refresh').click();await settle();assert.equal(f.$('sessions-list').querySelector('img,script,svg'),null);assert.match(f.$('sessions-list').textContent,/CROOM/);assert.match(f.$('sessions-list').textContent,/读取时执行中/);assert.equal(f.$('sessions-list').children.length,1);}finally{f.close();}
});
test('repeated list clicks are single-flight and errors keep prior records clearly stale',async()=>{
  let finish!:(v:any)=>void;let calls=0;const f=uiFixture(()=>++calls===1?page([{id:'before'}],'next'):new Promise(r=>finish=r));try{f.$('sessions-refresh').click();await settle();f.$('sessions-more').click();f.$('sessions-more').click();f.$('sessions-refresh').click();assert.equal(f.calls.length,2);finish({ok:false,error:{message:'连接器已停止，请重新启动。'}});await settle();assert.equal(f.$('sessions-list').children.length,1);assert.match(f.$('sessions-pagination').textContent,/不能认为.*最新/);assert.equal(f.$('sessions-more').disabled,false);}finally{f.close();}
});
test('repeated backend cursors stop pagination with an explicit incomplete warning',async()=>{
  const f=uiFixture(()=>page([{id:'one'}],'repeat'));try{f.$('sessions-refresh').click();await settle();f.$('sessions-more').click();await settle();assert.equal(f.$('sessions-more').hidden,true);assert.match(f.$('sessions-feedback').textContent,/重复.*游标/);assert.match(f.$('sessions-pagination').textContent,/不完整/);}finally{f.close();}
});
test('malformed response does not replace an already rendered safe page',async()=>{
  let calls=0;const f=uiFixture(()=>++calls===1?page([{id:'safe'}]):page([{name:'invalid without id'}]));try{f.$('sessions-refresh').click();await settle();f.$('sessions-refresh').click();await settle();assert.equal(f.$('sessions-list').children.length,1);assert.match(f.$('sessions-list').textContent,/safe/);assert.match(f.$('sessions-feedback').textContent,/缺少有效/);}finally{f.close();}
});
