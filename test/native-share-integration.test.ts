import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseConfig } from '../src/config.js';
import { Runtime } from '../src/runtime.js';
import { apiServer } from '../src/server.js';
import type { SlackPort } from '../src/types.js';
import { FakeBackend, event, request, waitFor } from './helpers.js';

const THREAD='native-same-thread', EMPLOYEES_ROOT='101.2', SPECTATOR_ROOT='202.3';
const OP='c'.repeat(48), AGENT='d'.repeat(48);
const BIRTH=1763800000;
function reply(id:string,text:string,phase:string|null='final_answer'){return{id,type:'agentMessage',phase,text};}
function turn(id:string,status:string,items:any[]=[]){return{id,status,itemsView:'full',items};}
class NativeBackend extends FakeBackend {
  history:any[]=[]; overridePage?:any;
  itemsToday:any[]=[];
  homeMatch=true; blockedTurns?:()=>Promise<void>;
  constructor(project:string, history?:any[]){
    super();this.history=history??[turn('pre-grant','completed',[reply('old-native-item','Old private material must stay native.')])];
    this.threads.set(THREAD,{id:THREAD,cwd:project,createdAt:BIRTH,status:{type:'idle'},canAcceptDirectInput:true});
  }
  get observation(){return{checkedAt:'2026-11-22T00:00:00.000Z',version:'0.171.0',homeVerified:this.connected&&this.homeMatch};}
  override async rpc(method:string,params:any){
    if(method==='thread/turns/list'&&params.threadId===THREAD){
      this.calls.push({method,params});
      await this.blockedTurns?.();
      if(this.overridePage)return this.overridePage;
      const start=Number(params.cursor??0),data=this.history.slice(start,start+params.limit).map(t=>({...t,itemsView:params.itemsView,items:params.itemsView==='notLoaded'?[]:t.items}));
      return{data,nextCursor:start+data.length<this.history.length?String(start+data.length):null,backwardsCursor:data.length?'mock-inverse':null};
    }
    if(method==='thread/items/list'&&params.threadId===THREAD){
      this.calls.push({method,params});
      const found=this.history.find(t=>t.id===params.turnId);
      const data=found?.status==='inProgress'?this.itemsToday.filter(i=>i.turnId===params.turnId):(found?.items??[]).map((item:any)=>({turnId:params.turnId,item,startedAtMs:null,completedAtMs:null}));
      return{data,nextCursor:null};
    }
    const response=await super.rpc(method,params);
    if(method==='thread/start')response.thread.createdAt=Math.floor(Date.now()/1000);
    return response;
  }
  notice(method:string,params:any){this.emit('notification',method,{threadId:THREAD,...params},this.epoch);}
  publish(id:string,items:any[]){this.history.unshift(turn(id,'completed',items));this.threads.get(THREAD).status={type:'idle'};this.notice('turn/completed',{turn:{id,status:'completed'}});}
  ongoing(id:string,items:any[]=[],waiting=false){
    this.history.unshift(turn(id,'inProgress',items));this.itemsToday=items.map(item=>({turnId:id,item,startedAtMs:BIRTH*1000,completedAtMs:BIRTH*1000+1}));
    this.threads.get(THREAD).status={type:'active',activeFlags:waiting?['waitingOnUserInput']:[]};
    this.notice('turn/started',{turn:{id,status:'inProgress'}});
    for(const item of items)this.notice('item/completed',{turnId:id,item});
  }
  ask(turnId:string,id:string,rpcId:number,isSecret=false,overrides:any={}){
    this.emit('request',{id:rpcId,epoch:this.epoch,method:'item/tool/requestUserInput',params:{threadId:THREAD,turnId,itemId:id,
      questions:[{id:'omit-question-id',header:'Layout choice',question:'Which layout should we use?',isOther:false,isSecret,
        options:[{label:'Compact',description:'An alternate visual arrangement.'},{label:'Spacious',description:'Another visual arrangement.'}]}],...overrides}});
  }
}

