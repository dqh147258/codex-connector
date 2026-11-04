import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionSearch, type SearchQuery } from '../src/session-search.js';
import { BackendError } from '../src/codex.js';
import { FakeBackend } from './helpers.js';

const entry=(n:number,type:string,text='needle',extra:any={})=>({
  turnId:`turn-${n}`,item:{id:`item-${n}`,type,...(type==='userMessage'?{content:[{type:'text',text}]}:{text}),...extra},
  startedAtMs:1000+n,completedAtMs:null,
});
function setup(histories:Record<string,any[]>={chosen:[]},limits:any={}) {
  const backend=new FakeBackend();backend.connected=true;
  for(const [index,threadId] of Object.keys(histories).entries())backend.threads.set(threadId,{id:threadId,cwd:'/allowed',name:`Task ${threadId}`,status:{type:'idle'},createdAt:10,updatedAt:100-index});
  backend.rpc=async(method,p)=>{
    backend.calls.push({method,params:p});
    if(method==='thread/list'){
      const rows=[...backend.threads.values()].sort((a,b)=>b.updatedAt-a.updatedAt),start=p.cursor?Number(p.cursor):0,data=rows.slice(start,start+p.limit);
      return{data,nextCursor:start+data.length<rows.length?String(start+data.length):null};
    }
    if(method==='thread/read'){const thread=backend.threads.get(p.threadId);if(!thread)throw Error('unavailable');return{thread};}
    if(method==='thread/items/list'){
      const rows=[...(histories[p.threadId]||[])].reverse(),start=p.cursor?Number(p.cursor):0,data=rows.slice(start,start+p.limit);
      return{data,nextCursor:start+data.length<rows.length?String(start+data.length):null};
    }
    throw Error(`Forbidden RPC: ${method}`);
  };
  const search=new SessionSearch(backend,t=>{if(t.cwd!=='/allowed')throw Error('denied');return{id:t.id,cwd:t.cwd,name:t.name,status:t.status,model:t.model};},limits);
  return{backend,search,histories};
}
const excerpts=(result:Awaited<ReturnType<SessionSearch['query']>>)=>result.matches.map(m=>m.message.excerpt);

test('search AND is literal, case insensitive and confined to a single visible message',async()=>{
  const {search}=setup({chosen:[entry(1,'userMessage','alpha'),entry(2,'agentMessage','beta'),entry(3,'agentMessage','ALPHA and BeTa'),entry(4,'userMessage','a.b [tag]')]});
  const and=await search.query({terms:['alpha','beta']});assert.deepEqual(excerpts(and),['ALPHA and BeTa']);
  assert.deepEqual(and.matches[0]!.message.matchedTerms,['alpha','beta']);
  assert.deepEqual(excerpts(await search.query({terms:['a.b','[tag]']})),['a.b [tag]']);
  assert.equal((await search.query({terms:['a.*b']})).returnedCount,0);
  const separate=setup({chosen:[entry(1,'userMessage','alpha'),entry(2,'agentMessage','beta')]});
  assert.equal((await separate.search.query({terms:['alpha','beta']})).returnedCount,0);
});

test('OR search preserves matched terms, role filters and message/session identity',async()=>{
  const {search}=setup({chosen:[entry(1,'userMessage','alpha'),entry(2,'agentMessage','beta',{phase:'final_answer'})]});
  const all=await search.query({terms:['alpha','beta'],mode:'or'});
  assert.deepEqual(excerpts(all),['beta','alpha']);assert.deepEqual(all.matches.map(m=>m.message.matchedTerms),[['beta'],['alpha']]);
  const user=await search.query({terms:['alpha','beta'],mode:'or',role:'user'});assert.deepEqual(excerpts(user),['alpha']);
  const assistant=await search.query({terms:['alpha','beta'],mode:'or',role:'assistant'});const m=assistant.matches[0]!;
  assert.equal(m.threadId,'chosen');assert.equal(m.metadata.name,'Task chosen');assert.equal(m.metadata.updatedAtUnixSeconds,100);
  assert.equal(m.message.role,'assistant');assert.equal(m.message.itemId,'item-2');assert.equal(m.message.turnId,'turn-2');assert.equal(m.message.phase,'final_answer');assert.equal(m.message.startedAtMs,1002);
});

