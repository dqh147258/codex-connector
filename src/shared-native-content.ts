import { containsSensitiveContent } from './files.js';
import { deliveryId } from './session-delivery.js';

/**
 * Approved native-to-Slack content only. This module does not prove the backend,
 * current grant/destination, ordered frontier, item origin, or pending lifecycle.
 * Callers must establish those before construction and recheck at dispatch.
 *
 * Upstream v0.165.0 generated schema (immutable):
 * https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/app-server-protocol/schema/typescript/MessagePhase.ts
 * https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/app-server-protocol/schema/typescript/v2/ThreadItem.ts
 * https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/app-server-protocol/schema/typescript/v2/ThreadItemEntry.ts
 * https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/app-server-protocol/schema/typescript/v2/ToolRequestUserInputParams.ts
 * https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/app-server-protocol/schema/typescript/v2/ToolRequestUserInputQuestion.ts
 */
const phases = ['commentary', 'partial_answer', 'final_answer'] as const;
type Phase = (typeof phases)[number];
type Question = Readonly<{header:string; question:string; labels:readonly string[]}>;
export type NativeProjection = Readonly<
  { kind:'message'; turnId:string; itemId:string; phase:Phase; text:string } |
  { kind:'input'; turnId:string; itemId:string; questions:readonly Question[] }
>;

// Entire projection measured before arbitrary downstream splitting; boundaries
// cannot hide sensitive text later in the body.
export const NATIVE_MESSAGE_MAX_WIRE_BYTES=9000, NATIVE_QUESTION_MAX_WIRE_BYTES=2400;
const MAX_LINES=80, MAX_TURN_ITEMS=512;
const MAX_QUESTIONS=4, MAX_LABELS=6, MAX_HEADER=128, MAX_QUESTION=600, MAX_LABEL=100;
const positiveTime=(x:unknown):x is number=>typeof x==='number'&&Number.isSafeInteger(x)&&x>0;
const shape=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x)&&
  (Object.getPrototypeOf(x)===Object.prototype||Object.getPrototypeOf(x)===null);
const fields=(o:Record<string,unknown>,allowed:readonly string[])=>Object.keys(o).every(k=>allowed.includes(k));
const exact=(o:Record<string,unknown>,allowed:readonly string[])=>Object.keys(o).length===allowed.length&&fields(o,allowed);
const isPhase=(p:unknown):p is Phase=>typeof p==='string'&&(phases as readonly string[]).includes(p);
const present=(value:Record<string,unknown>,key:string)=>Object.hasOwn(value,key);

