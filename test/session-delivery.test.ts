import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { BackendError } from '../src/codex.js';
import { Store } from '../src/store.js';
import { deliveryStatus, deliveryView, validateMessageDelivery } from '../src/session-delivery.js';
import { compactResult } from '../src/slack-results.js';
import { validateCommand } from '../src/protocol.js';
import { fixture, ready, run, request, event, waitFor } from './helpers.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 5));
const saved = (f:ReturnType<typeof fixture>, id:string) => f.store.state.work.find(w => w.id === id)!;
function emit(f:ReturnType<typeof fixture>, method:string, params:any, epoch=f.backend.epoch) {
  f.backend.emit('notification', method, params, epoch);
}
function user(threadId:string, clientId:string, turnId='turn-matched') {
  return {threadId,turnId,item:{type:'userMessage',id:'item-distinct-from-client',clientId,content:[{type:'text',text:'same text'}]}};
}
function rejectStart(f:ReturnType<typeof fixture>, code='RPC_REJECTED') {
  const rpc=f.backend.rpc.bind(f.backend);
  f.backend.rpc=async(method,params)=>{if(method==='thread/queue/start'){f.backend.calls.push({method,params});throw new BackendError(code);}return rpc(method,params);};
}

test('send start rejection reports accepted admission, not still queued or model completion',async()=>{
  const f=fixture();try{
    const s=await ready(f);rejectStart(f);
    const w=await run(f,'session.send',{sessionId:s.id,text:'same text'});
    assert.equal(w.status,'completed');assert.equal(deliveryStatus(w),'accepted');
    assert.equal(w.messageDelivery?.admission,'accepted');assert.equal(w.messageDelivery?.start,'rejected');
    assert.equal(w.messageDelivery?.execution,'unknown');assert.equal(w.messageDelivery?.queuedSubmissionId,'queued-1');
    assert.equal(f.backend.calls.filter(c=>c.method==='thread/queue/add').length,1);
    assert.ok(!f.backend.calls.some(c=>['turn/start','turn/steer'].includes(c.method)));
    assert.ok(!f.store.state.outbox.some(o=>o.text.includes('Message remains queued')));
    const text=compactResult(w,deliveryView(w));assert.match(text,/Message evidence: accepted; command=completed/);
    assert.match(text,/does not establish current queue position or non-delivery/);
  }finally{await f.cleanup();}
});

test('queue/add may auto-consume before its response; exact evidence suppresses redundant start',async()=>{
  const f=fixture();try{
    const s=await ready(f),rpc=f.backend.rpc.bind(f.backend);
    f.backend.rpc=async(method,params)=>{
      if(method==='thread/queue/add'){
        const ack=await rpc(method,params);
        emit(f,'item/started',user(s.threadId,params.clientUserMessageId));
        emit(f,'turn/completed',{threadId:s.threadId,turn:{id:'turn-matched',status:'completed'}});
        await tick();return ack;
      }
      if(method==='thread/queue/start'){f.backend.calls.push({method,params});throw new BackendError('RPC_REJECTED');}
      return rpc(method,params);
    };
    const w=await run(f,'session.send',{sessionId:s.id,text:'same text'});
    assert.equal(deliveryStatus(w),'completed');assert.equal(w.messageDelivery?.start,'not-requested');assert.ok(!f.backend.calls.some(c=>c.method==='thread/queue/start'));
    assert.equal(w.messageDelivery?.turnId,'turn-matched');assert.equal(w.messageDelivery?.evidence,'turn-lifecycle');
  }finally{await f.cleanup();}
});

test('queue without resume acknowledges admission only; autonomous matching lifecycle can establish processing',async()=>{
  const f=fixture();try{
    const s=await ready(f),w=await run(f,'session.queue',{sessionId:s.id,text:'same text'});
    assert.equal(deliveryStatus(w),'accepted');assert.equal(w.messageDelivery?.start,'not-requested');
    assert.ok(!f.backend.calls.some(c=>c.method==='thread/queue/start'));
    emit(f,'item/completed',user(s.threadId,w.id));await tick();
    assert.equal(deliveryStatus(saved(f,w.id)),'processing');
  }finally{await f.cleanup();}
});

