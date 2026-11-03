import { BackendError } from './codex.js';
import { resultSensitive } from './slack-results.js';
import type { Backend } from './types.js';

export class SessionContentError extends Error { constructor(readonly code:string){super(code);} }
const fail=(code:string):never=>{throw new SessionContentError(code);};
const code=(error:unknown)=>error instanceof SessionContentError?error.code:error instanceof BackendError&&['METHOD_UNSUPPORTED','BACKEND_UNAVAILABLE','RPC_REJECTED'].includes(error.code)?error.code:'HISTORY_UNAVAILABLE';
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const time=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
const nextCursor=(value:unknown):string|null=>value===null||value===undefined?null:typeof value==='string'&&value.length>0&&value.length<=512&&!/[\x00-\x1f\x7f]/.test(value)?value:fail('INVALID_HISTORY_PAGE');
export interface ContentLimits { timeoutMs:number; rpcTimeoutMs:number; maxBytes:number; maxPages:number; pageSize:number; maxCalls:number }
const LIMITS:ContentLimits={timeoutMs:30000,rpcTimeoutMs:5000,maxBytes:2*1024*1024,maxPages:3,pageSize:20,maxCalls:40};
interface Budget{deadline:number;bytes:number;calls:number;epoch:string}
export interface VisibleMessage { itemId:string|null;turnId:string|null;role:'user'|'assistant';phase:string|null;startedAtMs:number|null;completedAtMs:number|null;excerpt:string|null;excerptTruncated:boolean;textStatus:'text'|'empty-or-non-text'|'withheld';nonTextOmitted:boolean }
type Slot={status:'found'|'withheld'|'absent'|'unknown';message?:VisibleMessage};
interface Scan { slots:{user?:Slot;assistant?:Slot};pages:number;scannedItems:number;exhausted:boolean;stop:'found'|'end'|'limit'|'error';error?:string }
/** Only supported read RPCs. No resume, filesystem fallback, hidden prompt/tool
 * export, timestamp sorting, or extra model invocation. */