async function fixture(homes=1) {
  const root=mkdtempSync(join(tmpdir(),'cc-native-share-')),project=join(root,'book');mkdirSync(project);
  const ids=Array.from({length:homes},(_,i)=>i===0?'default':'extra'+i);
  const paths=new Map(ids.map(id=>[id,join(root,'home-'+id)]));for(const path of paths.values())mkdirSync(path);
  const cfg=parseConfig({
    version:2,instanceId:'test',port:18672,approvalTimeoutSec:30,projects:{demo:project},
    backends:Object.fromEntries(ids.map(id=>[id,{executable:process.execPath,codexHome:paths.get(id),...(id==='default'?{aliases:['primary']}:{} )}])),
    slack:{enabled:true,servers:ids,teamId:'T1',inputChannel:'CIN',outputChannel:'COUT',allowedHumans:['U1'],approvalUsers:['U1'],trustedBots:[{botId:'BDOT',userId:'UDOT',appId:'ADOT'}],dot:{name:'dot',userId:'UDOT'}},
    local:{enabled:true,agents:[{id:'agent',tokenHash:createHash('sha256').update(AGENT).digest('hex'),servers:ids,projects:['demo'],commands:['server.list','session.list']}]}
  });
  const backends=new Map<string,NativeBackend>(),posts:{channel:string;text:string;threadTs?:string;id:string}[]=[];
  let pauseRoot:((rootTs:string)=>Promise<boolean>)|undefined, postError:string|undefined, denial:string|undefined;
  const slack:SlackPort={
    async post(channel,text,o){posts.push({channel,text,threadTs:o.threadTs,id:o.deliveryId});if(denial&&text.includes(denial))throw Object.assign(Error('mock permission change'),{code:'slack_webapi_platform_error',data:{error:'not_in_channel'}});if(postError&&text.includes(postError))throw Error('unknown send response');return '410.42';},
    async resolveDot(){return {userId:'UDOT',name:'dot'};}, async threadExists(){throw Error('Sharing should use the exact-root reader');},
    async verifySharedRoot(_channel,ts){return pauseRoot?Promise.race([pauseRoot(ts),sleep(1200,false,{ref:false})]):true;},async humanMessage(){return undefined;}
  };
  const histories = new Map<string,any[]>();
  const make=()=>{
    const r=new Runtime(cfg,join(root,'connector'),slack,undefined,(_p,id)=>{
      const b=new NativeBackend(project,histories.get(id));b.epoch=randomUUID();histories.set(id,b.history);backends.set(id,b);return b;
    });
    for(const c of r.cores.values())Object.assign(c,{postIntervalMs:0});return r;
  };
  let runtime=make();
  const start=async(bot='BSELF')=>{await runtime.connectLocal();await runtime.enableSlack('USELF',bot);};
  const subscribe=async(root:string,serverId='default',threadId=THREAD)=>{
    const q=request('session.subscribe',{threadId,serverId}),core=runtime.core(serverId);
    assert.equal(runtime.accept(event(q,{thread_ts:root})),true);
    await waitFor(()=>core.store.state.work.some(w=>w.request.id===q.id&&w.status==='completed'));
    return core.store.state.subscriptions!.find(s=>s.owner.threadTs===root)!.id;
  };
  const preview=(id:string,target='default')=>runtime.nativeShare(target,'preview',id) as {
    confirmationId:string;confirmationPhrase:string;disclosure:string;serverId:string;nativeThreadId:string;workspaceId:string;channel:string;rootThreadTs:string
  };
  const grant=async(id:string,target='default')=>{const p=preview(id,target);return runtime.nativeShare(target,'grant',id,p.confirmationId,p.confirmationPhrase);};
  const inspection=(id:string,target='default')=>runtime.nativeShare(target,'inspect',id) as {status:string;reason:string|null};
  return {root,project,ids,config:cfg,posts,start,backends,subscribe,preview,grant,inspection,get runtime(){return runtime;},
    pause(fn?:typeof pauseRoot){pauseRoot=fn;},markUncertain(marker:string){postError=marker;},deny(marker:string){denial=marker;},
    async restart(bot?:string){await runtime.close();runtime=make();await start(bot);},
    async close(){await runtime.close();rmSync(root,{recursive:true,force:true});}
  };
}
const observe=(f:Awaited<ReturnType<typeof fixture>>,text:string,root=EMPLOYEES_ROOT)=>waitFor(()=>f.posts.some(p=>p.text.includes(text)&&p.threadTs===root));
const never=(f:Awaited<ReturnType<typeof fixture>>,text:string)=>assert.equal(f.posts.some(p=>p.text.includes(text)),false,text);
const nativePosts=(f:Awaited<ReturnType<typeof fixture>>,root=EMPLOYEES_ROOT)=>f.posts.filter(p=>p.threadTs===root&&p.text.startsWith('Codex '));

