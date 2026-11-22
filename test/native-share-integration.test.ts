import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash,randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseConfig } from '../src/config.js';
import { Runtime } from '../src/runtime.js';
import { apiServer } from '../src/server.js';
import type { SlackPort } from '../src/types.js';
import { FakeBackend,FakeThreads,rootThread,event,request,waitFor } from './helpers.js';

const ORIGINAL='00000000-1111-7111-8111-100000000001', FRESH='00000000-1111-7111-8111-200000000001';
const ROOT='101.2', OTHER='201.3', OP='c'.repeat(48), AGENT='d'.repeat(48), BIRTH=1763800000;
const asTurn=(id:string,status:string,items:any[]=[])=>({id,status,itemsView:'full',items});
const reply=(id:string,text:string,phase='final_answer')=>({id,type:'agentMessage',text,phase});
function deferred<T=void>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return{resolve,promise};}
interface Ledgers { threads:FakeThreads; turns:Map<string,any[]>; createCount:number }
class NativeBackend extends FakeBackend{
  onStart?:(thread:any)=>Promise<any>;
  beforeRead?:(threadId:string)=>Promise<void>;
  withoutLiveTurns=false;
  liveItems=new Map<string,any[]>();
  constructor(private ledger:Ledgers,private project:string){
    super();this.threads=ledger.threads;this.epoch=randomUUID();
  }
  get observation(){return{version:'0.171.0-alpha.13',homeVerified:this.connected,checkedAt:'2026-11-22T00:00:00Z'};}
  private rows(id:string){return this.ledger.turns.get(id)??[];}
  override async rpc(method:string,p:any):Promise<any>{
    if(method==='thread/start'){
      this.calls.push({method,params:p});
      const n=++this.ledger.createCount,id=n===1?FRESH:randomUUID().replace(/^(.{14})4/,(_m,head)=>head+'7');
      const thread=rootThread(id,p.cwd,{source:'appServer',createdAt:BIRTH+n,status:{type:'idle'},canAcceptDirectInput:true,turns:[],ephemeral:false});
      this.threads.set(id,thread);this.ledger.turns.set(id,[]);
      return this.onStart?this.onStart(structuredClone(thread)):{thread:structuredClone(thread)};
    }
    if(method==='thread/read'){
      await this.beforeRead?.(p.threadId);
      return super.rpc(method,p);
    }
    if(method==='thread/turns/list'){
      this.calls.push({method,params:p});
      const rows=this.rows(p.threadId).filter(t=>!this.withoutLiveTurns||t.status!=='inProgress');
      const start=Number(p.cursor??0),data=rows.slice(start,start+p.limit).map(t=>({...t,itemsView:p.itemsView,items:p.itemsView==='notLoaded'?[]:t.items}));
      return{data,nextCursor:start+data.length<rows.length?String(start+data.length):null};
    }
    if(method==='thread/items/list'){
      this.calls.push({method,params:p});
      const row=this.rows(p.threadId).find(t=>t.id===p.turnId);
      const data=row?.status==='inProgress'?this.liveItems.get(p.threadId)??[]:(row?.items??[]).map((item:any)=>({turnId:p.turnId,item,startedAtMs:null,completedAtMs:null}));
      return{data,nextCursor:null};
    }
    return super.rpc(method,p);
  }
  notice(method:string,threadId:string,p:any={}){this.emit('notification',method,{threadId,...p},this.epoch);}
  publish(threadId:string,turnId:string,items:any[]){
    const rows=this.rows(threadId),old=rows.findIndex(t=>t.id===turnId);
    if(old>=0)rows[old]=asTurn(turnId,'completed',items);else rows.unshift(asTurn(turnId,'completed',items));
    this.threads.get(threadId).status={type:'idle'};
    this.notice('turn/completed',threadId,{turn:{id:turnId,status:'completed'}});
  }
  ongoing(threadId:string,turnId:string,items:any[]=[],waiting=false){
    this.rows(threadId).unshift(asTurn(turnId,'inProgress',items));
    this.liveItems.set(threadId,items.map(item=>({turnId,item,startedAtMs:BIRTH*1000,completedAtMs:BIRTH*1000+1})));
    this.threads.get(threadId).status={type:'active',activeFlags:waiting?['waitingOnUserInput']:[]};
    this.notice('turn/started',threadId,{turn:{id:turnId,status:'inProgress'}});
    for(const item of items)this.notice('item/completed',threadId,{turnId,item});
  }
  ask(threadId:string,turnId:string,itemId:string,id:number,question:string,opts:{secret?:boolean;qid?:string}={}){
    this.emit('request',{id,epoch:this.epoch,method:'item/tool/requestUserInput',params:{threadId,turnId,itemId,
      questions:[{id:opts.qid??' layout_id'.trim(),header:'Layout choice',question,isOther:false,isSecret:opts.secret??false,options:[{label:'Compact',description:'One option.'},{label:'Spacious',description:'Another option.'}]}]}});
  }
}
async function fixture(n=1){
  const directory=mkdtempSync(join(tmpdir(),'dedicated-native-')),project=join(directory,'book');mkdirSync(project);
  const ids=Array.from({length:n},(_,i)=>i===0?'default':'extra'+i);
  const paths=ids.map(id=>join(directory,'home-'+id));paths.forEach(p=>mkdirSync(p));
  const cfg=parseConfig({version:2,instanceId:'test',port:19781,approvalTimeoutSec:30,projects:{book:project},
    backends:Object.fromEntries(ids.map((id,i)=>[id,{executable:process.execPath,codexHome:paths[i],...(i===0?{aliases:['primary']}: {})}])),
    slack:{teamId:'T1',inputChannel:'CIN',outputChannel:'COUT',allowedHumans:['U1'],approvalUsers:['U1'],trustedBots:[{botId:'BDOT',userId:'UDOT',appId:'ADOT'}],servers:ids,dot:{name:'dot',userId:'UDOT'}},
    local:{enabled:true,agents:[{id:'test-agent',tokenHash:createHash('sha256').update(AGENT).digest('hex'),servers:ids,projects:['book'],commands:['server.list']}]}
  });
  const stores=new Map<string,Ledgers>(),backends=new Map<string,NativeBackend>();
  const posts:{channel:string;text:string;root?:string;id:string}[]=[];
  let rootCheck:((root:string)=>Promise<boolean>)|undefined,postFault:((text:string)=>void)|undefined;
  const slack:SlackPort={async post(channel,text,o){posts.push({channel,text,root:o.threadTs,id:o.deliveryId});postFault?.(text);return '444.2';},
    async resolveDot(){return{userId:'UDOT',name:'dot'};},async threadExists(){throw Error('Use exact root verification');},
    async verifySharedRoot(_,ts){return rootCheck?Promise.race([rootCheck(ts),sleep(1500,false,{ref:false})]):true;},async humanMessage(){return undefined;}};
  const init=()=>{
    const r=new Runtime(cfg,join(directory,'connector'),slack,undefined,(_p,id)=>{
      let data=stores.get(id);
      if(!data){
        data={threads:new FakeThreads([[ORIGINAL,rootThread(ORIGINAL,project,{createdAt:BIRTH,status:{type:'idle'},canAcceptDirectInput:true})]]),
          turns:new Map([[ORIGINAL,[asTurn('old-history','completed',[reply('old-item','Original private history.')])]]]),createCount:0};
        stores.set(id,data);
      }
      const b=new NativeBackend(data,project);backends.set(id,b);return b;
    });
    for(const core of r.cores.values())Object.assign(core,{postIntervalMs:0});
    return r;
  };
  let runtime=init();
  const start=async(bot='BSELF')=>{await runtime.connectLocal();await runtime.enableSlack('USELF',bot);};
  const subscribe=async(root=ROOT,id='default',thread=ORIGINAL)=>{
    const q=request('session.subscribe',{serverId:id,threadId:thread}),core=runtime.core(id);
    assert.ok(runtime.accept(event(q,{thread_ts:root})));
    await waitFor(()=>core.store.state.work.some(w=>w.request.id===q.id&&w.status==='completed'));
    return core.store.state.subscriptions!.find(s=>s.owner.threadTs===root&&s.threadId===thread)!.id;
  };
  const preview=async(id:string,server='default')=>await runtime.nativeShare(server,'preview-create',id) as {
    confirmationId:string;confirmationPhrase:string;disclosure:string;project:string;workspaceId:string;channel:string;rootThreadTs:string;boundaryPolicy:string
  };
  type Result={status:string;reason:string|null;newSubscriptionId:string|null;newNativeThreadId:string|null;sharing?:{status:string}};
  const create=async(id:string,server='default')=>{const p=await preview(id,server);return await runtime.nativeShare(server,'create',id,p.confirmationId,p.confirmationPhrase) as Result;};
  const inspect=(id:string,server='default')=>runtime.nativeShare(server,'inspect',id) as {status:string;reason:string|null;dedicatedCreation:Result|null};
  return {directory,project,ids,stores,backends,posts,subscribe,preview,create,inspect,start,get runtime(){return runtime;},
    rootCheck(fn?:typeof rootCheck){rootCheck=fn;},fault(fn?:typeof postFault){postFault=fn;},
    async restart(bot?:string){await runtime.close();runtime=init();await start(bot);},
    async close(){await runtime.close();rmSync(directory,{force:true,recursive:true});}
  };
}
type F=Awaited<ReturnType<typeof fixture>>;
const observed=(f:F,needle:string,root=ROOT)=>waitFor(()=>f.posts.some(p=>p.text.includes(needle)&&p.root===root));
const never=(f:F,needle:string)=>assert.ok(!f.posts.some(p=>p.text.includes(needle)),needle);

