import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { COMMANDS, validateCommand } from '../src/protocol.js';

const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
type Fixture=ReturnType<typeof fixture>;
function backend(f:Fixture,reply:(method:string,params:any)=>any){
  f.backend.rpc=async(method,params)=>{f.backend.calls.push({method,params});return reply(method,params);};
}
const methods=(f:Fixture)=>f.backend.calls.map(c=>c.method);
const list=(f:Fixture,params:Record<string,unknown>)=>(f.connector as any).list(validateCommand('session.list',params));

test('view is optional in the registry and desktop defaults retain both sources and original fields',async()=>{
  assert.equal(Object.hasOwn(COMMANDS['session.list'].params.view,'default'),false);
  assert.equal(validateCommand('session.list',{}).view,undefined);
  const f=fixture();try{
    backend(f,(method)=>method==='thread/list'?{data:[{id:'history',cwd:f.dir}],nextCursor:null}:{data:[],nextCursor:null});
    const page=await f.connector.sessionPage();
    assert.deepEqual(methods(f),['thread/list','thread/loaded/list']);
    assert.equal(page.view,'all');assert.equal(page.pageLimitPerSource,50);
    assert.equal(page.sessions[0]!.loaded,null);assert.equal(page.returnedCount,1);
    assert.deepEqual(page.scanned,{loaded:0,history:1});assert.equal(page.hasMore,false);
    for(const key of ['sessions','nextCursor','unresolvedLoadedIds','pageLimitPerSource','scope'])assert.ok(Object.hasOwn(page,key));
    assert.equal(Object.hasOwn(page,'total'),false);assert.match(page.scope,/not a global session count or complete enumeration/);
  }finally{await f.cleanup();}
});

test('loaded view reads only one loaded page and metadata, retaining unknown placeholders',async()=>{
  const f=fixture();try{
    backend(f,(method,p)=>{
      if(method==='thread/loaded/list')return{data:['ready','missing'],nextCursor:'next'};
      if(method==='thread/read'&&p.threadId==='ready')return{thread:{id:'ready',cwd:f.dir,status:{type:'idle'}}};
      throw Error('unavailable');
    });
    const page=await f.connector.sessionPage({view:'loaded',limit:2});
    assert.deepEqual(methods(f),['thread/loaded/list','thread/read','thread/read']);
    assert.deepEqual(f.backend.calls[0]!.params,{limit:2,cursor:undefined});
    assert.equal(page.sessions.length,2);assert.equal(page.sessions[1]!.loaded,true);
    assert.equal(page.sessions[1]!.status.type,'unknown');assert.equal(page.sessions[1]!.manageable,null);
    assert.deepEqual(page.unresolvedLoadedIds,['missing']);assert.equal(page.unknownLoadedCount,1);
    assert.equal(page.hasMore,true);assert.ok(page.nextCursor);assert.deepEqual(page.scanned,{loaded:2,history:0});
    assert.equal(f.store.state.sessions.length,0);assert.equal(f.store.state.work.length,0);assert.equal(f.posts.length,0);
  }finally{await f.cleanup();}
});

test('history view only calls thread/list and never implies that indexed sessions are unloaded',async()=>{
  const f=fixture();try{
    backend(f,(method,p)=>{assert.equal(method,'thread/list');assert.equal(p.useStateDbOnly,true);return{data:[{id:'old',cwd:f.dir,status:{type:'active'}}],nextCursor:'history-next'};});
    const page=await f.connector.sessionPage({view:'history',limit:1});
    assert.deepEqual(methods(f),['thread/list']);assert.equal(page.sessions[0]!.loaded,null);
    assert.deepEqual(page.sessions[0]!.discoverySources,['indexed-history']);assert.equal(page.returnedCount,1);
    assert.deepEqual(page.scanned,{loaded:0,history:1});assert.equal(page.unknownLoadedCount,0);assert.equal(page.hasMore,true);
  }finally{await f.cleanup();}
});

test('active view uses fresh metadata and preserves continuation through zero-match pages',async()=>{
  const f=fixture();try{
    backend(f,(method,p)=>{
      if(method==='thread/loaded/list')return p.cursor?{data:['busy'],nextCursor:null}:{data:['idle','failed','unknown'],nextCursor:'later'};
      assert.equal(method,'thread/read');
      if(p.threadId==='failed')throw Error('unavailable');
      return{thread:{id:p.threadId,cwd:f.dir,...(p.threadId==='unknown'?{}:{status:{type:p.threadId==='busy'?'active':'idle'}})}};
    });
    const one=await f.connector.sessionPage({view:'active',limit:3});
    assert.equal(one.returnedCount,0);assert.deepEqual(one.sessions,[]);assert.equal(one.hasMore,true);
    assert.deepEqual(one.unresolvedLoadedIds,['failed']);assert.equal(one.unknownLoadedCount,2);assert.ok(one.nextCursor);
    assert.deepEqual(methods(f),['thread/loaded/list','thread/read','thread/read','thread/read']);
    const two=await f.connector.sessionPage({view:'active',limit:3,cursor:one.nextCursor});
    assert.equal(two.sessions[0]!.id,'busy');assert.equal(two.sessions[0]!.status.type,'active');assert.equal(two.sessions[0]!.loaded,true);
    assert.equal(two.returnedCount,1);assert.equal(two.hasMore,false);assert.equal(two.nextCursor,null);
    assert.deepEqual(two.scanned,{loaded:1,history:0});assert.equal(two.unknownLoadedCount,0);
    assert.equal(f.backend.calls.filter(c=>c.method==='thread/loaded/list').length,2);
    assert.equal(f.backend.calls.find(c=>c.params.cursor==='later')!.method,'thread/loaded/list');
  }finally{await f.cleanup();}
});