test('explicit owner grant forwards future reply, ordinary question and structured question only to the authorized Slack root',async()=>{
  const f=await fixture();try{
    await f.start();const id=await f.subscribe(EMPLOYEES_ROOT),spectator=await f.subscribe(SPECTATOR_ROOT);
    const b=f.backends.get('default')!,core=f.runtime.core('default');
    assert.equal(f.inspection(id).status,'unshared');
    assert.equal(f.inspection(spectator).status,'unshared');
    // An eligible-looking native reply and old live turn receive no default grant.
    b.publish('before-grant',[reply('no-consent','A reply before the owner accepted.')]);
    b.ongoing('in-flight-before-grant');
    const rejected=f.preview(id);
    await assert.rejects(async()=>f.runtime.nativeShare('default','grant',id,rejected.confirmationId,rejected.confirmationPhrase),/WAIT_UNTIL_IDLE/);
    b.history[0]=turn('in-flight-before-grant','completed',[reply('finished-private','A private turn that was already running.')]);
    b.threads.get(THREAD).status={type:'idle'};
    const offer=f.preview(id);
    assert.deepEqual([offer.serverId,offer.nativeThreadId,offer.workspaceId,offer.channel,offer.rootThreadTs],['default',THREAD,'T1','CIN',EMPLOYEES_ROOT]);
    assert.match(offer.disclosure,/entered locally or through another client/);
    await assert.rejects(async()=>f.runtime.nativeShare('default','grant',spectator,offer.confirmationId,offer.confirmationPhrase),/CONFIRMATION_REQUIRED/);
    await assert.rejects(async()=>f.runtime.nativeShare('default','grant',id,offer.confirmationId,offer.confirmationPhrase),/CONFIRMATION_REQUIRED/);
    assert.throws(()=>f.runtime.nativeShare('primary','inspect',id),/SERVER_UNAVAILABLE/);
    await f.grant(id);
    // A fabricated/live-only completed message cannot bypass ordered history.
    b.notice('item/completed',{turnId:'in-flight-before-grant',item:reply('late-pre-grant','Late pre-activation content.')});
    b.notice('item/completed',{turnId:'not-in-history',item:reply('forged','Unverified live body.')});
    b.ongoing('future-active',[{id:'native-prompt',type:'userMessage',content:[{type:'text',text:'The original local prompt stays private.'}]},reply('plain-question','How should we arrange the overview?','commentary')],true);
    b.ask('future-active','structured',72);
    // The official Windows release uses this reserved question id for an
    // app-side approval even if a template supplies benign-looking wording.
    b.ask('future-active','mcp-same-rpc',171,false,{questions:[{id:'mcp_tool_call_approval_mcp-same-rpc',header:'Review layout',question:'A benign-looking app approval stays native?',isOther:false,isSecret:false,
      options:[{label:'Minimal',description:'Use a clean layout.'}]}]});
    b.itemsToday.push({turnId:'future-active',item:{id:'related-tool',type:'mcpToolCall'},startedAtMs:BIRTH*1000,completedAtMs:null});
    b.ask('future-active','related-tool',172,false,{questions:[{id:'unrecognized',header:'Alternate layout',question:'A matching tool item is not a normal question?',isOther:false,isSecret:false,options:null}]});
    b.ask('future-active','secret-ask',73,true,{questions:[{id:'secret',header:'Secret test descriptor',question:'Unshareable question',isOther:false,isSecret:true,options:null}]});
    b.emit('request',{id:74,epoch:b.epoch,method:'item/commandExecution/requestApproval',params:{threadId:THREAD,turnId:'future-active',command:'Sensitive command operation text'}});
    b.notice('item/agentMessage/delta',{turnId:'future-active',delta:'Stream fragments stay local.'});
    await observe(f,'How should we arrange the overview?');
    await observe(f,'Which layout should we use?');
    const q=f.posts.find(x=>x.text.includes('Which layout should we use?'))!;
    assert.match(q.text,/Layout choice\nWhich layout should we use\?\n• Compact\n• Spacious/);
    assert.match(q.text,/Answer in the original Codex window/);
    assert.doesNotMatch(q.text,/alternate visual|omit-question-id|structured/);
    b.notice('serverRequest/resolved',{requestId:72});
    const last=[reply('plain-question','How should we arrange the overview?','commentary'),reply('future-reply','The overview and comparison are ready.'),reply('unknown-phase','A body with no verified display phase.',null),
      {id:'tool',type:'commandExecution',aggregatedOutput:'Contents of the command output.'},
      {id:'thought',type:'reasoning',content:['No hidden reasoning in Slack.']},reply('looks-secret','Your password: demo-fixture-value')];
    b.history[0]=turn('future-active','completed',last);b.threads.get(THREAD).status={type:'idle'};
    b.notice('turn/completed',{turn:{id:'future-active',status:'completed'}});b.notice('turn/completed',{turn:{id:'future-active',status:'completed'}});
    await observe(f,'The overview and comparison are ready.');
    assert.equal(nativePosts(f).filter(p=>p.text.includes('How should')).length,1);
    assert.equal(nativePosts(f,SPECTATOR_ROOT).length,0);
    ['Old private material','before the owner','already running','Late pre-activation','Unverified live body','Sensitive command operation','Stream fragments','original local prompt','Unshareable question','benign-looking app approval','matching tool item','no verified display phase','Contents of the command output','hidden reasoning in Slack','demo-fixture-value'].forEach(t=>never(f,t));
    assert.equal(b.responses.length,0);assert.equal(b.calls.filter(x=>x.method==='turn/interrupt').length,0);
    assert.ok(b.calls.filter(r=>r.method==='thread/turns/list').every(r=>r.params.itemsView==='notLoaded'));
    assert.ok(!b.calls.some(r=>r.method==='thread/items/list'&&['pre-grant','before-grant','in-flight-before-grant'].includes(r.params.turnId)));
    assert.ok(core.store.state.outbox.filter(o=>o.nativeShare).every(o=>o.channel==='CIN'&&o.threadTs===EMPLOYEES_ROOT&&o.text.startsWith('[Native content record:')));
    assert.equal(core.store.state.results?.some(row=>row.text.includes('The overview and comparison')),false);
  }finally{await f.close();}
});