test('existing native history, late events and unverifiable boundaries never enable body sharing; new session needs typed scope',async()=>{
  const f=await fixture();try{
    await f.start();const source=await f.subscribe(),b=f.backends.get('default')!,core=f.runtime.core('default');
    assert.throws(()=>f.runtime.nativeShare('default','preview',source),/EXISTING_SESSION_UNSUPPORTED/);
    assert.throws(()=>f.runtime.nativeShare('default','grant',source,'prior-code','old-consent'),/EXISTING_SESSION_UNSUPPORTED/);
    b.ongoing(ORIGINAL,'old-live',[reply('old-active','An original native replay must stay local.','commentary')],true);
    b.ask(ORIGINAL,'old-live','same-question',7,'Does a private question stay local?');
    const offer=await f.preview(source);
    assert.match(offer.disclosure,/Create a new, empty Codex session/);assert.match(offer.disclosure,/No existing Codex session or history is shared/);
    assert.match(offer.disclosure,/work started while setup is running/);
    assert.deepEqual([offer.project,offer.workspaceId,offer.channel,offer.rootThreadTs],['book','T1','CIN',ROOT]);
    assert.equal(offer.confirmationPhrase,'CREATE AND SHARE NEW CODEX SESSION TO T1/CIN/'+ROOT);
    await assert.rejects(async()=>f.runtime.nativeShare('default','create',source,offer.confirmationId,'SHARE AFTER NATIVE CUT'),/CONFIRMATION_REQUIRED/);
    assert.equal(b.calls.filter(c=>['thread/turns/list','thread/start'].includes(c.method)).length,0);
    const other=await f.subscribe(OTHER),newOffer=await f.preview(source);
    await assert.rejects(async()=>f.runtime.nativeShare('default','create',other,newOffer.confirmationId,newOffer.confirmationPhrase),/CONFIRMATION_REQUIRED/);
    assert.throws(()=>f.runtime.nativeShare('primary','inspect',source),/SERVER_UNAVAILABLE/);
    b.onStart=async(thread)=>{
      assert.equal(core.store.state.nativeShareCreations!.at(-1)!.status,'creating');
      assert.equal(core.store.state.nativeShares?.length??0,0);
      b.publish(ORIGINAL,'old-live',[reply('old-active','An original native replay must stay local.')]);
      return{thread};
    };
    const created=await f.create(source);
    assert.equal(created.status,'proven');assert.equal(created.newNativeThreadId,FRESH);assert.equal(created.sharing?.status,'active');
    assert.equal(f.inspect(source).status,'unshared');assert.equal(f.inspect(created.newSubscriptionId!).status,'active');
    assert.deepEqual(b.calls.find(c=>c.method==='thread/start')!.params,{cwd:f.project,ephemeral:false});
    assert.ok(!b.calls.some(c=>c.method==='thread/turns/list'&&c.params.threadId===ORIGINAL));
    b.publish(FRESH,'fresh-answer',[reply('good','This new session has a welcome response.')]);
    await observed(f,'new session has a welcome response');
    assert.ok(!f.posts.some(p=>p.root===OTHER&&p.text.includes('welcome response')));
    ['Original private history','original native replay','private question stays local'].forEach(x=>never(f,x));
  }finally{await f.close();}
});

