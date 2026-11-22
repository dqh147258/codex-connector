import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,rootThread,run} from './helpers.js';

test('ordinary discovery excludes children and unavailable loaded IDs without creating or reading turns',async()=>{
  const f=fixture();try{
    await f.connector.initialize();
    f.backend.rpc=async(method,params)=>{
      f.backend.calls.push({method,params});
      if(method==='thread/list')return{data:[rootThread('history',f.dir,{status:{type:'active'}})],nextCursor:null};
      if(method==='thread/loaded/list')return{data:['agent','missing'],nextCursor:null};
      if(method==='thread/read'&&params.threadId==='agent')return{thread:rootThread('agent',f.dir,{
        source:{subAgent:'review'},canAcceptDirectInput:true,status:{type:'active'}})};
      throw Error('metadata unavailable');
    };
    const page=await f.connector.sessionPage({limit:3});
    assert.deepEqual(page.sessions.map(x=>x.id),['history']);
    assert.equal(page.returnedCount,1);assert.equal(page.sessions[0]!.loaded,null);
    assert.deepEqual(page.unresolvedLoadedIds,['missing']);
    assert.ok(f.backend.calls.every(c=>['thread/list','thread/loaded/list','thread/read'].includes(c.method)));
    assert.equal(f.posts.length,0);assert.equal(f.store.state.sessions.length,0);assert.equal(f.store.state.work.length,0);
  }finally{await f.cleanup();}
});

test('discovery uses paired bounded cursors and never labels stored-only observations unloaded',async()=>{const f=fixture();try{await f.connector.initialize();f.backend.rpc=async(method,params)=>{f.backend.calls.push({method,params});if(method==='thread/list')return{data:[rootThread('history',f.dir)],nextCursor:null};if(method==='thread/loaded/list')return params.cursor?{data:['history'],nextCursor:null}:{data:['first'],nextCursor:'loaded-next'};return{thread:rootThread(params.threadId,f.dir,{status:{type:'idle'},canAcceptDirectInput:true})};};const one=await f.connector.sessionPage({limit:1});assert.equal(one.sessions.length,2);assert.equal(one.pageLimitPerSource,1);assert.ok(one.nextCursor);const two=await f.connector.sessionPage({limit:1,cursor:one.nextCursor});assert.equal(two.nextCursor,null);assert.equal(two.sessions[0]!.id,'history');assert.equal(two.sessions[0]!.loaded,true);assert.equal(f.backend.calls.filter(x=>x.method==='thread/list').length,1);assert.equal(f.backend.calls.filter(x=>x.method==='thread/loaded/list').at(-1)!.params.cursor,'loaded-next');}finally{await f.cleanup();}});

test('desktop query rejects command/project/unknown fields and malformed bounds without RPC or mutations',async()=>{const f=fixture();try{for(const value of [{command:'session.create'},{project:'repo'},{limit:0},{limit:101},{cursor:4},{cursor:'bad-cursor'},[],null])await assert.rejects(f.connector.sessionPage(value));assert.equal(f.backend.calls.length,0);assert.equal(f.store.state.work.length,0);}finally{await f.cleanup();}});

test('discovery includes only authorized binding destinations and absolute file policy does not grant control',async()=>{const f=fixture();try{f.config.projects={};f.config.filePolicy={allowAbsolutePaths:true};await f.connector.initialize();f.backend.threads.set('external',{id:'external',cwd:'/external',canAcceptDirectInput:true,status:{type:'idle'}});f.store.transaction(s=>s.sessions.push({id:'old',threadId:'external',cwd:'/external',project:'@shared',channel:'CREVOKED',threadTs:'100.1',createdAt:''}));const page=await f.connector.sessionPage();assert.equal(page.sessions[0]!.manageable,false);assert.equal(page.sessions[0]!.reason,'SESSION_SCOPE_NOT_ALLOWED');assert.equal(page.sessions[0]!.binding,null);assert.equal(f.backend.calls.some(c=>c.method==='thread/resume'),false);}finally{await f.cleanup();}});