test('only exact userMessage.clientId + thread proves receipt; item completion/final text is not turn completion',async()=>{
  const f=fixture();try{
    const s=await ready(f);rejectStart(f);const w=await run(f,'session.send',{sessionId:s.id,text:'same text'});
    emit(f,'item/started',user('another-thread',w.id));
    emit(f,'item/started',user(s.threadId,'another-client'));
    emit(f,'item/started',{...user(s.threadId,w.id),item:{type:'userMessage',id:w.id,clientUserMessageId:w.id}});
    emit(f,'turn/started',{threadId:s.threadId,turn:{id:'unrelated',status:'inProgress'}});
    emit(f,'turn/completed',{threadId:s.threadId,turn:{id:'unrelated',status:'completed'}});
    await tick();assert.equal(deliveryStatus(saved(f,w.id)),'accepted');
    emit(f,'item/completed',user(s.threadId,w.id));await tick();
    assert.equal(deliveryStatus(saved(f,w.id)),'processing');
    emit(f,'item/completed',{threadId:s.threadId,turnId:'turn-matched',item:{id:'answer',type:'agentMessage',phase:'final_answer',text:'Done'}});
    await tick();assert.equal(deliveryStatus(saved(f,w.id)),'processing');
    emit(f,'turn/completed',{threadId:s.threadId,turn:{id:'turn-matched',status:'completed'}});await tick();
    assert.equal(deliveryStatus(saved(f,w.id)),'completed');
    emit(f,'item/started',user(s.threadId,w.id));emit(f,'turn/started',{threadId:s.threadId,turn:{id:'turn-matched',status:'inProgress'}});
    await tick();assert.equal(deliveryStatus(saved(f,w.id)),'completed');
  }finally{await f.cleanup();}
});

for(const status of ['completed','failed','interrupted'])test(`terminal ${status} received before start response is retained`,async()=>{
  const f=fixture();try{
    const s=await ready(f),rpc=f.backend.rpc.bind(f.backend);
    f.backend.rpc=async(method,params)=>{const r=await rpc(method,params);if(method==='thread/queue/start'){emit(f,'turn/completed',{threadId:s.threadId,turn:{id:r.turn.id,status}});await tick();}return r;};
    const w=await run(f,'session.send',{sessionId:s.id,text:'same text'});
    assert.equal(deliveryStatus(w),status);assert.equal(w.messageDelivery?.start,'accepted');
  }finally{await f.cleanup();}
});

test('terminal notification before user correlation is held by exact thread/turn only',async()=>{
  const f=fixture();try{
    const s=await ready(f);rejectStart(f);const w=await run(f,'session.send',{sessionId:s.id,text:'same text'});
    emit(f,'turn/completed',{threadId:s.threadId,turn:{id:'turn-matched',status:'completed'}});
    emit(f,'item/started',user(s.threadId,w.id));await tick();
    assert.equal(deliveryStatus(saved(f,w.id)),'completed');
  }finally{await f.cleanup();}
});

test('start timeout preserves queue acceptance and same request never enqueues twice',async()=>{
  const f=fixture();try{
    const s=await ready(f);rejectStart(f,'RPC_OUTCOME_UNCERTAIN');
    const r=request('session.send',{sessionId:s.id,text:'same text'}),receipt=f.connector.local(r);
    await waitFor(()=>saved(f,receipt.id).status==='uncertain');
    const w=saved(f,receipt.id);assert.equal(deliveryStatus(w),'uncertain');assert.equal(w.messageDelivery?.admission,'accepted');
    assert.equal(w.messageDelivery?.queuedSubmissionId,'queued-1');
    f.connector.local(r);await tick();assert.equal(f.backend.calls.filter(c=>c.method==='thread/queue/add').length,1);
    assert.equal((await run(f,'session.delivery',{sessionId:s.id,workId:w.id,refresh:false})).status,'completed');
    emit(f,'item/started',user(s.threadId,w.id));emit(f,'turn/completed',{threadId:s.threadId,turn:{id:'turn-matched',status:'completed'}});await tick();
    assert.equal(deliveryStatus(saved(f,w.id)),'completed');assert.equal(saved(f,w.id).status,'uncertain','RPC outcome and model lifecycle are separate');
    assert.equal(f.backend.calls.filter(c=>c.method==='thread/queue/add').length,1);
  }finally{await f.cleanup();}
});