test('dedicated setup holds only fresh same-epoch live questions, even if the persisted active turn is late',async()=>{
  const f=await fixture();try{
    await f.start();const source=await f.subscribe(),b=f.backends.get('default')!,core=f.runtime.core('default');
    const entered=deferred(),resume=deferred();let held=false;
    b.beforeRead=async(threadId)=>{if(threadId===FRESH){b.threads.get(FRESH).createdAt++;if(!held){held=true;entered.resolve();await resume.promise;}}};
    const creation=f.create(source);await entered.promise;
    const row=core.store.state.nativeShares![0]!;
    assert.equal(row.state,'pending');assert.equal(row.nativeThreadId,FRESH);
    assert.equal(f.inspect(source).dedicatedCreation?.newSubscriptionId,row.subscriptionId);
    b.withoutLiveTurns=true;
    b.ongoing(FRESH,'fresh-running',[reply('plain-while-setup','How should we arrange the new outline?','commentary')],true);
    b.ask(FRESH,'fresh-running','setup-question',72,'Which layout is suitable for the new outline?');
    b.ask(FRESH,'fresh-running','setup-resolved',73,'The resolved setup choice must not appear?');
    b.notice('serverRequest/resolved',FRESH,{requestId:73});
    b.ask(FRESH,'fresh-running','secret',74,'The secret test question?',{secret:true});
    b.ask(FRESH,'fresh-running','approval',75,'A benign-looking app approval must stay native?',{qid:'mcp_tool_call_approval_approval'});
    b.notice('item/started',FRESH,{turnId:'fresh-running',item:{id:'earlier-tool',type:'mcpToolCall'}});
    b.ask(FRESH,'fresh-running','earlier-tool',76,'A matching native action must stay native?');
    b.notice('item/agentMessage/delta',FRESH,{turnId:'fresh-running',delta:'Raw stream is not shared.'});
    assert.equal(core.store.state.outbox.filter(o=>o.nativeShare).length,0);
    assert.ok(!JSON.stringify(core.store.state).includes('Which layout is suitable'));
    resume.resolve();await creation;
    await observed(f,'Which layout is suitable');
    const question=f.posts.find(p=>p.text.includes('Which layout is suitable'))!;
    assert.match(question.text,/Layout choice\nWhich layout is suitable[^\n]+\n• Compact\n• Spacious/);
    assert.match(question.text,/Answer in the original Codex window/);assert.doesNotMatch(question.text,/One option|layout_id/);
    b.withoutLiveTurns=false;b.notice('item/completed',FRESH,{turnId:'fresh-running',item:reply('plain-while-setup','How should we arrange the new outline?','commentary')});
    await observed(f,'arrange the new outline');
    b.publish(FRESH,'fresh-running',[reply('plain-while-setup','How should we arrange the new outline?','commentary'),
      reply('final','The new outline is ready.'),{id:'user',type:'userMessage',content:[{type:'text',text:'Local user input is not shared.'}]},
      {id:'tool',type:'commandExecution',aggregatedOutput:'Raw tool result is not shared.'},reply('secret-tail','Your password: demo-secret-tail')]);
    await observed(f,'new outline is ready');
    assert.equal(f.posts.filter(p=>p.text.includes('arrange the new outline')).length,1);
    ['resolved setup choice','secret test question','benign-looking app approval','matching native action','Raw stream','Local user input','Raw tool result','demo-secret-tail'].forEach(x=>never(f,x));
    assert.equal(b.responses.length,0);assert.ok(!b.calls.some(c=>c.method==='turn/interrupt'));
  }finally{await f.close();}
});

