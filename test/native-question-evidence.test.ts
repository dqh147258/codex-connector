import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionableQuestion,answerSpec,canOfferQuestion,closeQuestionEvidence,confirmQuestionPost,nativeAnswerPayload,
  observeQuestionEvidence,questionDigest,recoverQuestionEvidence,stageQuestionPost,validateQuestionEvidence } from '../src/native-question-evidence.js';
import { projectNativeInput } from '../src/shared-native-content.js';

const rpc='item/tool/requestUserInput';
const p={threadId:'thread-one',turnId:'turn-one',itemId:'item-one',questions:[{id:'layout_one',header:'Layout',question:'Which visual layout works?',
  isOther:false,isSecret:false,options:[{label:'Clean',description:'One column.'},{label:'Spacious',description:'Two columns.'}]}]};
const key=questionDigest('logical'),digest=questionDigest('schema'),e1=questionDigest('first'),e2=questionDigest('second');
const staged={epoch:e1,request:questionDigest('rpc'),deliveryId:'post-one',reference:questionDigest('random-reference')};

test('answer wire result contains only fixed exact native option labels, never captions or free text',()=>{
  const projection=projectNativeInput(rpc,p)!;
  const spec=answerSpec(p,projection)!;
  assert.deepEqual(JSON.parse(JSON.stringify(nativeAnswerPayload(spec,[1]))),{answers:{layout_one:{answers:['Spacious']}}});
  for(const choices of [[],[2],[-1],[0.5],[NaN],[1,1],['1']])
    assert.equal(nativeAnswerPayload(spec,choices as number[]),undefined);
  for(const newFields of [{id:'__proto__'},{id:'mcp_tool_call_approval_1'},{isOther:true},{isSecret:true},{options:null},
    {options:[{label:' Clean',description:'One column.'},{label:'Spacious',description:'Two columns.'}]}])
    assert.equal(answerSpec({...p,questions:[{...p.questions[0],...newFields}]},projection),undefined);
  assert.notEqual(answerSpec({...p,questions:[{...p.questions[0],options:[{label:'Clean',description:'A changed rule.'},{label:'Spacious',description:'Two columns.'}]}]},projection)?.digest,spec.digest);
});

test('replay cannot renew original relative timeout or presume unseen replay full duration',()=>{
  const d:import('../src/native-question-evidence.js').QuestionState={};
  const q=observeQuestionEvidence(d,key,digest,e1,10000,5000,true)!;
  assert.equal(q.expiresAt,15000);
  const replay=observeQuestionEvidence(d,key,digest,e2,14000,120000,false)!;
  assert.equal(replay.expiresAt,15000);
  assert.equal(canOfferQuestion(replay,e2,digest,14000),false);
  const noEvidence=observeQuestionEvidence(d,questionDigest('unseen'),digest,e2,15000,100000,false)!;
  assert.equal(noEvidence.expiresAt,15000);
  assert.equal(canOfferQuestion(noEvidence,e2,digest,15000),false);
  assert.doesNotThrow(()=>validateQuestionEvidence(d));
});

test('native observations have independent post, one-shot claim, submitted and resolved evidence',()=>{
  const d:import('../src/native-question-evidence.js').QuestionState={};
  const row=observeQuestionEvidence(d,key,digest,e1,10000,30000,true)!;
  const proof={refHash:staged.reference,epoch:staged.epoch,request:staged.request,messageTs:'10.5',digest};
  stageQuestionPost(row,staged);
  assert.equal(actionableQuestion(row,proof,15000),false);
  assert.equal(confirmQuestionPost(row,staged.deliveryId,proof.messageTs),true);
  assert.equal(actionableQuestion(row,proof,15000),true);
  assert.equal(actionableQuestion(row,{...proof,epoch:e2},15000),false);
  assert.equal(actionableQuestion(row,{...proof,messageTs:'11.5'},15000),false);
  row.status='submitting';row.claimedBy=questionDigest('human-one');
  closeQuestionEvidence(row,17000);
  assert.equal(row.status,'submitting');
  recoverQuestionEvidence(d);
  assert.equal(row.status,'uncertain');
  assert.equal(canOfferQuestion(row,e2,digest,19000),false);
  assert.equal(actionableQuestion(row,proof,19000),false);
  assert.doesNotThrow(()=>validateQuestionEvidence(d));
  (row as any).secretAnswer='This unknown state field cannot persist.';
  assert.throws(()=>validateQuestionEvidence(d),/NATIVE_QUESTION_STATE_INVALID/);
});