export class SessionContent {
  private limits:ContentLimits;
  constructor(private backend:Backend,private authorize:(thread:any)=>Record<string,unknown>,limits:Partial<ContentLimits>={}){this.limits={...LIMITS,...limits};for(const[k,v]of Object.entries(this.limits))if(!Number.isSafeInteger(v)||v<1||v>LIMITS[k as keyof ContentLimits])fail('INVALID_CONTENT_LIMIT');}
  private budget():Budget{return{deadline:Date.now()+this.limits.timeoutMs,bytes:0,calls:0,epoch:this.backend.epoch};}
  private async rpc(method:'thread/read'|'thread/items/list',params:unknown,b:Budget){
    if(!this.backend.connected||b.epoch!==this.backend.epoch)fail('CONTENT_BACKEND_CHANGED');
    const remaining=b.deadline-Date.now();if(remaining<=0||++b.calls>this.limits.maxCalls)fail('CONTENT_BUDGET_EXCEEDED');
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      const value=await Promise.race([this.backend.rpc(method,params),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new SessionContentError('CONTENT_TIMEOUT')),Math.min(remaining,this.limits.rpcTimeoutMs));})]);
      if(!this.backend.connected||b.epoch!==this.backend.epoch)fail('CONTENT_BACKEND_CHANGED');
      let size:number;try{size=Buffer.byteLength(JSON.stringify(value),'utf8');}catch{fail('INVALID_HISTORY_PAGE');}
      b.bytes+=size!;if(b.bytes>this.limits.maxBytes)fail('CONTENT_BUDGET_EXCEEDED');return value;
    }finally{if(timer)clearTimeout(timer);}
  }
  private async metadata(threadId:string,b:Budget):Promise<Record<string,unknown>>{
    if(!id(threadId))fail('INVALID_THREAD_ID');
    const response=await this.rpc('thread/read',{threadId,includeTurns:false},b),thread=response?.thread;
    if(!thread||thread.id!==threadId)fail('INVALID_THREAD_METADATA');
    let meta:Record<string,unknown>;try{meta=this.authorize(thread);}catch{fail('SESSION_SCOPE_NOT_ALLOWED');}
    if(resultSensitive({name:thread.name,cwd:thread.cwd,model:thread.model})||resultSensitive(meta!))fail('SENSITIVE_CONTENT');
    const field=(value:unknown,max:number)=>typeof value==='string'?[...value].slice(0,max).join(''):null;
    const status=meta!.status as any;
    return{id:threadId,name:field(meta!.name,200),cwd:field(meta!.cwd,1024),status:{type:field(status?.type,40)||'unknown'},model:field(meta!.model,100),source:field(meta!.source,100),manageable:typeof meta!.manageable==='boolean'?meta!.manageable:null,canAcceptDirectInput:typeof meta!.canAcceptDirectInput==='boolean'?meta!.canAcceptDirectInput:null,connectorSessionId:field(meta!.connectorSessionId,128),createdAtUnixSeconds:time(thread.createdAt),updatedAtUnixSeconds:time(thread.updatedAt)};
  }
  private message(entry:any,maxChars:number):VisibleMessage|undefined{
    const item=entry?.item;if(!item||!['userMessage','agentMessage'].includes(item.type))return;
    const user=item.type==='userMessage',parts=Array.isArray(item.content)?item.content:[],nonText=user&&parts.some((p:any)=>p?.type!=='text');
    const base={itemId:id(item.id)?item.id:null,turnId:id(entry.turnId)?entry.turnId:null,role:user?'user' as const:'assistant' as const,phase:user?null:['commentary','partial_answer','final_answer'].includes(item.phase)?item.phase:null,startedAtMs:time(entry.startedAtMs),completedAtMs:time(entry.completedAtMs)};
    // Scan full nested raw content, not a clipped or JSON-escaped representation.
    if(resultSensitive(item)||resultSensitive(base))return{...base,...(resultSensitive(base)?{itemId:null,turnId:null}:{}),excerpt:null,excerptTruncated:false,textStatus:'withheld',nonTextOmitted:nonText};
    const text=user?parts.filter((p:any)=>p?.type==='text'&&typeof p.text==='string').map((p:any)=>p.text).join('\n'):typeof item.text==='string'?item.text:'';
    const chars=[...text];return{...base,excerpt:text?chars.slice(0,maxChars).join(''):null,excerptTruncated:chars.length>maxChars,textStatus:text?'text':'empty-or-non-text',nonTextOmitted:nonText};
  }
  private async page(threadId:string,order:'asc'|'desc',cursor:string|undefined,limit:number,b:Budget){
    const page=await this.rpc('thread/items/list',{threadId,sortDirection:order,limit,...(cursor?{cursor}:{})},b);
    if(!page||!Array.isArray(page.data)||page.data.length>limit||!Object.hasOwn(page,'nextCursor')||page.nextCursor===undefined||page.data.some((e:any)=>!e||typeof e!=='object'||Array.isArray(e)||!e.item||typeof e.item!=='object'||Array.isArray(e.item)||typeof e.item.type!=='string'||!e.item.type||e.item.type==='agentMessage'&&typeof e.item.text!=='string'||e.item.type==='userMessage'&&(!Array.isArray(e.item.content)||e.item.content.some((part:any)=>!part||typeof part!=='object'||Array.isArray(part)||typeof part.type!=='string'||!part.type||part.type==='text'&&typeof part.text!=='string'))))fail('INVALID_HISTORY_PAGE');
    const next=nextCursor(page.nextCursor);if(next&&next===cursor)fail('INVALID_HISTORY_PAGE');return{data:page.data,nextCursor:next};
  }
  private async scan(threadId:string,order:'asc'|'desc',roles:('user'|'assistant')[],maxChars:number,b:Budget):Promise<Scan>{
    const out:Scan={slots:{},pages:0,scannedItems:0,exhausted:false,stop:'limit'},seen=new Set<string>();let cursor:string|undefined;
    try{for(let i=0;i<this.limits.maxPages;i++){
      const page=await this.page(threadId,order,cursor,this.limits.pageSize,b);out.pages++;out.scannedItems+=page.data.length;
      if(page.nextCursor&&seen.has(page.nextCursor))fail('INVALID_HISTORY_PAGE');
      for(const entry of page.data){const m=this.message(entry,maxChars);if(m&&roles.includes(m.role)&&!out.slots[m.role])out.slots[m.role]={status:m.textStatus==='withheld'?'withheld':'found',message:m};}
      out.exhausted=page.nextCursor===null;
      if(roles.every(role=>out.slots[role])){out.stop='found';break;}
      if(out.exhausted){out.stop='end';break;}
      seen.add(page.nextCursor!);cursor=page.nextCursor!;
    }}catch(e){out.stop='error';out.error=code(e);}
    for(const role of roles)out.slots[role]??={status:out.exhausted?'absent':'unknown'};
    return out;
  }
  async overview(threadIds:string[],maxChars=500){
    if(!Array.isArray(threadIds)||threadIds.length<1||threadIds.length>5||new Set(threadIds).size!==threadIds.length||threadIds.some(x=>!id(x))||!Number.isSafeInteger(maxChars)||maxChars<100||maxChars>1000)fail('INVALID_OVERVIEW_QUERY');
    const b=this.budget(),items:any[]=[],asOf=new Date().toISOString();
    for(const threadId of threadIds){try{
      const metadata=await this.metadata(threadId,b),first=await this.scan(threadId,'asc',['user'],maxChars,b),last=await this.scan(threadId,'desc',['user','assistant'],maxChars,b);
      // Do not publish a history captured under a now-revoked/moved scope.
      const current=await this.metadata(threadId,b);if(current.cwd!==metadata.cwd)fail('SESSION_SCOPE_CHANGED');
      const coverage=(s:Scan)=>({pages:s.pages,scannedItems:s.scannedItems,exhausted:s.exhausted,stop:s.stop,error:s.error||null});
      items.push({threadId,metadata:current,firstUser:first.slots.user,lastUser:last.slots.user,latestAssistant:last.slots.assistant,coverage:{ascending:coverage(first),descending:coverage(last)},error:null});
    }catch(e){items.push({threadId,error:code(e)});}}
    return{kind:'session.overview',asOf,summaryMode:'deterministic-excerpts; no model summary',ordering:'available persisted item creation ordinal, not timestamps or update time',consistency:'separate non-atomic reads; not proof of current task or first-ever original prompt',items,count:items.length};
  }
  async messages(p:{threadId:string;role?:'all'|'user'|'assistant';order?:'asc'|'desc';limit?:number;maxChars?:number;cursor?:string}){
    const {threadId}=p,role=p.role||'all',order=p.order||'desc',limit=p.limit??10,maxChars=p.maxChars??1000;
    if(!id(threadId)||!['all','user','assistant'].includes(role)||!['asc','desc'].includes(order)||!Number.isSafeInteger(limit)||limit<1||limit>20||!Number.isSafeInteger(maxChars)||maxChars<100||maxChars>2000)fail('INVALID_MESSAGES_QUERY');
    let cursor:string|undefined;
    if(p.cursor){try{if(p.cursor.length>2048||!/^[A-Za-z0-9_-]+$/.test(p.cursor))throw Error();const c=JSON.parse(Buffer.from(p.cursor,'base64url').toString());if(!c||c.v!==1||c.threadId!==threadId||c.role!==role||c.order!==order||Object.keys(c).sort().join(',')!=='cursor,order,role,threadId,v'||!nextCursor(c.cursor))throw Error();cursor=c.cursor;}catch{fail('INVALID_CURSOR');}}
    const b=this.budget(),metadata=await this.metadata(threadId,b),page=await this.page(threadId,order,cursor,limit,b),items=page.data.map((e:any)=>this.message(e,maxChars)).filter((m:VisibleMessage|undefined)=>m&&(role==='all'||m.role===role));
    const current=await this.metadata(threadId,b);if(current.cwd!==metadata.cwd)fail('SESSION_SCOPE_CHANGED');
    const next=page.nextCursor?Buffer.from(JSON.stringify({v:1,threadId,role,order,cursor:page.nextCursor})).toString('base64url'):null;
    return{kind:'session.messages',threadId,role,order,limit,maxChars,nextCursor:next,hasMore:next!==null,asOf:new Date().toISOString(),metadata:current,items,returnedCount:items.length,scannedItems:page.data.length,coverage:'one server page, filtered after reading; empty visible page may have continuation; live data is not a snapshot',summaryMode:'deterministic-excerpts; no tool/reasoning/system content'};
  }
}
