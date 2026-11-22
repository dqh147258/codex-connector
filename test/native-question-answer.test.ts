import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync,mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseConfig } from '../src/config.js';
import { Runtime } from '../src/runtime.js';
import { SlackClient } from '../src/slack.js';
import { SlackLink } from '../src/slack-link.js';
import { SocketModeClient } from '@slack/socket-mode';
import type { SlackPort } from '../src/types.js';
import type { SlackQuestionOrigin as Origin } from '../src/slack-questions.js';
import { FakeBackend,FakeThreads,event,request,waitFor } from './helpers.js';

const ORIGINAL='00000000-1111-7111-8111-100000000001';
const DEDICATED='00000000-1111-7111-8111-200000000001';
const TURN='native-turn-common', ITEM='native-question-common', RPC=848, BIRTH=1763800100;
const FORM_ONE='f'.repeat(32), FORM_TWO='g'.repeat(32);
const APP='AQUESTIONS', ACCOUNT='T1', CHANNEL='CIN', PERMITTED='U1', NONDELEGATED='U2';
interface Card {channel:string;root:string;ts:string;text:string;reference?:string;count?:number}
type NativeOffer={id:string|number;method:string;params:{
  threadId:string;turnId:string;itemId:string;isBlocking:boolean;autoResolutionMs:number|null;
  questions:{id:string;header:string;question:string;isOther:boolean;isSecret:boolean;options:{label:string;description:string}[]}[];
}};
type Model={threads:FakeThreads;turns:Map<string,any[]>;requests:Map<string,NativeOffer>};
function deferred<T=void>(){let resolve!:(x:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return{resolve,promise};}
const ordinary=(text='Which layout would you like for the preview?'):NativeOffer=>({id:RPC,method:'item/tool/requestUserInput',params:{
  threadId:DEDICATED,turnId:TURN,itemId:ITEM,isBlocking:true,autoResolutionMs:null,
  questions:[{id:'layout_key',header:'Choose layout',question:text,isOther:false,isSecret:false,
    options:[{label:'Compact',description:'Uses a compact layout.'},{label:'Spacious',description:'Uses a spacious layout.'}]}],
}});
const thread=(id:string,cwd:string,createdAt:number)=>({id,sessionId:id,cwd,createdAt,source:'appServer',threadSource:'user',
  parentThreadId:null,forkedFromId:null,attachedToThreadId:null,ephemeral:false,turns:[],canAcceptDirectInput:true,status:{type:'idle'}});
class Native extends FakeBackend {
  respondHook?:(id:string|number,result:unknown)=>Promise<void>;
  expectedEpochs:(string|undefined)[]=[];
  constructor(private model:Model,private replayOnResume:()=>boolean){
    super();this.threads=model.threads;this.epoch=randomUUID();
  }
  get observation(){return{checkedAt:'2026-11-22T00:00:00Z',version:'0.171.0-alpha.13',homeVerified:this.connected};}
  override async rpc(method:string,p:any):Promise<any>{
    if(method==='thread/start'){
      this.calls.push({method,params:p});
      assert.equal(this.model.threads.has(DEDICATED),false,'a backend must not auto-create a replacement');
      const meta=thread(DEDICATED,p.cwd,BIRTH+1);this.model.threads.set(DEDICATED,meta);this.model.turns.set(DEDICATED,[]);
      return{thread:structuredClone(meta)};
    }
    if(method==='thread/resume'){
      const meta=await super.rpc(method,p);
      // Mock only the official still-pending callback replay on the resumed
      // connection. No request is reconstructed from stored history.
      if(this.replayOnResume()&&p.threadId===DEDICATED)for(const q of this.model.requests.values())this.emitRequest(q);
      return meta;
    }
    if(method==='thread/turns/list'){
      this.calls.push({method,params:p});const raw=this.model.turns.get(p.threadId)??[],from=Number(p.cursor??0);
      const data=raw.slice(from,from+p.limit).map(t=>({...t,itemsView:p.itemsView,items:p.itemsView==='notLoaded'?[]:t.items}));
      return{data,nextCursor:from+data.length<raw.length?String(from+data.length):null};
    }
    if(method==='thread/items/list'){
      this.calls.push({method,params:p});
      const rows=this.model.turns.get(p.threadId)??[];
      const selected=p.turnId?rows.filter(t=>t.id===p.turnId):rows;
      return {data:selected.flatMap(t=>t.items.map((item:unknown)=>({turnId:t.id,item,startedAtMs:BIRTH*1000,completedAtMs:BIRTH*1000+1}))),nextCursor:null};
    }
    return super.rpc(method,p);
  }
  override async respond(id:string|number,result:unknown,expectedEpoch?:string){
    this.expectedEpochs.push(expectedEpoch);
    await super.respond(id,result);await this.respondHook?.(id,result);
  }
  emitRequest(q:NativeOffer){this.emit('request',{...structuredClone(q),epoch:this.epoch});}
  ask(q:NativeOffer){
    const {threadId,turnId}=q.params,meta=this.model.threads.get(threadId);assert.ok(meta);
    const rows=this.model.turns.get(threadId)??[];
    if(!rows.some(t=>t.id===turnId)){
      rows.unshift({id:turnId,status:'inProgress',itemsView:'full',items:[]});this.model.turns.set(threadId,rows);
    }
    meta.status={type:'active',activeFlags:['waitingOnUserInput']};
    this.model.requests.set(String(q.id),structuredClone(q));
    this.emit('notification','turn/started',{threadId,turn:{id:turnId,status:'inProgress'}},this.epoch);
    this.emitRequest(q);
  }
  resolveRequest(id:string|number,threadId=DEDICATED){
    this.model.requests.delete(String(id));
    this.emit('notification','serverRequest/resolved',{threadId,requestId:id},this.epoch);
  }
}
async function fixture(homes=1,sdkWire=false){
  const dir=mkdtempSync(join(tmpdir(),'native-question-answers-')),project=join(dir,'project');mkdirSync(project);
  const ids=Array.from({length:homes},(_,i)=>i===0?'default':'extra'+i);
  const homesMap=Object.fromEntries(ids.map(id=>{
    const home=join(dir,'home-'+id);mkdirSync(home);return [id,{executable:process.execPath,codexHome:home}];
  }));
  const cfg=parseConfig({version:2,instanceId:'test',port:19782,approvalTimeoutSec:120,
    projects:{book:project},backends:homesMap,
    slack:{teamId:ACCOUNT,inputChannel:CHANNEL,outputChannel:'COUT',allowedHumans:[PERMITTED,NONDELEGATED],
      approvalUsers:[PERMITTED,NONDELEGATED],trustedBots:[{botId:'BDOT',userId:'UDOT',appId:'ADOT'}],servers:ids,dot:{name:'dot',userId:'UDOT'}},
    local:{enabled:true},
  });
  const model=new Map<string,Model>(),backends=new Map<string,Native>(),posts:Card[]=[];
  let checkRoot: (channel:string,ts:string)=>Promise<boolean>=async()=>true;
  let postHook:((value:Card)=>Promise<void>)|undefined;
  let replay=false;
  const slack:SlackPort={
    questionActionsAvailable:()=>true,questionAppId:()=>APP,
    async post(channel,text,options){
      const action=options.questionAction;
      const card:Card={channel,root:options.threadTs!,ts:'420.'+(posts.length+1),text,reference:action?.reference,count:action?.questionCount};
      posts.push(card);await postHook?.(card);return card.ts;
    },
    async resolveDot(){return{userId:'UDOT',name:'dot'};},
    async threadExists(){throw Error('Must verify actual root');},
    verifySharedRoot(channel,ts){return checkRoot(channel,ts);},
    async humanMessage(){return undefined;},
  };
  const sdk=sdkWire?new SocketModeClient({appToken:'test-no-credential',autoReconnectEnabled:false}):undefined;
  const web=sdk?new SlackClient('test-no-credential'):undefined,apiPosts:any[]=[],forms:any[]=[],statusUpdates:any[]=[];
  let link:SlackLink|undefined,seq=0,viewSeq=0;
  if(sdk&&web){
    (sdk as any).start=async()=>({});(sdk as any).disconnect=async()=>{};(sdk as any).send=async()=>{};
    (web.web as any).axios.defaults.adapter=()=>{throw Error('External network disabled in SDK fixture');};
    web.resolveDot=slack.resolveDot;
    const api=async(method:string,opts:any):Promise<any>=>{
      if(method==='auth.test')return {ok:true,team_id:ACCOUNT,user_id:'USELF',bot_id:'BSELF'};
      if(method==='bots.info')return {ok:true,bot:{id:'BSELF',user_id:'USELF',app_id:APP,deleted:false}};
      if(method==='users.info')return {ok:true,user:{id:opts.user,team_id:ACCOUNT,deleted:false,is_bot:false,is_app_user:false,profile:{}}};
      if(method==='chat.postMessage'){
        const ts='450.'+(apiPosts.length+1);apiPosts.push({...opts,ts});return {ok:true,channel:opts.channel,ts};
      }
      if(method==='conversations.history'){
        assert.equal(opts.oldest,opts.latest);assert.equal(opts.inclusive,true);
        return {ok:true,messages:await checkRoot(opts.channel,opts.oldest)?[{ts:opts.oldest}]:[]};
      }
      if(method==='views.open')return {ok:true,view:{...opts.view,id:'VNATIVE'+(++viewSeq),team_id:ACCOUNT,app_id:APP}};
      if(method==='views.update'){
        if(opts.view.submit)forms.push({...opts.view,id:opts.view_id,team_id:ACCOUNT,app_id:APP});else statusUpdates.push(opts.view);
        return {ok:true};
      }
      throw Error('Unrecognized SDK request in fixture: '+method);
    };
    for(const method of ['auth.test','bots.info','users.info','chat.postMessage','conversations.history','views.open','views.update']){
      const [component,route]=method.split('.') as [string,string];
      (web.web as any)[component][route]=(opts:any)=>api(method,opts);
    }
  }
  const wire=async(payload:any)=>{
    assert.ok(sdk);await (sdk as any).onWebSocketMessage(Buffer.from(JSON.stringify({type:'interactive',envelope_id:'test-'+(++seq),accepts_response_payload:true,payload})),false);
  };
  function init(){
    const r=new Runtime(cfg,join(dir,'connector'),web??slack,undefined,(_profile,id)=>{
      let data=model.get(id);
      if(!data){data={threads:new FakeThreads([[ORIGINAL,thread(ORIGINAL,project,BIRTH)]]),turns:new Map([[ORIGINAL,[]]]),requests:new Map()};model.set(id,data);}
      const b=new Native(data,()=>replay);backends.set(id,b);return b;
    });
    for(const core of r.cores.values())Object.assign(core,{postIntervalMs:0});
    return r;
  }
  let rt=init();
  const start=async()=>{
    await rt.connectLocal();
    if(sdk&&web){
      link=new SlackLink(ACCOUNT,rt,()=>web.web.auth.test(),()=>sdk,{client:web,gateway:rt});
      await link.connect();
    }else await rt.enableSlack('USELF','BSELF');
  };
  await start();
  return { cfg,ids,model,backends,posts,apiPosts,forms,statusUpdates,wire,get rt(){return rt;},get gateway(){return rt;},
    root(fn:(channel:string,ts:string)=>Promise<boolean>){checkRoot=fn;},
    onPost(hook?:typeof postHook){postHook=hook;},
    async dedicated(server='default',root='101.2',responders:readonly string[]|null=[PERMITTED]){
      const q=request('session.subscribe',{serverId:server,threadId:ORIGINAL}),core=rt.core(server);
      assert.ok(rt.accept(event(q,{thread_ts:root})));
      await waitFor(()=>core.store.state.work.some(w=>w.request.id===q.id&&['completed','failed','uncertain'].includes(w.status)));
      assert.equal(core.store.state.work.find(w=>w.request.id===q.id)?.status,'completed');
      const sub=core.store.state.subscriptions?.find(s=>s.owner.threadTs===root&&s.threadId===ORIGINAL);
      assert.ok(sub);
      const shown=await rt.nativeShare(server,'preview-create',sub.id,undefined,undefined,responders?[...responders]:undefined) as {
        confirmationId:string;confirmationPhrase:string;answerUsers?:string[];
      };
      assert.deepEqual(shown.answerUsers??[],responders??[]);
      if(responders?.length)assert.ok(responders.every(user=>shown.confirmationPhrase.includes(user)));
      const made=await rt.nativeShare(server,'create',sub.id,shown.confirmationId,shown.confirmationPhrase) as {
        status:string;newNativeThreadId:string|null;newSubscriptionId:string|null;sharing?:{status:string};
      };
      assert.equal(made.status,'proven');assert.equal(made.newNativeThreadId,DEDICATED);
      assert.equal(made.sharing?.status,'active');
      return made.newSubscriptionId!;
    },
    async waitCard(text:string,root='101.2'){
      await waitFor(()=>posts.some(p=>p.root===root&&p.text.includes(text)));
      return posts.find(p=>p.root===root&&p.text.includes(text))!;
    },
    async restart(withReplay:boolean){
      await rt.close();replay=withReplay;rt=init();await start();
    },
    async close(){await link?.close();await rt.close();rmSync(dir,{recursive:true,force:true});},
  };
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
const origin=(card:Card,changes:Partial<Origin>={}):Origin=>{
  assert.ok(card.reference,'fixture is expected to be an actionable posted question');
  return{teamId:ACCOUNT,appId:APP,userId:PERMITTED,channel:card.channel,rootThreadTs:card.root,messageTs:card.ts,reference:card.reference,...changes};
};
const replyJSON=(value:unknown)=>JSON.parse(JSON.stringify(value));
const nativeResponses=(f:Fixture,server='default')=>f.backends.get(server)!.responses.map(r=>({id:r.id,result:replyJSON(r.result)}));
async function eligible(f:Fixture,q=ordinary(),server='default',root='101.2'){
  f.backends.get(server)!.ask(q);
  const card=await f.waitCard(q.params.questions[0]!.question,root);
  await waitFor(()=>f.rt.core(server).store.state.nativeQuestionAnswers?.some(r=>r.status==='posted'&&r.messageTs===card.ts)===true);
  return origin(card);
}

test('authorized choices bind the acknowledged Slack card to exactly one typed native callback',async()=>{
  const f=await fixture(),release=deferred();try{
    await f.dedicated();
    const q=ordinary();q.id='native-rpc-string';
    q.params.questions.push({id:'tone_key',header:'Choose tone',question:'What tone fits this preview?',isOther:false,isSecret:false,
      options:[{label:'Quiet',description:'A quieter tone.'},{label:'Bright',description:'A brighter tone.'}]});
    const b=f.backends.get('default')!;
    f.onPost(async card=>{if(card.reference)await release.promise;});
    b.ask(q);
    await waitFor(()=>f.posts.some(c=>c.reference));
    const card=await f.waitCard(q.params.questions[0]!.question);
    assert.equal(card.count,2);
    assert.equal(await f.gateway.openQuestion(origin(card)),undefined,'No answerable reference before Slack acknowledges its actual message');
    assert.deepEqual(nativeResponses(f),[]);
    release.resolve();f.onPost();
    await waitFor(()=>f.rt.core('default').store.state.nativeQuestionAnswers?.some(x=>x.status==='posted'&&x.messageTs===card.ts)===true);
    const a=origin(card);
    assert.deepEqual(await f.gateway.openQuestion(a),{questions:[
      {header:'Choose layout',question:'Which layout would you like for the preview?',labels:['Compact','Spacious']},
      {header:'Choose tone',question:'What tone fits this preview?',labels:['Quiet','Bright']},
    ]});
    assert.ok(!card.text.includes('layout_key')&&!card.text.includes('tone_key')&&!card.text.includes('Uses a compact layout.'));
    for(const invalid of [[0],[1,2],[-1,0],[0,1.5]])assert.equal(await f.gateway.submitQuestion(a,invalid,FORM_ONE),'denied');
    assert.deepEqual(nativeResponses(f),[]);
    assert.equal(await f.gateway.submitQuestion(a,[1,0],FORM_ONE),'submitted');
    assert.deepEqual(nativeResponses(f),[{id:'native-rpc-string',result:{answers:{
      layout_key:{answers:['Spacious']},tone_key:{answers:['Quiet']},
    }}}]);
    assert.deepEqual(b.expectedEpochs,[b.epoch]);
    assert.equal(await f.gateway.submitQuestion(a,[1,0],FORM_ONE),'submitted','Identical form and selections get the exact previous receipt');
    assert.equal(await f.gateway.submitQuestion(a,[0,1],FORM_ONE),'prior-answer','A replay using the same nonce must not claim a different selection was sent');
    assert.equal(await f.gateway.submitQuestion(a,[1,0],FORM_TWO),'prior-answer','A different form must not claim a receipt for an identical choice');
    assert.equal(await f.gateway.submitQuestion(a,[0,1],FORM_TWO),'prior-answer','A different form must not claim the first form’s receipt');
    assert.equal(nativeResponses(f).length,1);
    assert.equal(f.rt.core('default').store.state.nativeQuestionAnswers?.at(-1)?.status,'submitted');
  }finally{release.resolve();await f.close();}
});

test('owner-selected humans and exact app/team/root/channel/message/reference are rechecked at open and submit',async()=>{
  const f=await fixture();try{
    const grant=await f.dedicated(),valid=await eligible(f);
    for(const patch of [{userId:NONDELEGATED},{userId:'UDOT'},{appId:'ASPOOF'},{teamId:'TWRONG'},
      {channel:'COUT'},{rootThreadTs:'202.4'},{messageTs:'420.099'},{reference:'reference-that-was-never-posted'}]){
      const variant={...valid,...patch};
      assert.equal(await f.gateway.openQuestion(variant),undefined,JSON.stringify(patch));
      assert.notEqual(await f.gateway.submitQuestion(variant,[0],FORM_ONE),'submitted');
    }
    assert.ok(await f.gateway.openQuestion(valid));
    await f.rt.nativeShare('default','revoke',grant);
    assert.equal(await f.gateway.openQuestion(valid),undefined);
    assert.notEqual(await f.gateway.submitQuestion(valid,[0],FORM_ONE),'submitted');
    assert.deepEqual(nativeResponses(f),[]);
  }finally{await f.close();}
});

test('identical native identities across three verified Homes are dispatched only by the selected post reference',async()=>{
  const f=await fixture(3);try{
    const roots=['101.2','201.3','301.4'];
    for(const [i,id] of f.ids.entries())await f.dedicated(id,roots[i]!);
    const offers=await Promise.all(f.ids.map((id,i)=>eligible(f,ordinary(),id,roots[i]!)));
    assert.equal(new Set(offers.map(o=>o.reference)).size,3);
    assert.equal(await f.gateway.openQuestion({...offers[2]!,reference:offers[0]!.reference}),undefined);
    assert.equal(await f.gateway.submitQuestion(offers[2]!,[0],FORM_ONE),'submitted');
    assert.deepEqual(nativeResponses(f,'default'),[]);assert.deepEqual(nativeResponses(f,'extra1'),[]);
    assert.deepEqual(nativeResponses(f,'extra2'),[{id:RPC,result:{answers:{layout_key:{answers:['Compact']}}}}]);
  }finally{await f.close();}
});

test('native UI resolution during Slack submission preflight wins even if the waiting flag persists',async()=>{
  const f=await fixture(),release=deferred();try{
    await f.dedicated();
    const a=await eligible(f),b=f.backends.get('default')!;
    assert.ok(await f.gateway.openQuestion(a));
    let checking=false;
    f.root(async()=>{checking=true;await release.promise;return true;});
    const submit=f.gateway.submitQuestion(a,[0],FORM_ONE);
    await waitFor(()=>checking);
    b.resolveRequest(RPC);
    await waitFor(()=>f.rt.core('default').store.state.nativeQuestionAnswers?.at(-1)?.status==='closed');
    assert.deepEqual(f.model.get('default')!.threads.get(DEDICATED).status.activeFlags,['waitingOnUserInput']);
    release.resolve();
    assert.equal(await submit,'closed');
    assert.equal(await f.gateway.openQuestion(a),undefined);
    assert.equal(await f.gateway.submitQuestion(a,[0],FORM_ONE),'closed');
    f.rt.core('default').store.transaction(d=>{delete d.nativeQuestionAnswers!.at(-1)!.nativeClosed;});
    assert.equal(await f.gateway.submitQuestion(a,[0],FORM_ONE),'unavailable','Old ambiguous closure rows must not claim a positive native close');
    assert.deepEqual(nativeResponses(f),[]);
    assert.ok(!b.calls.some(c=>['turn/interrupt','turn/start','turn/steer'].includes(c.method)));
  }finally{release.resolve();await f.close();}
});

test('an uncertain native response consumes its reference despite concurrent submissions or a later authenticated replay',async()=>{
  const f=await fixture(),release=deferred();try{
    await f.dedicated();
    const a=await eligible(f),firstBackend=f.backends.get('default')!;
    firstBackend.respondHook=async()=>{await release.promise;throw Error('Synthetic transport lost after write');};
    const attempted=f.gateway.submitQuestion(a,[0],FORM_ONE);
    await waitFor(()=>firstBackend.responses.length===1);
    const repeat=f.gateway.submitQuestion(a,[1],FORM_ONE);
    const second=f.gateway.submitQuestion(a,[1],FORM_TWO);
    release.resolve();
    assert.equal(await attempted,'unconfirmed');
    assert.equal(await repeat,'unconfirmed');
    assert.equal(await second,'unconfirmed');
    assert.equal(firstBackend.responses.length,1);assert.deepEqual(firstBackend.expectedEpochs,[firstBackend.epoch]);
    assert.equal(f.rt.core('default').store.state.nativeQuestionAnswers?.at(-1)?.status,'uncertain');
    await f.restart(true);
    const current=f.backends.get('default')!;
    assert.notEqual(current.epoch,firstBackend.epoch);
    await waitFor(()=>current.calls.some(c=>c.method==='thread/resume'&&c.params.threadId===DEDICATED));
    current.emitRequest(ordinary());await sleep(35);
    assert.equal(await f.gateway.openQuestion(a),undefined);
    assert.notEqual(await f.gateway.submitQuestion(a,[0],FORM_ONE),'submitted');
    assert.equal(current.responses.length,0);assert.equal(firstBackend.responses.length,1);
    assert.equal(f.posts.filter(p=>p.reference).length,1);
  }finally{release.resolve();await f.close();}
});

test('old share consent and free-text native requests may notify, but cannot generate an answer handle',async()=>{
  const f=await fixture(2);try{
    await f.dedicated('default','101.2',null);
    await f.dedicated('extra1','201.3');
    const nominal=ordinary('Which preview fits the old grant?'),free=ordinary('Which new preview would you like?');
    free.params.questions[0]!.isOther=true;
    f.backends.get('default')!.ask(nominal);f.backends.get('extra1')!.ask(free);
    const a=await f.waitCard(nominal.params.questions[0]!.question),b=await f.waitCard(free.params.questions[0]!.question,'201.3');
    assert.equal(a.reference,undefined);assert.equal(b.reference,undefined);
    assert.ok(a.text.includes('original Codex')&&b.text.includes('original Codex'));
    for(const c of [a,b]){
      const bad:Origin={teamId:ACCOUNT,appId:APP,userId:PERMITTED,channel:c.channel,rootThreadTs:c.root,messageTs:c.ts,reference:'forged-not-posted-question-reference'};
      assert.equal(await f.gateway.openQuestion(bad),undefined);
      assert.notEqual(await f.gateway.submitQuestion(bad,[0],FORM_ONE),'submitted');
    }
    assert.deepEqual(nativeResponses(f,'default'),[]);assert.deepEqual(nativeResponses(f,'extra1'),[]);
  }finally{await f.close();}
});


test('a changed native descriptor invalidates the old choice mapping; replay cannot restore it',async()=>{
  const f=await fixture();try{
    await f.dedicated();const a=await eligible(f),b=f.backends.get('default')!;
    assert.ok(await f.gateway.openQuestion(a));
    const updated=ordinary('Which revised layout fits the preview?');
    updated.params.questions[0]!.options.reverse();
    b.emitRequest(updated);
    assert.notEqual(await f.gateway.submitQuestion(a,[0],FORM_ONE),'submitted');
    assert.equal(await f.gateway.openQuestion(a),undefined);
    b.emitRequest(ordinary());await sleep(30);
    assert.equal(await f.gateway.openQuestion(a),undefined);
    assert.deepEqual(nativeResponses(f),[]);
  }finally{await f.close();}
});

test('only a genuine still-pending replay after reconnect can post a new card for an unattempted native answer',async()=>{
  const f=await fixture();try{
    await f.dedicated();
    const live=ordinary();live.params.autoResolutionMs=30_000;
    const old=await eligible(f,live);
    const expiry=f.rt.core('default').store.state.nativeQuestionAnswers?.at(-1)?.expiresAt;
    assert.ok(expiry);
    const previousBackend=f.backends.get('default')!;
    await f.restart(false);
    const b=f.backends.get('default')!;
    assert.notEqual(b.epoch,previousBackend.epoch);
    assert.equal(await f.gateway.openQuestion(old),undefined);
    assert.notEqual(await f.gateway.submitQuestion(old,[0],FORM_ONE),'submitted');
    assert.equal(f.posts.filter(p=>p.reference).length,1,'waiting flag does not recreate a callback');
    assert.equal(b.responses.length,0);
    b.emit('notification','turn/started',{threadId:DEDICATED,turn:{id:TURN,status:'inProgress'}},b.epoch);
    assert.equal(await f.gateway.openQuestion(old),undefined);
    assert.equal(f.posts.filter(p=>p.reference).length,1);
    b.emitRequest(live);
    await waitFor(()=>f.posts.some(p=>p.reference&&p.reference!==old.reference));
    const card=f.posts.find(p=>p.reference&&p.reference!==old.reference)!;
    await waitFor(()=>f.rt.core('default').store.state.nativeQuestionAnswers?.some(x=>x.status==='posted'&&x.messageTs===card.ts)===true);
    assert.equal(await f.gateway.openQuestion(old),undefined);
    assert.equal(f.rt.core('default').store.state.nativeQuestionAnswers?.at(-1)?.expiresAt,expiry,'replayed relative expiry cannot extend the original window');
    const fresh=origin(card);
    assert.notEqual(fresh.messageTs,old.messageTs);
    assert.ok(await f.gateway.openQuestion(fresh));
    assert.equal(await f.gateway.submitQuestion(fresh,[1],FORM_ONE),'submitted');
    assert.deepEqual(nativeResponses(f),[{id:RPC,result:{answers:{layout_key:{answers:['Spacious']}}}}]);
    assert.deepEqual(previousBackend.responses,[]);
  }finally{await f.close();}
});

test('temporary root verification failure, allowed-human revocation, and clock margin cannot authorize native dispatch',async()=>{
  const f=await fixture();try{
    await f.dedicated();
    const a=await eligible(f);
    assert.ok(await f.gateway.openQuestion(a));
    f.root(async()=>false);
    assert.notEqual(await f.gateway.submitQuestion(a,[1],FORM_ONE),'submitted');
    assert.deepEqual(nativeResponses(f),[]);
  }finally{await f.close();}
  const f2=await fixture();try{
    await f2.dedicated();
    const a=await eligible(f2);
    f2.cfg.slack.allowedHumans.splice(f2.cfg.slack.allowedHumans.indexOf(PERMITTED),1);
    assert.equal(await f2.gateway.openQuestion(a),undefined);
    assert.notEqual(await f2.gateway.submitQuestion(a,[1],FORM_ONE),'submitted');
    assert.deepEqual(nativeResponses(f2),[]);
  }finally{await f2.close();}
  const f3=await fixture();try{
    await f3.dedicated();
    const soon=ordinary('Which preview briefly remains available?');soon.params.autoResolutionMs=1000;
    f3.backends.get('default')!.ask(soon);
    const c=await f3.waitCard(soon.params.questions[0]!.question);
    assert.equal(c.reference,undefined,'short native deadline only yields a notice');
    assert.deepEqual(nativeResponses(f3),[]);
  }finally{await f3.close();}
});


const cardClick=(msg:any,triggerId:string)=>({type:'block_actions',team:{id:ACCOUNT},api_app_id:APP,user:{id:PERMITTED,team_id:ACCOUNT},
  channel:{id:CHANNEL},container:{type:'message',channel_id:CHANNEL,message_ts:msg.ts,is_ephemeral:false},
  message:{type:'message',user:'USELF',bot_id:'BSELF',thread_ts:'101.2',ts:msg.ts},trigger_id:triggerId,
  actions:[{...msg.blocks[1].elements[0],block_id:msg.blocks[1].block_id}]});
const cardSubmit=(view:any,choice:string)=>({type:'view_submission',team:{id:ACCOUNT},api_app_id:APP,user:{id:PERMITTED},view:{
  ...view,state:{values:{q0:{pick:{type:'static_select',selected_option:{value:choice}}}}}
}});
async function sdkCard(f:Fixture,question:string){
  f.backends.get('default')!.ask(ordinary(question));
  await waitFor(()=>f.apiPosts.some(p=>p.blocks?.[1]?.elements?.[0]?.value));
  const msg=f.apiPosts.find(p=>p.blocks?.[1]?.elements?.[0]?.value)!;
  await waitFor(()=>f.rt.core('default').store.state.nativeQuestionAnswers?.some(q=>q.status==='posted'&&q.messageTs===msg.ts)===true);
  return msg;
}

test('live Slack SDK parser and posted modal complete an exact typed native response end to end',async()=>{
  const f=await fixture(1,true);try{
    await f.dedicated();
    const msg=await sdkCard(f,'Which layout should this SDK example use?');
    assert.equal(msg.thread_ts,'101.2');assert.equal(msg.reply_broadcast,false);
    assert.match(msg.blocks[0].text.text,/SDK example/);
    await f.wire(cardClick(msg,'test-opaque-trigger-first'));await waitFor(()=>f.forms.length===1);
    await f.wire(cardClick(msg,'test-opaque-trigger-second'));await waitFor(()=>f.forms.length===2);
    assert.notEqual(f.forms[0].private_metadata,f.forms[1].private_metadata);
    assert.notEqual(f.forms[0].id,f.forms[1].id);
    const submit=(i:number,choice:string)=>cardSubmit(f.forms[i],choice);
    await f.wire(submit(0,'1'));await f.wire(submit(0,'1'));await f.wire(submit(0,'0'));
    await waitFor(()=>f.statusUpdates.some(r=>JSON.stringify(r).includes('其他客户端')));
    await f.wire(submit(1,'0'));
    await waitFor(()=>f.statusUpdates.some(r=>JSON.stringify(r).includes('已有一份答复')));
    assert.equal(f.statusUpdates.filter(r=>JSON.stringify(r).includes('已将答复发给')).length,1);
    assert.equal(f.statusUpdates.filter(r=>JSON.stringify(r).includes('本表单的选择没有发送')).length,1);
    assert.deepEqual(nativeResponses(f),[{id:RPC,result:{answers:{layout_key:{answers:['Spacious']}}}}]);
  }finally{await f.close();}
});


test('a Slack transport replacement alone makes the old form unusable even on the same native connection',async()=>{
  const f=await fixture();try{
    await f.dedicated();
    const old=await eligible(f,ordinary('Which layout before the Slack reconnect?'));
    const native=f.backends.get('default')!,epoch=native.epoch;
    assert.ok(await f.gateway.openQuestion(old));
    f.rt.disableSlack();
    assert.equal(await f.gateway.submitQuestion(old,[0],FORM_ONE),'denied');
    await f.rt.enableSlack('USELF','BSELF');
    assert.equal(native.epoch,epoch);
    assert.equal(await f.gateway.openQuestion(old),undefined);
    assert.equal(await f.gateway.submitQuestion(old,[0],FORM_ONE),'unavailable');
    assert.deepEqual(nativeResponses(f),[]);
  }finally{await f.close();}
});


test('real Slack SDK adapter reports a transient root outage without closing the live question; a verified retry can respond',async()=>{
  const f=await fixture(1,true);try{
    await f.dedicated();
    const msg=await sdkCard(f,'Which layout after checking the Slack thread?'),b=f.backends.get('default')!;
    await f.wire(cardClick(msg,'trigger-temporary-root'));await waitFor(()=>f.forms.length===1);
    let failingRootChecks=0;
    f.root(async(c,ts)=>{assert.equal(c,CHANNEL);assert.equal(ts,'101.2');failingRootChecks++;throw Error('Synthetic Slack API error');});
    await f.wire(cardSubmit(f.forms[0],'0'));
    await waitFor(()=>f.statusUpdates.some(r=>JSON.stringify(r).includes('暂时无法核对')));
    assert.equal(failingRootChecks,1);assert.deepEqual(nativeResponses(f),[]);
    assert.equal(f.statusUpdates.some(r=>JSON.stringify(r).includes('已关闭')),false);
    assert.equal(f.rt.core('default').store.state.nativeQuestionAnswers?.at(-1)?.status,'posted');
    assert.equal(f.model.get('default')!.requests.has(String(RPC)),true);
    f.root(async()=>true);
    // The next normal refresh observes the same positively live callback.
    b.emit('notification','item/completed',{threadId:DEDICATED,turnId:TURN,item:{type:'agentMessage',id:'irrelevant-msg',text:'Ready'}},b.epoch);
    await waitFor(()=>f.rt.core('default').store.state.nativeShares?.at(-1)?.observationalGap===undefined);
    await f.wire(cardClick(msg,'trigger-restored-root'));await waitFor(()=>f.forms.length===2);
    await f.wire(cardSubmit(f.forms[1],'1'));
    await waitFor(()=>f.statusUpdates.some(r=>JSON.stringify(r).includes('已将答复发给')));
    assert.deepEqual(nativeResponses(f),[{id:RPC,result:{answers:{layout_key:{answers:['Spacious']}}}}]);
  }finally{await f.close();}
});

test('legacy submitted evidence stays non-writable but cannot attest an exact form',async()=>{
  const f=await fixture();try{
    await f.dedicated();
    const a=await eligible(f);
    assert.equal(await f.gateway.submitQuestion(a,[0],FORM_ONE),'submitted');
    const rules=f.rt.core('default').store;
    rules.transaction(d=>{
      const row=d.nativeQuestionAnswers!.at(-1)!;
      assert.equal(row.status,'submitted');
      assert.match(row.claimDigest!,/^[a-f0-9]{64}$/);
      assert.ok(!JSON.stringify(row).includes(FORM_ONE));
      delete row.claimDigest; // upgrades do not know which old form was sent
    });
    assert.equal(await f.gateway.submitQuestion(a,[0],FORM_ONE),'prior-answer');
    assert.deepEqual(nativeResponses(f),[{id:RPC,result:{answers:{layout_key:{answers:['Compact']}}}}]);
  }finally{await f.close();}
});
