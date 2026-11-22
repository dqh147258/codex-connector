import { createHash,randomBytes } from 'node:crypto';
import { deliveryId } from './session-delivery.js';
import type { NativeProjection } from './shared-native-content.js';

const MAX_EVIDENCE=512, STOP_AFTER=300_000, SAFETY_MARGIN=1_500;
const isRecord=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const isHash=(x:unknown):x is string=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const validTime=(x:unknown):x is number=>typeof x==='number'&&Number.isSafeInteger(x)&&x>0;
const timestamp=(x:unknown):x is string=>typeof x==='string'&&/^\d{1,20}\.\d{1,10}$/.test(x);
export const questionDigest=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export const newQuestionReference=()=>randomBytes(24).toString('base64url');
export type AnswerSpec={digest:string;questions:readonly {questionId:string;choices:readonly string[]}[]};

/** Keep exact callback option values in memory only. The strict native
 * projection is a precondition, not a substitute for wire type/label equality.
 * Do not offer a partial modal if any question allows unbounded/free input. */
export function answerSpec(params:unknown,projection:NativeProjection):AnswerSpec|undefined{
  if(projection.kind!=='input'||!isRecord(params)||!Array.isArray(params.questions)||params.questions.length!==projection.questions.length)return;
  const questions:AnswerSpec['questions'][number][]=[];
  const canonicalWire:unknown[]=[];
  for(const [ix,wire] of params.questions.entries()){
    const p=projection.questions[ix];
    if(!p||!isRecord(wire)||wire.isOther!==false||wire.isSecret!==false||!deliveryId(wire.id)||!Array.isArray(wire.options)||
      p.labels.length<1||wire.options.length!==p.labels.length)return;
    // Prevent prototypes and reserved IDs even on otherwise legitimate prompts.
    if(['__proto__','constructor','prototype'].includes(wire.id)||/^mcp_tool_call_approval_/i.test(wire.id))return;
    const choices:string[]=[];
    const optionDetails:unknown[]=[];
    for(const [j,option] of wire.options.entries()){
      if(!isRecord(option)||typeof option.label!=='string'||option.label!==p.labels[j]||typeof option.description!=='string')return;
      choices.push(option.label);optionDetails.push([option.label,option.description]);
    }
    questions.push({questionId:wire.id,choices});
    canonicalWire.push([wire.id,wire.header,wire.question,optionDetails]);
  }
  return {digest:questionDigest([projection,canonicalWire,params.isBlocking??null]),questions};
}

export function nativeAnswerPayload(spec:AnswerSpec, choices:readonly number[]){
  if(!Array.isArray(choices)||choices.length!==spec.questions.length)return;
  const answers=Object.create(null) as Record<string,{answers:string[]}>;
  for(const [i,q] of spec.questions.entries()){
    const index=choices[i];
    if(typeof index!=='number'||!Number.isSafeInteger(index)||index<0||index>=q.choices.length)return;
    answers[q.questionId]={answers:[q.choices[index]!]};
  }
  return {answers};
}

export interface QuestionEvidence {
  // Logical identity hashes include verified Home/backend, grant, thread, turn and item.
  key:string; digest:string; firstEpoch:string; firstObservedAt:number; expiresAt:number;
  status:'observed'|'posting'|'posted'|'submitting'|'submitted'|'uncertain'|'closed'|'changed';
  epoch?:string; deliveryId?:string; reference?:string; messageTs?:string; request?:string;
  claimedBy?:string; closedAt?:number;
}
export interface QuestionState { nativeQuestionAnswers?:QuestionEvidence[] }
const statuses=new Set(['observed','posting','posted','submitting','submitted','uncertain','closed','changed']);
const fieldNames=new Set(['key','digest','firstEpoch','firstObservedAt','expiresAt','status','epoch','deliveryId','reference','messageTs','request','claimedBy','closedAt']);