test('a lost or contradictory thread/start response is uncertain, never auto-retries, never adopts an old ID',async()=>{
  const f=await fixture();try{
    await f.start();const source=await f.subscribe(),b=f.backends.get('default')!;
    b.onStart=async()=>{throw Error('Response lost after native creation');};
    const outcome=await f.create(source);
    assert.equal(outcome.status,'uncertain');assert.equal(outcome.newNativeThreadId,null);
    assert.equal(f.stores.get('default')!.createCount,1);
    await f.restart();
    assert.equal(f.inspect(source).dedicatedCreation?.status,'uncertain');
    await assert.rejects(()=>f.create(source),/ALREADY_PENDING/);
    assert.equal(f.stores.get('default')!.createCount,1);
    f.runtime.nativeShare('default','revoke',source);
    const fresh=f.backends.get('default')!;
    fresh.onStart=async()=>({thread:{...fresh.threads.get(ORIGINAL),sessionId:ORIGINAL,turns:[],forkedFromId:null,parentThreadId:null,attachedToThreadId:null,ephemeral:false}});
    const bad=await f.create(source);
    assert.equal(bad.status,'uncertain');assert.equal(bad.newNativeThreadId,null);
    fresh.publish(ORIGINAL,'old-id-response',[reply('failed-birth','Do not adopt a known old thread returned from creation.')]);
    await sleep(30);never(f,'known old thread');
    assert.equal(f.runtime.core('default').store.state.nativeShares?.length??0,0);
    assert.equal(f.stores.get('default')!.createCount,2);
    f.runtime.nativeShare('default','revoke',source);
    fresh.onStart=async(thread)=>({thread:{...thread,attachedToThreadId:ORIGINAL}});
    const attached=await f.create(source);
    assert.equal(attached.status,'uncertain');assert.equal(attached.newNativeThreadId,null);
    assert.equal(f.runtime.core('default').store.state.nativeShares?.length??0,0);
  }finally{await f.close();}
});