test('revocation, in-flight confirmation, stale structured request and exact Slack root checks at adapter boundary',async()=>{
  const f=await fixture();try{
    await f.start();const sub=await f.subscribe(EMPLOYEES_ROOT),b=f.backends.get('default')!;
    let release!:(v:boolean)=>void,checks=0;
    f.pause(()=>new Promise(r=>{release=r;checks++;}));
    const p=f.preview(sub);
    const race=Promise.resolve(f.runtime.nativeShare('default','grant',sub,p.confirmationId,p.confirmationPhrase));
    await waitFor(()=>checks===1);f.runtime.nativeShare('default','revoke',sub);release(true);
    await assert.rejects(race,/SCOPE_CHANGED/);
    f.pause();await f.grant(sub);
    let started=false;f.pause(()=>new Promise(r=>{release=r;started=true;}));
    b.ongoing('live',[reply('action-ready','Ready for presentation feedback.','commentary')],true);
    await waitFor(()=>started);
    const cut=await f.runtime.nativeShare('default','revoke',sub);
    assert.ok('inFlightMayStillArrive' in cut);assert.equal(cut.inFlightMayStillArrive,false);
    release(true);await sleep(40);never(f,'Ready for presentation feedback');
    b.history[0]=turn('live','completed');b.threads.get(THREAD).status={type:'idle'};
    f.pause();await f.grant(sub);
    started=false;f.pause(()=>new Promise(r=>{release=r;started=true;}));
    b.ongoing('request-current',[],true);b.ask('request-current','unresolved-then-closed',90);
    await waitFor(()=>started);
    b.notice('serverRequest/resolved',{requestId:90});
    release(true);await sleep(40);never(f,'Which layout should we use?');
    b.history[0]=turn('request-current','completed');
    started=false;f.pause(()=>new Promise(r=>{release=r;started=true;}));
    b.ongoing('late-association',[],true);
    b.ask('late-association','later-qualified-as-tool',91,false,{questions:[{id:'context-review',header:'Layout review',question:'Provide the redraft format?',isOther:false,isSecret:false,options:null}]});
    await waitFor(()=>started);
    // This native item appears in the App Server read after the initial queue,
    // without forwarding a lifecycle event to the connector.
    b.itemsToday.push({turnId:'late-association',item:{id:'later-qualified-as-tool',type:'mcpToolCall'},startedAtMs:BIRTH*1000,completedAtMs:null});
    release(true);await sleep(40);never(f,'Provide the redraft format?');
    b.history[0]=turn('late-association','completed');
    f.pause(async()=>false);b.publish('root-removed',[reply('wrong-destination','Text after its destination was removed.')]);
    await waitFor(()=>f.inspection(sub).status==='retired');never(f,'Text after its destination was removed.');
    assert.equal(b.responses.length,0);assert.equal(b.calls.filter(x=>x.method==='turn/interrupt').length,0);
  }finally{await f.close();}
});

