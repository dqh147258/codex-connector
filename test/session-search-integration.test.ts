import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, commandHelp, validateCommand } from '../src/protocol.js';
import { compactResult, nextResultCommand, nextResultQuery, readResult } from '../src/slack-results.js';
import { event, fixture, request, waitFor } from './helpers.js';

const message=(n:number)=>({turnId:`turn-${n}`,item:{id:`item-${n}`,type:'agentMessage',phase:'final_answer',text:`Queue conclusion ${n}`}});

test('search protocol has explicit defaults, bounded terms, read permission and generated help',()=>{
  assert.deepEqual(validateCommand('session.search',{terms:['queue']}),{terms:['queue'],mode:'and',role:'all',sessionLimit:10,limit:20,maxChars:1000});
  assert.equal(COMMANDS['session.search'].permission,'read');
  assert.equal(commandHelp('session.search').commands[0]!.name,'session.search');
  for(const params of [{},{terms:[]},{terms:[' ']},{terms:[1]},{terms:['x'.repeat(201)]},{terms:Array(11).fill('x')},{terms:Array(6).fill('x'.repeat(200))},{terms:['x\ny']},{terms:['x'],sessionLimit:21},{terms:['x'],limit:0},{terms:['x'],mode:'AND'},{terms:['x'],role:'tool'},{terms:['x'],regex:true},{terms:['x'],cursor:'x'.repeat(129)}])assert.throws(()=>validateCommand('session.search',params));
  assert.doesNotThrow(()=>validateCommand('session.search',{terms:['中文','a b'],mode:'or',role:'assistant'}));
});

test('Slack search produces compact hit index and scoped result.next without rediscovering or losing matches',async()=>{
  const f=fixture();try{
    await f.connector.initialize();f.backend.calls=[];
    f.backend.threads.set('recent',{id:'recent',cwd:f.dir,name:'Recent task',status:{type:'idle'},updatedAt:20,createdAt:10});
    const original=f.backend.rpc.bind(f.backend),rows=Array.from({length:3},(_,i)=>message(i+1));
    f.backend.rpc=async(method,p)=>{
      if(method==='thread/items/list'){f.backend.calls.push({method,params:p});const start=p.cursor?Number(p.cursor):0;return{data:rows.slice(start,start+p.limit),nextCursor:start+p.limit<rows.length?String(start+p.limit):null};}
      return original(method,p);
    };
    const r=request('session.search',{terms:['queue','conclusion'],mode:'and',role:'assistant',limit:1});
    assert.equal(f.connector.accept(event(r,{thread_ts:'90.1'})),true);f.connector.pump();
    await waitFor(()=>f.store.state.work.some(w=>w.request.id===r.id&&w.status==='completed'));
    const work=f.store.state.work.find(w=>w.request.id===r.id)!,snapshot=f.store.state.results!.find(s=>s.id===work.resultRef?.resultId)!;
    const result=JSON.parse(snapshot.text);assert.equal(result.returnedCount,1);assert.equal(result.matches[0].metadata.name,'Recent task');assert.equal(result.matches[0].message.itemId,'item-1');assert.ok(result.nextCursor);
    const compact=compactResult(work,result,snapshot);assert.match(compact,/Search matches=1/);assert.match(compact,/result.next/);assert.match(compact,/NOT execution activity/);
    assert.equal(nextResultCommand(f.store.state,snapshot.id,work.source,f.config),'session.search');
    assert.equal(nextResultQuery(f.store.state,snapshot.id,work.source,f.config).cursor,result.nextCursor);
    assert.throws(()=>readResult(f.store.state,snapshot.id,1,{...work.source,userId:'someone-else'},f.config));
    assert.throws(()=>nextResultQuery(f.store.state,snapshot.id,{...work.source,threadTs:'91.1'},f.config));
    const next=request('result.next',{resultId:snapshot.id});f.connector.accept(event(next,{thread_ts:'90.1'}));f.connector.pump();
    await waitFor(()=>f.store.state.work.some(w=>w.request.id===next.id&&w.status==='completed'));
    const second=f.store.state.results!.find(s=>s.id===f.store.state.work.find(w=>w.request.id===next.id)!.resultRef?.resultId)!;
    assert.equal(JSON.parse(second.text).matches[0].message.itemId,'item-2');
    assert.equal(f.backend.calls.filter(c=>c.method==='thread/list').length,1);
    assert.ok(f.backend.calls.every(c=>['thread/list','thread/read','thread/items/list'].includes(c.method)));
    assert.equal(f.store.state.sessions.length,0);
  }finally{await f.cleanup();}
});

test('search rechecks the authenticated actor and policy before storing result or sending text',async()=>{
  for(const revoke of ['actor','policy']){
    const f=fixture();try{
      await f.connector.initialize();f.backend.threads.set('recent',{id:'recent',cwd:f.dir,status:{type:'idle'}});
      const original=f.backend.rpc.bind(f.backend);
      f.backend.rpc=async(method,p)=>{if(method==='thread/items/list'){
        if(revoke==='actor')f.config.slack.trustedBots=[];else f.config.filePolicy={allowAbsolutePaths:true};
        return{data:[message(1)],nextCursor:null};
      }return original(method,p);};
      const r=request('session.search',{terms:['queue']});f.connector.accept(event(r));f.connector.pump();
      await waitFor(()=>f.store.state.work.some(w=>w.request.id===r.id&&w.status==='failed'));
      const work=f.store.state.work.find(w=>w.request.id===r.id)!;
      assert.equal(work.error,revoke==='actor'?'ACTOR_REVOKED':'SESSION_SCOPE_CHANGED');assert.equal(f.store.state.results?.length??0,0);
      assert.ok(!f.store.state.outbox.some(o=>o.text.includes('Queue conclusion')));
    }finally{await f.cleanup();}
  }
});
