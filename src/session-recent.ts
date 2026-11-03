import type { Backend } from './types.js';
import type { ActivityRecord } from './session-activity.js';
import { resultSensitive } from './slack-results.js';
export class RecentError extends Error { constructor(readonly code:string){super(code);} }
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(v);
const timestamp=(v:unknown,now:number):number|null=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0&&v<=now+300000?v:null;
const seconds=(v:unknown,now:number)=>typeof v==='number'?timestamp(v*1000,now):null;
type Limits={candidates:number;calls:number;bytes:number;timeoutMs:number;rpcMs:number};
const defaults:Limits={candidates:40,calls:100,bytes:2*1024*1024,timeoutMs:20000,rpcMs:3000};
/** Only metadata discovery and metadata-only turn pages. Never joins event streams. */
export class RecentSessions {
  private limits:Limits;
  constructor(private backend:Backend,private records:()=>readonly ActivityRecord[],private summarize:(thread:any)=>Record<string,any>,limits:Partial<Limits>={}){this.limits={...defaults,...limits};for(const k of Object.keys(defaults) as (keyof Limits)[])if(!Number.isSafeInteger(this.limits[k])||this.limits[k]<1||this.limits[k]>defaults[k])throw new RecentError('INVALID_RECENT_LIMIT');}
  async query(limit=5){
    if(!Number.isSafeInteger(limit)||limit<1||limit>20)throw new RecentError('INVALID_RECENT_QUERY');
    const now=Date.now(),epoch=this.backend.epoch,deadline=now+this.limits.timeoutMs;let calls=0,bytes=0;
    const rpc=async(method:string,params:any)=>{if(!this.backend.connected||this.backend.epoch!==epoch)throw new RecentError('RECENT_CONNECTION_CHANGED');if(++calls>this.limits.calls||Date.now()>=deadline)throw new RecentError('RECENT_BUDGET_EXCEEDED');let timer:ReturnType<typeof setTimeout>|undefined;try{const r=await Promise.race([this.backend.rpc(method,params),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new RecentError('RECENT_TIMEOUT')),Math.min(this.limits.rpcMs,deadline-Date.now()));})]);if(!this.backend.connected||this.backend.epoch!==epoch)throw new RecentError('RECENT_CONNECTION_CHANGED');bytes+=Buffer.byteLength(JSON.stringify(r)??'');if(bytes>this.limits.bytes)throw new RecentError('RECENT_BUDGET_EXCEEDED');return r;}finally{if(timer)clearTimeout(timer);}};
    const error=(e:any)=>e instanceof RecentError?e.code:['METHOD_UNSUPPORTED','RPC_ERROR'].includes(e?.code)?e.code:'METADATA_UNAVAILABLE';
    const page=(r:any,ids:boolean)=>{if(!r||!Array.isArray(r.data)||r.data.length>this.limits.candidates||!Object.hasOwn(r,'nextCursor')||r.nextCursor!==null&&(typeof r.nextCursor!=='string'||!r.nextCursor||r.nextCursor.length>512)||r.data.some((t:any)=>!id(ids?t:t?.id)))throw new RecentError('INVALID_RECENT_PAGE');return r;};
    let stored:any={data:[],nextCursor:null},loaded:any={data:[],nextCursor:null};const sourceErrors:Record<string,string>={};
    try{stored=page(await rpc('thread/list',{limit:this.limits.candidates,sortKey:'updated_at',sortDirection:'desc',useStateDbOnly:true,modelProviders:[]}),false);}catch(e){sourceErrors.history=error(e);}
    try{loaded=page(await rpc('thread/loaded/list',{limit:this.limits.candidates}),true);}catch(e){sourceErrors.loaded=error(e);}
    const records=this.records(),ledger=new Map(records.map(r=>[r.threadId,r])),loadedIds=new Set<string>(loaded.data);
    // Interleave evidence sources instead of allowing history to consume the entire candidate budget.
    const pools=[records.map(r=>r.threadId),[...loadedIds],stored.data.map((t:any)=>t.id)],ids:string[]=[];
    for(let i=0;ids.length<this.limits.candidates&&pools.some(p=>i<p.length);i++)for(const pool of pools){const v=pool[i];if(id(v)&&!ids.includes(v)&&ids.length<this.limits.candidates)ids.push(v);}
    const rows:any[]=[],unknownIds:string[]=[],failures:{threadId:string;error:string}[]=[];let turnMethodUnavailable=false;
    for(const threadId of ids){
      try{
        const r=await rpc('thread/read',{threadId,includeTurns:false});if(r?.thread?.id!==threadId)throw new RecentError('INVALID_RECENT_PAGE');
        const t=r.thread,selected={id:threadId,name:t.name,cwd:t.cwd,model:t.model,source:typeof t.source==='string'?t.source:'structured-source'};
        if(resultSensitive(selected))throw new RecentError('SENSITIVE_CONTENT');
        const raw=this.summarize(t);if(resultSensitive(raw))throw new RecentError('SENSITIVE_CONTENT');
        const field=(v:unknown,max:number)=>typeof v==='string'?[...v].slice(0,max).join(''):null;
        const meta={id:threadId,name:field(raw.name,200),cwd:field(raw.cwd,1024),status:{type:field(raw.status?.type,40)||'unknown'},model:field(raw.model,100),source:field(raw.source,100),project:field(raw.project,128),manageable:typeof raw.manageable==='boolean'?raw.manageable:null,reason:field(raw.reason,100),canAcceptDirectInput:typeof raw.canAcceptDirectInput==='boolean'?raw.canAcceptDirectInput:null,connectorSessionId:field(raw.connectorSessionId,128)};
        const observed=ledger.get(threadId),observedTime=observed?timestamp(observed.activityAtMs,now):null;
        let activityAtMs=observedTime,activitySource=observedTime?'observed-lifecycle':null,activityEvent=observedTime?observed!.eventKind:null,activityTurnId:string|null=null,turnError:string|null=null;
        if(!turnMethodUnavailable){try{
          const turns=await rpc('thread/turns/list',{threadId,limit:1,sortDirection:'desc',itemsView:'notLoaded'});
          if(!turns||!Array.isArray(turns.data)||turns.data.length>1||turns.data.some((v:any)=>!v||!id(v.id)))throw new RecentError('INVALID_RECENT_PAGE');
          const turn=turns.data[0];if(turn&&resultSensitive({id:turn.id}))throw new RecentError('SENSITIVE_CONTENT');const started=seconds(turn?.startedAt,now),completed=seconds(turn?.completedAt,now),at=Math.max(started||0,completed||0)||null;
          if(at!==null&&(activityAtMs===null||at>activityAtMs)){activityAtMs=at;activitySource='latest-turn-lifecycle';activityEvent=completed!==null&&completed>= (started||0)?'turn/completed':'turn/started';activityTurnId=turn.id;}
        }catch(e){turnError=error(e);if(turnError==='METHOD_UNSUPPORTED')turnMethodUnavailable=true;}}
        else turnError='METHOD_UNSUPPORTED';
        const row={...meta,threadId,loaded:loadedIds.has(threadId)?true:null,currentState:meta.status?.type||'unknown',lastActivityAtMs:activityAtMs,lastActivityAt:activityAtMs?new Date(activityAtMs).toISOString():null,activitySource,activityEvent,activityTurnId,observedAtMs:activitySource==='observed-lifecycle'?observed!.observedAtMs:null,backendUpdatedAtMs:seconds(t.updatedAt,now),turnMetadataError:turnError};
        rows.push(row);if(activityAtMs===null)unknownIds.push(threadId);
      }catch(e){failures.push({threadId,error:error(e)});if(e instanceof RecentError&&['RECENT_CONNECTION_CHANGED','RECENT_BUDGET_EXCEEDED','RECENT_TIMEOUT'].includes(e.code))break;}
    }
    if(!this.backend.connected||this.backend.epoch!==epoch)throw new RecentError('RECENT_CONNECTION_CHANGED');
    const known=rows.filter(r=>r.lastActivityAtMs!==null).sort((a,b)=>b.lastActivityAtMs-a.lastActivityAtMs||(a.threadId<b.threadId?-1:a.threadId>b.threadId?1:0));
    // Generic updates are a separate reference list, never blended into execution ranking.
    const updatedCandidates=[...new Set<string>(stored.data.map((t:any)=>t.id))].map(threadId=>rows.find(r=>r.threadId===threadId)).filter((r:any)=>r&&r.lastActivityAtMs===null).slice(0,limit);
    return{kind:'session.recent',asOf:new Date(now).toISOString(),limit,sessions:known.slice(0,limit),returnedCount:Math.min(known.length,limit),updatedCandidates,unknownActivityCount:unknownIds.length,unknownActivityIds:unknownIds,failures,ranking:'Producer lifecycle timestamp descending, exact thread ID ascending on ties, among inspected candidates only. Generic backend updates are separate, preserve backend order, and are NOT execution activity.',coverage:{globalTopN:false,candidateLimit:this.limits.candidates,candidateCount:ids.length,inspectedCount:rows.length,uninspectedCount:ids.length-rows.length-failures.length,omittedDiscoveredCount:new Set(pools.flat()).size-ids.length,knownActivityCount:known.length,loadedScanned:loaded.data.length,historyScanned:stored.data.length,recordedThreads:records.length,loadedHasMore:Boolean(loaded.nextCursor),historyHasMore:Boolean(stored.nextCursor),sourceErrors,turnMethodUnavailable,scope:'Current shared daemon loaded page + indexed interactive nonarchived history across providers + bounded Connector-observed lifecycle records. No automatic attach/resume, history-file scan or message content. Latest sampled turn is not a complete execution log; unknown timestamps do not mean inactive. Queries are not an atomic snapshot; separate servers and standalone sessions are not guaranteed visible.'}};
  }
}
