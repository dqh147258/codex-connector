import test from 'node:test';
import assert from 'node:assert/strict';
import { NATIVE_MESSAGE_MAX_WIRE_BYTES, NATIVE_QUESTION_MAX_WIRE_BYTES, parseNativeProjection, projectNativeInput, projectNativeItem, projectNativeMessage, renderNativeProjection, validateNativeProjection } from '../src/shared-native-content.js';

const message = (text:unknown, phase:unknown='final_answer') => ({
  type:'agentMessage',id:'native-item-1',text,phase,memoryCitation:null,delivery:null,questions:null,
});
const entry = (item:unknown, completedAtMs:unknown=200) => ({turnId:'native-turn-1',item,startedAtMs:100,completedAtMs});
const descriptor=() => ({
  threadId:'thread-not-shown',turnId:'turn-not-shown',itemId:'item-not-shown',isBlocking:true,autoResolutionMs:null,
  questions:[{
    id:'question-hidden',header:'Preview type',question:'Which preview would you like?',
    isOther:false,isSecret:false,options:[
      {label:'Light',description:'hidden description with raw details'},
      {label:'Dark',description:'other hidden description'},
    ],
  }],
});
const requestMethod='item/tool/requestUserInput';
test('explicit native completed-agent phases carry replies and ordinary assistant questions, without waiting for the whole turn',()=>{
  for(const [phase,prefix] of [
    ['commentary','Codex progress'],['partial_answer','Codex partial reply'],['final_answer','Codex reply'],
  ] as const) {
    const p=projectNativeItem(entry(message('Which version would you like?',phase)));
    assert.ok(p&&p.kind==='message');
    assert.equal(p.turnId,'native-turn-1');assert.equal(p.itemId,'native-item-1');assert.equal(p.phase,phase);
    assert.equal(renderNativeProjection(p),prefix+'\nWhich version would you like?');
    assert.deepEqual(parseNativeProjection(JSON.parse(JSON.stringify(p))),p);
  }
  const p=projectNativeItem(entry(message('渲染预览已经完成。你想先看哪个版本？ 😀')));
  assert.match(renderNativeProjection(p)!,/预览已经完成。/u);
});
test('completed item proof and explicitly documented phase are necessary; no raw events, deltas, tools or hidden metadata',()=>{
  const known=message('Safe sentence.');
  const {phase:_,...phaseless}=known;
  const bad=[
    entry(phaseless),entry({...known,phase:null}),entry({...known,phase:''}),entry({...known,phase:'analysis'}),
    entry({...known,text:42}),entry({...known,type:'dynamicToolCall'}),entry({...known,type:'reasoning'}),
    entry({...known,type:'commandExecution'}),entry({...known,type:'userMessage'}),
    entry({...known,delivery:'async'}),entry({...known,questions:[]}),entry({...known,memoryCitation:{entries:[]}}),
    entry({...known,toolResult:'not a display facet'}),entry(known,null),entry(known,50),
    {...entry(known),threadId:'notification-not-an-item-page'},
    {method:'item/completed',params:{turnId:'native-turn-1',item:known}}, {type:'item/agentMessage/delta',delta:'private'},
    {...entry(known),turnId:'../../spoof'},
  ];
  for(const value of bad)assert.equal(projectNativeItem(value),undefined,JSON.stringify(value));
  const turn={id:'native-turn-1',itemsView:'full',status:'completed',items:[known]};
  assert.equal(renderNativeProjection(projectNativeMessage(turn,known)),'Codex reply\nSafe sentence.');
  for(const status of ['inProgress','failed','interrupted',null])
    assert.equal(projectNativeMessage({...turn,status},known),undefined);
  assert.equal(projectNativeMessage({...turn,itemsView:'summary'},known),undefined);
  assert.equal(projectNativeMessage(turn,{...known}),undefined);
  assert.equal(projectNativeMessage({...turn,items:[known,{...known}]},known),undefined);
});
test('only user-visible title, question and option labels survive an official structured request',()=>{
  const p=projectNativeInput(requestMethod,descriptor());
  assert.deepEqual(p,{kind:'input',turnId:'turn-not-shown',itemId:'item-not-shown',
    questions:[{header:'Preview type',question:'Which preview would you like?',labels:['Light','Dark']}]});
  const actual=renderNativeProjection(p)!;
  for(const text of ['Preview type','Which preview would you like?','• Light','• Dark',
    'Answer in the original Codex window. Slack replies are not sent to Codex.'])assert.ok(actual.includes(text));
  assert.ok(!/not-shown|question-hidden|description|isBlocking|isSecret|autoResolutionMs/.test(actual));
  assert.ok(!/question-hidden|description|isBlocking|isSecret|autoResolutionMs/.test(JSON.stringify(p)));
  // No-choice question is still genuine. No permissions or answer template.
  const open=descriptor();open.questions[0]!.isOther=true;
  const options=null;
  const free=projectNativeInput(requestMethod,{...open,questions:[{...open.questions[0]!,options}]});
  assert.deepEqual(free?.kind==='input'&&free.questions[0]!.labels,[]);
  assert.match(renderNativeProjection(free)!,/Which preview/);
});
test('rejects mixed secret, unknown or alternative request shapes as a whole, including tool approvals disguised as input',()=>{
  for(const method of ['item/permissions/requestApproval','item/fileChange/requestApproval','item/commandExecution/requestApproval',
    'mcpServer/elicitation/request','item/tool/requestUserInput/delta'])assert.equal(projectNativeInput(method,descriptor()),undefined);
  const d=descriptor(), q=d.questions[0]!;
  const {isSecret:_,...noSecretFlag}=q, {header:__,...missingHeader}=q;
  for(const descriptor of [
    {...d,itemId:null},{...d,questions:[]},{...d,questions:[q,{...q,id:'second',isSecret:true}]},
    {...d,questions:[noSecretFlag]},{...d,questions:[missingHeader]}, {...d,questions:[q,q]},
    {...d,questions:[{...q,isSecret:'false'}]}, {...d,isBlocking:'true'}, {...d,autoResolutionMs:-1},
    {...d,hiddenReasoning:'not an official field'}, {...d,questions:[{...q,debug:'not supported'}]},
    {...d,questions:[{...q,options:[{label:'Choice'}]}]},
    {...d,questions:[{...q,options:[{label:'Choice',description:'',command:'git status'}]}]},
    {...d,questions:[{...q,options:[{label:'Choice',description:''},{label:'Choice',description:'duplicate'}]}]},
    {...d,questions:[{...q,header:'Approve app tool call?',options:[{label:'Run the tool and continue.',description:'Run it'}]}]},
    {...d,questions:[{...q,header:'Permission approval',question:'Proceed with the selected option?'}]},
    {...d,questions:[{...q,question:'Please send your verification code.'}]},
    {...d,questions:[{...q,question:'Choose a winter colour.\r\nFake line'}]},
    {...d,questions:[{...q,options:[{label:'MY_PASSWORD=example',description:'opaque'}]}]},
    {...d,questions:[{...q,options:[{label:'Option A',description:'This option exposes an untrusted api key.'}]}]},
    {...d,questions:[{...q,options:[{label:'Allow once',description:'This looks harmless.'}]}]},
  ]) assert.equal(projectNativeInput(requestMethod,descriptor),undefined,JSON.stringify(descriptor));
});
test('whole-text screening suppresses known credentials, commands, tool excerpts and sensitive or high-impact details',()=>{
  const denied=[
    'The first part looks fine.\n```bash\ncat private.txt\n```',
    'Use `npm test` from the shell.','The command is git status.',
    'Done.\n    verbatim tool detail','Done.\n$ exit','--- a/file.txt\n+++ b/file.txt',
    'Traceback (most recent call last):','Done. Full stdout is below.', 'ERROR code 7',
    'The hidden reasoning has two steps.','This is the system prompt:',
    'This file is at C:\\Users\\Private\\Document.txt', 'Look under /workspace/hosting/private.txt',
    'The api key should not be shared.','Unstructured test token: sk-test_PlaceholderOnly1234567',
    'ＳＫ state. 私钥将保存在本机。','Untrusted password: synthetic','Please enter your ＰＡＳＳＷＯＲＤ.',
    'Credential fragment: 0123456789012345678901234567890123456789','Done. Authorization: Basic anything.','Cookie: auth-value',
    'This is the confirmation for a wire transfer.', 'A medical diagnosis was added.',
    'The account is 4111 1111 1111 1111.', 'A licence id candidate uses 123-45-6789.',
    'Safe prefix. Please visit https://example.invalid/document?opaque=foo',
    'Encoded content &#x60; or %60 in prose.', 'safe prefix\u2066spoof',
    'Runtime fragment: function x() { return false; }',
    ('This normal sentence is repeated. '.repeat(65))+'password: do-not-clip',
  ];
  for(const content of denied)assert.equal(projectNativeItem(entry(message(content))),undefined,content.slice(0,100));
});
test('plain Slack render is deterministic, avoids provider-controlled mentions/formatting, and checks the complete wire size',()=>{
  const p=projectNativeItem(entry(message('Choose *A* or _B_. <@UABCD> <!channel> <#CABC> @here <em>plain</em> & stay.')));
  assert.ok(p&&validateNativeProjection(p));
  const rendered=renderNativeProjection(p)!;
  assert.match(rendered,/Choose ∗A∗ or ＿B＿/u);assert.match(rendered,/\[reference omitted\]/u);
  assert.ok(!/[<>&@*]/u.test(rendered));
  assert.equal(rendered,renderNativeProjection(JSON.parse(JSON.stringify(p))));
  assert.equal(projectNativeItem(entry(message('测试结果正常。'.repeat(500)))),undefined);
  assert.equal(projectNativeItem(entry(message('Ready\n'.repeat(81)))),undefined);
  assert.equal(projectNativeItem(entry(message('   '))),undefined);
  const d=descriptor(),q=d.questions[0]!;
  const max={...d,questions:Array.from({length:4},(_,index)=>({...q,id:'q-'+index,header:'a'.repeat(120),
    question:'A short question. '.repeat(30),options:[{label:'b'.repeat(80),description:''}]}))};
  assert.equal(projectNativeInput(requestMethod,max),undefined);
});
test('revalidation of cached shape declines extra fields, unsafe replacement text and non-canonical render',()=>{
  const p=projectNativeItem(entry(message('I chose the second layout.')))!;
  for(const bad of [{...p,text:'My password is placeholder.'},{...p,text:'<!everyone>'},{...p,text:'   I chose the second layout.'},
    {...p,phase:'unknown'},{...p,debug:{}},{...p,itemId:'../unsafe'}]) {
    assert.equal(parseNativeProjection(bad),undefined);assert.equal(renderNativeProjection(bad),undefined);
  }
  const request=projectNativeInput(requestMethod,descriptor());
  assert.ok(request?.kind==='input'&&validateNativeProjection(request));
  assert.equal(parseNativeProjection({...request,questions:[{...request.questions[0]!,labels:['"api_key":"not-exported"']}]}),undefined);
  assert.equal(parseNativeProjection({...request,questions:[{...request.questions[0]!,description:'not projected'}]}),undefined);
});

test('large benign replies render whole for splitting, but a sensitive suffix blocks every byte',()=>{
  assert.equal(NATIVE_MESSAGE_MAX_WIRE_BYTES,9000);assert.equal(NATIVE_QUESTION_MAX_WIRE_BYTES,2400);
  const long='The second layout is now ready. '.repeat(265)+'Choose the one you prefer.';
  const p=projectNativeItem(entry(message(long)));assert.ok(p);
  const body=renderNativeProjection(p)!;
  assert.equal(body,'Codex reply\n'+long);
  assert.ok(Buffer.byteLength(body)>8000&&Buffer.byteLength(body)<=9000);
  assert.equal(projectNativeItem(entry(message(long+' Authorization: Basic fakeBasicValue.'))),undefined);
  assert.equal(parseNativeProjection({...p,text:long+' \x60git status\x60'}),undefined);
  assert.ok(renderNativeProjection(projectNativeItem(entry(message('预览可以看了。'.repeat(390))))));
});
