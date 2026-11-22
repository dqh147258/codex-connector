import { createServer, type IncomingMessage } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { parseEnvelope, START_MARKER, END_MARKER } from './protocol.js';
import type { Connector } from './connector.js';
import type { Runtime } from './runtime.js';
import { OPERATOR, type LocalPrincipal } from './types.js';
async function jsonBody(req:IncomingMessage){
  if(!req.headers['content-type']?.startsWith('application/json'))throw Error('BAD_CONTENT_TYPE');const chunks:Buffer[]=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>65536)throw Error('BODY_TOO_LARGE');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const digest=(v:string)=>createHash('sha256').update(v).digest();
const keys=(v:unknown,allowed:string[])=>Boolean(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>allowed.includes(k)));
const word=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=200;
const safeError=new Set(['SERVER_SELECTION_REQUIRED','SERVER_UNAVAILABLE','RECEIPT_NOT_FOUND','LOCAL_SCOPE_DENIED','ACTOR_REVOKED','LOCAL_BINDING_REQUIRED','LOCAL_ACTION_REQUIRED','NEED_VERIFIABLE_HUMAN_DECISION','REQUEST_ID_CONFLICT','LOCAL_GRANT_CHANGED','TURN_OWNER_UNVERIFIED','SLACK_EXPLICIT_BINDING_UNAVAILABLE','INVALID_CURSOR','EVENT_CURSOR_INVALID','LOCAL_EVENT_CURSOR_INVALID','LOCAL_EVENT_SCOPE_DENIED','LOCAL_EVENT_LIMIT','SESSION_NOT_FOUND','EVENT_WAIT_ABORTED','INVALID_LOCAL_EVENT_CURSOR','INVALID_LOCAL_EVENT_QUERY','LOCAL_EVENT_SUBSCRIPTION_UNAVAILABLE','LOCAL_EVENT_SCOPE_UNAVAILABLE','LOCAL_EVENT_WAIT_LIMIT','LOCAL_EVENT_STREAM_LIMIT','WRONG_TARGET','UNKNOWN_ACTION','NATIVE_SHARE_SUBSCRIPTION_NOT_FOUND','NATIVE_SHARE_NOT_READY','NATIVE_SHARE_IDENTITY_UNVERIFIED','NATIVE_SHARE_ALREADY_GRANTED','NATIVE_SHARE_PREVIEW_LIMIT','NATIVE_SHARE_CONFIRMATION_REQUIRED','NATIVE_SHARE_SCOPE_CHANGED','NATIVE_SHARE_DESTINATION_CHECK_UNAVAILABLE','NATIVE_SHARE_DESTINATION_UNVERIFIED','NATIVE_SHARE_THREAD_CHANGED','NATIVE_SHARE_WAIT_UNTIL_IDLE','NATIVE_SHARE_USE_DEDICATED_THREAD','NATIVE_SHARE_HISTORY_GAP','NATIVE_SHARE_EXISTING_SESSION_UNSUPPORTED','NATIVE_SHARE_DEDICATED_PROJECT_REQUIRED','NATIVE_SHARE_CREATE_ALREADY_PENDING','NATIVE_SHARE_CREATE_LIMIT']);
export function apiServer(connector:Connector|Runtime,token:string){
 const runtime='cores' in connector?connector:undefined;
 const operator=digest(token);
 return createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
  const auth=req.headers.authorization;let p:LocalPrincipal|undefined;
  if(typeof auth==='string'&&auth.startsWith('Bearer ')&&auth.length>=39&&auth.length<8192){
    const got=digest(auth.slice(7));
    if(timingSafeEqual(got,operator))p=OPERATOR;
    else if(runtime){const agent=runtime.config.local?.agents?.find(x=>timingSafeEqual(got,Buffer.from(x.tokenHash,'hex')));if(agent)p=runtime.principal(`agent:${agent.id}`);}
  }
  if(req.headers.origin!==undefined||!/^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host||'')||!p||runtime?.config.local?.enabled===false){res.writeHead(401);res.end('{"error":"Unauthorized"}');return;}
  const abort=new AbortController();res.once('close',()=>abort.abort());
  try{
    if(req.method!=='POST'||req.url!=='/v1/command'){res.writeHead(404);res.end('{"error":"Not found"}');return;}
    const body=await jsonBody(req);let result;
    if(!body||typeof body!=='object'||Array.isArray(body))throw Error('UNKNOWN_ACTION');
    if(body.action==='servers'&&runtime&&keys(body,['action']))result=runtime.servers(p);
    else if(body.action==='receipt'&&runtime&&keys(body,['action','serverId','workId'])&&word(body.workId))result=runtime.receipt(body,p);
    else if(body.action==='events'&&runtime&&keys(body,['action','serverId','sessionId','cursor','waitMs','limit'])&&word(body.sessionId))result=await runtime.events(body,p,abort.signal);
    else if(body.action==='unwatch'&&runtime&&keys(body,['action','serverId','sessionId','subscriptionId'])&&word(body.sessionId)&&word(body.subscriptionId))result=runtime.unwatch(body,p);
    else if(body.action==='command'&&keys(body,['action','envelope'])){const r=parseEnvelope(`${START_MARKER}\n${JSON.stringify(body.envelope)}\n${END_MARKER}`,connector.config.instanceId);result=connector.local(r,p);}
    else if(p.role!=='operator')throw Error('LOCAL_SCOPE_DENIED');
    else if(body.action==='native.share'&&runtime&&keys(body,['action','operation','serverId','subscriptionId','confirmationId','phrase'])&&word(body.serverId)&&word(body.subscriptionId)&&
      (['inspect','preview','preview-create','revoke'].includes(body.operation)&&body.confirmationId===undefined&&body.phrase===undefined||
       ['grant','create'].includes(body.operation)&&word(body.confirmationId)&&typeof body.phrase==='string'&&body.phrase.length<=430)){
      result=await runtime.nativeShare(body.serverId,body.operation,body.subscriptionId,body.confirmationId,body.phrase);
    }
    else if(body.action==='status'&&keys(body,['action','serverId']))result=runtime?runtime.status(body.serverId):connector.status();
    else if(body.action==='sessions'&&keys(body,['action','params']))result=await connector.sessionPage(body.params??{});
    else if(body.action==='recover'&&keys(body,['action','serverId','kind','id','observedTs'])&&['command','outbox'].includes(body.kind)&&word(body.id)){if(runtime)runtime.recover(body.kind,body.id,body.observedTs,body.serverId);else connector.recover(body.kind,body.id,body.observedTs);result={recovered:body.id};}
    else throw Error('UNKNOWN_ACTION');
    if(!res.destroyed)res.end(JSON.stringify({ok:true,result}));
  }catch(e){if(res.destroyed)return;const message=e instanceof Error?e.message:'';res.writeHead(['LOCAL_SCOPE_DENIED','LOCAL_GRANT_CHANGED','ACTOR_REVOKED','LOCAL_BINDING_REQUIRED'].includes(message)?403:400);res.end(JSON.stringify({error:safeError.has(message)?message:'REQUEST_REJECTED'}));}
 });
}