test('tool, reasoning, system, unknown and non-text payloads are never searched or returned',async()=>{
  const rows=['tool','commandExecution','mcpToolCall','reasoning','systemMessage','developerMessage','unknown'].map((type,i)=>entry(i,type,'HIDDEN_NEEDLE'));
  rows.push(entry(10,'userMessage','',{content:[{type:'image',url:'HIDDEN_NEEDLE'},{type:'audio',text:'HIDDEN_NEEDLE'},{type:'file',path:'HIDDEN_NEEDLE'}]}));
  rows.push(entry(11,'userMessage','',{content:[{type:'text',text:'visible needle'},{type:'image',url:'HIDDEN_NEEDLE'}]}));
  rows.push(entry(12,'agentMessage','visible conclusion',{reasoning:'HIDDEN_NEEDLE',toolOutput:'HIDDEN_NEEDLE'}));
  const {search,backend}=setup({chosen:rows});const hidden=await search.query({terms:['HIDDEN_NEEDLE']});assert.equal(hidden.returnedCount,0);assert.ok(!JSON.stringify(hidden).includes('"excerpt":"HIDDEN'));
  const visible=await search.query({terms:['visible']});assert.equal(visible.returnedCount,2);assert.ok(!JSON.stringify(visible.matches).includes('HIDDEN_NEEDLE'));assert.equal(visible.matches[1]!.message.nonTextOmitted,true);
  assert.ok(backend.calls.every(c=>['thread/list','thread/read','thread/items/list'].includes(c.method)));
  assert.ok(backend.calls.filter(c=>c.method==='thread/read').every(c=>c.params.includeTurns===false));assert.equal(backend.responses.length,0);
});

test('sensitive content is withheld before matching, including nested and beyond-excerpt secrets',async()=>{
  const secret='password = "not-a-real-secret-value"';
  const {search}=setup({chosen:[entry(1,'userMessage','needle '+'.'.repeat(2200)+secret),entry(2,'agentMessage','needle',{extra:{quoted:secret}}),entry(3,'agentMessage','safe needle')]});
  for(const terms of [['needle'],['unmatched']]){
    const r=await search.query({terms,maxChars:100});assert.equal(r.coverage.withheldMessages,2);assert.equal(r.coverage.searchableContentComplete,false);assert.ok(!JSON.stringify(r).includes('not-a-real-secret'));
  }
  assert.deepEqual(excerpts(await search.query({terms:['needle']})),['safe needle']);
  await assert.rejects(search.query({terms:[secret]}),/SENSITIVE_CONTENT/);
});

test('long text search scans past prefix and returns code-point bounded excerpts around hit',async()=>{
  const text='İ'.repeat(150)+'🙂'.repeat(300)+'NEEDLE'+'尾'.repeat(200);
  const {search}=setup({chosen:[entry(1,'agentMessage',text)]});const r=await search.query({terms:['needle'],maxChars:100});const m=r.matches[0]!.message;
  assert.equal(m.totalChars,[...text].length);assert.equal([...m.excerpt!].length,100);assert.equal(m.excerpt,[...text].slice(m.excerptStart,m.excerptEnd).join(''));assert.ok(m.excerpt!.includes('NEEDLE'));assert.equal(m.excerptStart,425);assert.equal(m.excerptTruncated,true);assert.ok(!/[\uD800-\uDBFF]$/.test(m.excerpt!));
});

test('default recent selection fixes ten indexed sessions in backend updated_at order',async()=>{
  const histories=Object.fromEntries(Array.from({length:12},(_,i)=>[`s${i}`,[entry(i,'userMessage',`needle ${i}`)]]));
  const {search,backend}=setup(histories);const r=await search.query({terms:['needle']});assert.equal(r.sessionLimit,10);assert.equal(r.limit,20);assert.equal(r.maxChars,1000);assert.equal(r.selectedSessionCount,10);assert.deepEqual(r.matches.map(m=>m.threadId),Array.from({length:10},(_,i)=>`s${i}`));
  assert.deepEqual(backend.calls[0],{method:'thread/list',params:{limit:20,sortKey:'updated_at',sortDirection:'desc',useStateDbOnly:true,modelProviders:[]}});
  assert.equal(r.coverage.discovery.hasMore,true);assert.equal(r.coverage.discovery.selectionComplete,true);assert.equal(r.coverage.globalSearch,false);
});

