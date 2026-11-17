import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,event,request,waitFor,ready } from './helpers.js';
async function invoke(f:ReturnType<typeof fixture>,command:string,params:any={},patch:any={}){const r=request(command,params);f.connector.accept(event(r,{thread_ts:'200.1',...patch}));f.connector.pump();await waitFor(()=>['completed','failed','uncertain'].includes(f.store.state.work.find(w=>w.request.id===r.id)?.status||''));return f.store.state.work.find(w=>w.request.id===r.id)!;}
const report=(f:ReturnType<typeof fixture>,id:string,phase='commentary',threadId='observed')=>f.backend.emit('notification','item/completed',{threadId,turnId:'turn-1',item:{id,type:'agentMessage',phase,text:'Progress '+id}},f.backend.epoch);

test('unbound observation relays completed phase/final/status only and never creates control binding or turns',async()=>{const f=fixture();try{await f.connector.initialize();f.backend.threads.set('observed',{id:'observed',cwd:f.dir,canAcceptDirectInput:false,status:{type:'active'}});const w=await invoke(f,'session.subscribe',{threadId:'observed'});assert.equal(w.status,'completed');const sub=f.store.state.subscriptions![0]!;assert.equal(f.store.state.sessions.length,0);for(const phase of ['commentary','partial_answer','final_answer'])report(f,phase,phase);report(f,'commentary');f.backend.emit('notification','item/agentMessage/delta',{threadId:'observed',delta:'MUST_NOT_RELAY'},f.backend.epoch);f.backend.emit('notification','item/completed',{threadId:'observed',turnId:'turn-1',item:{id:'reasoning',type:'reasoning',text:'MUST_NOT_RELAY'}},f.backend.epoch);f.backend.emit('notification','turn/completed',{threadId:'observed',turn:{id:'turn-1',status:'completed'}},f.backend.epoch);await waitFor(()=>f.store.state.outbox.filter(o=>o.subscriptionId===sub.id).length===4);assert.ok(f.store.state.outbox.filter(o=>o.subscriptionId===sub.id).every(o=>o.channel==='CIN'&&o.threadTs==='200.1'));assert.ok(!JSON.stringify(f.store.state.outbox).includes('MUST_NOT_RELAY'));assert.ok(f.backend.calls.every(c=>['thread/read','thread/loaded/list','thread/resume'].includes(c.method)));assert.equal(f.backend.responses.length,0);}finally{await f.cleanup();}});

test('observer receives only fixed decision notice, no RPC response or approval authority',async()=>{const f=fixture();try{await f.connector.initialize();f.backend.threads.set('observed',{id:'observed',cwd:f.dir,status:{type:'active'}});await invoke(f,'session.subscribe',{threadId:'observed'});f.backend.emit('request',{id:33,epoch:f.backend.epoch,method:'item/commandExecution/requestApproval',params:{threadId:'observed',turnId:'turn-1',command:'PRIVATE_SCOPE',cwd:f.dir}});await waitFor(()=>f.store.state.outbox.some(o=>o.subscriptionId&&o.text.includes('decision/input')));assert.ok(!JSON.stringify(f.store.state.outbox).includes('PRIVATE_SCOPE'));assert.equal(f.store.state.pending.length,0);assert.equal(f.backend.responses.length,0);}finally{await f.cleanup();}});

test('cancel disables queued and future delivery with no legacy fallback at original binding',async()=>{const f=fixture();try{const s=await ready(f);await invoke(f,'session.subscribe',{threadId:s.threadId},{channel:'CIN',thread_ts:s.threadTs});const sub=f.store.state.subscriptions![0]!;assert.equal(sub.owner.channel,'CIN');await invoke(f,'session.unsubscribe',{subscriptionId:sub.id},{thread_ts:s.threadTs});const before=f.store.state.outbox.length;report(f,'cancelled','commentary',s.threadId);await new Promise(r=>setTimeout(r,20));assert.equal(f.store.state.outbox.length,before);assert.equal(f.backend.responses.length,0);assert.ok(!f.backend.calls.some(c=>['thread/unsubscribe','turn/interrupt'].includes(c.method)));}finally{await f.cleanup();}});

test('same-bound-thread explicit subscription cancel stops legacy finals and approval prompts',async()=>{const f=fixture();try{await f.connector.initialize();await invoke(f,'session.create',{project:'repo'});const s=f.store.state.sessions[0]!;await invoke(f,'session.subscribe',{threadId:s.threadId});const sub=f.store.state.subscriptions![0]!;await invoke(f,'session.unsubscribe',{subscriptionId:sub.id});const before=f.store.state.outbox.length;report(f,'aftercancel','final_answer',s.threadId);f.backend.emit('request',{id:34,epoch:f.backend.epoch,method:'item/commandExecution/requestApproval',params:{threadId:s.threadId,turnId:'turn-1',command:'echo hello',cwd:f.dir}});await waitFor(()=>f.store.state.pending.length===1);assert.equal(f.store.state.outbox.length,before);assert.equal(f.backend.responses.length,0);assert.equal(f.store.state.sessions.length,1);}finally{await f.cleanup();}});

