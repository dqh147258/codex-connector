import { createHash, randomUUID } from 'node:crypto';
import { BackendError } from './codex.js';
import { SessionContent, SessionContentError, type ContentLimits, type VisibleMessage } from './session-content.js';
import { resultSensitive } from './slack-results.js';
import type { Backend } from './types.js';

export interface SearchQuery {
  terms: string[]; mode?: 'and'|'or'; role?: 'all'|'user'|'assistant';
  sessionLimit?: number; limit?: number; maxChars?: number; cursor?: string;
}
interface PendingSession { threadId: string; cursor?: string; cwd?: unknown; seen: string[]; pages: number }
interface Discovery {
  pages: number; scannedSessions: number; excludedSessions: number; hasMore: boolean;
  selectionComplete: boolean; error: string|null;
}
interface Continuation {
  query: string; scope: string; epoch: string; expiresAt: number;
  selectedCount: number; pending: PendingSession[]; discovery: Discovery;
  failedSessions: number; withheldMessages: number;
}
interface SearchLimits extends ContentLimits { discoveryPages: number; totalPagesPerSession: number }
const DEFAULTS: SearchLimits = { timeoutMs:30000,rpcTimeoutMs:5000,maxBytes:2*1024*1024,maxPages:3,pageSize:20,maxCalls:100,discoveryPages:3,totalPagesPerSession:100 };
const fail=(code:string):never=>{throw new SessionContentError(code);};
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
const cursorValid=(v:unknown):v is string|null=>v===null||typeof v==='string'&&v.length>0&&v.length<=512&&!/[\x00-\x1f\x7f]/.test(v);
const errorCode=(e:unknown)=>e instanceof SessionContentError?e.code:e instanceof BackendError&&['METHOD_UNSUPPORTED','BACKEND_UNAVAILABLE','RPC_REJECTED'].includes(e.code)?e.code:'HISTORY_UNAVAILABLE';
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const integer=(v:number,min:number,max:number)=>Number.isSafeInteger(v)&&v>=min&&v<=max;

/** Bounded read-only literal search. Raw tool/reasoning items are never matched,
 * exported, cached or summarized. Continuations contain only IDs/cursors/counts. */