test('restart while a native create is in flight never reuses the unacknowledged fresh thread',async()=>{
  const f=await fixture();try{
    await f.start();
    const source=await f.subscribe(),before=f.backends.get('default')!;
    const entered=deferred(),abandoned=deferred<any>();
    before.onStart=async()=>{entered.resolve();return abandoned.promise;};
    // Model a process exit before receiving an acknowledgement. Deliberately
    // do not resolve work in the old process after reopening the same ledger.
    void f.create(source).catch(()=>{});
    await entered.promise;
    assert.equal(f.inspect(source).dedicatedCreation?.status,'creating');
    assert.equal(f.stores.get('default')!.createCount,1);
    await f.restart();
    assert.equal(f.inspect(source).dedicatedCreation?.status,'uncertain');
    assert.equal(f.inspect(source).dedicatedCreation?.newNativeThreadId,null);
    await assert.rejects(()=>f.create(source),/ALREADY_PENDING/);
    const after=f.backends.get('default')!;
    after.publish(FRESH,'orphan-new-turn',[reply('orphan-new-body','This unacknowledged fresh thread must never post.')]);
    await sleep(30);never(f,'unacknowledged fresh thread');
    assert.equal(f.stores.get('default')!.createCount,1);
  }finally{await f.close();}
});

test('exact consent cannot follow live destination/identity changes or a revoked creation',async()=>{
  const f=await fixture();try{
    await f.start();const source=await f.subscribe();
    f.rootCheck(async()=>false);
    const refused=await f.create(source);
    assert.equal(refused.status,'failed');assert.equal(refused.reason,'NATIVE_SHARE_DESTINATION_UNVERIFIED');assert.equal(f.stores.get('default')!.createCount,0);
    f.rootCheck();
    let entered=deferred(),release=deferred();
    const b=f.backends.get('default')!;
    b.onStart=async(thread)=>{entered.resolve();await release.promise;return{thread};};
    const task=f.create(source);await entered.promise;
    await f.runtime.enableSlack('USELF','CHANGEDBOT');
    release.resolve();
    assert.equal((await task).status,'uncertain');
    assert.equal(f.runtime.core('default').store.state.nativeShares?.length??0,0);
    f.runtime.nativeShare('default','revoke',source);
    entered=deferred();release=deferred();
    const next=f.create(source);await entered.promise;
    const revoke=await f.runtime.nativeShare('default','revoke',source);
    assert.ok('inFlightMayStillCreate' in revoke&&revoke.inFlightMayStillCreate===true);
    release.resolve();assert.equal((await next).status,'revoked');
    assert.equal(f.runtime.core('default').store.state.nativeShares?.length??0,0);
  }finally{await f.close();}
});