test('cancel during pacing prevents queued post; another actor/thread cannot cancel',async()=>{const f=fixture();try{await f.connector.initialize();f.backend.threads.set('observed',{id:'observed',cwd:f.dir,status:{type:'active'}});await invoke(f,'session.subscribe',{threadId:'observed'});await waitFor(()=>f.store.state.outbox.every(o=>o.status==='sent'));const sub=f.store.state.subscriptions![0]!;assert.equal((await invoke(f,'session.unsubscribe',{subscriptionId:sub.id},{thread_ts:'201.1'})).status,'failed');await waitFor(()=>f.store.state.outbox.every(o=>o.status==='sent'));(f.connector as any).postIntervalMs=80;report(f,'unsent');await waitFor(()=>f.store.state.outbox.some(o=>o.subscriptionId&&o.status==='queued'));f.connector.subscriptions.cancel(sub.id,sub.owner);await new Promise(r=>setTimeout(r,120));assert.ok(!f.posts.some(p=>p.text.includes('Progress unsent')));assert.ok(f.store.state.outbox.some(o=>o.subscriptionId===sub.id&&o.status==='failed'));}finally{await f.cleanup();}});

test('subscription policy revocation and stale epoch suppress content; absolute file access never grants observation scope',async()=>{const f=fixture();try{await f.connector.initialize();f.config.filePolicy={allowAbsolutePaths:true};f.backend.threads.set('outside',{id:'outside',cwd:'/outside-scope',status:{type:'active'}});assert.equal((await invoke(f,'session.subscribe',{threadId:'outside'})).error,'SUBSCRIPTION_SCOPE_REVOKED');assert.equal(f.backend.calls.some(c=>c.method==='thread/resume'),false);f.backend.threads.set('observed',{id:'observed',cwd:f.dir,status:{type:'active'}});await invoke(f,'session.subscribe',{threadId:'observed'});const before=f.store.state.outbox.length;f.config.slack.trustedBots=[];report(f,'revoked');await new Promise(r=>setTimeout(r,10));assert.equal(f.store.state.outbox.length,before);}finally{await f.cleanup();}});

test('early reconnect event is not consumed; validated replay waits for join success and scope failure cancels it',async()=>{for(const scopeFails of [false,true]){const f=fixture();try{await f.connector.initialize();f.backend.threads.set('observed',{id:'observed',cwd:f.dir,status:{type:'active'}});await invoke(f,'session.subscribe',{threadId:'observed'});await waitFor(()=>f.store.state.outbox.every(o=>o.status==='sent'));f.backend.epoch='epoch-2';report(f,'replay');await new Promise(r=>setTimeout(r,10));assert.equal(f.store.state.seenNotifications['observed:turn-1:replay'],undefined);const original=f.backend.rpc.bind(f.backend);let release!:()=>void;const blocked=new Promise<void>(r=>{release=r;});f.backend.rpc=async(method,p)=>{if(method==='thread/resume'){report(f,'replay');await blocked;return{thread:{id:'observed',cwd:scopeFails?'/outside-scope':f.dir,status:{type:'active'}}};}return original(method,p);};const reconnect=f.connector.reconnect();await waitFor(()=>f.store.state.outbox.some(o=>o.subscriptionId&&o.text.includes('Progress replay')));f.connector.flush();await new Promise(r=>setTimeout(r,10));assert.equal(f.posts.some(p=>p.text.includes('Progress replay')),false);release();await reconnect;if(scopeFails){assert.equal(f.posts.some(p=>p.text.includes('Progress replay')),false);assert.ok(f.store.state.outbox.some(o=>o.subscriptionId&&o.status==='failed'));}else{await waitFor(()=>f.posts.some(p=>p.text.includes('Progress replay')));assert.equal(f.posts.filter(p=>p.text.includes('Progress replay')).length,1);}}finally{await f.cleanup();}}});