test('v2 cursors bind view and project and reject incompatible source states before RPC',async()=>{
  const f=fixture();try{
    backend(f,()=>({data:[],nextCursor:'later'}));
    const page=await list(f,{view:'loaded',project:'repo',limit:1});
    const before=f.backend.calls.length;
    for(const params of [{view:'active',project:'repo'},{view:'loaded'},{view:'history',project:'repo'},{view:'all',project:'repo'}]){
      await assert.rejects(list(f,{...params,cursor:page.nextCursor}),/INVALID_CURSOR/);
    }
    assert.equal(f.backend.calls.length,before);
    const decoded=JSON.parse(Buffer.from(page.nextCursor,'base64url').toString());
    assert.equal(decoded.v,2);assert.equal(decoded.view,'loaded');assert.equal(decoded.project,'repo');
    for(const change of [{v:3},{loadedDone:true},{storedDone:false},{project:null},{extra:true}]){
      await assert.rejects(list(f,{view:'loaded',project:'repo',cursor:encode({...decoded,...change})}),/INVALID_CURSOR/);
    }
    assert.equal(f.backend.calls.length,before);
  }finally{await f.cleanup();}
});

test('project filtering remains bounded, including pages with no project matches',async()=>{
  const f=fixture();try{
    backend(f,(method,p)=>method==='thread/loaded/list'?{data:['outside','missing'],nextCursor:'later'}:p.threadId==='outside'?{thread:{id:'outside',cwd:'/outside',status:{type:'active'}}}:Promise.reject(Error('missing')));
    const page=await list(f,{view:'active',project:'repo',limit:2});
    assert.equal(page.returnedCount,0);assert.equal(page.hasMore,true);assert.equal(page.unknownLoadedCount,1);
    assert.deepEqual(page.unresolvedLoadedIds,['missing']);assert.deepEqual(page.scanned,{loaded:2,history:0});
    assert.deepEqual(methods(f),['thread/loaded/list','thread/read','thread/read']);
    await assert.rejects(f.connector.sessionPage({project:'repo',view:'loaded'}),/INVALID_SESSION_QUERY/);
  }finally{await f.cleanup();}
});

test('legacy all cursors continue with exhausted sources skipped, but cannot be mixed with filters',async()=>{
  const f=fixture();try{
    backend(f,(method,p)=>{assert.equal(method,'thread/loaded/list');assert.equal(p.cursor,'old-next');return{data:[],nextCursor:null};});
    const cursor=encode({storedDone:true,loaded:'old-next',loadedDone:false});
    const page=await f.connector.sessionPage({cursor});assert.equal(page.view,'all');assert.equal(page.hasMore,false);
    assert.deepEqual(methods(f),['thread/loaded/list']);
    for(const view of ['loaded','active','history'])await assert.rejects(f.connector.sessionPage({view,cursor}),/INVALID_CURSOR/);
    await assert.rejects(list(f,{project:'repo',cursor}),/INVALID_CURSOR/);
    assert.equal(f.backend.calls.length,1);
  }finally{await f.cleanup();}
});

test('malformed, repeated and oversized backend cursors fail rather than being replayed',async()=>{
  const f=fixture();try{
    for(const nextCursor of [true,1,{},'', 'x'.repeat(513),'bad\nvalue']){
      backend(f,()=>({data:[],nextCursor}));
      await assert.rejects(f.connector.sessionPage({view:'loaded',limit:1}),/INVALID_SESSION_PAGE/);
    }
    const cursor=encode({v:2,view:'loaded',project:null,loaded:'same',storedDone:true,loadedDone:false});
    backend(f,()=>({data:[],nextCursor:'same'}));
    const before=f.backend.calls.length;
    await assert.rejects(f.connector.sessionPage({view:'loaded',cursor}),/INVALID_SESSION_PAGE/);
    assert.equal(f.backend.calls.length,before+1);
    backend(f,()=>({data:['one','two'],nextCursor:null}));
    await assert.rejects(f.connector.sessionPage({view:'loaded',limit:1}),/INVALID_SESSION_PAGE/);
    assert.equal(f.backend.calls.length,before+2);
  }finally{await f.cleanup();}
});

test('failed fresh reads do not reuse stale history status as active',async()=>{
  const f=fixture();try{
    backend(f,(method)=>{
      if(method==='thread/list')return{data:[{id:'stale',cwd:f.dir,status:{type:'active'},canAcceptDirectInput:true}],nextCursor:null};
      if(method==='thread/loaded/list')return{data:['stale'],nextCursor:null};
      throw Error('metadata failed');
    });
    const all=await f.connector.sessionPage({view:'all'});
    assert.equal(all.sessions[0]!.status.type,'unknown');assert.equal(all.sessions[0]!.loaded,true);
    assert.equal(all.sessions[0]!.manageable,null);assert.deepEqual(all.sessions[0]!.discoverySources,['indexed-history','loaded']);
    f.backend.calls.length=0;
    const active=await f.connector.sessionPage({view:'active'});
    assert.equal(active.returnedCount,0);assert.equal(active.unknownLoadedCount,1);
    assert.deepEqual(methods(f),['thread/loaded/list','thread/read']);
  }finally{await f.cleanup();}
});