export function validateQuestionEvidence(d:Readonly<QuestionState>){
  const rows=d.nativeQuestionAnswers;
  if(rows===undefined)return;
  if(!Array.isArray(rows)||rows.length>MAX_EVIDENCE||new Set(rows.map(q=>q?.key)).size!==rows.length||
    rows.some(q=>!isRecord(q)||!Object.keys(q).every(k=>fieldNames.has(k))||!isHash(q.key)||!isHash(q.digest)||!isHash(q.firstEpoch)||
      !validTime(q.firstObservedAt)||!validTime(q.expiresAt)||q.expiresAt<q.firstObservedAt||q.expiresAt-q.firstObservedAt>STOP_AFTER||
      typeof q.status!=='string'||!statuses.has(q.status)||q.epoch!==undefined&&!isHash(q.epoch)||q.reference!==undefined&&!isHash(q.reference)||
      q.deliveryId!==undefined&&!deliveryId(q.deliveryId)||q.messageTs!==undefined&&!timestamp(q.messageTs)||
      q.request!==undefined&&!isHash(q.request)||q.claimedBy!==undefined&&!isHash(q.claimedBy)||q.closedAt!==undefined&&!validTime(q.closedAt)||
      ['posting','posted','submitting','submitted','uncertain'].includes(q.status)&&(!q.epoch||!q.request||!q.deliveryId||!q.reference)||
      ['posted','submitting','submitted','uncertain'].includes(q.status)&&!q.messageTs||
      ['submitting','submitted','uncertain'].includes(q.status)&&!q.claimedBy)){
    throw Error('NATIVE_QUESTION_STATE_INVALID');
  }
}

export function recoverQuestionEvidence(d:QuestionState){
  for(const row of d.nativeQuestionAnswers??[]){
    if(row.status==='submitting')row.status='uncertain';
    // No post ack => ref is not actionable. A verified replay can mint a
    // different ref; an uncertain native response must never be repeated.
    if(row.status==='posting')row.status='observed';
  }
}
export function observeQuestionEvidence(d:QuestionState,key:string,digest:string,epoch:string,now:number,
  relativeTimeout:unknown,observedFromBirth:boolean){
  const rows=d.nativeQuestionAnswers??=[];
  const prior=rows.find(q=>q.key===key);
  if(prior){
    // A changed question is never fulfilled by an old modal, even if a
    // later replay happens to revert to the original contents.
    if(prior.digest!==digest){if(!['submitting','submitted','uncertain'].includes(prior.status))prior.status='changed';return;}
    return prior;
  }
  if(rows.length>=MAX_EVIDENCE)return;
  const relative=typeof relativeTimeout==='number'&&Number.isSafeInteger(relativeTimeout)&&relativeTimeout>0?relativeTimeout:undefined;
  const duration=relative===undefined?STOP_AFTER:observedFromBirth?Math.min(STOP_AFTER,relative):0;
  const q:QuestionEvidence={key,digest,firstEpoch:epoch,firstObservedAt:now,expiresAt:now+duration,status:'observed'};
  rows.push(q);return q;
}

export function canOfferQuestion(row:QuestionEvidence|undefined,epoch:string,digest:string,now:number){
  return !!row&&row.digest===digest&&row.expiresAt-now>SAFETY_MARGIN&&
    (row.status==='observed'||row.status==='posting'&&row.epoch===epoch||row.status==='posted'&&row.epoch!==epoch);
}
export function stageQuestionPost(row:QuestionEvidence,slot:{epoch:string;request:string;deliveryId:string;reference:string}){
  row.status='posting';row.epoch=slot.epoch;row.request=slot.request;row.deliveryId=slot.deliveryId;row.reference=slot.reference;delete row.messageTs;
}
export function confirmQuestionPost(row:QuestionEvidence,deliveryId:string,ts:string){
  if(row.status!=='posting'||row.deliveryId!==deliveryId||!timestamp(ts))return false;
  row.status='posted';row.messageTs=ts;return true;
}
export function actionableQuestion(row:QuestionEvidence|undefined,proof:{refHash:string;epoch:string;request:string;messageTs:string;digest:string},now:number){
  return !!row&&row.status==='posted'&&row.reference===proof.refHash&&row.epoch===proof.epoch&&row.request===proof.request&&
    row.messageTs===proof.messageTs&&row.digest===proof.digest&&row.expiresAt-now>SAFETY_MARGIN;
}
export function closeQuestionEvidence(row:QuestionEvidence,now:number){
  row.closedAt=now;
  if(!['submitting','submitted','uncertain','changed'].includes(row.status))row.status='closed';
}