test('each existing subscriber receives reconnect replay after its own join, once per destination', async () => {
  const f = fixture();
  try {
    await f.connector.initialize();
    f.backend.threads.set('observed', { id: 'observed', cwd: f.dir, status: { type: 'active' } });
    await invoke(f, 'session.subscribe', { threadId: 'observed' });
    await invoke(f, 'session.subscribe', { threadId: 'observed' }, { thread_ts: '201.1' });
    f.backend.epoch = 'epoch-2';
    const rpc = f.backend.rpc.bind(f.backend);
    f.backend.rpc = async (method, params) => {
      if (method === 'thread/resume') {
        report(f, 'reconnect-question');
        f.backend.emit('notification', 'turn/completed', { threadId: 'observed', turn: { id: 'turn-1', status: 'completed' } }, f.backend.epoch);
        // Force the first replay through the event lane before the next join.
        await (f.connector as any).events;
      }
      return rpc(method, params);
    };
    await f.connector.reconnect();
    await (f.connector as any).events;
    for (const row of f.store.state.subscriptions!) {
      const messages = f.store.state.outbox.filter(o => o.subscriptionId === row.id);
      assert.equal(messages.filter(o => o.text.includes('Progress reconnect-question')).length, 1);
      assert.equal(messages.filter(o => o.text.includes('turn turn-1: completed')).length, 1);
    }
    report(f, 'reconnect-question');
    await (f.connector as any).events;
    assert.equal(f.store.state.outbox.filter(o => o.text.includes('Progress reconnect-question')).length, 2);
  } finally { await f.cleanup(); }
});

test('bound finals, failed turns and full input prompts recover on replay without crossing approval destinations', async () => {
  const f = fixture();
  try {
    await f.connector.initialize();
    await invoke(f, 'session.create', { project: 'repo' });
    const session = f.store.state.sessions[0]!;
    // Rejoin the observation-only destination first, then the bound destination.
    await invoke(f, 'session.subscribe', { threadId: session.threadId }, { thread_ts: '201.1' });
    await invoke(f, 'session.subscribe', { threadId: session.threadId });
    f.backend.epoch = 'epoch-2';
    const input = { id: 76, epoch: f.backend.epoch, method: 'item/tool/requestUserInput', params: {
      threadId: session.threadId, turnId: 'input-turn', questions: [{ id: 'choice', question: 'Which safe option?', isSecret: false, options: [{ label: 'A' }, { label: 'B' }] }] } };
    const replay = () => {
      report(f, 'final-question', 'final_answer', session.threadId);
      f.backend.emit('notification', 'turn/completed', { threadId: session.threadId, turn: { id: 'failed-turn', status: 'failed' } }, f.backend.epoch);
      f.backend.emit('request', input);
    };
    const rpc = f.backend.rpc.bind(f.backend);
    f.backend.rpc = async (method, params) => { if (method === 'thread/resume') { replay(); await (f.connector as any).events; } return rpc(method, params); };
    await f.connector.reconnect();
    replay(); await (f.connector as any).events;
    const [observer, bound] = f.store.state.subscriptions!;
    const observerText = f.store.state.outbox.filter(o => o.subscriptionId === observer!.id).map(o => o.text);
    const boundText = f.store.state.outbox.filter(o => o.subscriptionId === bound!.id).map(o => o.text);
    assert.equal(observerText.filter(t => t.includes('final-question')).length, 1);
    assert.equal(boundText.filter(t => t.includes('final-question')).length, 1);
    assert.equal(observerText.filter(t => t.includes('failed-turn')).length, 1);
    assert.equal(boundText.filter(t => t.includes('failed-turn')).length, 1);
    assert.equal(observerText.filter(t => t.includes('decision/input required')).length, 1);
    assert.equal(observerText.some(t => t.includes('Which safe option?') || t.includes('input.respond')), false);
    assert.equal(boundText.filter(t => t.includes('Which safe option?')).length, 1);
    assert.ok(boundText.some(t => t.includes('input.respond') && t.includes('CODEX_CONNECTOR')));
    assert.equal(f.store.state.pending.length, 1);
    assert.equal(f.backend.responses.length, 0);
  } finally { await f.cleanup(); }
});

test('attach receipt distinguishes the control binding from opt-in observation and creates no subscription', async () => {
  const f = fixture();
  try {
    await f.connector.initialize();
    f.backend.threads.set('observed', { id: 'observed', cwd: f.dir, status: { type: 'active' } });
    assert.equal((await invoke(f, 'session.attach', { threadId: 'observed' })).status, 'completed');
    assert.equal(f.store.state.subscriptions?.length || 0, 0);
    assert.ok(f.store.state.outbox.some(o => o.text.includes('does NOT subscribe') && o.text.includes('session.subscribe {"threadId":"observed"}')));
    report(f, 'ordinary-question'); await (f.connector as any).events;
    assert.ok(!f.store.state.outbox.some(o => o.text.includes('ordinary-question')));
  } finally { await f.cleanup(); }
});