test('lost add acknowledgement can later be correlated without retry',async()=>{
  const f=fixture();try{
    const s=await ready(f),rpc=f.backend.rpc.bind(f.backend);
    f.backend.rpc=async(method,params)=>{if(method==='thread/queue/add'){f.backend.calls.push({method,params});throw new BackendError('RPC_OUTCOME_UNCERTAIN');}return rpc(method,params);};
    const w=await run(f,'session.send',{sessionId:s.id,text:'same text'});
    assert.equal(w.messageDelivery?.admission,'uncertain');assert.equal(deliveryStatus(w),'uncertain');
    assert.ok(!f.backend.calls.some(c=>c.method==='thread/queue/start'));
    emit(f,'item/started',user(s.threadId,w.id));await tick();assert.equal(deliveryStatus(saved(f,w.id)),'processing');
  }finally{await f.cleanup();}
});

test('malformed/mismatched acknowledgements never start an unrelated entry or claim processing',async()=>{
  for(const response of [{queuedSubmission:{}},{queuedSubmission:{id:'queue-wrong',clientUserMessageId:'wrong'}},{queuedSubmission:{id:'bad\nid',clientUserMessageId:'wrong'}}]){
    const f=fixture();try{
      const s=await ready(f),rpc=f.backend.rpc.bind(f.backend);
      f.backend.rpc=async(method,params)=>method==='thread/queue/add'?response:rpc(method,params);
      const w=await run(f,'session.send',{sessionId:s.id,text:'same text'});
      assert.equal(deliveryStatus(w),'uncertain');assert.equal(w.status,'uncertain');assert.ok(!f.backend.calls.some(c=>c.method==='thread/queue/start'));
    }finally{await f.cleanup();}
  }
  const f=fixture();try{
    const s=await ready(f),rpc=f.backend.rpc.bind(f.backend);
    f.backend.rpc=async(method,params)=>method==='thread/queue/start'?{}:rpc(method,params);
    const w=await run(f,'session.send',{sessionId:s.id,text:'same text'});
    assert.equal(w.messageDelivery?.startError,'INVALID_START_ACK');assert.equal(deliveryStatus(w),'uncertain');
  }finally{await f.cleanup();}
});

test('unknown mutation exception remains uncertain rather than a safe-to-repeat failure',async()=>{
  const f=fixture();try{
    const s=await ready(f),rpc=f.backend.rpc.bind(f.backend);f.backend.rpc=async(method,params)=>{if(method==='thread/queue/add')throw Error('unknown');return rpc(method,params);};
    const w=await run(f,'session.send',{sessionId:s.id,text:'same text'});assert.equal(w.status,'uncertain');assert.equal(w.messageDelivery?.admission,'uncertain');
  }finally{await f.cleanup();}
});

test('readback correlates a missed user item and exact terminal turn without control RPCs or message export',async()=>{
  const f=fixture();try{
    const s=await ready(f);rejectStart(f);const w=await run(f,'session.send',{sessionId:s.id,text:'same text'}),rpc=f.backend.rpc.bind(f.backend);
    f.backend.rpc=async(method,params)=>{
      if(method==='thread/items/list'){f.backend.calls.push({method,params});return{data:[{...user(s.threadId,w.id),item:{...user(s.threadId,w.id).item,content:[{type:'text',text:'DO_NOT_EXPORT'}]}}],nextCursor:null};}
      if(method==='thread/turns/list'){f.backend.calls.push({method,params});return{data:[{id:'turn-unrelated',status:'failed'},{id:'turn-matched',status:'completed'}],nextCursor:null};}
      return rpc(method,params);
    };
    const before=f.backend.calls.length;assert.equal((await run(f,'session.delivery',{sessionId:s.id,workId:w.id})).status,'completed');
    assert.equal(deliveryStatus(saved(f,w.id)),'completed');
    assert.ok(f.backend.calls.slice(before).every(c=>['thread/read','thread/queue/list','thread/items/list','thread/turns/list'].includes(c.method)));
    assert.ok(!JSON.stringify(f.store.state).includes('DO_NOT_EXPORT'));
  }finally{await f.cleanup();}
});