test('selection paginates past denied scopes and never reads excluded session bodies',async()=>{
  const {search,backend}=setup({outside:[],chosen:[entry(1,'userMessage')],last:[entry(2,'agentMessage')]},{pageSize:1});backend.threads.get('outside')!.cwd='/outside';
  const r=await search.query({terms:['needle'],sessionLimit:2});assert.equal(r.selectedSessionCount,2);assert.equal(r.coverage.discovery.pages,3);assert.equal(r.coverage.discovery.excludedSessions,1);assert.deepEqual(r.matches.map(m=>m.threadId),['chosen','last']);
  assert.ok(!backend.calls.some(c=>c.method!=='thread/list'&&c.params.threadId==='outside'));
});

test('tool-only bounded pages return empty result with continuation and eventually visible match',async()=>{
  const rows=[entry(1,'userMessage','needle'),...Array.from({length:6},(_,i)=>entry(i+2,'commandExecution','PRIVATE'))];
  const {search,backend}=setup({chosen:rows},{pageSize:2,maxPages:3});const one=await search.query({terms:['needle']});assert.equal(one.returnedCount,0);assert.equal(one.sessions[0]!.pages,3);assert.equal(one.coverage.stop,'page-budget');assert.ok(one.nextCursor);assert.equal(one.coverage.traversalComplete,false);
  const two=await search.query({terms:['needle'],cursor:one.nextCursor!});assert.deepEqual(excerpts(two),['needle']);assert.equal(two.nextCursor,null);assert.equal(two.coverage.traversalComplete,true);assert.equal(backend.calls.filter(c=>c.method==='thread/list').length,1);
});

test('matching-message limits drain raw page tails without missing or duplicating matches',async()=>{
  const rows=Array.from({length:11},(_,i)=>entry(i+1,i%3===0?'commandExecution':'userMessage',`needle ${i+1}`));
  const {search,backend}=setup({chosen:rows});const seen:string[]=[];let cursor:string|undefined;
  do{const r=await search.query({terms:['needle'],limit:2,...(cursor?{cursor}:{})});assert.ok(r.returnedCount<=2);seen.push(...r.matches.map(m=>m.message.itemId!));cursor=r.nextCursor??undefined;}while(cursor);
  assert.deepEqual(seen,rows.filter(r=>r.item.type==='userMessage').reverse().map(r=>r.item.id));assert.equal(new Set(seen).size,seen.length);
  assert.ok(backend.calls.filter(c=>c.method==='thread/items/list').every(c=>c.params.limit<=2));
});

test('continuations retain original selection even if newly updated sessions appear',async()=>{
  const {search,backend,histories}=setup({chosen:[entry(1,'userMessage','older needle'),entry(2,'userMessage','newer needle')]});
  const one=await search.query({terms:['needle'],limit:1});backend.threads.set('new',{id:'new',cwd:'/allowed',updatedAt:1000});histories.new=[entry(3,'userMessage','new session needle')];
  const two=await search.query({terms:['needle'],limit:1,cursor:one.nextCursor!});assert.deepEqual(excerpts(two),['older needle']);assert.equal(two.selectedSessionCount,1);assert.ok(!backend.calls.some(c=>c.params.threadId==='new'));
});

test('continuation rejects altered query, role, limits, scope and backend epoch before RPC',async()=>{
  const {search,backend}=setup({chosen:[entry(1,'userMessage'),entry(2,'userMessage')]});const query={terms:['needle'],limit:1};const first=await search.query(query,'actor/channel/thread/policy');assert.match(first.nextCursor!,/^[a-f0-9-]{36}$/);
  for(const patch of [{terms:['other']},{mode:'or'},{role:'user'},{limit:2},{sessionLimit:2},{maxChars:100}]){const before=backend.calls.length;await assert.rejects(search.query({...query,...patch,cursor:first.nextCursor!} as SearchQuery,'actor/channel/thread/policy'),/INVALID_SEARCH_CURSOR/);assert.equal(backend.calls.length,before);}
  await assert.rejects(search.query({...query,cursor:first.nextCursor!},'another-scope'),/INVALID_SEARCH_CURSOR/);
  backend.epoch='reconnected';const before=backend.calls.length;await assert.rejects(search.query({...query,cursor:first.nextCursor!},'actor/channel/thread/policy'),/INVALID_SEARCH_CURSOR/);assert.equal(backend.calls.length,before);
});