test('input replay uses saved safe details and never revives closed, cancelled or sensitive prompts', async () => {
  for (const mode of ['safe', 'secret', 'resolved', 'expired', 'cancelled', 'revoked']) {
    const f = fixture();
    try {
      await f.connector.initialize(); await invoke(f, 'session.create', { project: 'repo' });
      const session = f.store.state.sessions[0]!;
      await invoke(f, 'session.subscribe', { threadId: session.threadId });
      const sub = f.store.state.subscriptions![0]!;
      f.backend.epoch = 'epoch-2';
      const input = { id: 77, epoch: f.backend.epoch, method: 'item/tool/requestUserInput', params: {
        threadId: session.threadId, turnId: 'input-turn', questions: [{ id: 'q', question: 'ORIGINAL_QUESTION', isSecret: mode === 'secret' }] } };
      f.backend.emit('request', input); await (f.connector as any).events;
      assert.equal(f.store.state.pending.length, 1);
      assert.equal(f.store.state.outbox.some(o => o.subscriptionId === sub.id), false);
      if (mode === 'resolved' || mode === 'expired') f.store.transaction(s => { if (mode === 'resolved') s.pending[0]!.status = 'resolved'; else s.pending[0]!.expiresAt = 0; });
      if (mode === 'cancelled') f.connector.subscriptions.cancel(sub.id, sub.owner);
      if (mode === 'revoked') f.config.slack.trustedBots = [];
      await f.connector.reconnect();
      const replay = structuredClone(input); replay.params.questions[0]!.question = 'REWRITTEN_REPLAY_QUESTION';
      f.backend.emit('request', replay); await (f.connector as any).events;
      const texts = f.store.state.outbox.filter(o => o.subscriptionId === sub.id).map(o => o.text).join('\n');
      assert.equal(texts.includes('REWRITTEN_REPLAY_QUESTION'), false);
      if (mode === 'safe') assert.ok(texts.includes('ORIGINAL_QUESTION') && texts.includes('input.respond'));
      else if (mode === 'secret') { assert.ok(texts.includes('LOCAL_ACTION_REQUIRED')); assert.equal(JSON.stringify(f.store.state).includes('ORIGINAL_QUESTION'), false); }
      else assert.equal(texts, '');
      assert.equal(f.backend.responses.length, 0);
    } finally { await f.cleanup(); }
  }
});

for (const secret of [false, true]) for (const terminal of ['resolved', 'completed', 'expired', 'responding']) {
  test(`${secret ? 'local-required' : 'ordinary'} request replay after ${terminal} cannot notify late-joining bound or observation destinations`, async () => {
    const f = fixture();
    try {
      await f.connector.initialize(); await invoke(f, 'session.create', { project: 'repo' });
      const session = f.store.state.sessions[0]!;
      await invoke(f, 'session.subscribe', { threadId: session.threadId });
      await invoke(f, 'session.subscribe', { threadId: session.threadId }, { thread_ts: '201.1' });
      f.backend.epoch = 'epoch-2';
      const input = { id: 78, epoch: f.backend.epoch, method: 'item/tool/requestUserInput', params: {
        threadId: session.threadId, turnId: 'input-turn', questions: [{ id: 'q', question: 'ORIGINAL_QUESTION', isSecret: secret }] } };
      f.backend.emit('request', input); await (f.connector as any).events;
      assert.equal(f.store.state.pending[0]!.status, secret ? 'local-required' : 'pending');
      assert.equal(f.store.state.outbox.some(o => o.subscriptionId), false);
      if (terminal === 'resolved') f.backend.emit('notification', 'serverRequest/resolved', { requestId: input.id }, f.backend.epoch);
      else if (terminal === 'completed') f.backend.emit('notification', 'turn/completed', { threadId: session.threadId, turn: { id: 'input-turn', status: 'completed' } }, f.backend.epoch);
      else f.store.transaction(s => { if (terminal === 'expired') s.pending[0]!.expiresAt = 0; else s.pending[0]!.status = 'responding'; });
      await (f.connector as any).events;
      await f.connector.reconnect();
      f.backend.emit('request', input); await (f.connector as any).events;
      const notices = f.store.state.outbox.filter(o => o.subscriptionId && /LOCAL_ACTION_REQUIRED|ORIGINAL_QUESTION|decision\/input required/.test(o.text));
      assert.deepEqual(notices, []);
      if (terminal === 'resolved' || terminal === 'completed') assert.equal(f.store.state.pending[0]!.status, terminal === 'resolved' ? 'resolved' : 'stale');
      assert.equal(f.backend.responses.length, 0);
    } finally { await f.cleanup(); }
  });
}
