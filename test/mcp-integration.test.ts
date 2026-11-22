import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

import { apiServer } from '../src/server.js';
import { Runtime } from '../src/runtime.js';
import { parseConfig } from '../src/config.js';
import { FakeBackend, waitFor } from './helpers.js';

const exec=promisify(execFile), script=resolve('dist/src/cli.js');
const token=randomBytes(32).toString('hex'); // synthetic in-memory fixture only
async function daemon() {
  const requests:any[]=[],home=mkdtempSync(join(tmpdir(),'connector-mcp-cli-'));
  const server=createServer(async(req,res)=>{
    assert.equal(req.method,'POST');assert.equal(req.url,'/v1/command');assert.equal(req.headers.authorization,'Bearer '+token);
    let raw='';for await(const b of req)raw+=b;
    const body=JSON.parse(raw);requests.push(body);res.setHeader('content-type','application/json');
    // Intentionally distinguish direct results, inbox admission, terminal receipts and events.
    let result:unknown;
    if(body.action==='servers')result=[{serverId:'alpha',status:'online'},{serverId:'beta',status:'offline'}];
    else if(body.action==='command'){
      if(body.envelope.params.serverId==='forbidden'){res.writeHead(403);res.end('{"error":"LOCAL_SCOPE_DENIED"}');return;}
      result={id:'work-123',requestId:body.envelope.id,serverId:'alpha',status:'accepted',acceptance:'connector-inbox-only',deliveryConfirmed:false};
    }else if(body.action==='receipt'){
      if(body.workId!=='work-123'){res.writeHead(404);res.end(JSON.stringify({error:'private daemon diagnostic '+token}));return;}
      result={id:body.workId,serverId:body.serverId,status:'completed',result:{sessionId:'binding-1',threadId:'native-1'}};
    }else if(body.action==='events'){
      if(body.waitMs)await new Promise(r=>setTimeout(r,60));
      result={serverId:body.serverId,events:[{id:'ev-1',type:'assistant.final',text:'hello\n你好',workId:'work-123',turnId:'turn-1'}],nextCursor:'opaque-cursor',gap:null,hasMore:false};
    }else if(body.action==='unwatch'){result={subscriptionId:body.subscriptionId,enabled:false};
    }else{res.writeHead(400);res.end('{}');return;}
    res.end(JSON.stringify({ok:true,result}));
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const addr=server.address();assert.ok(addr&&typeof addr!=='string');
  const flags=['--port',String(addr.port),'--target','test-mcp'];
  const env={...process.env,CONNECTOR_TOKEN:token,CONNECTOR_HOME:home};
  return {requests,flags,env,home,close:async()=>{await new Promise<void>(r=>server.close(()=>r()));rmSync(home,{recursive:true,force:true});}};
}
const init=(id:string|number,protocolVersion='2025-11-25')=>({jsonrpc:'2.0',id,method:'initialize',params:{protocolVersion,capabilities:{},clientInfo:{name:'fixture',version:'1'}}});
const req=(id:string|number,method:string,params?:unknown)=>({jsonrpc:'2.0',id,method,params});
const ready={jsonrpc:'2.0',method:'notifications/initialized'};
const call=(id:string|number,name:string,args:Record<string,unknown>={})=>req(id,'tools/call',{name,arguments:args});
const toolResult=(packet:any)=>{assert.notEqual(packet.result.isError,true);return JSON.parse(packet.result.content[0].text);};
async function run(f:Pick<Awaited<ReturnType<typeof daemon>>,'flags'|'env'>,frames:(unknown|string)[]){
  const p=spawn(process.execPath,[script,'mcp',...f.flags],{env:f.env,stdio:'pipe'});
  let stderr='';p.stderr.on('data',chunk=>{stderr+=chunk;});
  const lines:string[]=[];createInterface({input:p.stdout}).on('line',line=>lines.push(line));
  const done=new Promise<void>((res,rej)=>{p.on('error',rej);p.on('close',code=>code===0?res():rej(Error('MCP exited '+code+': '+stderr)));});
  p.stdin.end(frames.map(frame=>typeof frame==='string'?frame:JSON.stringify(frame)).join('\n')+'\n');
  await done;
  assert.equal(stderr,'');assert.ok(!lines.join('\n').includes(token));
  return lines.map(line=>{const m=JSON.parse(line);assert.equal(m.jsonrpc,'2.0');return m;}); // stdout contains no banner or diagnostics
}

test('real stdio MCP: lifecycle, discovery, explicit scoped commands, exact receipt and asynchronous events',{timeout:15000},async()=>{
  const f=await daemon();
  try{
    const packets=await run(f,[req('early','tools/list'),init('boot','future-version'),ready,req('discover','tools/list'),req(5,'ping'),call('servers','server_list'),
      call('attach','session_attach',{serverId:'alpha',project:'demo',threadId:'native-1',requestId:'attach-0001'}),
      call('events','session_events',{serverId:'alpha',sessionId:'binding-1',cursor:'prior-cursor',waitMs:150,limit:9}),
      call('receipt','receipt_get',{serverId:'alpha',workId:'work-123'}),req('unknown','server/operations'),
      {jsonrpc:'2.0',method:'tools/call',params:{name:'session_send',arguments:{sessionId:'binding-1',text:'do not execute',requestId:'ignored-0001'}}}]);
    const by=new Map(packets.map(m=>[m.id,m]));assert.equal(packets.length,9);assert.equal(by.get('early').error.code,-32002);
    assert.equal(by.get('boot').result.protocolVersion,'2025-11-25');assert.deepEqual(by.get('boot').result.capabilities,{tools:{}});
    const schemas=by.get('discover').result.tools as any[],names=schemas.map(t=>t.name);
    for(const n of ['server_list','session_list','session_attach','session_create','session_send','session_history','receipt_get','session_events'])assert.ok(names.includes(n),n);
    assert.equal(names.some(n=>/approval|input_respond|rpc|shell|recover|files|screen/i.test(n)),false);
    assert.deepEqual(schemas.find(t=>t.name==='session_send').inputSchema.required,['requestId','sessionId','text']);
    assert.deepEqual(by.get(5).result,{});assert.equal(by.get('unknown').error.code,-32601);
    assert.equal(toolResult(by.get('servers'))[0].serverId,'alpha');
    const admission=toolResult(by.get('attach'));assert.equal(admission.status,'accepted');assert.equal(admission.deliveryConfirmed,false);
    assert.equal(toolResult(by.get('receipt')).result.sessionId,'binding-1');
    assert.equal(toolResult(by.get('events')).events[0].text,'hello\n你好');
    assert.ok(packets.findIndex(m=>m.id==='receipt')<packets.findIndex(m=>m.id==='events'));
    assert.equal(f.requests.length,4);
    const sent=f.requests.find(r=>r.action==='command').envelope;
    assert.deepEqual(sent,{v:1,id:'attach-0001',target:'test-mcp',command:'session.attach',params:{serverId:'alpha',project:'demo',threadId:'native-1'}});
    assert.deepEqual(f.requests.find(r=>r.action==='events'),{action:'events',serverId:'alpha',sessionId:'binding-1',cursor:'prior-cursor',waitMs:150,limit:9});
  }finally{await f.close();}
});

test('real MCP blocks raw bridges, bad argument shapes, Slack routes, leaked transport diagnostics and oversized frames',{timeout:15000},async()=>{
  const f=await daemon();
  try{
    const packets=await run(f,['is not JSON','x'.repeat(70000),init(1,'2025-03-26'),ready,call(2,'approval.respond'),
      call(3,'session_send',{sessionId:'s',text:'no id'}),call(4,'session_create',{requestId:'create-00001',project:'demo',outputThreadTs:'5.1'}),
      call(5,'session_list',{serverId:'forbidden'}),call(6,'session_events',{sessionId:'s',waitMs:30001}),
      call(7,'receipt_get',{workId:'unknown-id'}),call(8,'session_list',{credentials:'not allowed'}),req(9,'ping')]);
    assert.equal(packets[0].error.code,-32700);assert.equal(packets[1].error.code,-32600);
    const by=new Map(packets.map(m=>[m.id,m]));assert.equal(by.get(1).result.protocolVersion,'2025-03-26');assert.equal(by.get(2).error.code,-32602);
    for(const id of [3,4,5,6,7,8])assert.equal(by.get(id).result.isError,true);
    assert.match(by.get(5).result.content[0].text,/LOCAL_SCOPE_DENIED/);
    assert.doesNotMatch(by.get(7).result.content[0].text,/private daemon diagnostic/);
    assert.deepEqual(by.get(9).result,{});assert.equal(f.requests.length,2);
  }finally{await f.close();}
});

test('real operator CLI: isolated agent endpoint, command→receipt/events, bad selector/empty-token failures before transport',{timeout:15000},async()=>{
  const f=await daemon();const cli=(...a:string[])=>exec(process.execPath,[script,...a,...f.flags],{env:f.env});
  try{
    assert.equal(JSON.parse((await cli('servers')).stdout).result.length,2);
    const admission=JSON.parse((await cli('command','--name','session.send','--server','alpha','--id','request-0001','--params','{"sessionId":"binding-1","text":"test"}')).stdout).result;
    assert.equal(admission.id,'work-123');assert.equal(admission.deliveryConfirmed,false);
    assert.equal(JSON.parse((await cli('receipt','--server','alpha','--work-id',admission.id)).stdout).result.status,'completed');
    assert.equal(JSON.parse((await cli('events','--session-id','binding-1','--server','alpha','--wait-ms','0')).stdout).result.nextCursor,'opaque-cursor');
    await assert.rejects(cli('command','--name','session.list','--server','alpha','--params','{"serverId":"other"}'),/Conflicting server/);
    await assert.rejects(cli('events','--session-id','binding-1','--url','https:\/\/elsewhere.invalid'),/Unknown option/);
    await assert.rejects(exec(process.execPath,[script,'mcp',...f.flags],{env:{...f.env,CONNECTOR_TOKEN:''}}),/Missing CONNECTOR_TOKEN/);
    assert.equal(JSON.parse((await cli('unwatch','--session-id','binding-1','--subscription-id','subscription-1','--server','alpha')).stdout).result.enabled,false);
    assert.equal(f.requests.length,5);
    await exec(process.execPath,[script,'init','--home',f.home,'--mode','local'],{env:f.env});
    for(const mode of ['slack','dual']){
      const dir=join(f.home,'fresh-'+mode);await exec(process.execPath,[script,'init','--home',dir,'--mode',mode],{env:f.env});
      const template=JSON.parse(readFileSync(join(dir,'config.json'),'utf8'));assert.equal(template.slack.enabled,true);assert.equal(template.local.enabled,mode==='dual');assert.equal(existsSync(join(dir,'api.token')),mode==='dual');
    }
    const config=JSON.parse(readFileSync(join(f.home,'config.json'),'utf8'));assert.deepEqual(config.slack,{enabled:false});assert.deepEqual(config.local,{enabled:true,agents:[]});
    // With a private operator token present, missing MCP env credentials must never fall back to it.
    const cleanEnv:NodeJS.ProcessEnv={...f.env};delete cleanEnv.CONNECTOR_TOKEN;
    await assert.rejects(exec(process.execPath,[script,'mcp','--home',f.home],{env:cleanEnv}),/Missing CONNECTOR_TOKEN/);
    // In Slack-only mode there is no loopback token to require for a config check.
    const slackOnly={...config,projects:{demo:f.home},backend:{executable:process.execPath},local:{enabled:false},slack:{teamId:'T1',inputChannel:'C1',outputChannel:'C1',allowedHumans:['U1'],approvalUsers:['U1'],trustedBots:[],dot:{name:'dot'}}};
    writeFileSync(join(f.home,'config.json'),JSON.stringify(slackOnly));rmSync(join(f.home,'api.token'));
    assert.match((await exec(process.execPath,[script,'doctor','--home',f.home],{env:cleanEnv})).stdout,/Codex was not launched/);
  }finally{await f.close();}
});

test('real MCP process → authenticated runtime → fake native backend: read, create, send, receipt and events without Slack',{timeout:30000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'connector-real-mcp-')),backend=new FakeBackend();
  const cfg=parseConfig({version:2,instanceId:'test-mcp',port:17381,approvalTimeoutSec:30,local:{enabled:true,agents:[{id:'mcp-test',tokenHash:createHash('sha256').update(token).digest('hex'),servers:['default'],projects:['demo'],commands:['server.list','session.create','session.list','session.send','session.events','session.history','session.delivery']}]},projects:{demo:root},backend:{executable:process.execPath}});
  let slackCalls=0;const forbidden=async()=>{slackCalls++;throw Error('Slack should not be touched');};
  const rt=new Runtime(cfg,join(root,'state'),{post:forbidden,resolveDot:forbidden,humanMessage:forbidden,threadExists:forbidden},undefined,()=>backend);
  const server=apiServer(rt,randomBytes(32).toString('hex'));
  try {
    await rt.connectLocal();await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
    const addr=server.address();assert.ok(addr&&typeof addr!=='string');
    const f={flags:['--target','test-mcp','--port',String(addr.port)],env:{...process.env,CONNECTOR_HOME:join(root,'nonexistent-operator-home'),CONNECTOR_TOKEN:token}};
    const tool=async(name:string,args:Record<string,unknown>={})=>{const packets=await run(f,[init(1),ready,call('r',name,args)]);return toolResult(packets.find(p=>p.id==='r'));};
    const receipt=async(w:any)=>{
      assert.equal(w.acceptance,'connector-inbox-only');assert.equal(w.deliveryConfirmed,false);assert.equal(w.serverId,'default');
      // Wait on the fixture ledger; verify that the independent client receives the same final result over the public API.
      await waitFor(()=>['completed','failed','uncertain'].includes(rt.core(w.serverId).store.state.work.find(r=>r.id===w.id)?.status??''));
      const r=await tool('receipt_get',{serverId:w.serverId,workId:w.id});assert.equal(r.status,'completed',r.error);return r;
    };
    assert.equal((await tool('server_list'))[0].serverId,'default');
    const create=await receipt(await tool('session_create',{requestId:'create-once-001',serverId:'default',project:'demo'}));
    const {sessionId,threadId}=create.result;assert.ok(sessionId&&threadId);
    const page=await receipt(await tool('session_list',{serverId:'default',project:'demo'}));assert.equal(page.result.sessions[0].id,threadId);
    const start=await tool('session_events',{serverId:'default',sessionId,waitMs:0});assert.ok(start.nextCursor&&start.subscriptionId);
    const send=await tool('session_send',{serverId:'default',requestId:'send-once-001',sessionId,text:'Test only'});
    const sent=await receipt(send);assert.ok(sent.delivery);assert.notEqual(sent.delivery.execution,'completed');
    backend.emit('notification','item/completed',{threadId,turnId:'turn-1',item:{id:'final-1',type:'agentMessage',phase:'final_answer',text:'Synthetic answer'}},backend.epoch);
    backend.emit('notification','turn/completed',{threadId,turn:{id:'turn-1',status:'completed'}},backend.epoch);
    const end=await tool('session_events',{serverId:'default',sessionId,cursor:start.nextCursor,waitMs:1000});
    assert.ok(end.events.some((e:any)=>e.type==='assistant.final'&&e.text==='Synthetic answer'&&e.workId===send.id));
    assert.ok(end.events.some((e:any)=>e.type==='turn.completed'&&e.workId===send.id));
    const stopped=await tool('session_unwatch',{serverId:'default',sessionId,subscriptionId:start.subscriptionId});assert.equal(stopped.enabled,false);
    assert.equal(slackCalls,0);assert.equal(backend.calls.filter(r=>r.method==='thread/queue/add').length,1);
  }finally{await new Promise<void>(r=>server.close(()=>r()));await rt.close();rmSync(root,{recursive:true,force:true});}
});