test('the new subscription can be unsubscribed or revoked; rollback and failed post permission remain closed',async()=>{
  const f=await fixture();try{
    await f.start();const source=await f.subscribe(),initial=await f.create(source),b=f.backends.get('default')!,core=f.runtime.core('default');
    const stop=request('session.unsubscribe',{serverId:'default',subscriptionId:initial.newSubscriptionId});
    assert.ok(f.runtime.accept(event(stop,{thread_ts:ROOT})));
    await waitFor(()=>core.store.state.work.some(w=>w.request.id===stop.id&&w.status==='completed'));
    b.publish(initial.newNativeThreadId!,'cancelled',[reply('after-cancel','Do not share after unsubscribe.')]);
    await waitFor(()=>f.inspect(initial.newSubscriptionId!).status==='retired');never(f,'after unsubscribe.');
    const second=await f.create(source),third=await f.create(source);
    assert.equal(second.status,'proven');assert.equal(third.status,'proven');
    f.runtime.nativeShare('default','revoke',second.newSubscriptionId!);
    b.publish(second.newNativeThreadId!,'operator-revoked',[reply('after-revoke','No body after local revoke.')]);
    b.notice('thread/rolledBack',third.newNativeThreadId!);
    assert.equal(f.inspect(third.newSubscriptionId!).status,'retired');
    b.publish(third.newNativeThreadId!,'rolled', [reply('after-rollback','No body after native rollback.')]);
    const fourth=await f.create(source);
    f.fault(text=>{if(text.includes('Posting lost membership'))throw Object.assign(Error('refused'),{code:'slack_webapi_platform_error',data:{error:'not_in_channel'}});});
    b.publish(fourth.newNativeThreadId!,'lost-slack',[reply('blocked','Posting lost membership.'),reply('follow-up','Do not follow up after denied membership.')]);
    await waitFor(()=>f.inspect(fourth.newSubscriptionId!).status==='retired');
    ['body after local revoke','body after native rollback','follow up after denied'].forEach(x=>never(f,x));
  }finally{await f.close();}
});

