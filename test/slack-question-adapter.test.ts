import assert from 'node:assert/strict';
import {test} from 'node:test';
import {SocketModeClient} from '@slack/socket-mode';
import {SlackClient} from '../src/slack.js';
import {SlackLink} from '../src/slack-link.js';
import type {SlackQuestionOrigin,SlackQuestionGateway} from '../src/slack-questions.js';

const team='TWORK',app='ACONN',user='UHUMAN',bot='BCONN',self='UCONN',channel='CWORK',root='100.001',ts='101.001';
const ref='Qx12345_6789-azABCDEFGHIJKLMNOPQRSTUVWXYZ';
const expected={teamId:team,appId:app,userId:user,channel,rootThreadTs:root,messageTs:ts,reference:ref};
const fields=[{header:'颜色',question:'选择主色',labels:['绿色','蓝色']},{header:'口味',question:'选择口味',labels:['甜','淡']}];
const tick=()=>new Promise<void>(r=>setImmediate(r));
async function setup(options:{botFault?:boolean;noGateway?:boolean;outcome?:'closed'|'denied'|'unconfirmed'|'error'}={}){
  const slack=new SlackClient('fake-noncredential');
  // Exercise the real SDK WebClient call shape and real SocketModeClient wire
  // decoder; only the Slack Web API / socket boundary is replaced in-process.
  const posts:any[]=[],modals:any[]=[],loaders:any[]=[],updates:any[]=[],acks:any[]=[],received:any[]=[],opens:SlackQuestionOrigin[]=[],answers:any[]=[],lookups:string[]=[];
  const sdk=new SocketModeClient({appToken:'fake-noncredential',autoReconnectEnabled:false});
  let seq=0,lastPost:any,closed=false,deny=false,botActor=false,waitHuman:Promise<void>|undefined;
  (sdk as any).start=async()=>({});(sdk as any).disconnect=async()=>{};
  (sdk as any).send=async(id:string,response:any)=>{acks.push({id,response});};
  (slack.web as any).axios.defaults.adapter=()=>{throw Error('No network in Slack fixture');};
  const mockApi=async(method:string,args:any)=>{
    if(method==='auth.test')return {ok:true,team_id:team,user_id:self,bot_id:bot};
    if(method==='bots.info'){assert.equal(args.bot,bot);return {ok:true,bot:{id:bot,user_id:options.botFault?'UWRONG':self,app_id:app,deleted:false}};}
    if(method==='users.info'){lookups.push(args.user);await waitHuman;return {ok:true,user:{id:args.user,team_id:team,is_app_user:false,is_bot:botActor,deleted:false,profile:{}}};}
    if(method==='chat.postMessage'){posts.push(args);lastPost=args;return {ok:true,channel,ts};}
    if(method==='views.open'){
      const view={...args.view,id:'V'+(1+loaders.length),team_id:team,app_id:app};
      loaders.push(view);return {ok:true,view};
    }
    if(method==='views.update'){
      if(args.view.submit)modals.push({...args.view,id:args.view_id,team_id:team,app_id:app});else updates.push(args);
      return {ok:true};
    }
    throw Error('unexpected mock method: '+method);
  };
  for(const method of ['auth.test','bots.info','users.info','chat.postMessage','views.open','views.update']){
    const [service,name]=method.split('.') as [string,string];(slack.web as any)[service][name]=(args:any)=>mockApi(method,args);
  }
  const gateway:SlackQuestionGateway={
    async openQuestion(o){opens.push(o);if(deny||closed||Object.keys(expected).some(k=>o[k as keyof SlackQuestionOrigin]!==expected[k as keyof SlackQuestionOrigin]))return;return {questions:fields};},
    async submitQuestion(o,choices){answers.push({o,choices});if(options.outcome==='error')throw Error('withheld');return options.outcome??'submitted';},
  };
  const link=new SlackLink(team,{accept:(x:any)=>{received.push(x);return true;},disableSlack(){},async enableSlack(){}} as any,
    ()=>slack.web.auth.test(),()=>sdk,options.noGateway?undefined:{client:slack,gateway});
  await link.connect();
  const wire=async(type:string,payload:any)=>{
    const envelope={type,envelope_id:'envelope-'+(++seq),payload,accepts_response_payload:type==='interactive'};
    await (sdk as any).onWebSocketMessage(Buffer.from(JSON.stringify(envelope)),false);
    await tick();await tick();
  };
  const post=async()=>slack.post(channel,'Codex 的普通问题', {threadTs:root,deliveryId:'delivery',questionAction:{reference:ref,questionCount:2}});
  const action=()=>({type:'block_actions',team:{id:team},api_app_id:app,user:{id:user,team_id:team},
    channel:{id:channel},container:{type:'message',channel_id:channel,message_ts:ts,is_ephemeral:false},
    message:{type:'message',user:self,bot_id:bot,thread_ts:root,ts},trigger_id:'opaque.trigger.test',
    actions:[{...lastPost.blocks[1].elements[0],block_id:lastPost.blocks[1].block_id}]});
  const submission=()=>({type:'view_submission',team:{id:team},api_app_id:app,user:{id:user},view:{
    ...modals.at(-1),state:{values:{q0:{pick:{type:'static_select',selected_option:{value:'1'}}},q1:{pick:{type:'static_select',selected_option:{value:'0'}}}}}
  }});
  return {slack,link,sdk,post,action,submission,wire,posts,modals,loaders,updates,acks,opens,answers,received,lookups,
    deny:()=>{deny=true;},bot:()=>{botActor=true;},wait:(p?:Promise<void>)=>{waitHuman=p;}};
}
test('exact native question card → actual Socket Mode decoder → verified user modal → one explicit ordinal submission',async()=>{
  const f=await setup();
  assert.equal(f.slack.questionActionsAvailable(),true);
  await f.post();
  assert.equal(f.posts[0].thread_ts,root);assert.equal(f.posts[0].reply_broadcast,false);
  assert.equal(f.posts[0].blocks[1].elements[0].value,ref);
  await f.wire('interactive',f.action());assert.deepEqual(f.opens,[expected]);assert.equal(f.acks[0].response,undefined);
  assert.equal(f.modals.length,1);assert.equal(f.modals[0].blocks.filter((x:any)=>x.type==='input').length,fields.length);
  for(const b of f.modals[0].blocks.filter((x:any)=>x.type==='input'))assert.equal(b.element.type,'static_select');
  assert.ok(!JSON.stringify(f.modals[0]).includes(ref),'opaque question ref need not enter modal metadata');
  const b=f.submission();await f.wire('interactive',b);await f.wire('interactive',b);
  assert.equal(f.opens.length,1);assert.deepEqual(f.answers,[{o:expected,choices:[1,0]}]);assert.deepEqual(f.lookups,[user,user]);
  assert.equal(f.acks[1].response.response_action,'update');assert.match(JSON.stringify(f.acks[1]),/尚未确认/);
  assert.equal(f.updates.length,1);assert.match(JSON.stringify(f.updates),/其他客户端/);assert.equal(f.received.length,0);
  await f.link.close();
});
test('no action on normal delivery; identity/scope failure omits card without disabling Slack',async()=>{
  for(const opts of [{},{botFault:true},{noGateway:true}]){
    const f=await setup(opts);await f.slack.post(channel,'normal',{threadTs:root,deliveryId:'ordinary'});
    assert.equal(f.posts[0].blocks,undefined);
    if(f.slack.questionActionsAvailable()===false){await f.post();assert.equal(f.posts[1].blocks,undefined);assert.match(f.posts[1].text,/原生 Codex/);}
    await f.link.close();assert.equal(f.slack.questionActionsAvailable(),false);
  }
});
test('unauthorized actors, wrong own app or bot, edits, disjoint card/root and forged fields cannot open an actionable modal',async()=>{
  const f=await setup();await f.post();
  const mutate:( (b:any)=>void )[]=[
    b=>{b.type='event_callback';},b=>{b.user.id=self;},b=>{b.user.id='BFAKE';},b=>{b.user.bot_id='BFAKE';},b=>{b.user.team_id='TOTHER';},
    b=>{b.team.id='TOTHER';},b=>{b.api_app_id='AOTHER';},b=>{b.message.app_id='AOTHER';},b=>{b.message.bot_id='BOTHER';},
    b=>{b.channel.id='COTHER';},b=>{b.container.message_ts='199.99';},b=>{b.message.thread_ts='199.99';},
    b=>{b.message.edited={user};},b=>{b.actions[0].type='plain_text_input';},b=>{b.actions[0].block_id='copy';},
    b=>{b.actions.push(b.actions[0]);},b=>{b.actions[0].value='short';},b=>{b.view={type:'modal'};},
    b=>{b.user.id='UOTHER';}, b=>{b.actions[0].value='differentOpaqueReferenceValue';}
  ];
  for(const alter of mutate){const b=f.action();alter(b);await f.wire('interactive',b);}
  assert.equal(f.modals.length,0);assert.equal(f.answers.length,0);
  // No interactive answer listener for an ordinary message or edited message.
  await f.wire('events_api',{event:{type:'message',user,thread_ts:root,ts,text:'1'}});
  await f.wire('events_api',{event:{type:'message',subtype:'message_changed',message:{text:'reply 2'}}});
  assert.equal(f.received.length,2);assert.equal(f.answers.length,0);
  f.bot();await f.wire('interactive',f.action());assert.equal(f.modals.length,0);await f.link.close();
});
test('view binds actual opener, nonce, view ID and exact owned app; unknown form shapes never reach gateway',async()=>{
  const f=await setup();await f.post();await f.wire('interactive',f.action());
  for(const alter of [(b:any)=>b.user.id='UOTHER',(b:any)=>b.view.private_metadata='x'.repeat(32),(b:any)=>b.view.id='VOTHER',
    (b:any)=>b.view.app_id='AOTHER',(b:any)=>b.api_app_id='AOTHER',(b:any)=>b.view.team_id='TOTHER',(b:any)=>b.view.callback_id='other']){
    const b=f.submission();alter(b);await f.wire('interactive',b);
  }
  assert.equal(f.answers.length,0);
  for(const alter of [(b:any)=>b.view.state.values.q0.pick.selected_option.value='2',
    (b:any)=>b.view.state.values.q0.pick={type:'plain_text_input',value:'free text'},
    (b:any)=>delete b.view.state.values.q1,(b:any)=>b.view.state.values.injected={},
    (b:any)=>b.view.state.values.q1.additional={}]) {
    const b=f.submission();alter(b);await f.wire('interactive',b);assert.equal(f.answers.length,0);
    await f.wire('interactive',f.action());
  }
  // Numeric choice is selected; no spoofed echoed label is trusted.
  const b:any=f.submission();b.view.state.values.q0.pick.selected_option.text={type:'plain_text',text:'UNTRUSTED'};
  await f.wire('interactive',b);assert.deepEqual(f.answers[0].choices,[1,0]);await f.link.close();
});
test('no outcome claim on closure/uncertainty or unsuccessful delivery; no second native attempt',async()=>{
  for(const [outcome,pattern] of [['closed',/不能证明/],['unconfirmed',/未自动重试/],['error',/未自动重试/],['denied',/未发送答复/]] as const){
    const f=await setup({outcome});await f.post();await f.wire('interactive',f.action());const b=f.submission();
    await f.wire('interactive',b);await f.wire('interactive',b);
    assert.equal(f.answers.length,1);assert.match(JSON.stringify(f.updates[0]),pattern);await f.link.close();
  }
});
test('socket lost during human revalidation or closed modal does not submit',async()=>{
  const f=await setup();await f.post();await f.wire('interactive',f.action());
  const b=f.submission();await f.wire('interactive',{...b,type:'view_closed'});await f.wire('interactive',b);assert.equal(f.answers.length,0);
  await f.wire('interactive',f.action());const next=f.submission();let release!:()=>void;
  f.wait(new Promise<void>(r=>release=r));await f.wire('interactive',next);assert.equal(f.acks.at(-1)?.response.response_action,'update');
  await f.link.close();release();await tick();assert.equal(f.answers.length,0);assert.equal(f.updates.length,0);
});

test('three-second trigger opens a private non-actionable loading view before a slow identity or native check',async()=>{
  const f=await setup();await f.post();let release!:()=>void;
  f.wait(new Promise<void>(r=>release=r));await f.wire('interactive',f.action());
  assert.equal(f.acks.length,1);assert.equal(f.loaders.length,1);assert.equal(f.modals.length,0);
  assert.equal(f.loaders[0].submit,undefined);assert.ok(!JSON.stringify(f.loaders).includes(fields[0]!.question));assert.equal(f.opens.length,0);
  release();await tick();assert.equal(f.modals.length,1);await f.link.close();
});

test('actionable card cannot establish a posted receipt on a mismatched Slack channel or malformed reply timestamp',async()=>{
  const f=await setup();
  for(const receipt of [{ok:true,channel:'COTHER',ts},{ok:true,channel,ts:root},{ok:true,ts},{ok:true,channel,ts:'not-a-ts'}]){
    f.slack.web.chat.postMessage=async()=>receipt;
    await assert.rejects(f.post(),/SLACK_OUTCOME_UNCERTAIN/);
  }
  await f.link.close();
});
