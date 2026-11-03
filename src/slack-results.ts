import { createHash, randomUUID } from 'node:crypto';
import { containsSensitiveContent } from './files.js';
import { COMMANDS } from './protocol.js';
import { formatRpcDiagnostic } from './rpc-diagnostics.js';
import type { Config, ResultSnapshot, Source, State, Work } from './types.js';

export const RESULT_TTL_MS=15*60*1000;
export const RESULT_PAGE_SIZE=1600;
export const RESULT_MAX_CHARS=250000;
const clean=(value:unknown,max=100)=>{const text=String(value??'unknown').replace(/[\r\n\t\x00-\x1f\x7f]/g,' ');return text.length>max?text.slice(0,max)+'…':text;};
const budget=(text:string,max=1500)=>[...text].slice(0,max).join('');
export function resultPolicy(config:Config){return createHash('sha256').update(JSON.stringify({slack:config.slack,projects:config.projects,filePolicy:config.filePolicy,sessionPolicy:config.sessionPolicy,screenPolicy:config.screenPolicy})).digest('hex');}
export function resultSensitive(value:unknown):boolean {
  if(typeof value==='string')return containsSensitiveContent(value);
  if(Array.isArray(value))return value.some(resultSensitive);
  return Boolean(value&&typeof value==='object'&&Object.entries(value).some(([key,v])=>containsSensitiveContent(key)||resultSensitive(v)));
}
export function storeResult(state:State,work:Work,result:unknown,config:Config,now=Date.now()):ResultSnapshot|undefined{
  const text=typeof result==='string'?result:JSON.stringify(result,null,2);
  if(typeof text!=='string'||text.length>RESULT_MAX_CHARS||containsSensitiveContent(text)||resultSensitive(result))return;
  const snapshot:ResultSnapshot={id:randomUUID(),command:work.request.command,source:work.source,createdAt:now,expiresAt:now+RESULT_TTL_MS,policy:resultPolicy(config),text};
  const data=result as any;if(['session.list','result.next'].includes(work.request.command)&&Array.isArray(data?.sessions)&&data.nextCursor)snapshot.nextQuery={view:data.view,limit:Math.min(data.pageLimitPerSource,10),cursor:data.nextCursor,...(data.project?{project:data.project}:{})};
  if(['session.messages','result.next'].includes(work.request.command)&&data?.kind==='session.messages'&&data.nextCursor){snapshot.nextCommand='session.messages';snapshot.nextQuery={threadId:data.threadId,role:data.role,order:data.order,limit:data.limit,maxChars:data.maxChars,cursor:data.nextCursor};}
  state.results=(state.results||[]).filter(r=>r.expiresAt>now).slice(-9);state.results.push(snapshot);return snapshot;
}
function authorizedResult(state:Readonly<State>,id:string,source:Source,config:Config,now:number){
  const r=state.results?.find(r=>r.id===id);
  if(!r||r.source.kind!==source.kind||r.source.userId!==source.userId||r.source.channel!==source.channel||r.source.threadTs!==source.threadTs||r.expiresAt<=now||r.policy!==resultPolicy(config)||containsSensitiveContent(r.text))throw Error('RESULT_UNAVAILABLE');try{if(resultSensitive(JSON.parse(r.text)))throw Error('RESULT_UNAVAILABLE');}catch(e){if((e as Error).message==='RESULT_UNAVAILABLE')throw e;}return r;
}
export function nextResultCommand(state:Readonly<State>,id:string,source:Source,config:Config,now=Date.now()){const r=authorizedResult(state,id,source,config,now);if(!r.nextQuery)throw Error('RESULT_UNAVAILABLE');return r.nextCommand==='session.messages'?'session.messages':'session.list';}
export function nextResultQuery(state:Readonly<State>,id:string,source:Source,config:Config,now=Date.now()){const r=authorizedResult(state,id,source,config,now);if(!r.nextQuery)throw Error('RESULT_UNAVAILABLE');return structuredClone(r.nextQuery);}
export function readResult(state:Readonly<State>,id:string,page:number,source:Source,config:Config,now=Date.now()){
  const r=authorizedResult(state,id,source,config,now);
  const points=[...r.text],pages=Math.max(1,Math.ceil(points.length/RESULT_PAGE_SIZE));if(!Number.isSafeInteger(page)||page<1||page>pages)throw Error('RESULT_PAGE_INVALID');
  return{resultId:r.id,command:r.command,page,pages,createdAt:r.createdAt,text:points.slice((page-1)*RESULT_PAGE_SIZE,page*RESULT_PAGE_SIZE).join(''),nextPage:page<pages?page+1:null};
}
/** Slack is a short index into a bounded result, not a dump of backend JSON.
 * Approval prompts and exact human-proof messages do not use this formatter. */