test('identical native thread, turn, item and RPC IDs are isolated across three Homes; prior tool evidence survives reconnect',async()=>{
  const f=await fixture(3);try{
    await f.start();const roots=[ROOT,'211.2','311.2'];
    const seeds=await Promise.all(f.ids.map((id,i)=>f.subscribe(roots[i]!,id)));
    const grants=await Promise.all(seeds.map((id,i)=>f.create(id,f.ids[i])));
    assert.ok(grants.every(g=>g.newNativeThreadId===FRESH));
    const first=f.backends.get('default')!;
    first.ongoing(FRESH,'same-turn',[],true);
    first.notice('item/started',FRESH,{turnId:'same-turn',item:{id:'same-item',type:'mcpToolCall'}});
    first.ask(FRESH,'same-turn','same-item',101,'This tool-linked question must not escape?');
    await sleep(35);never(f,'tool-linked question');
    const deny=f.runtime.core('default').store.state.nativeShares![0]!.questionDeny;
    assert.equal(deny?.length,1);
    await f.restart();
    await Promise.all(grants.map((g,i)=>waitFor(()=>f.inspect(g.newSubscriptionId!,f.ids[i]).status==='active')));
    f.ids.forEach((id,i)=>{
      const b=f.backends.get(id)!;
      if(i>0)b.ongoing(FRESH,'same-turn',[],true);
      b.ask(FRESH,'same-turn','same-item',101,'Which style should Home '+(i+1)+' use?');
    });
    await observed(f,'Home 2 use?',roots[1]);await observed(f,'Home 3 use?',roots[2]);
    never(f,'Home 1 use?');
    assert.ok(!f.posts.some(p=>p.text.includes('Home 2 use?')&&p.root!==roots[1]));
    assert.ok(!f.posts.some(p=>p.text.includes('Home 3 use?')&&p.root!==roots[2]));
    assert.deepEqual(f.runtime.core('default').store.state.nativeShares![0]!.questionDeny,deny);
  }finally{await f.close();}
});

test('offline recovery remains causal on a proven new ID; a resolved offline question and uncertain Slack post are never retried',async()=>{
  const f=await fixture();try{
    await f.start();const source=await f.subscribe(),created=await f.create(source),b=f.backends.get('default')!,core=f.runtime.core('default');
    const rootEntered=deferred(),release=deferred<boolean>();
    f.rootCheck(async()=>{rootEntered.resolve();return release.promise;});
    b.ongoing(FRESH,'offline-turn',[],true);
    b.ask(FRESH,'offline-turn','offline-question',22,'A question resolved offline must not appear?');
    await rootEntered.promise;
    b.connected=false;b.emit('disconnect',b.epoch);
    b.publish(FRESH,'offline-turn',[reply('offline-final','An eligible response is recovered on reconnect.')]);
    release.resolve(true);f.rootCheck();
    await f.restart();
    f.runtime.core('default').store.transaction(d=>{for(const o of d.outbox)if(o.nativeShare&&o.status==='queued')o.nextAttemptAt=0;});
    f.runtime.core('default').flush();
    await observed(f,'eligible response is recovered');
    never(f,'question resolved offline');
    f.fault(text=>{if(text.includes('Slack transport uncertain'))throw Error('unknown outcome');});
    f.backends.get('default')!.publish(FRESH,'uncertain-turn',[reply('uncertain','Slack transport uncertain for this reply.')]);
    const fresh=f.runtime.core('default');
    await waitFor(()=>fresh.store.state.outbox.some(o=>o.nativeShare?.projection.itemId==='uncertain'&&o.status==='uncertain'));
    const old=fresh.store.state.outbox.find(o=>o.nativeShare?.projection.itemId==='uncertain')!;
    assert.throws(()=>f.runtime.recover('outbox',old.id),/SCOPE_UNVERIFIED/);
    assert.equal(f.posts.filter(p=>p.text.includes('Slack transport uncertain')).length,1);
  }finally{await f.close();}
});