test('durable bounded offline recovery, no uncertain resend and same-ID separation across three Homes',async()=>{
  const f=await fixture(3);try{
    await f.start();const roots=['101.2','211.2','311.2'];
    const ids=await Promise.all(f.ids.map((id,index)=>f.subscribe(roots[index]!,id)));
    await Promise.all(ids.map((sub,i)=>f.grant(sub,f.ids[i])));
    const b0=f.backends.get('default')!,b1=f.backends.get('extra1')!,b2=f.backends.get('extra2')!;
    b0.notice('item/completed',{turnId:'collision',item:reply('same-item','A native wake signal before the connection drops.')});
    b0.connected=false;b0.emit('disconnect',b0.epoch);
    await sleep(15);assert.equal(f.inspection(ids[0]!).status,'paused');
    b0.history.unshift(turn('collision','completed',[reply('same-item','Isolated first Home recovered.')]));
    b1.publish('collision',[reply('same-item','Isolated second Home live.')]);b2.publish('collision',[reply('same-item','Isolated third Home live.')]);
    await observe(f,'Isolated second Home live.',roots[1]);await observe(f,'Isolated third Home live.',roots[2]);
    never(f,'Isolated first Home recovered.');
    await f.restart();
    await observe(f,'Isolated first Home recovered.',roots[0]);
    assert.equal(f.posts.filter(p=>p.text.includes('Isolated')).length,3);
    assert.ok(!f.posts.some(p=>p.text.includes('Isolated first Home')&&p.threadTs!==roots[0]));
    assert.ok(!f.posts.some(p=>p.text.includes('Isolated second Home')&&p.threadTs!==roots[1]));
    assert.ok(!f.posts.some(p=>p.text.includes('Isolated third Home')&&p.threadTs!==roots[2]));
    f.markUncertain('network-outcome-test');f.backends.get('extra1')!.publish('uncertain-turn',[reply('uncertain','A network-outcome-test message.')]);
    const core=f.runtime.core('extra1');await waitFor(()=>core.store.state.outbox.some(o=>o.nativeShare?.projection.kind==='message'&&o.nativeShare.projection.text.includes('network-outcome-test')&&o.status==='uncertain'));
    const old=core.store.state.outbox.find(o=>o.nativeShare?.projection.kind==='message'&&o.nativeShare.projection.text.includes('network-outcome-test'))!;
    assert.throws(()=>f.runtime.recover('outbox',old.id,undefined,'extra1'),/SCOPE_UNVERIFIED/);
    await f.restart('DIFFERENTBOT');
    f.backends.get('default')!.publish('reconnected-different-destination',[reply('different-auth','A different Slack connection cannot receive this body.')]);
    await waitFor(()=>f.inspection(ids[0]!).status==='retired');
    never(f,'A different Slack connection');
    assert.equal(f.posts.filter(p=>p.text.includes('network-outcome-test')).length,1);
  }finally{await f.close();}
});