// The filter is deliberately conservative; native text is untrusted even after
// a display phase is proved. This is a set of fail-closed heuristics, NOT DLP:
// it can miss contextual privacy, disguised code, unknown secret formats, or
// sensitive prose without recognisable markers. It can also suppress safe text.
// Use the native UI instead of bypassing a blocked projection.
const sensitiveOrOperational:readonly RegExp[]=[
  /\x60|~{3}|(^|\n)(?: {4}|[ \t]*[$>#%] +(?:[\w.~/\\-]))|&&|\|\|/u,
  /(^|\n)[ ]*(?:diff --git|@@\s+-|\+\+\+\s|---\s+(?:a\/|\/)|[Aa]t \S+\s+\(|Traceback\s|[A-Z][A-Z0-9_]{3,}=|[\[{]\s*["'])/m,
  /\b(?:stderr|stdout|stack trace|raw (?:tool|command|console|debug|server) (?:log|output)|system prompt|hidden (?:reasoning|instructions)|chain[ -]of[ -]thought|developer (?:message|instructions|prompt)|debug (?:log|output|trace)|internal (?:reasoning|prompt|instructions)|command output|run (?:this|the) command|permission scope|sandbox override|unrestricted access|elevated privileges|exit code)\b/i,
  /(^|\n)[ ]*(?:(?:ERROR|WARN|DEBUG|TRACE|FATAL)(?:[ \t:\[]|$)|(?:error|cause|exception|panic)\s*:|\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2})/m,
  /\b(?:sudo|curl|wget|ssh|scp|rsync|bash|zsh|powershell(?:\.exe)?|cmd\.exe|chmod|chown|kubectl|Invoke-WebRequest|Invoke-Expression|Remove-Item)\s+(?:\S+)/i,
  /\b(?:git\s+(?:add|status|checkout|switch|clone|log|diff|fetch|pull|push|commit|merge|reset|rebase|clean|restore|remote)\b|(?:npm|pnpm|yarn|npx|bun|pip|uv|cargo|docker|python3?)\s+(?:test|install|ci|run|exec|build|compose|push|pull|publish|add|remove|-m\b|--?\w)|rm\s+-[^ ]+|(?:cat|cp|mv|ls|mkdir|touch|head|tail|find|grep|sed|awk)\s+(?:--?\w|[~/\\.]\S+))\b/i,
  /\b(?:exec|eval|require|fetch|print|console\.log)\s*\(|\$[({]|\b(?:function|const|let|var|class|import)\s+[\w$]+\s*(?:[=({]|from\b)|<\/?(?:script|style|iframe|svg|img)\b/i,
  /(?:^|[\s("'=])(?:[a-z]:[\\/]|[\\]{2}|~[\\/]|\/(?:home|Users|root|workspace|etc|mnt|opt|tmp|var|private|dev|proc)\/)|\.\.?[\\/](?:ssh|aws|config|codex|npmrc|git-credentials)\b/i,
  /\b(?:passwords?|passphrases?|passcodes?|credentials?|client[_ -]?secrets?|private[_ -]?keys?|secret[_ -]?keys?|api[_ -]?keys?|(?:access|refresh|session|bearer|authentication|reset|recovery|personal access)[_ -]?tokens?|(?:api|auth)[_ -]?tokens?|ssh[_ -]?keys?|recovery[_ -]?(?:codes?|seeds?|phrases?)|seed[_ -]?phrases?|one[- ]time passwords?|verification codes?|activation codes?|authorization\s*:|bearer\s+[\w./+-]{4,}|otp\s*[:=])\b/i,
  /\b(?:authorization|cookie|set-cookie|(?:session[_ -]?)?token|secret)\s*[:=]|\bbasic\s+[\w+/-]{8,}/i,
  /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk[-_](?:live_|test_|proj-|svcacct-)?[A-Za-z0-9_-]{12,}|xox[a-z]-[A-Za-z0-9-]{8,}|xapp-[A-Za-z0-9-]{8,}|(?:AKIA|ASIA)[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/u,
  /(?:^|[\s'"])(?:[a-f\d]{32,}|[A-Za-z0-9_/-]{40,}={0,2})(?=$|[\s'".,;:!?])/i,
  /\b\d{3}-\d{2}-\d{4}\b|(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)|\b(?:full )?(?:social security(?: number)?|bank account(?: number)?|credit card(?: number)?|passport (?:id|number)|driver'?s licen[cs]e (?:id|number)|taxpayer identification(?: number)?|medical diagnosis|prescription medication|lawsuit settlement|wire transfer|severance agreement|employment termination|resignation notice|legally binding|formal accusation)\b/i,
  /密码|口令|验证码|恢复密钥|助记词|账号凭据|存取令牌|访问令牌|私钥|身份证(?:号|号码)|银行(?:账号|卡号)|医疗诊断|辞职信|解雇通知|汇款指令|转账指令|隐藏推理|系统提示词|开发者指令|命令输出|工具原始输出|是否授权|(?:批准|许可|允许).{0,12}(?:命令|工具|脚本|权限)|提升权限/u,
  /\b(?:approve (?:app|the app|this|the) (?:tool|command|action)|(?:app tool|tool call|command|file change|permission) approval|run (?:the|this) tool and (?:continue|remember)|grant (?:the|this)?\s*(?:(?:tool|app|device|file|network) )?(?:access|permission)|continue with elevated privileges)\b/i,
  // Deny live links outright for these automatic shares. URLs and opaque
  // addresses can embed personal data, auth tokens, or hidden destinations.
  /(?:\b[a-z][a-z\d+.-]{0,47}:\/\/|\bwww\.|\bmailto:|\b[\w.+-]{1,128}@[a-z\d.-]{1,253}\.[a-z]{2,63}\b|\bhttps?%3a%2f%2f)/i,
  /(?:&(?:amp|lt|gt|#(?:\d+|x[\da-f]+));|%[\da-f]{2}|\\(?:x[\da-f]{2}|u[\da-f]{4}))/i,
];

// Existing SlackClient escapes &, <, > and sends parse:none, link_names:false,
// unfurl_links:false. Also remove provider-controlled mention tokens and
// disable mrkdwn punctuation in the body itself. Do not pre-escape entities;
// the transport will perform its normal escaping once. See:
// https://docs.slack.dev/messaging/formatting-message-text/
const approvalLabel=/^(?:allow|accept|decline|allow and don['’]t ask me again|approve(?: for this session)?|authorize|allow (?:once|always|for this session)|deny permission|grant access|批准|授权|(?:本次|始终)允许)$/i;
// v0.171.0-alpha.13 (the verified Windows executable's release source) and
// v0.165.0 emit the same RPC for ordinary questions and fallback MCP/app
// approvals. The core builds reserved question IDs *before* rendering a
// customizable approval template; never use the wording as the discriminator.
// https://github.com/openai/codex/blob/rust-v0.171.0-alpha.13/codex-rs/core/src/mcp_tool_call.rs#L1823-L1849
const approvalId=/^mcp_tool_call_approval(?:[_:.-]|$)/i;
const plain=(s:string)=>s.replace(/<(?:[@#!][^<>\n]{0,256})>/gu,'[reference omitted]')
  .replace(/:[A-Za-z0-9_+-]{1,64}:/gu,c=>c.replaceAll(':','：'))
  .replace(/[@<>*_~&]/gu,c=>({'@':'＠','<':'＜','>':'＞','*':'∗','_':'＿','~':'～','&':'＆'}[c]!));
function safeText(raw:unknown,max:number,singleLine=false):string|undefined{
  if(typeof raw!=='string'||raw.length>max||Buffer.byteLength(raw)>max)return;
  const authored=raw.replace(/\r\n/g,'\n');
  if(/[\r\t\p{Cf}\uD800-\uDFFF\u2028\u2029]/u.test(authored)||/\p{Cc}/u.test(authored.replaceAll('\n','')))return;
  if(singleLine&&authored.includes('\n')||authored.split('\n').length>MAX_LINES)return;
  const normalized=authored.normalize('NFKC');
  if(containsSensitiveContent(authored)||containsSensitiveContent(normalized)||
    sensitiveOrOperational.some(re=>re.test(normalized)))return;
  const text=plain(authored.trim());
  if(!/[\p{L}\p{N}\p{So}]/u.test(text)||Buffer.byteLength(text)>max)return;
  return text;
}
function render(p:NativeProjection) {
  if(p.kind==='message'){
    const prefix=p.phase==='final_answer'?'Codex reply':p.phase==='partial_answer'?'Codex partial reply':'Codex progress';
    return `${prefix}\n${p.text}`;
  }
  const qs=p.questions.map(q=>`${q.header}\n${q.question}${q.labels.map(l=>'\n• '+l).join('')}`);
  return ['Codex asked a question',...qs,'Answer in the original Codex window. Slack replies are not sent to Codex.'].join('\n\n');
}
function bounded(p:NativeProjection):NativeProjection|undefined{
  // Account for existing SlackClient escaping (defence in depth if rendering
  // ever stops neutralising all three special characters).
  const escaped=render(p).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  return Buffer.byteLength(escaped)<=(p.kind==='message'?NATIVE_MESSAGE_MAX_WIRE_BYTES:NATIVE_QUESTION_MAX_WIRE_BYTES)?p:undefined;
}
function message(turnId:string,item:unknown):NativeProjection|undefined{
  if(!shape(item)||!fields(item,['type','id','phase','text','memoryCitation','delivery','questions'])||
    item.type!=='agentMessage'||!deliveryId(item.id)||!isPhase(item.phase))return;
  // Async question/delivery schemas and memory citations are not part of this
  // supported projection. Missing/null metadata is compatible with older builds.
  if(item.memoryCitation!=null||item.delivery!=null||item.questions!=null)return;
  const text=safeText(item.text,NATIVE_MESSAGE_MAX_WIRE_BYTES);
  return text?bounded({kind:'message',turnId,itemId:item.id,phase:item.phase,text}):undefined;
}

/** A completed individual entry returned by ordered native thread/items/list. */
export function projectNativeItem(entry:unknown):NativeProjection|undefined {
  if(!shape(entry)||!fields(entry,['turnId','item','startedAtMs','completedAtMs'])||
    !deliveryId(entry.turnId)||!positiveTime(entry.completedAtMs))return;
  if(entry.startedAtMs!=null&&(!positiveTime(entry.startedAtMs)||entry.startedAtMs>entry.completedAtMs))return;
  return message(entry.turnId,entry.item);
}

/** Optional fallback for a known completed native turn with a proven full items
 * view. Never pass a live turn/completed notification or a summary view here. */
export function projectNativeMessage(turn:unknown,item:unknown):NativeProjection|undefined {
  if(!shape(turn)||!deliveryId(turn.id)||turn.status!=='completed'||turn.itemsView!=='full'||!Array.isArray(turn.items)||
    turn.items.length>MAX_TURN_ITEMS||!shape(item)||!turn.items.includes(item)||
    turn.items.filter(x=>shape(x)&&x.id===item.id).length!==1)return;
  return message(turn.id,item);
}

/** Rebuild visible facets from the sealed supported request shape. The caller
 * must prove this exact same-epoch request is still pending at queue/dispatch. */
export function projectNativeInput(method:string,params:unknown):NativeProjection|undefined {
  if(method!=='item/tool/requestUserInput'||!shape(params)||
    !fields(params,['threadId','turnId','itemId','questions','isBlocking','autoResolutionMs'])||
    !deliveryId(params.threadId)||!deliveryId(params.turnId)||!deliveryId(params.itemId)||
    !Array.isArray(params.questions)||params.questions.length<1||params.questions.length>MAX_QUESTIONS||
    present(params,'isBlocking')&&typeof params.isBlocking!=='boolean'||
    present(params,'autoResolutionMs')&&params.autoResolutionMs!==null&&params.autoResolutionMs!==0&&!positiveTime(params.autoResolutionMs))return;
  const questions:Question[]=[],ids=new Set<string>();
  for(const q of params.questions){
    if(!shape(q)||!exact(q,['id','header','question','isOther','isSecret','options'])||
      !deliveryId(q.id)||approvalId.test(q.id)||ids.has(q.id)||q.isSecret!==false||typeof q.isOther!=='boolean')return;
    ids.add(q.id);
    const header=safeText(q.header,MAX_HEADER,true),question=safeText(q.question,MAX_QUESTION,true);
    if(!header||!question)return;
    const labels:string[]=[];
    if(q.options!==null){
      if(!Array.isArray(q.options)||q.options.length>MAX_LABELS)return;
      for(const option of q.options){
        if(!shape(option)||!exact(option,['label','description'])||typeof option.description!=='string'||
          Buffer.byteLength(option.description)>NATIVE_QUESTION_MAX_WIRE_BYTES)return;
        // Descriptions cannot appear in Slack, but may expose what looks like
        // a harmless choice as an approval or include a recognizable secret.
        if(option.description.trim()&&!safeText(option.description,NATIVE_QUESTION_MAX_WIRE_BYTES))return;
        const label=safeText(option.label,MAX_LABEL,true);
        if(!label||approvalLabel.test(label.normalize('NFKC'))||labels.includes(label))return;
        labels.push(label);
      }
    }
    questions.push({header,question,labels});
  }
  return bounded({kind:'input',turnId:params.turnId,itemId:params.itemId,questions});
}

/** Parse a *projection*, never a native payload. Match the canonical selected
 * fields and repeat content screening and escaping/size assessment on read. */
export function parseNativeProjection(value:unknown):NativeProjection|undefined{
  if(!shape(value)||!deliveryId(value.turnId)||!deliveryId(value.itemId))return;
  if(value.kind==='message'){
    if(!exact(value,['kind','turnId','itemId','phase','text'])||!isPhase(value.phase))return;
    const text=safeText(value.text,NATIVE_MESSAGE_MAX_WIRE_BYTES);
    return text&&text===value.text?bounded({kind:'message',turnId:value.turnId,itemId:value.itemId,phase:value.phase,text}):undefined;
  }
  if(value.kind!=='input'||!exact(value,['kind','turnId','itemId','questions'])||!Array.isArray(value.questions)||
    value.questions.length<1||value.questions.length>MAX_QUESTIONS)return;
  const questions:Question[]=[];
  for(const q of value.questions){
    if(!shape(q)||!exact(q,['header','question','labels'])||!Array.isArray(q.labels)||q.labels.length>MAX_LABELS)return;
    const header=safeText(q.header,MAX_HEADER,true),question=safeText(q.question,MAX_QUESTION,true);
    if(!header||header!==q.header||!question||question!==q.question)return;
    const labels:string[]=[];
    for(const raw of q.labels){
      const label=safeText(raw,MAX_LABEL,true);
      if(!label||label!==raw||approvalLabel.test(label.normalize('NFKC'))||labels.includes(label))return;
      labels.push(label);
    }
    questions.push({header,question,labels});
  }
  return bounded({kind:'input',turnId:value.turnId,itemId:value.itemId,questions});
}
export const validateNativeProjection=(value:unknown):value is NativeProjection=>parseNativeProjection(value)!==undefined;
export function renderNativeProjection(value:unknown):string|undefined {
  const p=parseNativeProjection(value);return p?render(p):undefined;
}