test('continuations are process-local, expire after fifteen minutes and evict past twenty entries',async()=>{
  const f=setup({chosen:[entry(1,'userMessage'),entry(2,'userMessage')]});const q={terms:['needle'],limit:1};const first=await f.search.query(q);
  await assert.rejects(setup({chosen:[]}).search.query({...q,cursor:first.nextCursor!}),/INVALID_SEARCH_CURSOR/);
  const realNow=Date.now;try{Date.now=()=>realNow()+15*60*1000+1;await assert.rejects(f.search.query({...q,cursor:first.nextCursor!}),/INVALID_SEARCH_CURSOR/);}finally{Date.now=realNow;}
  for(let i=0;i<20;i++)await f.search.query(q);await assert.rejects(f.search.query({...q,cursor:first.nextCursor!}),/INVALID_SEARCH_CURSOR/);
});

test('invalid query boundaries and cursor inputs fail before any backend RPC',async()=>{
  const {search,backend}=setup();const bad:any[]=[{terms:[]},{terms:Array(11).fill('a')},{terms:['a'.repeat(201)]},{terms:Array(6).fill('a'.repeat(200))},{terms:['']},{terms:['  ']},{terms:['a\nb']},{terms:[3]},{terms:'needle'},{mode:'xor'},{role:'tool'},{sessionLimit:0},{sessionLimit:21},{sessionLimit:1.2},{limit:0},{limit:51},{maxChars:99},{maxChars:2001}];
  for(const patch of bad)await assert.rejects(search.query({terms:['needle'],...patch}),/INVALID_SEARCH_QUERY/);
  for(const cursor of ['', 'bogus','x'.repeat(129),null,1])await assert.rejects(search.query({terms:['needle'],cursor} as any),/INVALID_SEARCH_CURSOR/);
  assert.equal(backend.calls.length,0);
  await search.query({terms:Array(5).fill('a'.repeat(200)),sessionLimit:20,limit:50,maxChars:2000});
});

test('malformed history pages and repeated cursors never claim complete coverage',async()=>{
  const badPages=[{data:[{item:{type:'agentMessage'}}],nextCursor:null},{data:[{item:{type:'userMessage',content:[{type:'text',text:42}]}}],nextCursor:null},{data:[],nextCursor:undefined},{data:[],nextCursor:'bad\ncursor'},{data:[]},{data:'bad',nextCursor:null}];
  for(const page of badPages){const {search,backend}=setup(),original=backend.rpc.bind(backend);backend.rpc=async(m,p)=>m==='thread/items/list'?page:original(m,p);const r=await search.query({terms:['needle']});assert.equal(r.sessions[0]!.error,'INVALID_HISTORY_PAGE');assert.equal(r.coverage.traversalComplete,false);}
  const {search,backend}=setup(),original=backend.rpc.bind(backend);backend.rpc=async(m,p)=>m==='thread/items/list'?{data:[],nextCursor:'same'}:original(m,p);const r=await search.query({terms:['needle']});assert.equal(r.sessions[0]!.error,'INVALID_HISTORY_PAGE');assert.equal(r.nextCursor,null);
});

test('all scanned sessions are reauthorized after later sessions and revoked excerpts are dropped',async()=>{
  const {search,backend}=setup({first:[entry(1,'userMessage','needle PRIVATE_FIRST')],second:[entry(2,'agentMessage','needle safe')]});const original=backend.rpc.bind(backend);
  backend.rpc=async(m,p)=>{const r=await original(m,p);if(m==='thread/items/list'&&p.threadId==='second')backend.threads.get('first')!.cwd='/revoked';return r;};
  const r=await search.query({terms:['needle']});assert.deepEqual(excerpts(r),['needle safe']);assert.equal(r.sessions[0]!.error,'SESSION_SCOPE_NOT_ALLOWED');assert.equal(r.sessions[0]!.metadata,undefined);assert.ok(!JSON.stringify(r).includes('PRIVATE_FIRST'));assert.equal(r.coverage.failedSessions,1);assert.equal(r.coverage.traversalComplete,false);
});