test('unproven activation, lost frontier and operator HTTP isolation stay closed',async()=>{
  const f=await fixture();const api=apiServer(f.runtime,OP);
  await new Promise<void>(resolve=>api.listen(0,'127.0.0.1',resolve));const port=(api.address() as {port:number}).port;
  const http=(body:any,token=OP)=>fetch('http://127.0.0.1:'+port+'/v1/command',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(body)});
  try{
    await f.start();const sub=await f.subscribe(EMPLOYEES_ROOT),b=f.backends.get('default')!;
    for(const operation of ['inspect','preview','grant','revoke'])assert.equal((await http({action:'native.share',operation,serverId:'default',subscriptionId:sub},AGENT)).status,403);
    assert.equal((await http({action:'native.share',operation:'preview',serverId:'primary',subscriptionId:sub})).status,400);
    assert.equal((await http({action:'native.share',operation:'grant',serverId:'default',subscriptionId:sub,confirmationId:'bogus',phrase:'forced'})).status,400);
    b.homeMatch=false;
    const noHome=await http({action:'native.share',operation:'preview',serverId:'default',subscriptionId:sub});
    assert.deepEqual(await noHome.json(),{error:'NATIVE_SHARE_IDENTITY_UNVERIFIED'});
    b.homeMatch=true;
    b.overridePage={data:[{id:'wrong-shape',status:'completed',items:[]}],nextCursor:null};
    const p=f.preview(sub);await assert.rejects(async()=>f.runtime.nativeShare('default','grant',sub,p.confirmationId,p.confirmationPhrase),/HISTORY_GAP/);
    b.overridePage=undefined;
    await f.grant(sub);
    b.history.splice(0,b.history.length,turn('not-an-anchor','completed',[reply('private-gap','Unverifiable gap message.')]));
    b.notice('turn/completed',{turn:{id:'not-an-anchor',status:'completed'}});
    await waitFor(()=>f.inspection(sub).status==='gap');never(f,'Unverifiable gap message.');
    // Rollback/unload signals hard invalidate the prior grant. No fallback or auto-recreate.
    b.notice('thread/rolledBack',{});
    await waitFor(()=>f.inspection(sub).status==='retired');
    assert.equal(b.calls.filter(c=>['thread/start','turn/start','turn/steer','turn/interrupt'].includes(c.method)).length,0);
  }finally{await new Promise<void>(done=>{api.close(()=>done());api.closeAllConnections();});await f.close();}
});

test('existing empty history needs a known boundary; a newly created owner dedicated session can be explicitly granted',async()=>{
  const f=await fixture();try{
    await f.start();
    const b=f.backends.get('default')!,sub=await f.subscribe(EMPLOYEES_ROOT);
    b.history.length=0;
    const p=f.preview(sub);
    await assert.rejects(async()=>f.runtime.nativeShare('default','grant',sub,p.confirmationId,p.confirmationPhrase),/USE_DEDICATED_THREAD/);
    const accepted=f.runtime.local(request('session.create',{project:'demo'}));
    await waitFor(()=>f.runtime.core('default').store.state.work.some(w=>w.id===accepted.id&&w.status==='completed'));
    const row=f.runtime.core('default').store.state.work.find(w=>w.id===accepted.id)!;
    const dedicated=row.resultRef!.threadId!;
    assert.notEqual(dedicated,THREAD);
    const id=await f.subscribe(SPECTATOR_ROOT,'default',dedicated);
    await f.grant(id);
    assert.equal(f.inspection(id).status,'active');
    assert.equal(f.inspection(sub).status,'unshared');
    assert.equal(b.calls.filter(c=>c.method==='thread/start').length,1);
    assert.equal(b.responses.length,0);
  }finally{await f.close();}
});

