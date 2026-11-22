import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { LocalEvents, type LocalEventScope } from '../src/local-events.js';
import type { State, Work } from '../src/types.js';
import { FakeBackend, request } from './helpers.js';

const A:LocalEventScope={project:'repo',sessionId:'s',threadId:'t',principal:'agent:A'},B={...A,principal:'agent:B'};
const now=Date.now();
const fresh=(exclusive=false):State=>({version:2,sessions:[{id:'s',threadId:'t',project:'repo',channel:exclusive?'':'COUT',
  localOwners:exclusive?[A.principal]:[A.principal,B.principal],createdAt:new Date(now-2000).toISOString()}],work:[],pending:[],outbox:[],seenEvents:{},seenNotifications:{}});
function work(id:string,principal:string,turnId?:string):Work {
  return {id,eventId:id,request:request('session.send',{sessionId:'s',text:'prompt'},id),source:{kind:principal==='slack'?'human':'local',userId:principal,channel:'',ts:'',threadTs:'',eventId:id},
    status:'completed',createdAt:new Date().toISOString(),messageDelivery:{threadId:'t',clientUserMessageId:id,queuedSubmissionId:'q-'+id,...(turnId?{turnId}:{}),
      admission:'accepted',start:turnId?'accepted':'not-requested',execution:turnId?'processing':'unknown',evidence:turnId?'queue-start-response':'queue-add-response',observationGap:false,observedAt:new Date().toISOString()}};
}
class Memory {
  constructor(private value:State){}
  get state(){return structuredClone(this.value);}
  transaction<T>(f:(draft:State)=>T):T {const d=structuredClone(this.value);const result=f(d);this.value=d;return result;}
}
function setup(exclusive=false,server='one'){
  const store=new Memory(fresh(exclusive)),backend=new FakeBackend();backend.connected=true;
  const events=new LocalEvents(store,backend,server);
  return {store,backend,events};
}
const item=(turnId:string,text:string,id='item',phase='final_answer')=>({threadId:'t',turnId,item:{type:'agentMessage',id,text,phase},completedAtMs:now});
const terminal=(turnId:string)=>({threadId:'t',turn:{id:turnId,status:'completed',completedAt:Math.floor(now/1000)}});
function pages(backend:FakeBackend,items:any[],turns:any[],partial=false){
  backend.rpc=async(method,params)=>{backend.calls.push({method,params});if(method==='thread/items/list')return {data:items,nextCursor:partial?'more':null};if(method==='thread/turns/list')return {data:turns,nextCursor:null};throw Error('unexpected RPC');};
}
test('capture independent of first poll; exact origin only on dual binding, stable replay IDs, scope-bound signed cursors',async()=>{
  const {events,store,backend}=setup();store.transaction(s=>s.work.push(work('a',A.principal,'own'),work('b',B.principal,'other'),work('c','slack','chat')));
  for(const [turn,text] of [['own','yes'],['other','another principal'],['chat','private slack'],['external','native desktop']] as const){
    events.observe('item/completed',item(turn,text),backend.epoch);events.observe('turn/completed',terminal(turn),backend.epoch);
  }
  events.observe('item/completed',item('own','old epoch','different'),'old');
  events.observe('item/completed',item('own','do not duplicate'),backend.epoch);
  events.observe('item/completed',item('own','not final','step','commentary'),backend.epoch);
  const a=events.subscribe(A),other=events.subscribe(B);assert.deepEqual(events.subscribe(A),a);
  const first=await events.poll(A,{...a,limit:1});assert.deepEqual(first.events.map(e=>e.type),['assistant.final']);assert.equal(first.hasMore,true);
  assert.equal((first.events[0] as any).text,'yes');assert.equal(first.events[0]!.workId,'a');
  const last=await events.poll(A,{subscriptionId:a.subscriptionId,cursor:first.nextCursor});assert.deepEqual(last.events.map(e=>e.type),['turn.completed']);
  assert.equal((await events.poll(A,{subscriptionId:a.subscriptionId})).events.length,2);
  assert.deepEqual((await events.poll(A,a)).events.map(e=>e.id),[first.events[0]!.id,last.events[0]!.id]);
  assert.ok(!JSON.stringify(store.state).includes('private slack'));assert.ok(!JSON.stringify(store.state).includes('native desktop'));
  await assert.rejects(events.poll(B,{subscriptionId:other.subscriptionId,cursor:first.nextCursor}),/CURSOR/);
  await assert.rejects(events.poll(A,{subscriptionId:other.subscriptionId}),/SUBSCRIPTION/);
  await assert.rejects(events.poll(A,{...a,cursor:'7.0.bad'}),/CURSOR/);
  assert.throws(()=>events.subscribe({...A,project:'other'}),/SCOPE/);
  // Equal native IDs on another server cannot consume this stream.
  const second=setup(false,'two');await assert.rejects(second.events.poll(A,{...second.events.subscribe(A),cursor:first.nextCursor}),/CURSOR/);
});
test('exclusive native binding is rechecked after sharing; competing origins, Slack observations and conflicts fail closed',async()=>{
  const {events,backend,store}=setup(true);
  events.observe('item/completed',item('desktop','one-owner output'),backend.epoch);
  const a=events.subscribe(A);assert.equal((await events.poll(A,a)).events[0]!.workId,null);
  store.transaction(s=>{s.sessions[0]!.channel='COUT';});
  const withheld=await events.poll(A,a);assert.equal(withheld.events.length,0);assert.equal(withheld.gap?.reason,'ownership_uncertain');
  events.observe('item/completed',item('desktop-new','not for a'),backend.epoch);
  assert.ok(!JSON.stringify(store.state).includes('not for a'));
  store.transaction(s=>{s.sessions[0]!.channel='';s.work.push(work('own',A.principal,'claimed'),work('slack','slack','claimed'));});
  events.observe('item/completed',item('claimed','ambiguous content'),backend.epoch);
  events.observe('item/completed',item('native','competing origin'),backend.epoch);
  assert.ok(!JSON.stringify(store.state).match(/ambiguous content|competing origin/));
  store.transaction(s=>{s.work=s.work.filter(w=>w.id!=='slack');s.work[0]!.messageDelivery!.correlationConflict=true;});
  events.observe('item/completed',item('claimed','conflicting content'),backend.epoch);assert.ok(!JSON.stringify(store.state).includes('conflicting content'));
  store.transaction(s=>{s.subscriptions=[{threadId:'t'} as any];});
  events.observe('item/completed',item('desktop','subscribed slack','new'),backend.epoch);assert.ok(!JSON.stringify(store.state).includes('subscribed slack'));
});
test('reconnect durably recovers terminal + final from supported read pages; missed exact client receipt, foreign turns and retries',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'local-event-restart-'));let store=new Store(dir);const backend=new FakeBackend();backend.connected=true;
  try{
    store.transaction(s=>Object.assign(s,fresh(),{work:[work('a',A.principal),work('c','slack','chat')]}));
    const events=new LocalEvents(store,backend,'server'),a=events.subscribe(A);
    pages(backend,[item('chat','private'),item('own','recovered'),{turnId:'own',item:{type:'userMessage',id:'user',clientId:'a',content:[]}}],[terminal('chat').turn,terminal('own').turn]);
    store.close();store=new Store(dir);backend.epoch='new';const reloaded=new LocalEvents(store,backend,'server');
    await Promise.all([reloaded.recover(A),reloaded.recover(A)]);
    const result=await reloaded.poll(A,a);assert.deepEqual(result.events.map(e=>e.type),['assistant.final','turn.completed']);
    assert.ok(result.gap?.historyRecovered);assert.ok(result.events.every(e=>e.workId==='a'&&e.turnId==='own'));
    assert.equal(store.state.work[0]!.messageDelivery!.turnId,'own');assert.ok(!JSON.stringify(store.state).includes('private'));
    await reloaded.recover(A);assert.deepEqual(backend.calls.map(c=>c.method),['thread/turns/list','thread/items/list']);
    reloaded.observe('item/completed',item('own','duplicate after recovery'),backend.epoch);
    assert.equal((await reloaded.poll(A,{subscriptionId:a.subscriptionId,cursor:result.nextCursor})).events.length,0);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('unsupported or partial history yields explicit gap, not false delivery; excludes native history before exclusive attachment',async()=>{
  const {store,backend,events}=setup(true),a=events.subscribe(A);backend.rpc=async()=>{throw Error('unsupported INTERNAL SECRET');};
  await events.recover(A);let r=await events.poll(A,a);assert.deepEqual(r.gap,{reason:'history_unavailable',historyRecovered:false});assert.equal(r.events.length,0);
  pages(backend,[{...item('old','never import'),completedAtMs:now-60000},item('native','recent')],[terminal('native').turn],true);backend.epoch='another';
  events.markDisconnected();await events.recover(A);r=await events.poll(A,a);
  assert.equal(r.gap?.reason,'history_window_incomplete');assert.deepEqual(r.events.map(e=>e.turnId),['native','native']);
  assert.ok(!JSON.stringify(store.state).includes('never import'));assert.ok(!JSON.stringify(store.state).includes('INTERNAL SECRET'));
});
test('retention gap, response size, redaction before clipping; cancellation and bounded interruptible waits',async()=>{
  const {store,backend,events}=setup(true),a=events.subscribe(A);
  const waiting=events.poll(A,{...a,waitMs:30000});
  events.observe('item/completed',item('native','one'),backend.epoch);assert.equal((await waiting).events.length,1);
  const secret='x'.repeat(8500)+' password = "actual-fake-credential"';
  events.observe('item/completed',item('native',secret,'sensitive'),backend.epoch);
  const e=(await events.poll(A,a)).events.at(-1) as any;assert.equal(e.withheld,true);assert.equal(e.text,null);assert.ok(!JSON.stringify(store.state).includes('actual-fake-credential'));
  for(let i=0;i<110;i++)events.observe('item/completed',item('native','中'.repeat(8192),String(i)),backend.epoch);
  const page=await events.poll(A,a);assert.equal(page.gap?.reason,'journal_retention');assert.ok(page.events.length>=1&&page.events.length<=100);assert.ok(Buffer.byteLength(JSON.stringify(page))<=256*1024);
  for(const q of [{limit:101},{waitMs:30001},{limit:0},{waitMs:-1}])await assert.rejects(events.poll(A,{...a,...q}),/QUERY/);
  const ctl=new AbortController(),p=events.poll(A,{subscriptionId:a.subscriptionId,cursor:page.nextCursor,waitMs:30000},ctl.signal);ctl.abort();assert.equal((await p).events.length,0);
  const revoked=events.poll(A,{subscriptionId:a.subscriptionId,cursor:page.nextCursor,waitMs:30000});events.cancel(A,a.subscriptionId);await assert.rejects(revoked,/SUBSCRIPTION/);
  assert.equal(events.list(A.principal).length,0);assert.notEqual(events.subscribe(A).subscriptionId,a.subscriptionId);
});
test('epoch or binding revoked mid-read discards content; mixed claims found during recovery cannot leak',async()=>{
  const {backend,events,store}=setup();store.transaction(s=>s.work.push(work('a',A.principal,'own')));const a=events.subscribe(A);
  backend.rpc=async m=>{if(m==='thread/turns/list')return {data:[terminal('own').turn],nextCursor:null};backend.epoch='switched';return {data:[item('own','foreign')],nextCursor:null};};
  await events.recover(A);assert.ok(!JSON.stringify(store.state).includes('foreign'));assert.equal((await events.poll(A,a)).gap?.reason,'history_unavailable');
  backend.rpc=async m=>{if(m==='thread/turns/list')return {data:[terminal('own').turn],nextCursor:null};store.transaction(s=>{s.sessions[0]!.localOwners=[];});return {data:[item('own','moved')],nextCursor:null};};
  await events.recover(A);await assert.rejects(events.poll(A,a),/SCOPE/);assert.ok(!JSON.stringify(store.state).includes('moved'));
});
test('fixed local action notice never stores privileged RPC details or sends a backend reply',async()=>{
  const {backend,events,store}=setup();store.transaction(s=>s.work.push(work('a',A.principal,'own'),work('c','slack','chat')));
  const request=(turnId:string,epoch:string,method='item/commandExecution/requestApproval')=>({epoch,method,params:{turnId,threadId:'t',command:'do-not-export',itemId:'hidden-item',questions:['sensitive question']}});
  for(const turnId of ['chat','native','own','own'])events.observeRequest(request(turnId,backend.epoch));
  events.observeRequest(request('own',backend.epoch,'unsupported'));
  const a=events.subscribe(A),page=await events.poll(A,a);assert.equal(page.events.length,1);
  assert.deepEqual(page.events[0],{id:page.events[0]!.id,workId:'a',turnId:'own',type:'local.action_required',text:'This turn requested local interaction. Check the original Codex UI.'});
  assert.ok(!JSON.stringify(store.state).match(/sensitive question|do-not-export|hidden-item|requestApproval/));assert.equal(backend.responses.length,0);assert.equal(backend.calls.length,0);
});
test('new exact ownership evidence in same epoch permits bounded history reconciliation',async()=>{
  const {backend,events,store}=setup();store.transaction(s=>s.work.push(work('a',A.principal)));
  pages(backend,[],[]);const a=events.subscribe(A);await events.recover(A);assert.equal((await events.poll(A,a)).events.length,0);
  store.transaction(s=>{s.work[0]=work('a',A.principal,'late');});
  pages(backend,[item('late','earlier than queue/start acknowledgement')],[terminal('late').turn]);await events.recover(A);
  assert.equal((await events.poll(A,a)).events.length,2);assert.deepEqual(backend.calls.map(c=>c.method),['thread/turns/list','thread/items/list','thread/turns/list','thread/items/list']);
});
test('independent bounded native pagination recovers second-page evidence, handles repeated cursor, and never replays mutations',async()=>{
  const {backend,events,store}=setup();store.transaction(s=>s.work.push(work('a',A.principal)));const a=events.subscribe(A);
  const user={turnId:'mine',item:{id:'user',type:'userMessage',clientId:'a'}};
  backend.rpc=async(method,p)=>{
    backend.calls.push({method,params:p});
    if(method==='thread/turns/list')return p.cursor?{data:[terminal('mine').turn],nextCursor:null}:{data:[terminal('other').turn],nextCursor:'turn-page'};
    if(method==='thread/items/list')return p.cursor?{data:[item('mine','safe'),user],nextCursor:'item-page'}:{data:[item('other','private')],nextCursor:'item-page'};
    throw Error('forbidden');
  };
  await events.recover(A);const r=await events.poll(A,a);
  assert.deepEqual(r.events.map(e=>e.type),['assistant.final','turn.completed']);assert.equal(r.gap?.reason,'history_window_incomplete');
  assert.ok(!JSON.stringify(store.state).includes('private'));assert.equal(store.state.work[0]!.messageDelivery?.execution,'completed');
  assert.deepEqual(backend.calls.map(c=>[c.method,c.params.cursor]),[['thread/turns/list',undefined],['thread/turns/list','turn-page'],['thread/items/list',undefined],['thread/items/list','item-page']]);
});
test('mixed native-turn user inputs in recovered history deny ownership even across different item pages',async()=>{
  const {backend,events,store}=setup();store.transaction(s=>s.work.push(work('a',A.principal),work('c','slack')));
  const e=(id:string)=>({turnId:'collision',item:{type:'userMessage',id:'input-'+id,clientId:id}});
  backend.rpc=async(method,p)=>method==='thread/turns/list'?{data:[terminal('collision').turn],nextCursor:null}:
    p.cursor?{data:[e('c')],nextCursor:null}:{data:[item('collision','not authorized'),e('a')],nextCursor:'second'};
  await events.recover(A);const r=await events.poll(A,events.subscribe(A));assert.equal(r.events.length,0);
  assert.equal(r.gap?.reason,'ownership_uncertain');assert.ok(!JSON.stringify(store.state).includes('not authorized'));
  assert.equal(store.state.work[0]!.messageDelivery!.execution,'completed');assert.equal(store.state.work[0]!.messageDelivery!.correlationConflict,undefined);
});
test('after reconnect without a live observer, bounded readback refresh finds later native events in same epoch',async t=>{
  t.mock.timers.enable({apis:['Date'],now});
  const {backend,events}=setup(true);const a=events.subscribe(A);pages(backend,[],[]);await events.recover(A);
  pages(backend,[item('later','new Desktop work')],[terminal('later').turn]);await events.recover(A);assert.equal((await events.poll(A,a)).events.length,0);
  t.mock.timers.tick(6000);await events.recover(A);assert.deepEqual((await events.poll(A,a)).events.map(e=>e.type),['assistant.final','turn.completed']);
});
test('mixed or missing clientId suppresses local event content independently of a verified submission receipt (live and persisted)',async()=>{
  const {store,backend,events}=setup();
  store.transaction(s=>s.work.push(work('submitted',A.principal,'proven')));
  const a=events.subscribe(A);
  events.observe('item/completed',item('proven','earlier final'),backend.epoch);
  events.observe('item/started',{threadId:'t',turnId:'proven',item:{type:'userMessage',id:'later-user-item'}},backend.epoch);
  events.observe('item/completed',item('proven','after ambiguous input','later-final'),backend.epoch);
  let r=await events.poll(A,a);assert.equal(r.events.length,0);assert.equal(r.gap?.reason,'ownership_uncertain');
  pages(backend,[item('proven','after ambiguous input','later-final'),{turnId:'proven',item:{type:'userMessage',id:'omitted-client-id'}}],[terminal('proven').turn]);
  const reopened=new LocalEvents(store,backend,'one');await reopened.recover(A);r=await reopened.poll(A,a);
  assert.equal(r.events.length,0);assert.equal(r.gap?.reason,'ownership_uncertain');assert.ok(!JSON.stringify(store.state).includes('after ambiguous input'));
  const d=store.state.work[0]!.messageDelivery!;
  assert.equal(d.start,'accepted');assert.equal(d.execution,'completed');assert.equal(d.correlationConflict,undefined);
});