test('queue presence/absence and uncorrelated history never imply processing; partial reads stay explicit',async()=>{
  for(const present of [false,true]){const f=fixture();try{
    const s=await ready(f);rejectStart(f);const w=await run(f,'session.send',{sessionId:s.id,text:'same text'}),rpc=f.backend.rpc.bind(f.backend);
    f.backend.rpc=async(method,params)=>method==='thread/queue/list'?{data:present?[{id:'queued-1',clientUserMessageId:w.id,input:[]}]:[],nextCursor:'more'}:rpc(method,params);
    await run(f,'session.delivery',{sessionId:s.id,workId:w.id});assert.equal(deliveryStatus(saved(f,w.id)),'accepted');
    assert.ok(f.store.state.outbox.some(o=>o.text.includes(present?'"state": "present"':'"state": "not-observed"')));
  }finally{await f.cleanup();}}
});

test('readback scope change cannot persist or disclose newly collected evidence',async()=>{
  const f=fixture();try{
    const s=await ready(f);rejectStart(f);const w=await run(f,'session.send',{sessionId:s.id,text:'same text'}),rpc=f.backend.rpc.bind(f.backend);let reads=0;
    f.backend.rpc=async(method,params)=>{
      if(method==='thread/read'&&++reads===2)return{thread:{id:s.threadId,cwd:'/outside-scope'}};
      if(method==='thread/items/list')return{data:[user(s.threadId,w.id)],nextCursor:null};
      return rpc(method,params);
    };
    const q=await run(f,'session.delivery',{sessionId:s.id,workId:w.id});assert.equal(q.error,'THREAD_PROJECT_MISMATCH');assert.equal(deliveryStatus(saved(f,w.id)),'accepted');
  }finally{await f.cleanup();}
});

test('disconnected and unsupported readback retain acknowledged evidence with errors',async()=>{
  const f=fixture();try{
    const s=await ready(f);rejectStart(f);const w=await run(f,'session.send',{sessionId:s.id,text:'same text'}),rpc=f.backend.rpc.bind(f.backend);
    f.backend.rpc=async(method,params)=>{if(method==='thread/queue/list')throw new BackendError('METHOD_UNSUPPORTED');return rpc(method,params);};
    assert.equal((await run(f,'session.delivery',{sessionId:s.id,workId:w.id})).status,'completed');
    assert.ok(f.store.state.outbox.some(o=>o.text.includes('METHOD_UNSUPPORTED')));
    f.backend.connected=false;
    f.backend.emit('disconnect',f.backend.epoch);await tick();
    assert.equal((await run(f,'session.delivery',{sessionId:s.id,workId:w.id})).status,'completed');
    assert.equal(deliveryStatus(saved(f,w.id)),'accepted');assert.equal(saved(f,w.id).messageDelivery?.observationGap,true);
    emit(f,'item/started',user(s.threadId,w.id));await tick();assert.equal(deliveryStatus(saved(f,w.id)),'accepted');
  }finally{await f.cleanup();}
});

test('stale epoch evidence is ignored and conflicting exact correlation is surfaced as uncertain',async()=>{
  const f=fixture();try{
    const s=await ready(f);rejectStart(f);const w=await run(f,'session.send',{sessionId:s.id,text:'same text'});
    emit(f,'item/started',user(s.threadId,w.id),'old-epoch');await tick();assert.equal(deliveryStatus(saved(f,w.id)),'accepted');
    emit(f,'item/started',user(s.threadId,w.id));await tick();assert.equal(deliveryStatus(saved(f,w.id)),'processing');
    emit(f,'item/started',user(s.threadId,w.id,'another-turn'));await tick();assert.equal(deliveryStatus(saved(f,w.id)),'uncertain');assert.equal(saved(f,w.id).messageDelivery?.correlationConflict,true);
  }finally{await f.cleanup();}
});

test('delivery query requires exact work/session and originating Slack actor/thread',async()=>{
  const f=fixture();try{
    const s=await ready(f),w=await run(f,'session.queue',{sessionId:s.id,text:'same text'});
    const r=request('session.delivery',{sessionId:s.id,workId:w.id,refresh:false});
    f.connector.accept(event(r));f.connector.pump();await waitFor(()=>f.store.state.work.some(x=>x.request.id===r.id&&x.status==='failed'));
    assert.equal(f.store.state.work.find(x=>x.request.id===r.id)?.error,'DELIVERY_NOT_FOUND');
    assert.equal((await run(f,'session.delivery',{sessionId:s.id,workId:'missing-work',refresh:false})).error,'DELIVERY_NOT_FOUND');
    assert.throws(()=>validateCommand('session.delivery',{sessionId:s.id,workId:w.id,resend:true}));
  }finally{await f.cleanup();}
});