test('long replies are screened as a whole and delivered as bounded native chunks, only to the verified address',async()=>{
  const f=await fixture();try{
    await f.start();await f.grant(await f.subscribe(EMPLOYEES_ROOT));
    const b=f.backends.get('default')!;
    const benign='This paragraph belongs in our teaching example. '.repeat(155).trim();
    b.publish('long-content',[reply('many-parts',benign),reply('secret-tail',benign+' Password: hide-this-at-the-end')]);
    const core=f.runtime.core('default');
    await waitFor(()=>core.store.state.outbox.filter(o=>o.nativeShare?.projection.itemId==='many-parts'&&o.status==='sent').length===4);
    const pieces=core.store.state.outbox.filter(o=>o.nativeShare?.projection.itemId==='many-parts');
    const ids=new Set(pieces.map(p=>p.id)),delivered=f.posts.filter(p=>ids.has(p.id));
    assert.equal(delivered.map(p=>p.text).join(''),'Codex reply\n'+benign);
    assert.ok(delivered.every(p=>Buffer.byteLength(p.text)<=2300&&p.threadTs===EMPLOYEES_ROOT));
    assert.ok(!core.store.state.outbox.some(o=>o.nativeShare?.projection.itemId==='secret-tail'));never(f,'hide-this-at-the-end');
  }finally{await f.close();}
});

test('Slack membership denial between root read and actual post retires the generation',async()=>{
  const f=await fixture();try{
    await f.start();const id=await f.subscribe(EMPLOYEES_ROOT);
    const b=f.backends.get('default')!;await f.grant(id);
    f.deny('Attachment update ready');
    b.publish('before-denial',[reply('denied-only-once','Attachment update ready.'),reply('skip-on-denial','The follow-up should not be attempted.')]);
    await waitFor(()=>f.inspection(id).status==='retired');
    assert.equal(f.posts.filter(p=>p.text.includes('Attachment update ready')).length,1);
    never(f,'The follow-up should not be attempted.');
    f.deny('no matching body');
    b.publish('no-revive',[reply('later','Regaining membership does not restore a grant.')]);
    await sleep(30);never(f,'Regaining membership');
  }finally{await f.close();}
});

test('same native thread, turn, item and request IDs across three Homes: open questions stay scoped and offline resolution is not replayed',async()=>{
  const f=await fixture(3);try{
    await f.start();
    const roots=['101.2','211.2','311.2'];
    const subs=await Promise.all(f.ids.map((id,i)=>f.subscribe(roots[i]!,id)));
    await Promise.all(subs.map((sub,i)=>f.grant(sub,f.ids[i])));
    let blocked=false, release!:(v:boolean)=>void;
    f.pause(async ts=>ts===roots[0]?new Promise<boolean>(r=>{blocked=true;release=r;}):true);
    f.ids.forEach((id,i)=>{
      const b=f.backends.get(id)!;b.ongoing('shared-turn',[],true);
      b.ask('shared-turn','shared-item',101,false,{questions:[{id:'layout-same-id',header:'Which visual arrangement?',question:'Choose a layout in Home '+(i+1)+'.',isOther:false,isSecret:false,options:null}]});
    });
    await waitFor(()=>blocked);
    await observe(f,'layout in Home 2.',roots[1]);await observe(f,'layout in Home 3.',roots[2]);
    const b=f.backends.get('default')!;
    b.connected=false;b.emit('disconnect',b.epoch);
    // Resolution happened offline. There is no current native request to
    // verify on reconnect even though the Connecter's durable row exists.
    b.history[0]=turn('shared-turn','completed');b.threads.get(THREAD).status={type:'idle'};
    release(true);f.pause();
    await f.restart();
    const core=f.runtime.core('default');
    core.store.transaction(d=>{for(const o of d.outbox)if(o.nativeShare?.projection.kind==='input'&&o.status==='queued')o.nextAttemptAt=0;});
    core.flush();
    await waitFor(()=>core.store.state.outbox.some(o=>o.nativeShare?.projection.kind==='input'&&o.status==='failed'));
    never(f,'layout in Home 1.');
    assert.equal(f.posts.filter(p=>p.text.includes('layout in Home')).length,2);
    assert.ok(!f.posts.some(p=>p.text.includes('Home 2.')&&p.threadTs!==roots[1]));
    assert.ok(!f.posts.some(p=>p.text.includes('Home 3.')&&p.threadTs!==roots[2]));
    assert.ok([...f.backends.values()].every(x=>x.responses.length===0));
  }finally{await f.close();}
});
