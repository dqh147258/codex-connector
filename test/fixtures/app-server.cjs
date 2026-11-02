// Local-only shared app-server protocol fixture. NOT Codex. No network or models.
const { Server } = require('node:http');
const { Duplex } = require('node:stream');
const { WebSocketServer } = require('ws');
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
const record = value => { if (process.env.CONNECTOR_FIXTURE_LOG) appendFileSync(process.env.CONNECTOR_FIXTURE_LOG, JSON.stringify(value) + '\n'); };
record({ kind: 'launch', args, credentialPresent: ['SLACK_APP_TOKEN', 'SLACK_BOT_TOKEN', 'CONNECTOR_TOKEN'].some(key => !!process.env[key]) });
if (args.length === 1 && args[0] === '--version') {
  process.stdout.write('codex-cli ' + (process.env.CONNECTOR_FIXTURE_VERSION || '0.166.0-alpha.1') + '\n');
  process.exit(0);
}
if(args.join(' ')==='app-server daemon start'){if(process.env.CONNECTOR_FIXTURE_DAEMON_FAIL)process.exit(40);if(process.env.CONNECTOR_FIXTURE_DAEMON_DELAY){setTimeout(()=>{process.stdout.write('started-or-already-running\n');process.exit(0);},200);return;}process.stdout.write('started-or-already-running\n');process.exit(0);}
if (args[0] !== 'app-server' || args[1] !== 'proxy' || (args.length !== 2 && !(args.length === 4 && args[2] === '--sock'))) process.exit(91);
if (process.env.SLACK_APP_TOKEN || process.env.SLACK_BOT_TOKEN || process.env.CONNECTOR_TOKEN) process.exit(92);
let socket;
const reply = value => socket.send(JSON.stringify(value));
const forbidden = ['sandbox', 'sandboxPolicy', 'approvalPolicy', 'permissions', 'config', 'model', 'effort'];
let initialized = false, turnSequence = 0;
const message = line => {
  let m; try { m = JSON.parse(line); } catch { process.exit(93); }
  record({ kind: 'message', value: m });
  if (m.jsonrpc) process.exit(94);
  if (m.method === 'initialize') {
    if (m.params?.capabilities?.experimentalApi !== true || m.params?.clientInfo?.name !== 'codex_connector') process.exit(95);
    reply({ id: m.id, result: { userAgent: 'local-fixture' } }); return;
  }
  if (m.method === 'initialized') { initialized = true; return; }
  if (!initialized) process.exit(96);
  if (m.id !== undefined && !m.method) { reply({ method: 'fixture/responseAccepted', params: { requestId: m.id, result: m.result } }); return; }
  if (forbidden.some(key => Object.hasOwn(m.params || {}, key))) process.exit(97);
  if (m.params?.threadId === 'fixture-timeout') return;
  if (m.params?.threadId === 'fixture-exit') process.exit(23);
  if (m.params?.threadId === 'fixture-malformed') { socket.send('not-json'); return; }
  if (m.params?.threadId === 'fixture-binary') { socket.send(Buffer.from('{}')); return; }
  if (m.params?.threadId === 'fixture-oversized') { socket.send(' '.repeat(8 * 1024 * 1024 + 1)); return; }
  if (m.params?.threadId === 'fixture-fragmented') {
    const response = JSON.stringify({ id:m.id, result:{ thread:{ id:'fragmented-thread' } } });
    socket.send(response.slice(0,10),{fin:false});socket.ping('fixture');socket.send(response.slice(10),{fin:true});return;
  }
  if (m.params?.threadId === 'fixture-missing-result') { reply({ id: m.id }); return; }
  if (m.params?.threadId === 'fixture-both-result-error') { reply({ id: m.id, result: {}, error: { code: -32603, message: 'conflicting outcome' } }); return; }
  if (m.params?.threadId === 'fixture-invalid-id') { reply({ id: { invalid: m.id }, result: {} }); return; }
  if (m.params?.threadId === 'fixture-null-id') { reply({ id: null, result: {} }); return; }
  if (m.params?.threadId === 'fixture-fractional-id') { reply({ id: 1.5, result: {} }); return; }
  if (m.params?.threadId === 'fixture-null-error') { reply({ id: m.id, error: null }); return; }
  if (m.params?.threadId === 'fixture-malformed-error') { reply({ id: m.id, error: { code: 'not-a-number', message: 'invalid code' } }); return; }
  if (m.method === 'thread/list') { reply({ id: m.id, result: { data: [{ id: 'shared-thread-1', cwd: '/fixture/project', status: { type: 'idle' } }], nextCursor: null } }); return; }
  if (m.method === 'thread/loaded/list') { reply({ id: m.id, result: { data: ['shared-thread-1'], nextCursor: null } }); return; }
  if (['thread/start', 'thread/read', 'thread/resume'].includes(m.method)) { reply({ id: m.id, result: { thread: { id: m.params.threadId || 'created-thread', cwd: m.params.cwd || '/fixture/project', status: { type: 'idle' } } } }); return; }
  if (['thread/turns/list', 'thread/items/list'].includes(m.method)) { reply({ id: m.id, result: { data: [], nextCursor: null } }); return; }
  if (m.method === 'thread/queue/add' || m.method === 'thread/queue/start') { reply({ id: m.id, error: { code: -32601, message: 'Fixture does not support this capability' } }); return; }
  if (m.method === 'turn/start') {
    const threadId = m.params.threadId, turnId = `turn-${++turnSequence}`, text = m.params.input?.[0]?.text || '';
    reply({ id: m.id, result: { turn: { id: turnId, status: 'inProgress' } } });
    if (text === '[approval]') { reply({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: 'item-1', command: 'fixture-command', availableDecisions: ['accept', 'decline', 'cancel'] } }); return; }
    if (text === '[input]') { reply({ id: 42, method: 'item/tool/requestUserInput', params: { threadId, turnId, itemId: 'item-2', questions: [{ id: 'question-1', header: 'Choice', question: 'Choose one', isOther: false, options: [{ label: 'A', description: 'Option A' }] }] } }); return; }
    reply({ method: 'item/completed', params: { threadId, turnId, item: { id: 'answer-1', type: 'agentMessage', phase: 'final_answer', text: 'fixture answer' } } });
    reply({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } }); return;
  }
  if (m.method === 'turn/steer' || m.method === 'turn/interrupt') { reply({ id: m.id, result: {} }); return; }
  reply({ id: m.id, error: { code: -32601, message: 'Unknown fixture method' } });
};
// The real CLI proxy tunnels the WebSocket HTTP upgrade and frames over stdio.
// No TCP listener is needed for this fixture.
const server = new Server();
const wss = new WebSocketServer({ noServer:true, perMessageDeflate:false });
server.on('upgrade',(request,stream,head)=>{
  record({kind:'upgrade',host:request.headers.host,upgrade:request.headers.upgrade});
  if(args[3]==='/fixture/reject-upgrade') { stream.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');return; }
  wss.handleUpgrade(request,stream,head,connection=>{
    socket=connection;
    socket.on('message',(data,isBinary)=>{if(isBinary)process.exit(98);message(data.toString());});
    socket.on('error',()=>process.exit(99));
    socket.on('close',()=>{record({kind:'proxyClosed'});process.exit(0);});
  });
});
server.emit('connection',Duplex.from({readable:process.stdin,writable:process.stdout}));