test('mismatched read metadata never replaces a requested loaded ID',async()=>{const f=fixture();try{await f.connector.initialize();f.backend.rpc=async(method)=>method==='thread/list'?{data:[],nextCursor:null}:method==='thread/loaded/list'?{data:['wanted'],nextCursor:null}:{thread:rootThread('wrong',f.dir,{canAcceptDirectInput:true})};const page=await f.connector.sessionPage();assert.deepEqual(page.sessions,[]);assert.deepEqual(page.unresolvedLoadedIds,['wanted']);}finally{await f.cleanup();}});

// v0.171 app-server represents review/compact/consolidation/other without a
// spawn parent, and thread_spawn uses nested snake-case fields.
const childSourceCases=[
  ['review',{source:{subAgent:'review'}}],['compact',{source:{subAgent:'compact'}}],
  ['consolidator',{source:{subAgent:'memory_consolidation'}}],
  ['other-agent',{source:{subAgent:{other:'background-helper'}}}],
  ['spawn',{source:{subAgent:{thread_spawn:{parent_thread_id:'existing-root',depth:1,
    agent_path:null,agent_nickname:null,agent_role:null}}}}],
  ['parent-only',{parentThreadId:'existing-root'}],['source-only',{threadSource:'subagent'}],
] as const;

test('mixed loaded/indexed discovery counts only interactive roots, not same-project child variants, unknown source or fabricated rows',async()=>{
  const f=fixture();try{
    await f.connector.initialize();
    const cases=new Map<string,any>(childSourceCases.map(([id,patch])=>[id,rootThread(id,f.dir,
      {...patch,name:'Ordinary User Title',status:{type:'active'},canAcceptDirectInput:true})]));
    cases.set('mystery',rootThread('mystery',f.dir,{source:'unknown',status:{type:'active'}}));
    cases.set('private-custom',rootThread('private-custom',f.dir,{source:{custom:'private-automation'},status:{type:'active'}}));
    cases.set('malformed',rootThread('malformed',f.dir,{parentThreadId:42,status:{type:'active'}}));
    cases.set('older-root',rootThread('older-root',f.dir,{source:'vscode',status:{type:'active'},canAcceptDirectInput:false}));
    cases.set('manual-fork',rootThread('manual-fork',f.dir,{source:'cli',forkedFromId:'existing-root',status:{type:'active'}}));
    cases.set('atlas-root',rootThread('atlas-root',f.dir,{source:{custom:'atlas'},status:{type:'active'}}));
    cases.set('chatgpt-root',rootThread('chatgpt-root',f.dir,{source:{custom:'chatgpt'},status:{type:'active'}}));
    cases.set('app-root',rootThread('app-root',f.dir,{source:'appServer',status:{type:'active'}}));
    f.backend.rpc=async(method,p)=>{
      f.backend.calls.push({method,params:p});
      if(method==='thread/list') {
        assert.equal(Object.hasOwn(p,'sourceKinds'),false);
        return {data:[...cases.values(),rootThread('stale',f.dir),rootThread('stale-mixed',f.dir)],nextCursor:null};
      }
      if(method==='thread/loaded/list')return {data:[...cases.keys(),'stale','stale-mixed'],nextCursor:null};
      if(method==='thread/read'&&p.threadId==='stale-mixed')return{thread:rootThread('stale-mixed',f.dir,{parentThreadId:'older-root'})};
      if(method==='thread/read'&&cases.has(p.threadId))return {thread:cases.get(p.threadId)};
      throw Error('unavailable');
    };
    const expected=['app-root','atlas-root','chatgpt-root','manual-fork','older-root'];
    for(const view of ['all','active','loaded']){
      const page=await f.connector.sessionPage({view,limit:30});
      const expectedIds=view==='all'?[...expected,'stale'].sort():expected;
      assert.deepEqual(page.sessions.map(x=>x.id).sort(),expectedIds);
      assert.equal(page.returnedCount,expectedIds.length);
      assert.equal(page.lineageDiagnostics.childThreads,childSourceCases.length+1);
      assert.equal(page.lineageDiagnostics.unverifiedThreads,3);
      if(view==='all')assert.equal(page.sessions.find(x=>x.id==='stale')!.loaded,null);
      assert.ok(!page.unresolvedLoadedIds.some((id:string)=>childSourceCases.some(([child])=>id===child)));
    }
    const history=await f.connector.sessionPage({view:'history',limit:30});
    assert.deepEqual(history.sessions.map(x=>x.id).sort(),[...expected,'stale','stale-mixed'].sort());
    assert.ok(f.backend.calls.every(c=>['thread/list','thread/loaded/list','thread/read'].includes(c.method)));
  }finally{await f.cleanup();}
});