export function compactResult(work:Work,result:any,snapshot?:ResultSnapshot):string{
  const c=work.request.command,p=work.request.params;
  if(c==='result.page')return`result ${result.resultId} | ${result.command} | page ${result.page}/${result.pages}\nSnapshot ${new Date(result.createdAt).toISOString()}; concatenate page text for full detail.\n${result.text}\n${result.nextPage?`nextPage=${result.nextPage}`:'End of result.'}`;
  let summary:string;
  if(c==='help')summary=p.command?String(result):`Commands: ${Object.keys(COMMANDS).join(', ')}\nUse help {"command":"session.list"} for parameters and examples. Slack session.list defaults to loaded sessions, at most 10 per source; view=active filters current loaded metadata, history is explicit. Use a new request ID for each page.`;
  else if(c==='capabilities')summary=`Backend ${result.connected?'connected':'disconnected'}; version=${clean(result.version)}; transport=${clean(result.transport)}\ninstance=${clean(result.instanceId)}; Slack transport=${clean(result.slackTransport?.revision)}; self=${clean(result.slackTransport?.connectorUserId)}\nscreensEnabled=${result.screenCapture?.enabled===true}; desktopCapture=${result.screenCapture?.desktopAvailable===true}\nabsoluteReadonly=${result.fileTools?.allowAbsolutePaths===true}; allSharedSessions=${result.sessionPolicy?.allowAllSharedSessions===true}; attached=${result.attachedThreads?.length||0}\nlastFailure=${clean(result.lastFailure??'none')}; unsupportedMethods=${(result.unsupportedMethods||[]).map((s:any)=>clean(s,60)).join(',')||'none'}`;
  else if(c==='screen.list')summary=`Displays (${result.platform}): permission=${result.permission}; selectionSupported=${result.selectionSupported}\n`+result.displays.map((d:any)=>`${d.id}: ${d.width}×${d.height}, scale=${d.scaleFactor}${d.primary?' (primary)':''}`).join('\n')+'\nCapture: screen.capture {"displayId":"all"} or exact display ID. Unredacted images go to this Slack thread.';
  else if(c==='screen.capture')summary=`Uploaded ${result.uploaded.length} requested display screenshot(s) to this thread. `+result.uploaded.map((i:any)=>`${i.displayId}: ${i.width}×${i.height}`).join(', ');
  else if(c==='session.recent'){
    summary=`Recent execution evidence: returned=${result.returnedCount}/${result.limit}; inspected=${result.coverage?.inspectedCount}/${result.coverage?.candidateCount}; unknownActivity=${result.unknownActivityCount}. Bounded candidates, NOT global top N.\n`+(result.sessions||[]).slice(0,10).map((r:any)=>`${clean(r.threadId,100)} | ${clean(r.lastActivityAt,30)} | ${clean(r.activitySource,25)} | ${clean(r.currentState,15)} | ${clean(r.name||'',35)}`).join('\n');
    if(result.updatedCandidates?.length)summary+='\nActivity unknown; backend-update references (NOT execution):\n'+result.updatedCandidates.slice(0,3).map((r:any)=>`${clean(r.threadId,100)} | ${r.backendUpdatedAtMs?new Date(r.backendUpdatedAtMs).toISOString():'unknown update time'} | ${clean(r.name||'',30)}`).join('\n');
    summary+='\nSelect exact threadId → session.overview → session.messages or explicit session.subscribe. Full rows and coverage in detail.';
  }
  else if(c==='session.overview'){
    const hint=(slot:any,max:number)=>clean(slot?.message?.excerpt??slot?.message?.textStatus??slot?.status??'unknown',max);
    summary=`Selected=${result.count}; deterministic excerpts of available persisted messages, not a semantic task summary. Separate reads, not atomic.\n`+(result.items||[]).map((r:any)=>r.error?`${clean(r.threadId,64)}: ${clean(r.error,50)}`:`${clean(r.threadId,64)} | ${clean(r.metadata?.name||'',20)} | ${clean(r.metadata?.status?.type,12)}\nfirst user: ${hint(r.firstUser,25)}; last user: ${hint(r.lastUser,25)}\nlatest model (${clean(r.latestAssistant?.message?.phase??'unknown',15)}): ${hint(r.latestAssistant,35)}`).join('\n');
  }
  else if(c==='session.messages'||c==='result.next'&&result.kind==='session.messages')summary=`Thread ${clean(result.threadId,128)}; visible=${result.returnedCount}; scanned=${result.scannedItems}; more=${Boolean(result.nextCursor)}; ${result.order}; role=${result.role}. One page, excerpts only.\n`+(result.items||[]).slice(0,3).map((r:any)=>`${clean(r.turnId,128)} ${r.role} (${clean(r.phase??'unknown',20)}): ${clean(r.excerpt??r.textStatus,180)}`).join('\n');
  else if(c==='session.list'||c==='result.next'){
    const rows=result.sessions||[],unknown=result.unknownLoadedCount??result.unresolvedLoadedIds?.length??0;
    summary=`Sessions view=${result.view||p.view||'loaded'}; returned=${rows.length}; unknownLoaded=${unknown}; more=${Boolean(result.nextCursor)}. scannedLoaded=${result.scanned?.loaded??'unknown'}, scannedHistory=${result.scanned?.history??'unknown'}; limitPerSource=${result.pageLimitPerSource}. Page counts, not a global total.\n`+rows.slice(0,10).map((r:any)=>`${clean(r.id,128)} | ${r.loaded===true?'loaded':'history(current unknown)'}:${clean(r.status?.type,20)} | ${clean(r.name||r.reason||'',55)}${r.connectorSessionId?` | session=${clean(r.connectorSessionId,128)}`:''}`).join('\n');
    if(rows.length>10)summary+=`\n${rows.length-10} more rows in this result detail.`;
    if(result.nextCursor)summary+=`\nContinue same view/project with nextCursor from result detail. Do not treat this page as all sessions.`;
    else summary+='\nEnd of this traversal; live state can change. Unknown metadata is not evidence of idle.';
  }
  else if(c==='files.list'){
    const rows=result.entries||[];summary=`Files: returned=${rows.length}; truncated=${Boolean(result.truncated)}\n`+rows.slice(0,10).map((r:any)=>`${r.type==='directory'?'dir':'file'} ${clean(r.path,120)}${r.type==='file'?` (${r.size} bytes)`:''}`).join('\n');if(rows.length>10)summary+=`\n${rows.length-10} more entries in result detail.`;
  }
  else if(c==='files.search')summary=`Search: matches=${result.matches?.length||0}; truncated=${Boolean(result.truncated)}; scanned=${result.scannedFiles??'unknown'}; skipped=${result.skippedFiles??0}\n`+(result.matches||[]).slice(0,5).map((r:any)=>`${clean(r.path,120)}:${r.line??'?'} ${clean(r.text,100)}`).join('\n');
  else if(c==='files.read')summary=`Read ${clean(result.path,180)}; offset=${result.offset??p.offset??0}; nextOffset=${result.nextOffset??'end'}; truncated=${Boolean(result.truncated)}\n${budget(String(result.text??result.content??''),1000)}`;
  else if(c==='session.history')summary=`History: returned=${result.items?.length||0}; more=${Boolean(result.nextCursor)}. User/assistant text only.\n`+(result.items||[]).slice(0,3).map((r:any)=>`${clean(r.turnId,128)} ${clean(r.type,20)}: ${clean(r.text,180)}`).join('\n');
  else if(c==='approval.list')summary=`Pending approvals=${result.length}; this index does not grant approval. Use the complete original prompt in its bound thread.\n`+result.slice(0,8).map((r:any)=>`${clean(r.id,128)} | ${clean(r.kind,20)} | session=${clean(r.sessionId,128)}`).join('\n');
  else if(['session.send','session.queue','session.delivery'].includes(c))summary=`Message evidence: ${clean(result.deliveryStatus,30)}; command=${clean(result.commandStatus,30)}; admission=${clean(result.admission,30)}; start=${clean(result.start,30)}; execution=${clean(result.execution,30)}\nworkId=${clean(result.workId,128)}; turnId=${clean(result.turnId??'unconfirmed',128)}${result.admissionError?`\nAdmission request: ${clean(result.admissionError,80)} (${formatRpcDiagnostic(result.admissionDiagnostic)}).`:''}${result.startError?`\nExplicit start request: ${clean(result.startError,80)} (${formatRpcDiagnostic(result.startDiagnostic)}); this does not establish current queue position or non-delivery. Start result and execution evidence are independent.`:''}\nAccepted means queue admission, not completion. Do not resend. Check session.delivery {\"sessionId\":\"${clean(result.sessionId,128)}\",\"workId\":\"${clean(result.workId,128)}\"}.${result.correlationConflict?' Conflicting correlation evidence; inspect the original session.':''}${result.observationGap?' Observation gap: events may have been missed.':''}${result.coverage?.errors?.length?' Readback incomplete; inspect detail.':''}`;
  else if(c==='session.reply')summary=`Reply queued; session=${clean(result.sessionId,128)}.`;
  else summary=typeof result==='string'?result:JSON.stringify(result,null,2);
  const full=typeof result==='string'?result:JSON.stringify(result);
  if(containsSensitiveContent(full)||resultSensitive(result))return`[${clean(work.request.id,128)}] Sensitive-looking output withheld; inspect locally.`;
  const pages=snapshot?Math.max(1,Math.ceil([...snapshot.text].length/RESULT_PAGE_SIZE)):0;
  const next=snapshot?.nextQuery?`\nNext query page: result.next {"resultId":"${snapshot.id}"}.`: '';
  const footer=snapshot?`${next}\nDetail: result.page {"resultId":"${snapshot.id}","page":1} (${pages} pages; same actor/thread; up to 15 min; earlier eviction possible).`:'\nDetail unavailable (size/security limit); request a smaller page or inspect locally.';
  return`[${clean(work.request.id,128)}] ${budget(summary)}${[...summary].length>1500?'\n[Summary shortened; complete result in detail]':''}${footer}`;
}