test('restart retains IDs and processing evidence, flags observation gap and never replays pending submission',async()=>{
  const f=fixture(),s=await ready(f),w=await run(f,'session.send',{sessionId:s.id,text:'same text'});
  await f.connector.close();f.store.transaction(state=>{const row=state.work.find(x=>x.id===w.id)!;row.status='executing';row.messageDelivery!.start='pending';});f.store.close();
  const store=new Store(f.dir);try{
    const row=store.state.work.find(x=>x.id===w.id)!;assert.equal(row.status,'uncertain');assert.equal(row.messageDelivery?.start,'uncertain');assert.equal(row.messageDelivery?.queuedSubmissionId,'queued-1');assert.equal(row.messageDelivery?.observationGap,true);assert.equal(deliveryStatus(row),'processing');
  }finally{store.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('real initial Slack result commits command=completed, while local acceptance is inbox-only',async()=>{
  const f=fixture();try{
    const s=await ready(f),r=request('session.send',{sessionId:s.id,text:'same text'});
    f.connector.accept(event(r));f.connector.pump();await waitFor(()=>f.store.state.work.some(w=>w.request.id===r.id&&w.status==='completed'));
    assert.ok(f.store.state.outbox.some(o=>o.text.includes('Message evidence: processing; command=completed')));
    const snapshot=f.store.state.results?.find(x=>x.command==='session.send');assert.equal(JSON.parse(snapshot!.text).commandStatus,'completed');
    const receipt=f.connector.local(request('session.queue',{sessionId:s.id,text:'later'}));assert.equal(receipt.acceptance,'connector-inbox-only');assert.equal(receipt.deliveryConfirmed,false);
  }finally{await f.cleanup();}
});

test('lost add acknowledgement recovers exact queue admission from client ID, without starting or replaying',async()=>{
  const f=fixture();try{
    const s=await ready(f),rpc=f.backend.rpc.bind(f.backend);
    f.backend.rpc=async(method,params)=>{if(method==='thread/queue/add')throw new BackendError('RPC_OUTCOME_UNCERTAIN');return rpc(method,params);};
    const w=await run(f,'session.send',{sessionId:s.id,text:'same text'});
    f.backend.rpc=async(method,params)=>method==='thread/queue/list'?{data:[{id:'recovered-queue',clientUserMessageId:w.id,input:[]}],nextCursor:null}:rpc(method,params);
    await run(f,'session.delivery',{sessionId:s.id,workId:w.id});const current=saved(f,w.id);
    assert.equal(current.messageDelivery?.queuedSubmissionId,'recovered-queue');assert.equal(current.messageDelivery?.admission,'accepted');assert.equal(current.messageDelivery?.evidence,'queue-readback');assert.equal(deliveryStatus(current),'accepted');
    assert.equal(current.status,'uncertain');assert.ok(!f.backend.calls.some(c=>c.method==='thread/queue/start'));
  }finally{await f.cleanup();}
});

test('conflicting queue IDs for one client correlation remain uncertain',async()=>{
  const f=fixture();try{
    const s=await ready(f),w=await run(f,'session.queue',{sessionId:s.id,text:'same text'}),rpc=f.backend.rpc.bind(f.backend);
    f.backend.rpc=async(method,params)=>method==='thread/queue/list'?{data:[{id:'queued-1',clientUserMessageId:w.id},{id:'queued-2',clientUserMessageId:w.id}],nextCursor:null}:rpc(method,params);
    await run(f,'session.delivery',{sessionId:s.id,workId:w.id});assert.equal(deliveryStatus(saved(f,w.id)),'uncertain');
  }finally{await f.cleanup();}
});

test('reconnect during readback discards collected evidence and cannot claim a current queue snapshot',async()=>{
  const f=fixture();try{
    const s=await ready(f);rejectStart(f);const w=await run(f,'session.send',{sessionId:s.id,text:'same text'}),rpc=f.backend.rpc.bind(f.backend);
    f.backend.rpc=async(method,params)=>{
      if(method==='thread/items/list')return{data:[user(s.threadId,w.id)],nextCursor:null};
      if(method==='thread/turns/list'){f.backend.epoch='epoch-new';return{data:[{id:'turn-matched',status:'completed'}],nextCursor:null};}
      return rpc(method,params);
    };
    await run(f,'session.delivery',{sessionId:s.id,workId:w.id});assert.equal(deliveryStatus(saved(f,w.id)),'accepted');
    const out=f.store.state.outbox.filter(o=>o.text.includes('"readbackCommitted"')).map(o=>o.text).join('');assert.match(out,/false/);assert.ok(!out.includes('queueObservation'));
  }finally{await f.cleanup();}
});

test('add RPC rejection is not treated as proof that a possibly persisted message was never submitted',async()=>{
  const f=fixture();try{
    const s=await ready(f),rpc=f.backend.rpc.bind(f.backend);f.backend.rpc=async(method,params)=>{if(method==='thread/queue/add')throw new BackendError('RPC_REJECTED');return rpc(method,params);};
    const w=await run(f,'session.send',{sessionId:s.id,text:'same text'});assert.equal(w.status,'uncertain');assert.equal(w.messageDelivery?.admissionError,'RPC_REJECTED');assert.equal(deliveryStatus(w),'uncertain');
  }finally{await f.cleanup();}
});

test('malformed started-terminal event cannot complete a message; contradictory terminal evidence is uncertain',async()=>{
  const f=fixture();try{
    const s=await ready(f),w=await run(f,'session.send',{sessionId:s.id,text:'same text'});
    emit(f,'turn/started',{threadId:s.threadId,turn:{id:'turn-1',status:'completed'}});await tick();assert.equal(deliveryStatus(saved(f,w.id)),'processing');
    emit(f,'turn/completed',{threadId:s.threadId,turn:{id:'turn-1',status:'completed'}});await tick();assert.equal(deliveryStatus(saved(f,w.id)),'completed');
    emit(f,'turn/completed',{threadId:s.threadId,turn:{id:'turn-1',status:'failed'}});await tick();assert.equal(deliveryStatus(saved(f,w.id)),'uncertain');
  }finally{await f.cleanup();}
});

test('read timeout reports incomplete coverage and a late read result cannot mutate evidence',async()=>{
  const f=fixture();try{
    const s=await ready(f);rejectStart(f);const w=await run(f,'session.send',{sessionId:s.id,text:'same text'}),rpc=f.backend.rpc.bind(f.backend);let finish:((value:any)=>void)|undefined;
    f.backend.rpc=async(method,params)=>method==='thread/items/list'?new Promise(resolve=>{finish=resolve;}):rpc(method,params);
    const receipt=f.connector.local(request('session.delivery',{sessionId:s.id,workId:w.id}));
    await waitFor(()=>Boolean(finish));await new Promise(resolve=>setTimeout(resolve,5100));await waitFor(()=>saved(f,receipt.id).status==='completed');
    assert.ok(f.store.state.outbox.some(o=>o.text.includes('DELIVERY_READ_TIMEOUT')));assert.equal(deliveryStatus(saved(f,w.id)),'accepted');
    finish!({data:[user(s.threadId,w.id)],nextCursor:null});await tick();assert.equal(deliveryStatus(saved(f,w.id)),'accepted');
  }finally{await f.cleanup();}
});

test('queue readback during pending add is not overwritten by conflicting later ack or late timeout',async()=>{
  for(const conflict of [true,false]){const f=fixture();try{
    const s=await ready(f),rpc=f.backend.rpc.bind(f.backend);let finish:((v:any)=>void)|undefined,reject:((e:any)=>void)|undefined;
    f.backend.rpc=async(method,params)=>{
      if(method==='thread/queue/add')return new Promise((res,rej)=>{finish=res;reject=rej;});
      if(method==='thread/queue/list')return{data:[{id:'readback-A',clientUserMessageId:receipt.id}],nextCursor:null};
      return rpc(method,params);
    };
    const receipt=f.connector.local(request('session.send',{sessionId:s.id,text:'same text'}));await waitFor(()=>Boolean(finish));
    await run(f,'session.delivery',{sessionId:s.id,workId:receipt.id});assert.equal(saved(f,receipt.id).messageDelivery?.admission,'accepted');
    if(conflict)finish!({queuedSubmission:{id:'ack-B',clientUserMessageId:receipt.id}});else reject!(new BackendError('RPC_OUTCOME_UNCERTAIN'));
    await waitFor(()=>saved(f,receipt.id).status==='uncertain');const d=saved(f,receipt.id).messageDelivery!;
    assert.equal(d.queuedSubmissionId,'readback-A');assert.equal(d.admission,'accepted');assert.equal(d.correlationConflict,conflict?true:undefined);
    assert.ok(!f.backend.calls.some(c=>c.method==='thread/queue/start'));
  }finally{await f.cleanup();}}
});

test('readback commit rechecks queue correlation against an ack received during revalidation',async()=>{
  const f=fixture();try{
    const s=await ready(f),rpc=f.backend.rpc.bind(f.backend);let finish:((v:any)=>void)|undefined,queryReads=0,refreshing=false;
    f.backend.rpc=async(method,params)=>{
      if(method==='thread/queue/add')return new Promise(res=>{finish=res;});
      if(method==='thread/queue/list')return{data:[{id:'readback-A',clientUserMessageId:receipt.id}],nextCursor:null};
      if(method==='thread/read'&&refreshing&&++queryReads===2){finish!({queuedSubmission:{id:'ack-B',clientUserMessageId:receipt.id}});await tick();}
      return rpc(method,params);
    };
    const receipt=f.connector.local(request('session.send',{sessionId:s.id,text:'same text'}));await waitFor(()=>Boolean(finish));refreshing=true;
    await run(f,'session.delivery',{sessionId:s.id,workId:receipt.id});const d=saved(f,receipt.id).messageDelivery!;
    assert.equal(d.queuedSubmissionId,'ack-B');assert.equal(d.correlationConflict,true);assert.equal(deliveryStatus(saved(f,receipt.id)),'uncertain');
  }finally{await f.cleanup();}
});

test('start rejection diagnostics coexist with correlated processing and completion without retry',async()=>{
  for(const status of ['processing','completed'] as const){const f=fixture();try{
    const s=await ready(f),rpc=f.backend.rpc.bind(f.backend);
    f.backend.rpc=async(method,params)=>{
      if(method==='thread/queue/start'){
        f.backend.calls.push({method,params});
        emit(f,'item/started',user(s.threadId,params.clientUserMessageId||f.store.state.work.at(-1)!.id));
        if(status==='completed')emit(f,'turn/completed',{threadId:s.threadId,turn:{id:'turn-matched',status:'completed'}});
        await tick();throw new BackendError('RPC_REJECTED',undefined,{rpcCode:-32600,classification:'QUEUE_ENTRY_NOT_FOUND'});
      }
      return rpc(method,params);
    };
    const w=await run(f,'session.send',{sessionId:s.id,text:'same text'});
    assert.equal(w.messageDelivery?.admission,'accepted');assert.equal(w.messageDelivery?.start,'rejected');assert.equal(deliveryStatus(w),status);
    assert.deepEqual(w.messageDelivery?.startDiagnostic,{rpcCode:-32600,classification:'QUEUE_ENTRY_NOT_FOUND'});
    const text=compactResult(w,deliveryView(w));assert.match(text,new RegExp(`execution=${status}`));assert.match(text,/Explicit start request: RPC_REJECTED \(JSON-RPC -32600; reason=QUEUE_ENTRY_NOT_FOUND\)/);
    assert.match(text,/Start result and execution evidence are independent/);
    assert.equal(f.backend.calls.filter(c=>c.method==='thread/queue/add').length,1);assert.equal(f.backend.calls.filter(c=>c.method==='thread/queue/start').length,1);
    assert.ok(!f.backend.calls.some(c=>['turn/start','turn/steer'].includes(c.method)));
  }finally{await f.cleanup();}}
});

test('unmatched busy rejection preserves unknown execution and no automatic resend or start',async()=>{
  const f=fixture();try{
    const s=await ready(f),rpc=f.backend.rpc.bind(f.backend);
    f.backend.rpc=async(method,params)=>{if(method==='thread/queue/start'){f.backend.calls.push({method,params});throw new BackendError('RPC_REJECTED',undefined,{rpcCode:-32600,classification:'THREAD_BUSY'});}return rpc(method,params);};
    const w=await run(f,'session.send',{sessionId:s.id,text:'same text'});
    assert.equal(deliveryStatus(w),'accepted');assert.equal(w.messageDelivery?.execution,'unknown');assert.equal(w.messageDelivery?.startDiagnostic?.classification,'THREAD_BUSY');
    await run(f,'session.delivery',{sessionId:s.id,workId:w.id,refresh:false});
    assert.equal(f.backend.calls.filter(c=>c.method==='thread/queue/add').length,1);assert.equal(f.backend.calls.filter(c=>c.method==='thread/queue/start').length,1);
  }finally{await f.cleanup();}
});

test('admission rejection retains diagnostics but remains conservative about side effects',async()=>{
  const f=fixture();try{
    const s=await ready(f),rpc=f.backend.rpc.bind(f.backend);
    f.backend.rpc=async(method,params)=>{if(method==='thread/queue/add')throw new BackendError('RPC_REJECTED',undefined,{rpcCode:-32603,classification:'INTERNAL_ERROR'});return rpc(method,params);};
    const w=await run(f,'session.send',{sessionId:s.id,text:'same text'});
    assert.equal(w.status,'uncertain');assert.equal(deliveryStatus(w),'uncertain');assert.equal(w.messageDelivery?.start,'not-requested');assert.equal(w.messageDelivery?.admissionDiagnostic?.rpcCode,-32603);
    assert.ok(f.store.state.outbox.some(o=>o.text.includes('Admission request: RPC_REJECTED (JSON-RPC -32603; reason=INTERNAL_ERROR)')));
    assert.ok(!f.backend.calls.some(c=>c.method==='thread/queue/start'));
  }finally{await f.cleanup();}
});

test('diagnostics survive restart without losing code or classification',async()=>{
  const f=fixture();try{
    const s=await ready(f);rejectStart(f);const old=await run(f,'session.send',{sessionId:s.id,text:'old'});
    f.store.transaction(state=>{const d=state.work.find(w=>w.id===old.id)!.messageDelivery!;d.startDiagnostic={rpcCode:-32600,classification:'QUEUE_ENTRY_NOT_FOUND'};});
    f.store.close();const store=new Store(f.dir);try{assert.deepEqual(store.state.work.find(w=>w.id===old.id)!.messageDelivery?.startDiagnostic,{rpcCode:-32600,classification:'QUEUE_ENTRY_NOT_FOUND'});}finally{store.close();}
  }finally{await f.cleanup();}
});

test('old records stay valid; corrupted diagnostic fields fail closed at the persistence boundary',async()=>{
  const f=fixture();try{
    const s=await ready(f);rejectStart(f);const w=await run(f,'session.send',{sessionId:s.id,text:'old'});
    assert.doesNotThrow(()=>validateMessageDelivery(w));assert.equal(w.messageDelivery?.startDiagnostic,undefined);
    assert.match(compactResult(w,deliveryView(w)),/RPC details unavailable/);
    for(const diagnostic of [{rpcCode:-32600,classification:'QUEUE_ENTRY_NOT_FOUND',raw:'private'}, {rpcCode:-32600,classification:'guessed-consumed'}, {rpcCode:0.1,classification:'UNCLASSIFIED'}]){
      const copy=structuredClone(w);copy.messageDelivery!.startDiagnostic=diagnostic as any;assert.throws(()=>validateMessageDelivery(copy),/INVALID_MESSAGE_DELIVERY_STATE/);
    }
    const copy=structuredClone(w);copy.messageDelivery!.startDiagnostic={rpcCode:-32600,classification:'THREAD_BUSY'};delete copy.messageDelivery!.startError;assert.throws(()=>validateMessageDelivery(copy),/INVALID_MESSAGE_DELIVERY_STATE/);
  }finally{await f.cleanup();}
});

test('explicit resume keeps selected-entry start when execution is unknown',async()=>{
  const f=fixture();try{
    const s=await ready(f);f.backend.threads.get(s.threadId).status={type:'idle',activeFlags:[]};
    const w=await run(f,'session.queue',{sessionId:s.id,text:'resume requested',resume:true});
    assert.equal(w.messageDelivery?.start,'accepted');assert.equal(deliveryStatus(w),'processing');assert.equal(w.messageDelivery?.startDiagnostic,undefined);
    assert.equal(f.backend.calls.filter(c=>c.method==='thread/queue/start').length,1);
    assert.equal(f.backend.calls.find(c=>c.method==='thread/queue/start')!.params.queuedSubmissionId,w.messageDelivery?.queuedSubmissionId);
  }finally{await f.cleanup();}
});