test('continuation checks cwd again before history and reconnect invalidates a live search',async()=>{
  const f=setup({chosen:[entry(1,'userMessage'),entry(2,'userMessage')]});const one=await f.search.query({terms:['needle'],limit:1});f.backend.threads.get('chosen')!.cwd='/revoked';const count=f.backend.calls.filter(c=>c.method==='thread/items/list').length;
  const two=await f.search.query({terms:['needle'],limit:1,cursor:one.nextCursor!});assert.equal(two.returnedCount,0);assert.equal(two.sessions[0]!.error,'SESSION_SCOPE_NOT_ALLOWED');assert.equal(f.backend.calls.filter(c=>c.method==='thread/items/list').length,count);
  for(const disconnect of [false,true]){const {search,backend}=setup({chosen:[entry(1,'userMessage','needle private')]}),original=backend.rpc.bind(backend);backend.rpc=async(m,p)=>{const r=await original(m,p);if(m==='thread/items/list'){if(disconnect)backend.connected=false;else backend.epoch='next-epoch';}return r;};await assert.rejects(search.query({terms:['needle']}),/CONTENT_BACKEND_CHANGED/);}
});

test('discovery failures are explicit and do not falsely report complete search',async()=>{
  for(const response of [null,{data:[],nextCursor:undefined},{data:[{id:'../bad'}],nextCursor:null},{data:[],nextCursor:'bad\ncursor'}]){
    const {search,backend}=setup();backend.rpc=async()=>response;const r=await search.query({terms:['needle']});assert.equal(r.coverage.discovery.error,'INVALID_SEARCH_DISCOVERY');assert.equal(r.coverage.discovery.selectionComplete,false);assert.equal(r.coverage.traversalComplete,false);assert.equal(r.coverage.searchableContentComplete,false);
  }
  const {search,backend}=setup();backend.rpc=async()=>{throw new BackendError('METHOD_UNSUPPORTED');};const r=await search.query({terms:['needle']});assert.equal(r.coverage.discovery.error,'METHOD_UNSUPPORTED');assert.equal(r.coverage.traversalComplete,false);
});

test('bounded incomplete discovery reports partial coverage even when selected histories end',async()=>{
  const {search,backend}=setup({outside:[],chosen:[entry(1,'userMessage')],later:[entry(2,'userMessage')]},{pageSize:1,discoveryPages:2});backend.threads.get('outside')!.cwd='/outside';
  const r=await search.query({terms:['needle'],sessionLimit:2});assert.equal(r.selectedSessionCount,1);assert.equal(r.coverage.discovery.pages,2);assert.equal(r.coverage.discovery.selectionComplete,false);assert.equal(r.coverage.discovery.hasMore,true);assert.equal(r.nextCursor,null);assert.equal(r.coverage.traversalComplete,false);assert.equal(r.coverage.searchableContentComplete,false);
});

test('byte, timeout, per-invocation call and total-page budgets remain bounded',async()=>{
  const big=setup({chosen:[entry(1,'userMessage','needle '+'.'.repeat(5000))]},{maxBytes:1500});const oversized=await big.search.query({terms:['needle']});assert.equal(oversized.sessions[0]!.error,'CONTENT_BUDGET_EXCEEDED');assert.equal(oversized.returnedCount,0);
  const slow=setup({}, {rpcTimeoutMs:10});slow.backend.rpc=async()=>new Promise(()=>{});const start=Date.now();const timed=await slow.search.query({terms:['needle']});assert.equal(timed.coverage.discovery.error,'CONTENT_TIMEOUT');assert.ok(Date.now()-start<1000);
  const bounded=setup({chosen:[entry(1,'userMessage'),entry(2,'userMessage')]},{maxCalls:4});await bounded.search.query({terms:['needle']});assert.ok(bounded.backend.calls.length<=4);
  const pages=setup({chosen:[entry(1,'userMessage'),entry(2,'userMessage'),entry(3,'userMessage')]},{pageSize:1,maxPages:1,totalPagesPerSession:2});const one=await pages.search.query({terms:['needle']});const two=await pages.search.query({terms:['needle'],cursor:one.nextCursor!});const three=await pages.search.query({terms:['needle'],cursor:two.nextCursor!});assert.equal(three.sessions[0]!.error,'SEARCH_SESSION_PAGE_LIMIT');assert.equal(three.nextCursor,null);assert.equal(three.coverage.traversalComplete,false);
});

