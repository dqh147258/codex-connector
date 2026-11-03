import { DesktopRuntime } from '../desktop/runtime.js';
import { Store } from '../src/store.js';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { DesktopScreens, type ScreenAPI } from '../desktop/screens.js';
import { ScreenError, validateScreenImages, type ScreenPort } from '../src/screens.js';
import { desktopScreenPort } from '../src/screen-ipc.js';
import { parseConfig } from '../src/config.js';
import { DesktopSettings } from '../desktop/settings.js';
import { Connector } from '../src/connector.js';
import { SlackClient } from '../src/slack.js';
import { validateCommand } from '../src/protocol.js';
import { fixture, request, event, run, waitFor } from './helpers.js';
const jpeg=()=>Buffer.from([0xff,0xd8,1,2,0xff,0xd9]);
const image=(displayId='1')=>({displayId,width:1280,height:720,jpeg:jpeg()});
function desktop(){
  let enabled=true,locked=false,permission='granted',calls=0;
  let displays=[{id:1,size:{width:1920,height:1080},scaleFactor:1},{id:2,size:{width:1280,height:720},scaleFactor:2}];
  let sources:Awaited<ReturnType<ScreenAPI['sources']>>=displays.map(d=>({display_id:String(d.id),thumbnail:{isEmpty:()=>false,getSize:()=>({width:1280,height:720}),toJPEG:()=>jpeg(),resize(){return this;}}}));
  const api:ScreenAPI={displays:()=>displays,primaryId:()=>1,permission:()=>permission,locked:()=>locked,sources:async()=>{calls++;return sources;}};
  return{api,port:new DesktopScreens(api,()=>enabled,'darwin',false),get calls(){return calls;},disable:()=>{enabled=false;},lock:()=>{locked=true;},deny:()=>{permission='denied';},sources:(s:typeof sources)=>{sources=s;},layout:()=>{displays=displays.slice(0,1);}};
}
test('display list never captures; exact ID and all captures are bounded and correctly labelled',async()=>{
  const d=desktop();assert.deepEqual((await d.port.list()).displays.map(d=>d.id),['1','2']);assert.equal(d.calls,0);
  assert.deepEqual((await d.port.capture('2')).map(i=>i.displayId),['2']);assert.deepEqual((await d.port.capture('all')).map(i=>i.displayId),['1','2']);
  await assert.rejects(d.port.capture('3'),/SCREEN_NOT_FOUND/);assert.equal(d.calls,2);
});
test('disabled, locked, denied and Wayland fail closed without capture',async()=>{
  for(const change of ['disable','lock','deny'] as const){const d=desktop();d[change]();await assert.rejects(d.port.capture('all'));assert.equal(d.calls,0);}
  const d=desktop(),port=new DesktopScreens(d.api,()=>true,'linux',true);assert.equal((await port.list()).selectionSupported,false);await assert.rejects(port.capture('all'),/SCREEN_SELECTION_UNAVAILABLE/);assert.equal(d.calls,0);
});
test('missing display mapping, duplicate mapping, empty image and layout changes never substitute a screen',async()=>{
  for(const kind of ['missing','duplicate','empty','layout']){const d=desktop();const original=await d.api.sources();
    if(kind==='missing')d.sources(original.slice(0,1));
    if(kind==='duplicate')d.sources([...original,original[1]!]);
    if(kind==='empty')d.sources(original.map(s=>({...s,thumbnail:{...s.thumbnail,isEmpty:()=>true}})));
    if(kind==='layout')d.api.sources=async()=>{d.layout();return original;};
    await assert.rejects(d.port.capture('all'),/SCREEN_SELECTION_UNAVAILABLE|SCREEN_LAYOUT_CHANGED/);
  }
});
test('capture serializes native work and rechecks opt-in after asynchronous OS work',async()=>{
  const d=desktop();let release!:(v:any)=>void;d.api.sources=()=>new Promise(r=>{release=r;});const first=d.port.capture('1');
  await assert.rejects(d.port.capture('all'),/SCREEN_BUSY/);d.disable();release([]);await assert.rejects(first,/SCREEN_DISABLED/);
});
test('JPEG image validation rejects wrong display, duplicates, huge data and invalid bytes',()=>{
  assert.equal(validateScreenImages([image()],'1').length,1);
  for(const images of [[],[image('2')],[image(),image()],[{...image(),jpeg:Buffer.alloc(6)}],[{...image(),width:3000}],[{...image(),jpeg:Buffer.alloc(6*1024*1024)}]])assert.throws(()=>validateScreenImages(images,'1'));
});
test('screen commands require explicit all or ID, cannot choose recipients, paths or enable capture',()=>{
  assert.deepEqual(validateCommand('screen.capture',{displayId:'all'}),{displayId:'all'});
  for(const params of [{},{displayId:'latest'},{displayId:'1',channel:'COTHER'},{displayId:'1',enabled:true},{displayId:'1',path:'/tmp/image'}])assert.throws(()=>validateCommand('screen.capture',params));
  assert.deepEqual(validateCommand('screen.list',{}),{});
});
async function connected(enabled=true){
  const f=fixture();f.config.screenPolicy={enabled};let captures=0,lists=0;const uploads:any[]=[];
  const port:ScreenPort={async list(){lists++;return{displays:[{id:'1',width:1920,height:1080,scaleFactor:1,primary:true}],platform:'darwin',selectionSupported:true,permission:'granted'};},async capture(id){captures++;return[image(id==='all'?'1':id)];}};
  f.slack.uploadScreens=async(channel,threadTs,images,requestId)=>{uploads.push({channel,threadTs,images,requestId,bytes:Buffer.from(images[0]!.jpeg)});};
  const connector=new Connector(f.config,f.store,f.backend,f.slack,0,port);connector.selfUserId='USELF';connector.selfBotId='BSELF';await connector.initialize();
  return{...f,connector,port,uploads,get captures(){return captures;},get lists(){return lists;},async cleanup(){await connector.close();await f.cleanup();}};
}
async function remote(f:Awaited<ReturnType<typeof connected>>,command='screen.capture',params:any={displayId:'all'},overrides:any={}){
  const r=request(command,params);assert.equal(f.connector.accept(event(r,{thread_ts:'88.123',...overrides})),true);f.connector.pump();await waitFor(()=>f.store.state.work.some(w=>w.request.id===r.id&&['completed','failed','uncertain'].includes(w.status)));return f.store.state.work.find(w=>w.request.id===r.id)!;
}
test('authenticated remote request uploads to its origin thread, never persists image bytes, deduplicates replay',async()=>{
  const f=await connected();try{
    const r=request('screen.capture',{displayId:'1'}),e=event(r,{thread_ts:'88.123'});assert.equal(f.connector.accept(e),true);f.connector.pump();await waitFor(()=>f.uploads.length===1);await waitFor(()=>f.store.state.work[0]?.status==='completed');
    assert.equal(f.uploads[0].channel,'CIN');assert.equal(f.uploads[0].threadTs,'88.123');assert.deepEqual(f.uploads[0].bytes,jpeg());assert.ok(f.uploads[0].images[0].jpeg.every((v:number)=>v===0));
    assert.ok(!readFileSync(join(f.dir,'state.json'),'utf8').includes(jpeg().toString('base64')));
    f.connector.accept(event(r,{thread_ts:'88.123'}));f.connector.pump();await new Promise(r=>setTimeout(r,10));assert.equal(f.captures,1);assert.equal(f.uploads.length,1);assert.equal(f.backend.calls.length,0);
  }finally{await f.cleanup();}
});
test('disabled capture, local no-destination, unauthorized actor and wrong channel never capture',async()=>{
  const f=await connected(false);try{
    assert.equal((await remote(f)).error,'SCREEN_DISABLED');assert.equal(f.captures,0);
    f.config.screenPolicy!.enabled=true;assert.equal((await run(f,'screen.capture',{displayId:'all'})).error,'SCREEN_SLACK_THREAD_REQUIRED');
    assert.equal(f.connector.accept(event(request('screen.capture',{displayId:'all'}),{user:'UEVIL'})),false);
    await remote(f,'screen.list',{});assert.equal(f.captures,0);assert.equal(f.lists,1);
    const before=f.store.state.work.length;f.connector.accept(event(request('screen.capture',{displayId:'all'}),{channel:'COUT'}));assert.equal(f.store.state.work.length,before);
  }finally{await f.cleanup();}
});
test('capture completion reauthorizes before upload; uncertain uploads never auto-replay',async()=>{
  const f=await connected();try{
    f.port.capture=async()=>{f.config.slack.trustedBots=[];return[image()];};assert.equal((await remote(f)).error,'ACTOR_REVOKED');assert.equal(f.uploads.length,0);
    f.config.slack.trustedBots=[{botId:'BDOT',userId:'UDOT',appId:'ADOT'}];f.port.capture=async()=>[image()];f.slack.uploadScreens=async()=>{throw new ScreenError('SCREEN_UPLOAD_UNCERTAIN');};
    const work=await remote(f);assert.equal(work.status,'uncertain');f.connector.pump();assert.equal(f.store.state.work.find(w=>w.id===work.id)!.status,'uncertain');
    f.slack.uploadScreens=async()=>{};assert.equal((await remote(f)).status,'completed');
  }finally{await f.cleanup();}
});
test('desktop settings and old configs default disabled; invalid policies are rejected',async()=>{
  const f=fixture();try{
    const settings=new DesktopSettings(f.dir,{isEncryptionAvailable:()=>false,encryptString:()=>Buffer.alloc(0),decryptString:()=>''});
    assert.equal(settings.defaultConfig().screenPolicy?.enabled,false);assert.equal(JSON.parse(readFileSync('config.example.json','utf8')).screenPolicy.enabled,false);
    assert.notEqual(parseConfig(structuredClone(f.config)).screenPolicy?.enabled,true);
    for(const policy of [null,{},[],{enabled:1},{enabled:true,background:true},Object.create({enabled:true})])assert.throws(()=>parseConfig({...f.config,screenPolicy:policy}));
    settings.saveConfig({...f.config,screenPolicy:{enabled:true}});assert.equal(settings.readConfig().screenPolicy?.enabled,true);
  }finally{await f.cleanup();}
});
class Ipc extends EventEmitter{env={CONNECTOR_DESKTOP_CHILD:'1'};connected=true;sent:any[]=[];send(m:any,cb:any){this.sent.push(m);cb?.();}}
test('child IPC correlates replies and times out without retry, no port outside desktop',async()=>{
  assert.equal(desktopScreenPort({env:{}} as any),undefined);
  const ipc=new Ipc(),port=desktopScreenPort(ipc as any,30)!;const pending=port.capture('1');
  ipc.emit('message',{type:'connector:screens:result',id:'other',result:[]});
  ipc.emit('message',{type:'connector:screens:result',id:ipc.sent[0].id,result:[{...image(),jpeg:jpeg().toString('base64')}]});assert.equal((await pending)[0]!.displayId,'1');assert.equal(ipc.listenerCount('message'),0);
  await assert.rejects(port.capture('all'),/SCREEN_TIMEOUT/);assert.equal(ipc.sent.length,2);assert.equal(ipc.listenerCount('message'),0);
});
test('Slack upload uses current external-upload API with explicit channel/thread and in-memory files',async()=>{
  const slack=new SlackClient('test');let options:any;(slack.web as any).filesUploadV2=async(o:any)=>{options=o;return{ok:true};};
  await slack.uploadScreens('CIN','1.123',[image()],'capture-123');assert.equal(options.channel_id,'CIN');assert.equal(options.thread_ts,'1.123');assert.ok(Buffer.isBuffer(options.file_uploads[0].file));assert.equal(options.file_uploads[0].filename,'screen-1.jpg');
  (slack.web as any).filesUploadV2=async()=>{throw Error('raw-sensitive-network-error');};await assert.rejects(slack.uploadScreens('CIN','1.123',[image()],'capture-123'),/SCREEN_UPLOAD_UNCERTAIN/);
});
test('native capture timeout rejects promptly, requires app restart and discards late sources',async()=>{
  const d=desktop();let resolve!:(value:any)=>void;d.api.sources=()=>new Promise(r=>{resolve=r;});const port=new DesktopScreens(d.api,()=>true,'darwin',false,5);
  await assert.rejects(port.capture('all'),/SCREEN_TIMEOUT/);await assert.rejects(port.capture('all'),/SCREEN_RESTART_REQUIRED/);resolve([]);await new Promise(r=>setImmediate(r));await assert.rejects(port.capture('1'),/SCREEN_RESTART_REQUIRED/);
});
test('first explicit macOS capture may invoke OS permission prompt; denied permission never captures',async()=>{
  const d=desktop();let permission='not-determined';d.api.permission=()=>permission;const sources=await d.api.sources();d.api.sources=async()=>{permission='granted';return sources;};assert.equal((await d.port.capture('1')).length,1);
  permission='not-determined';d.api.sources=async()=>sources;await assert.rejects(d.port.capture('1'),/SCREEN_PERMISSION_DENIED/);
});
test('HiDPI native thumbnails are resized into the image budget',async()=>{
  const d=desktop();let resized=false;const small={isEmpty:()=>false,getSize:()=>({width:2560,height:1440}),toJPEG:()=>jpeg(),resize(){return this;}};
  d.api.sources=async()=>[{display_id:'1',thumbnail:{...small,getSize:()=>({width:5120,height:2880}),resize(options){resized=true;assert.equal(options.width,2560);assert.equal(options.height,1440);return small;}}}];
  assert.equal((await d.port.capture('1'))[0]!.width,2560);assert.equal(resized,true);
});
test('queued capture expires before touching desktop; disconnected/invalid thread is never captured',async()=>{
  const f=await connected();try{
    const r=request('screen.capture',{displayId:'all'});f.connector.accept(event(r));f.store.transaction(s=>{s.work[0]!.createdAt=new Date(Date.now()-61000).toISOString();});f.connector.pump();await waitFor(()=>f.store.state.work[0]?.status==='failed');assert.equal(f.store.state.work[0]?.error,'SCREEN_REQUEST_EXPIRED');assert.equal(f.captures,0);
    f.slack.threadExists=async()=>false;assert.equal((await remote(f)).error,'SCREEN_SLACK_THREAD_REQUIRED');assert.equal(f.captures,0);
  }finally{await f.cleanup();}
});
test('known Slack rejection stays distinct from uncertain outcome and SDK requests have a real timeout',async()=>{
  const slack=new SlackClient('test');assert.equal((slack.web as any).axios.defaults.timeout,10000);
  for(const error of [{code:'slack_webapi_platform_error',data:{error:'missing_scope'}},{code:'slack_webapi_rate_limited_error'}]){(slack.web as any).filesUploadV2=async()=>{throw error;};await assert.rejects(slack.uploadScreens('CIN','1.1',[image()],'id'),/SCREEN_UPLOAD_REJECTED/);}
});
test('restart cancels a queued momentary capture rather than taking it on a different desktop later',async()=>{
  const f=fixture();try{
    f.connector.accept(event(request('screen.capture',{displayId:'all'})));f.store.close();const reopened=new Store(f.dir);try{assert.equal(reopened.state.work[0]!.status,'failed');assert.equal(reopened.state.work[0]!.error,'SCREEN_REQUEST_EXPIRED');}finally{reopened.close();}
  }finally{await f.cleanup();}
});
test('native settings opt-in prompts once, cancellation never saves, unchanged true does not reprompt',async()=>{
  const f=fixture();try{
    const source=readFileSync('desktop/main.ts','utf8'),start=source.indexOf('saveConfig:async value=>')+'saveConfig:'.length,end=source.indexOf(',\n  saveCredentials:',start);
    let saved=0,asked=0,cancel=true,previous:any={...f.config,screenPolicy:{enabled:false}};
    const handler=runInNewContext('('+source.slice(start,end)+')',{ensureStopped:()=>{},settings:{readConfig:()=>previous,saveConfig:()=>{saved++;}},snapshot:()=>({}),confirm:async(title:string,message:string)=>{asked++;assert.match(title,/截图/);assert.match(message,/密码/);assert.match(message,/无需逐次/);if(cancel)throw Error('CANCELLED');}});
    const next={...f.config,screenPolicy:{enabled:true}};await assert.rejects(handler(next),/CANCELLED/);assert.equal(saved,0);
    cancel=false;await handler(next);assert.equal(saved,1);previous=next;await handler(next);assert.equal(saved,2);assert.equal(asked,2);
  }finally{await f.cleanup();}
});
class DesktopChild extends EventEmitter{stdout=new EventEmitter();stderr=new EventEmitter();connected=true;sent:any[]=[];send(m:any,cb?:()=>void){this.sent.push(m);cb?.();}}
test('parent IPC only serves its live enabled child, strips bytes on stop and rejects arbitrary requests',async()=>{
  const f=fixture(),child=new DesktopChild();let release!:(value:any)=>void,captures=0;const pixels=image();
  const provider:ScreenPort={async list(){return{displays:[],platform:'linux',selectionSupported:true,permission:'os-managed'};},capture:async()=>{captures++;return new Promise(r=>{release=r;});}};
  const runtime=new DesktopRuntime(f.dir,'/fixed/cli','/fixed/runtime',(()=>child)as any,1000,provider);
  try{
    f.store.close();runtime.start({...f.config,screenPolicy:{enabled:true}},{appToken:'A',botToken:'B'});child.emit('message',{type:'connector:ready'});
    child.emit('message',{type:'connector:screens',id:'12345678-1234-1234-1234-123456789abc',operation:'capture',displayId:'1',path:'/bad'});assert.equal(captures,0);
    child.emit('message',{type:'connector:screens',id:'12345678-1234-1234-1234-123456789abc',operation:'capture',displayId:'1'});assert.equal(captures,1);
    child.emit('message',{type:'connector:screens',id:'22345678-1234-1234-1234-123456789abc',operation:'capture',displayId:'1'});await waitFor(()=>child.sent.some(m=>m.error==='SCREEN_BUSY'));
    const stop=runtime.stop();release([pixels]);await waitFor(()=>child.sent.some(m=>m.error==='SCREEN_CANCELLED'));assert.ok(pixels.jpeg.every(v=>v===0));assert.ok(!child.sent.some(m=>Array.isArray(m.result)));
    child.emit('close',0);await stop;
  }finally{await f.cleanup();}
});
