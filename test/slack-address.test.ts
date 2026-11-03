import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseEnvelope} from '../src/protocol.js';
import {parseSlackEnvelope,isSlackAddressed,SlackTransportError,SLACK_TRANSPORT_REVISION} from '../src/slack-envelope.js';
import {fixture,request,event,envelope,ready,pending,human,waitFor} from './helpers.js';
const address='<@USELF>',r=request('capabilities',{},'address-v2'),body=envelope(r);
const section=(text:string)=>[{type:'section',text:{type:'plain_text',text,emoji:false}}];
const forms=[address,'<@USELF|Codex Connector>','&lt;@USELF&gt;'];

test('verified bot self-address accepts bounded label or single escaped token without changing envelope',()=>{
  for(const prefix of forms)for(const separator of ['\n','\r\n',' ']){
    const text=prefix+separator+body;
    assert.equal(isSlackAddressed(text,address,true),true);
    assert.deepEqual(parseSlackEnvelope(text,undefined,r.target,true,address),r);
    assert.deepEqual(parseSlackEnvelope(text,[{type:'rich_text',elements:[]}],r.target,true,address),r);
  }
  assert.deepEqual(parseSlackEnvelope(address+'\r\n'+body.replace(/\n/g,'\r\n'),undefined,r.target,false,address),r);
});
test('block agreement normalizes only the same self address in both texts then exact newline flattening',()=>{
  for(const fallbackPrefix of forms)for(const shownPrefix of forms){
    const shown=shownPrefix+'\n'+body;
    for(const fallback of [fallbackPrefix+'\n'+body,(fallbackPrefix+'\n'+body).replace(/\n/g,' ')])assert.deepEqual(parseSlackEnvelope(fallback,section(shown),r.target,true,address),r);
  }
  const crlf=address+'\r\n'+body.replace(/\n/g,'\r\n');
  assert.deepEqual(parseSlackEnvelope(crlf,section(crlf),r.target,true,address),r);
  assert.deepEqual(parseSlackEnvelope(crlf.replace(/\r\n/g,' '),section(crlf),r.target,true,address),r);
  for(const shown of [body,'<@OTHER>\n'+body,address+'\n\n'+body,address+'\n'+body.replace('capabilities','help')])assert.throws(()=>parseSlackEnvelope('&lt;@USELF&gt;\n'+body,section(shown),r.target,true,address));
});
test('wrong identity, malformed labels, multiple addresses, whitespace and entity tricks fail closed',()=>{
  for(const prefix of ['<@OTHER>','<@USELFX>','<@USELF|>','<@USELF|'+'a'.repeat(81)+'>','<@USELF|a\nb>','<@USELF|a&b>','<@USELF|a|b>','<@USELF|<b>>','&lt;@USELF|label&gt;','&amp;lt;@USELF&amp;gt;','&#60;@USELF&#62;','prefix '+address])assert.throws(()=>parseSlackEnvelope(prefix+'\n'+body,undefined,r.target,true,address));
  for(const value of [address+'\t'+body,address+'\r'+body,address+'  '+body,address+'\n'+address+'\n'+body,' '+address+'\n'+body])assert.throws(()=>parseSlackEnvelope(value,undefined,r.target,true,address));
  for(const prefix of forms.slice(1))assert.throws(()=>parseSlackEnvelope(prefix+'\n'+body,undefined,r.target,false,address));
  assert.equal(isSlackAddressed('<@OTHER|Codex Connector>\n'+body,address,true),false);
  assert.equal(isSlackAddressed('&lt;@USELF&gt;\n'+body,address,false),false);
});
test('address compatibility never decodes body entities, relaxes JSON or extracts from extra blocks',()=>{
  const textRequest=request('session.reply',{sessionId:'session-1',text:'&lt;literal&gt; &amp; <@OTHER>'},'address-body'),text=envelope(textRequest),raw='&lt;@USELF&gt;\n'+text;
  assert.deepEqual(parseSlackEnvelope(raw,section(address+'\n'+text),r.target,true,address),textRequest);
  assert.throws(()=>parseSlackEnvelope(raw,section(address+'\n'+text.replace('&lt;literal&gt;','<literal>')),r.target,true,address));
  for(const shown of [body.replace('"v":1','"v":1,"v":1'),body.replace('"v":1','"v":1,"\\u0076":1'),'```\n'+body+'\n```'])assert.throws(()=>parseSlackEnvelope(address+'\n'+shown,section(address+'\n'+shown),r.target,true,address));
  assert.throws(()=>parseSlackEnvelope(address+'\n'+body,[...section(address+'\n'+body),...section(body)],r.target,true,address));
  assert.throws(()=>parseSlackEnvelope(address+'\n'+body,[{...section(address+'\n'+body)[0],accessory:{}}],r.target,true,address));
  assert.throws(()=>parseSlackEnvelope(address+'\n'+body,undefined,'other-target',true,address));
});
test('connector authenticates before adapted addresses and dedupes representations without rerun',async()=>{
  const f=fixture();try{await f.connector.initialize();for(const prefix of forms){const e=event(r,{text:prefix+'\n'+body,thread_ts:'200.1'});for(const patch of [{user:'UEVIL'},{bot_id:'BEVIL'},{app_id:'AEVIL'},{channel:'COTHER'}])assert.equal(f.connector.accept({...e,event:{...e.event,...patch}}),false);assert.equal(f.connector.accept({...e,team_id:'TEVIL'}),false);assert.equal(f.connector.accept(e),true);}assert.equal(f.store.state.work.length,1);assert.equal(f.store.state.work[0]!.source.threadTs,'200.1');assert.equal(f.connector.accept(event(r,{user:'USELF',text:forms[1]+'\n'+body})),false);assert.equal(f.connector.capabilities().slackTransport.connectorUserId,'USELF');assert.equal(f.connector.capabilities().slackTransport.revision,SLACK_TRANSPORT_REVISION);assert.equal(f.connector.capabilities().fileTools.allowAbsolutePaths,false);}finally{await f.cleanup();}
});
test('adapted bot still cannot approve and fetched human proof stays canonical-only',async()=>{
  const f=fixture();try{const s=await ready(f),p=await pending(f,s),args={requestId:p.id,epoch:p.epoch,sessionId:s.id,turnId:p.turnId,decision:'accept'};const decision=request('approval.respond',args,'address-approve');f.connector.accept(event(decision,{thread_ts:s.threadTs,text:forms[1]+'\n'+envelope(decision)}));f.connector.pump();await waitFor(()=>f.store.state.work.some(w=>w.request.id===decision.id&&w.status==='failed'));assert.equal(f.backend.responses.length,0);for(const prefix of forms)assert.throws(()=>parseEnvelope(prefix+'\n'+envelope(decision),'test'));f.connector.accept(human(decision,s.threadTs!));f.connector.pump();await waitFor(()=>f.backend.responses.length===1);}finally{await f.cleanup();}
});
test('rejection diagnostics contain fixed stage only, never message or block content',async()=>{
  const f=fixture();try{await f.connector.initialize();const secret='private-message-do-not-echo';f.connector.accept(event(r,{text:forms[1]+'\n'+body,blocks:section(address+'\n'+secret),thread_ts:'400.1'}));const output=f.store.state.outbox.at(-1)!;assert.match(output.text,/self-address-v2: fallback-mismatch/);assert.ok(!output.text.includes(secret));assert.equal(output.threadTs,'400.1');assert.equal(f.store.state.work.length,0);assert.throws(()=>parseSlackEnvelope(address+'\t'+body,undefined,r.target,true,address),(e:any)=>e instanceof SlackTransportError&&e.stage==='address');}finally{await f.cleanup();}
});