test('sensitive session metadata is excluded before history and metadata changes cannot leak excerpts',async()=>{
  const {search,backend}=setup({unsafe:[entry(1,'userMessage')],chosen:[entry(2,'userMessage','needle private')]});backend.threads.get('unsafe')!.name='password = "not-a-real-secret-value"';
  const original=backend.rpc.bind(backend);backend.rpc=async(m,p)=>{const r=await original(m,p);if(m==='thread/items/list'&&p.threadId==='chosen')backend.threads.get('chosen')!.name='password = "not-a-real-secret-value"';return r;};
  const r=await search.query({terms:['needle']});assert.equal(r.coverage.discovery.excludedSessions,1);assert.equal(r.returnedCount,0);assert.equal(r.sessions[0]!.error,'SENSITIVE_CONTENT');assert.ok(!backend.calls.some(c=>c.method==='thread/items/list'&&c.params.threadId==='unsafe'));assert.ok(!JSON.stringify(r).includes('not-a-real-secret'));
});

test('cwd changes to another authorized scope still invalidate original session data',async()=>{
  const f=setup({first:[entry(1,'userMessage','needle PRIVATE_FIRST')],second:[entry(2,'userMessage','needle safe')]});
  const search=new SessionSearch(f.backend,t=>({id:t.id,cwd:t.cwd,name:t.name}));const original=f.backend.rpc.bind(f.backend);
  f.backend.rpc=async(m,p)=>{const r=await original(m,p);if(m==='thread/items/list'&&p.threadId==='second')f.backend.threads.get('first')!.cwd='/also-allowed';return r;};
  const result=await search.query({terms:['needle']});assert.equal(result.sessions[0]!.error,'SESSION_SCOPE_CHANGED');assert.deepEqual(excerpts(result),['needle safe']);assert.ok(!JSON.stringify(result).includes('PRIVATE_FIRST'));
});

test('repeated discovery cursor and unsupported history remain explicit partial results',async()=>{
  const f=setup();f.backend.rpc=async()=>({data:[],nextCursor:'repeat'});const r=await f.search.query({terms:['needle']});assert.equal(r.coverage.discovery.error,'INVALID_SEARCH_DISCOVERY');assert.equal(r.coverage.traversalComplete,false);
  const h=setup(),original=h.backend.rpc.bind(h.backend);h.backend.rpc=async(m,p)=>{if(m==='thread/items/list')throw new BackendError('METHOD_UNSUPPORTED');return original(m,p);};const result=await h.search.query({terms:['needle']});assert.equal(result.sessions[0]!.error,'METHOD_UNSUPPORTED');assert.equal(result.coverage.traversalComplete,false);assert.equal(result.sessions[0]!.metadata!.id,'chosen');assert.ok(h.backend.calls.every(c=>['thread/list','thread/read','thread/items/list'].includes(c.method)));
});

test('malicious history returning more than requested cannot overrun matching-message limit',async()=>{
  const {search,backend}=setup(),original=backend.rpc.bind(backend);backend.rpc=async(m,p)=>m==='thread/items/list'?{data:[entry(1,'userMessage'),entry(2,'userMessage')],nextCursor:null}:original(m,p);
  const r=await search.query({terms:['needle'],limit:1});assert.equal(r.returnedCount,0);assert.equal(r.sessions[0]!.error,'INVALID_HISTORY_PAGE');assert.equal(r.coverage.traversalComplete,false);
});


test('sensitive assignments formed by joined text parts are withheld before matching or clipping',async()=>{
  const rows=[entry(1,'userMessage','',{content:[{type:'text',text:'password'},{type:'text',text:'= "split-sensitive-value" '+'.'.repeat(300)+'needle'}]})];
  const {search}=setup({chosen:rows});
  for(const terms of [['needle'],['unmatched']]){
    const result=await search.query({terms,maxChars:100});
    assert.equal(result.returnedCount,0);assert.equal(result.coverage.withheldMessages,1);
    assert.equal(result.coverage.searchableContentComplete,false);
    assert.ok(!JSON.stringify(result).includes('split-sensitive-value'));
  }
});
