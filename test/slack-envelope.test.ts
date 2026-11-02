import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnvelope } from '../src/protocol.js';
import { parseSlackEnvelope } from '../src/slack-envelope.js';
import { fixture, request, event, envelope } from './helpers.js';
const r = request('capabilities', {}, 'transport-1');
const text = envelope(r);
const flattened = text.replace(/\n/g, ' ');
const blocks = () => [{type:'section', block_id:'slack-generated', text:{type:'plain_text',text,emoji:false}}];

test('trusted bot exact plain-text section recovers only newline-flattened fallback; base parser unchanged',()=>{
  assert.throws(()=>parseEnvelope(flattened,r.target));
  assert.deepEqual(parseSlackEnvelope(flattened,blocks(),r.target,true),r);
  assert.deepEqual(parseSlackEnvelope(text,undefined,r.target,false),r);
  assert.deepEqual(parseSlackEnvelope(text,undefined,r.target,true),r);
  // Explicit plain_text command blocks must agree even with a canonical fallback.
  assert.throws(()=>parseSlackEnvelope(text,[{type:'section',text:{type:'plain_text',text:text.replace('capabilities','help')}}],r.target,true));
  assert.deepEqual(parseSlackEnvelope(text,blocks(),r.target,true),r);
  assert.deepEqual(parseSlackEnvelope(text,[{type:'rich_text',elements:[]}],r.target,true),r);
  assert.throws(()=>parseSlackEnvelope(text,[...blocks(),{type:'divider'}],r.target,true));
  assert.throws(()=>parseSlackEnvelope(text,[{...blocks()[0],accessory:{}}],r.target,true));
});
test('transport rejects human, omitted/mismatched fallback, multiple/rich/extra/quoted/injected blocks',()=>{
  assert.throws(()=>parseSlackEnvelope(flattened,blocks(),r.target,false));
  for (const candidate of [undefined,[],[...blocks(),...blocks()], [{...blocks()[0],fields:[]}], [{...blocks()[0],accessory:{type:'button'}}], [{...blocks()[0],expand:true}], [{...blocks()[0],text:{type:'mrkdwn',text}}], [{...blocks()[0],text:{type:'plain_text',text,verbatim:true}}], [{...blocks()[0],text:{type:'plain_text',text,emoji:'false'}}], [{...blocks()[0],block_id:'x'.repeat(256)}]]) {
    assert.throws(()=>parseSlackEnvelope(flattened,candidate,r.target,true));
  }
  for (const fallback of ['', ' '+flattened, flattened+' ', flattened.replace('capabilities','help'), flattened.replace(' ', '  ')]) assert.throws(()=>parseSlackEnvelope(fallback,blocks(),r.target,true));
  for (const value of ['quoted\n'+text,text+'\n', '```\n'+text+'\n```',text.replace('capabilities','CODEX_CONNECTOR_COMMAND_BEGIN')]) assert.throws(()=>parseSlackEnvelope(value.replace(/\n/g,' '),[{type:'section',text:{type:'plain_text',text:value}}],r.target,true));
});
test('transport preserves target/schema validation and exact JSON whitespace',()=>{
  assert.throws(()=>parseSlackEnvelope(flattened,blocks(),'other-target',true));
  const duplicate=text.replace('"v":1','"v":1,"v":1');
  assert.throws(()=>parseSlackEnvelope(duplicate.replace(/\n/g,' '),[{type:'section',text:{type:'plain_text',text:duplicate}}],r.target,true));
  const value=text.replace('"params":{}','"params":{},"actor":"Carl"');
  assert.throws(()=>parseSlackEnvelope(value.replace(/\n/g,' '),[{type:'section',text:{type:'plain_text',text:value}}],r.target,true));
  const blank=text.replace(/\n/g,'\n\n');
  assert.deepEqual(parseSlackEnvelope(blank.replace(/\n/g,' '),[{type:'section',text:{type:'plain_text',text:blank}}],r.target,true),r);
});
test('connector authenticates before block recovery and dedupes same command across transports',async()=>{
  const f=fixture();try{
    await f.connector.initialize();
    const message=event(r,{text:flattened,blocks:blocks()});
    for(const patch of [{bot_id:'BEVIL'},{user:'UEVIL'},{app_id:'AEVIL'},{channel:'COTHER'}]) assert.equal(f.connector.accept({...message,event:{...message.event,...patch}}),false);
    assert.equal(f.connector.accept({...message,team_id:'TOTHER'}),false);
    assert.equal(f.store.state.work.length,0);
    assert.equal(f.connector.accept(message),true);
    assert.equal(f.store.state.work.length,1);
    assert.equal(f.store.state.work[0]!.request.command,'capabilities');
    f.connector.accept(event(r));
    assert.equal(f.store.state.work.length,1);
    const humanMessage=event(request('capabilities',{},'human-transport'),{text:flattened,blocks:blocks(),user:'UHUMAN',bot_id:undefined,app_id:undefined,bot_profile:undefined});
    f.connector.accept(humanMessage);
    assert.equal(f.store.state.work.length,1);
  }finally{await f.cleanup();}
});