export class SessionSearch extends SessionContent {
  private searchLimits: SearchLimits;
  private continuations=new Map<string,Continuation>();
  constructor(backend:Backend,authorize:(thread:any)=>Record<string,unknown>,limits:Partial<SearchLimits>={}) {
    // The overview/messages limits retain their original 40-call ceiling.
    const {discoveryPages: _discoveryPages,totalPagesPerSession: _totalPagesPerSession,...contentLimits}=limits;
    super(backend,authorize,{...contentLimits,maxCalls:Math.min(limits.maxCalls??40,40)});
    this.searchLimits={...DEFAULTS,...limits};
    for(const [k,v] of Object.entries(this.searchLimits))if(!integer(v,1,DEFAULTS[k as keyof SearchLimits]))fail('INVALID_SEARCH_LIMIT');
  }
  private save(state:Continuation):string {
    for(const [key,value] of this.continuations)if(value.expiresAt<=Date.now())this.continuations.delete(key);
    while(this.continuations.size>=20)this.continuations.delete(this.continuations.keys().next().value!);
    const key=randomUUID();this.continuations.set(key,structuredClone(state));return key;
  }
  async query(input:SearchQuery,scope='local') {
    const mode=input.mode??'and',role=input.role??'all',sessionLimit=input.sessionLimit??10,limit=input.limit??20,maxChars=input.maxChars??1000;
    if(!Array.isArray(input.terms)||input.terms.length<1||input.terms.length>10||input.terms.some(t=>typeof t!=='string'||!t.trim()||t.length>200||/[\x00-\x1f\x7f]/.test(t))||input.terms.reduce((n,t)=>n+t.length,0)>1000||!['and','or'].includes(mode)||!['all','user','assistant'].includes(role)||!integer(sessionLimit,1,20)||!integer(limit,1,50)||!integer(maxChars,100,2000))fail('INVALID_SEARCH_QUERY');
    const terms=input.terms.map(t=>t.trim());
    if(resultSensitive(terms))fail('SENSITIVE_CONTENT');
    const query=hash(JSON.stringify({terms,mode,role,sessionLimit,limit,maxChars}));
    const b=this.budget(this.searchLimits.maxCalls),startedAt=new Date().toISOString();
    let state:Continuation;
    if(input.cursor!==undefined){
      const saved=typeof input.cursor==='string'&&input.cursor.length<=128?this.continuations.get(input.cursor):undefined;
      if(!saved||saved.query!==query||saved.scope!==scope||saved.epoch!==b.epoch||saved.expiresAt<=Date.now())fail('INVALID_SEARCH_CURSOR');
      state=structuredClone(saved!);
    }else{
      state={query,scope,epoch:b.epoch,expiresAt:Date.now()+15*60*1000,selectedCount:0,pending:[],discovery:{pages:0,scannedSessions:0,excludedSessions:0,hasMore:false,selectionComplete:false,error:null},failedSessions:0,withheldMessages:0};
      let cursor:string|undefined;const seen=new Set<string>(),ids=new Set<string>();
      try {
        for(let n=0;n<this.searchLimits.discoveryPages;n++){
          const response=await this.rpc('thread/list',{limit:this.searchLimits.pageSize,sortKey:'updated_at',sortDirection:'desc',useStateDbOnly:true,modelProviders:[],...(cursor?{cursor}:{})},b);
          if(!response||!Array.isArray(response.data)||response.data.length>this.searchLimits.pageSize||!cursorValid(response.nextCursor)||response.data.some((t:any)=>!t||!id(t.id)))fail('INVALID_SEARCH_DISCOVERY');
          const next=response.nextCursor as string|null;
          if(next&&(next===cursor||seen.has(next)))fail('INVALID_SEARCH_DISCOVERY');
          state.discovery.pages++;state.discovery.hasMore=next!==null;
          for(let index=0;index<response.data.length;index++){
            const thread=response.data[index];state.discovery.scannedSessions++;
            if(ids.has(thread.id))continue;ids.add(thread.id);
            // Do not read message bodies for candidates outside allowed scope.
            try {const metadata=this.authorize(thread);if(resultSensitive({id:thread.id,name:thread.name,cwd:thread.cwd,model:thread.model})||resultSensitive(metadata))throw Error();}
            catch {state.discovery.excludedSessions++;continue;}
            state.pending.push({threadId:thread.id,seen:[],pages:0});
            if(state.pending.length===sessionLimit){state.discovery.hasMore=next!==null||index+1<response.data.length;break;}
          }
          if(state.pending.length===sessionLimit||next===null){state.discovery.selectionComplete=true;break;}
          seen.add(next);cursor=next;
        }
      }catch(e){state.discovery.error=errorCode(e);}
      state.selectedCount=state.pending.length;
    }
    const matches:{threadId:string;metadata:Record<string,unknown>;message:VisibleMessage&{matchedTerms:string[];excerptStart:number;excerptEnd:number;totalChars:number}}[]=[];
    const sessions:{threadId:string;metadata?:Record<string,unknown>;pages:number;scannedItems:number;withheldMessages:number;exhausted:boolean;error:string|null}[]=[];
    const nextPending:PendingSession[]=[],visited=new Map<string,{cwd:unknown;row:typeof sessions[number]}>();
    let stop='end',scannedItems=0;
    const normalized=terms.map(t=>t.toLowerCase());
    for(let index=0;index<state.pending.length;index++){
      const pending=structuredClone(state.pending[index]!);
      // Reserve one metadata recheck per visited session, plus this one's reads.
      if(matches.length>=limit||b.calls+visited.size+3>this.searchLimits.maxCalls||Date.now()>=b.deadline){
        stop=matches.length>=limit?'match-limit':'budget';nextPending.push(...state.pending.slice(index));break;
      }
      const row:typeof sessions[number]={threadId:pending.threadId,pages:0,scannedItems:0,withheldMessages:0,exhausted:false,error:null};sessions.push(row);
      try {
        const metadata=await this.metadata(pending.threadId,b);
        if(pending.cwd!==undefined&&pending.cwd!==metadata.cwd)fail('SESSION_SCOPE_CHANGED');
        pending.cwd=metadata.cwd;visited.set(pending.threadId,{cwd:metadata.cwd,row});
        for(let pageIndex=0;pageIndex<this.searchLimits.maxPages;pageIndex++){
          if(pending.pages>=this.searchLimits.totalPagesPerSession)fail('SEARCH_SESSION_PAGE_LIMIT');
          if(b.calls+visited.size+1>this.searchLimits.maxCalls||Date.now()>=b.deadline){stop='budget';break;}
          // A backend page can never contain more matches than remaining slots.
          // Thus we finish every accepted raw page; no page-tail matches are lost.
          const page=await this.page(pending.threadId,'desc',pending.cursor,Math.min(this.searchLimits.pageSize,limit-matches.length),b);
          if(page.nextCursor&&pending.seen.includes(hash(page.nextCursor)))fail('INVALID_HISTORY_PAGE');
          row.pages++;pending.pages++;row.scannedItems+=page.data.length;scannedItems+=page.data.length;
          for(const entry of page.data){
            if(!['userMessage','agentMessage'].includes(entry.item.type))continue;
            const wantedRole=entry.item.type==='userMessage'?'user':'assistant';
            if(role!=='all'&&role!==wantedRole)continue;
            // Check entire raw message BEFORE deciding whether it matches. Never
            // reveal whether a withheld message contains a requested keyword.
            const visible=this.message(entry,1);
            if(!visible||visible.textStatus==='withheld'){row.withheldMessages++;continue;}
            const text=entry.item.type==='userMessage'?entry.item.content.filter((p:any)=>p.type==='text').map((p:any)=>p.text).join('\n'):entry.item.text;
            if(!text)continue;
            // Joining individually safe parts can form a sensitive assignment.
            if(resultSensitive(text)){row.withheldMessages++;continue;}
            const lower=text.toLowerCase(),found=normalized.map(t=>lower.includes(t));
            if(!(mode==='and'?found.every(Boolean):found.some(Boolean)))continue;
            // Locate in original code points: lowercasing can expand Unicode
            // characters, so a lowercased UTF-16 index is not a safe source index.
            const chars=[...text];let normalizedOffset=0,first=0;
            const hit=Math.min(...normalized.filter((_,i)=>found[i]).map(t=>lower.indexOf(t)));
            for(;first<chars.length;first++){const width=chars[first]!.toLowerCase().length;if(normalizedOffset+width>hit)break;normalizedOffset+=width;}
            const start=Math.max(0,first-Math.floor(maxChars/4)),end=Math.min(chars.length,start+maxChars);
            matches.push({threadId:pending.threadId,metadata,message:{...visible,excerpt:chars.slice(start,end).join(''),excerptTruncated:start>0||end<chars.length,matchedTerms:terms.filter((_,i)=>found[i]),excerptStart:start,excerptEnd:end,totalChars:chars.length}});
          }
          row.exhausted=page.nextCursor===null;
          if(row.exhausted)break;
          pending.seen.push(hash(page.nextCursor!));pending.cursor=page.nextCursor!;
          if(matches.length>=limit){stop='match-limit';break;}
        }
        if(!row.exhausted)nextPending.push(pending);
      }catch(e){row.error=errorCode(e);state.failedSessions++;}
    }
    // Recheck every scanned session after the entire multi-session read, not
    // merely just after each page. Drop its data if policy/cwd changed meanwhile.
    for(const [threadId,{cwd,row}] of visited){
      try{const current=await this.metadata(threadId,b);if(current.cwd!==cwd)fail('SESSION_SCOPE_CHANGED');row.metadata=current;for(const match of matches)if(match.threadId===threadId)match.metadata=current;}
      catch(e){if(!row.error)state.failedSessions++;row.error=errorCode(e);row.metadata=undefined;for(let i=matches.length-1;i>=0;i--)if(matches[i]!.threadId===threadId)matches.splice(i,1);const at=nextPending.findIndex(p=>p.threadId===threadId);if(at>=0)nextPending.splice(at,1);}
    }
    if(!this.backend.connected||this.backend.epoch!==b.epoch)fail('CONTENT_BACKEND_CHANGED');
    const withheld=sessions.reduce((n,s)=>n+s.withheldMessages,0);state.withheldMessages+=withheld;state.pending=nextPending;
    const nextCursor=nextPending.length?this.save(state):null;
    const selectedTraversalComplete=!nextCursor&&state.failedSessions===0;
    const traversalComplete=selectedTraversalComplete&&state.discovery.selectionComplete&&!state.discovery.error;
    return{kind:'session.search',asOf:startedAt,terms,mode,role,sessionLimit,limit,maxChars,selectedSessionCount:state.selectedCount,matches,returnedCount:matches.length,sessions,nextCursor,hasMore:nextCursor!==null,
      coverage:{discovery:state.discovery,scannedItems,scannedSessions:sessions.length,pendingSessions:nextPending.length,failedSessions:state.failedSessions,withheldMessages:state.withheldMessages,selectedTraversalComplete,traversalComplete,searchableContentComplete:traversalComplete&&state.withheldMessages===0,stop:nextCursor?(stop==='end'?'page-budget':stop):state.failedSessions?'errors':state.discovery.error?'discovery-error':!state.discovery.selectionComplete?'discovery-limit':'end',limits:{...this.searchLimits},globalSearch:false},
      ordering:'Fixed bounded selection from indexed interactive nonarchived history, backend updated_at descending (NOT execution activity); item creation ordinal descending per session. Continuations visit pending sessions in selection order.',
      matching:'Case-insensitive literal substrings, AND/OR within one visible message. No regex, stemming, cross-message conjunction or semantic model summary. Excerpts center the first hit; other matched terms may be outside the excerpt.',
      consistency:'Separate live reads, not an atomic snapshot. Tool/reasoning/system/non-text content excluded; sensitive-looking messages withheld before matching. Empty partial results do not establish no matches.',
      continuation:nextCursor?{expiresAt:new Date(state.expiresAt).toISOString(),scope:'Same query, authenticated actor/channel/thread, permission policy and backend epoch; process-local, bounded cache may evict early. Use result.next.'}:null};
  }
}