test('human messages cannot opt into labelled or escaped transport, unauthorized senders get no diagnostics',async()=>{
  const f=fixture();try{await f.connector.initialize();for(const prefix of forms.slice(1)){const message=event(r,{text:prefix+'\n'+body,blocks:section(prefix+'\n'+body),user:'UHUMAN',bot_id:undefined,app_id:undefined,subtype:undefined});assert.equal(f.connector.accept(message),false);}for(const prefix of forms){const message=event(r,{text:prefix+'\ninvalid',user:'UEVIL'});assert.equal(f.connector.accept(message),false);}assert.equal(f.store.state.work.length,0);assert.equal(f.store.state.outbox.length,0);}finally{await f.cleanup();}
});
test('bot relay does not normalize any self-address inside fetched human proof',async()=>{
  const f=fixture();try{const s=await ready(f),p=await pending(f,s),args={requestId:p.id,epoch:p.epoch,sessionId:s.id,turnId:p.turnId,decision:'decline'};const proof=envelope(request('approval.respond',args,'human-proof'));for(const prefix of forms){f.slack.humanMessage=async()=>({user:'UHUMAN',ts:'200.1',thread_ts:s.threadTs,text:prefix+'\n'+proof,blocks:section(proof)});const relayed=request('approval.respond',{...args,humanMessageTs:'200.1'});f.connector.accept(event(relayed,{text:forms[1]+'\n'+envelope(relayed)}));f.connector.pump();await waitFor(()=>f.store.state.work.some(w=>w.request.id===relayed.id&&w.status==='failed'));assert.equal(f.backend.responses.length,0);}f.slack.humanMessage=async()=>({user:'UHUMAN',ts:'200.1',thread_ts:s.threadTs,text:proof});const relayed=request('approval.respond',{...args,humanMessageTs:'200.1'});f.connector.accept(event(relayed,{text:forms[2]+'\n'+envelope(relayed)}));f.connector.pump();await waitFor(()=>f.backend.responses.length===1);assert.equal(f.backend.responses[0].result.decision,'decline');}finally{await f.cleanup();}
});