test('child-only upstream loaded pages cannot fill the visible list or consume the continuation',async()=>{
  const f=fixture();try{
    await f.connector.initialize();
    f.backend.rpc=async(method,p)=>{
      f.backend.calls.push({method,params:p});
      if(method==='thread/loaded/list'){
        const n=Number(p.cursor??0);
        return n<12?{data:['child-'+n],nextCursor:String(n+1)}:{data:['visible-after-children'],nextCursor:null};
      }
      assert.equal(method,'thread/read');
      return {thread:rootThread(p.threadId,f.dir,{status:{type:'active'},
        ...(p.threadId.startsWith('child-')?{parentThreadId:'existing-root'}:{})})};
    };
    let cursor:string|undefined,found=false;
    for(let i=0;i<13;i++){
      const page=await f.connector.sessionPage({view:'loaded',limit:1,...(cursor?{cursor}:{})});
      assert.ok(page.sessions.every(x=>x.id==='visible-after-children'));
      if(page.sessions.length){found=true;assert.equal(page.returnedCount,1);break;}
      assert.equal(page.returnedCount,0);assert.equal(page.hasMore,true);assert.ok(page.nextCursor);
      cursor=page.nextCursor!;
    }
    assert.ok(found);
    assert.deepEqual(f.backend.calls.filter(c=>c.method==='thread/loaded/list').map(c=>c.params.cursor??'0'),
      Array.from({length:13},(_,n)=>String(n)));
  }finally{await f.cleanup();}
});

test('local attach checks lineage before resume; positive Desktop fork remains attachable and normal creation remains visible',async()=>{
  const f=fixture();try{
    await f.connector.initialize();
    f.backend.threads.set('child',rootThread('child',f.dir,{parentThreadId:'parent-root',canAcceptDirectInput:true}));
    f.backend.threads.raw('absent',{id:'absent',cwd:f.dir,canAcceptDirectInput:true});
    f.backend.threads.set('fork',rootThread('fork',f.dir,{source:{custom:'atlas'},forkedFromId:'prior-human-thread',canAcceptDirectInput:true}));
    for(const [id,code] of [['child','SUBAGENT_THREAD_NOT_SUPPORTED'],['absent','NATIVE_THREAD_ROOT_UNVERIFIED']] as const){
      const w=await run(f,'session.attach',{threadId:id,project:'repo'});
      assert.equal(w.error,code);assert.equal(w.status,'failed');
      assert.ok(!f.backend.calls.some(c=>c.method==='thread/resume'&&c.params.threadId===id));
      assert.ok(!f.store.state.sessions.some(s=>s.threadId===id));
    }
    assert.equal((await run(f,'session.attach',{threadId:'fork',project:'repo'})).status,'completed');
    assert.ok(f.backend.calls.some(c=>c.method==='thread/resume'&&c.params.threadId==='fork'));
    const created=await run(f,'session.create',{project:'repo'});assert.equal(created.status,'completed');
    assert.ok((await f.connector.sessionPage({view:'loaded'})).sessions.some(x=>x.id===created.resultRef?.threadId));
  }finally{await f.cleanup();}
});


test('attach does not persist a binding when resume contradicts the initial root read',async()=>{
  const f=fixture();try{
    await f.connector.initialize();
    f.backend.threads.set('claimed-root',rootThread('claimed-root',f.dir,{canAcceptDirectInput:true}));
    const rpc=f.backend.rpc.bind(f.backend);
    f.backend.rpc=async(method,p)=>{
      if(method==='thread/resume')return {thread:rootThread('claimed-root',f.dir,{parentThreadId:'actual-parent'})};
      return rpc(method,p);
    };
    const w=await run(f,'session.attach',{threadId:'claimed-root',project:'repo'});
    assert.equal(w.status,'failed');assert.equal(w.error,'SUBAGENT_THREAD_NOT_SUPPORTED');
    assert.ok(!f.store.state.sessions.some(s=>s.threadId==='claimed-root'));
  }finally{await f.cleanup();}
});