test('legacy snapshot authorization cannot resume and scoped loopback credentials cannot create sharing sessions',async()=>{
  const f=await fixture();const api=apiServer(f.runtime,OP);
  await new Promise<void>(r=>api.listen(0,'127.0.0.1',r));const port=(api.address() as {port:number}).port;
  const http=(body:any,auth=OP)=>fetch('http://127.0.0.1:'+port+'/v1/command',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+auth},body:JSON.stringify(body)});
  try{
    await f.start();const source=await f.subscribe();
    for(const operation of ['inspect','preview-create','create','revoke']){
      assert.equal((await http({action:'native.share',operation,serverId:'default',subscriptionId:source},AGENT)).status,403);
    }
    const obsolete=await http({action:'native.share',operation:'preview',serverId:'default',subscriptionId:source});
    assert.deepEqual(await obsolete.json(),{error:'NATIVE_SHARE_EXISTING_SESSION_UNSUPPORTED'});
    const newSession=await f.create(source);
    f.runtime.core('default').store.transaction(d=>{
      const grant=d.nativeShares![0]!;grant.consentVersion=3;grant.boundaryPolicy='first-verified-native-frontier-v1';delete grant.creationId;
    });
    await f.restart();
    assert.equal(f.inspect(newSession.newSubscriptionId!).status,'retired');
    assert.equal(f.inspect(newSession.newSubscriptionId!).reason,'NATIVE_SHARE_EXPLICIT_REAUTHORIZATION_REQUIRED');
    f.backends.get('default')!.publish(FRESH,'old-policy',[reply('old-activation','An older cutoff policy does not grant this body.')]);
    await sleep(30);never(f,'older cutoff policy');
  }finally{await new Promise<void>(r=>{api.close(()=>r());api.closeAllConnections();});await f.close();}
});


test('dedicated sharing preview reclassifies the observed source; a child may not authorize new dedicated creation',async()=>{
  const f=await fixture();try{
    await f.start();const source=await f.subscribe(),b=f.backends.get('default')!;
    b.threads.get(ORIGINAL).parentThreadId='other-root';
    await assert.rejects(f.preview(source),/NATIVE_SHARE_THREAD_CHANGED/);
    assert.equal(b.calls.filter(c=>c.method==='thread/start').length,0);
    assert.equal(f.runtime.core('default').store.state.nativeShares?.length??0,0);
  }finally{await f.close();}
});

test('a positive thread/start acknowledgement carrying child lineage cannot establish Slack sharing',async()=>{
  const f=await fixture();try{
    await f.start();const source=await f.subscribe(),b=f.backends.get('default')!;
    b.onStart=async thread=>{
      const child={...thread,source:{subAgent:{other:'native-child'}}};
      b.threads.raw(thread.id,child);return {thread:child};
    };
    const result=await f.create(source);
    assert.equal(result.status,'uncertain');assert.equal(result.newSubscriptionId,null);
    assert.ok(!f.runtime.core('default').store.state.nativeShares?.some(row=>row.nativeThreadId===FRESH));
    b.publish(FRESH,'child-turn',[reply('child-text','Dedicated-child body must stay private.')]);
    await sleep(35);
    never(f,'Dedicated-child body');
    assert.equal(b.calls.filter(c=>c.method==='thread/start').length,1);
    assert.ok(!b.calls.some(c=>['thread/resume','thread/turns/list','thread/items/list'].includes(c.method)&&c.params.threadId===FRESH));
  }finally{await f.close();}
});

test('an existing dedicated grant may not resume observation after root lineage becomes unverified',async()=>{
  const f=await fixture();try{
    await f.start();const source=await f.subscribe(),created=await f.create(source);
    assert.equal(created.sharing?.status,'active');const id=created.newSubscriptionId!;
    f.stores.get('default')!.threads.get(FRESH).source='unknown';
    await f.restart();
    const b=f.backends.get('default')!;
    assert.notEqual(f.inspect(id).status,'active');
    assert.ok(!b.calls.some(c=>c.method==='thread/resume'&&c.params.threadId===FRESH));
    b.publish(FRESH,'unverified-turn',[reply('unverified','Unknown lineage body should stay private.')]);
    await sleep(35);
    never(f,'Unknown lineage body');
    assert.ok(!b.calls.some(c=>['thread/turns/list','thread/items/list'].includes(c.method)&&c.params.threadId===FRESH));
  }finally{await f.close();}
});
