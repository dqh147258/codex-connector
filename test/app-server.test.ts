import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { BackendError, SharedAppServer, codexLaunch } from '../src/codex.js';
const fixtureExecutable = resolve('test/fixtures/app-server.cjs');
const errorCode = (code: string) => (error: unknown) => error instanceof BackendError && error.code === code;
function setup(options: { timeout?: number; socketPath?: string; expectedVersion?: string; version?: string; autoStartDaemon?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'shared-proxy-test-')), log = join(dir, 'wire.jsonl');
  const oldLog = process.env.CONNECTOR_FIXTURE_LOG, oldVersion = process.env.CONNECTOR_FIXTURE_VERSION;
  process.env.CONNECTOR_FIXTURE_LOG = log;
  if (options.version !== undefined) process.env.CONNECTOR_FIXTURE_VERSION = options.version; else delete process.env.CONNECTOR_FIXTURE_VERSION;
  const server = new SharedAppServer({ executable: fixtureExecutable, socketPath: options.socketPath, expectedVersion: options.expectedVersion, autoStartDaemon: options.autoStartDaemon }, options.timeout || 2000);
  const readLog = (): any[] => { try { return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };
  const close = async () => {
    try { await server.close(); } finally {
      if (oldLog === undefined) delete process.env.CONNECTOR_FIXTURE_LOG; else process.env.CONNECTOR_FIXTURE_LOG = oldLog;
      if (oldVersion === undefined) delete process.env.CONNECTOR_FIXTURE_VERSION; else process.env.CONNECTOR_FIXTURE_VERSION = oldVersion;
      rmSync(dir, { recursive: true, force: true });
    }
  };
  return { server, readLog, close };
}
test('shared proxy version/initialize handshake, fixed transport, optional socket and policy inheritance', async () => {
  const f = setup({ socketPath: '/fixture/explicit-control.sock', expectedVersion: '0.166.0-alpha.1' });
  try {
    await Promise.all([f.server.connect(), f.server.connect()]);
    assert.equal(f.server.connected, true); assert.ok(f.server.epoch);
    const caps = f.server.capabilities(); assert.equal(caps.transport, 'shared-daemon-proxy'); assert.equal(caps.policyOverrides, false); assert.equal(caps.arbitraryRpc, false);
    assert.equal((await f.server.rpc('thread/list', { limit: 10 })).data[0].id, 'shared-thread-1');
    assert.equal((await f.server.rpc('thread/loaded/list', {})).data[0], 'shared-thread-1');
    assert.equal((await f.server.rpc('thread/read', { threadId: 'shared-thread-1' })).thread.id, 'shared-thread-1');
    assert.equal((await f.server.rpc('thread/resume', { threadId: 'shared-thread-1', cwd: '/fixture/project', excludeTurns: true })).thread.id, 'shared-thread-1');
    assert.equal((await f.server.rpc('thread/start', { cwd: '/fixture/project' })).thread.id, 'created-thread');
    assert.deepEqual((await f.server.rpc('thread/turns/list', { threadId: 'shared-thread-1', limit: 10 })).data, []);
    const launches = f.readLog().filter(x => x.kind === 'launch'); assert.equal(launches.length, 2);
    assert.deepEqual(launches[0].args, ['--version']); assert.deepEqual(launches[1].args, ['app-server', 'proxy', '--sock', '/fixture/explicit-control.sock']);
    assert.ok(f.readLog().filter(x => x.kind === 'message').every(x => !Object.keys(x.value.params || {}).some(k => ['sandbox', 'sandboxPolicy', 'approvalPolicy', 'permissions', 'model', 'effort'].includes(k))));
  } finally { await f.close(); }
});
test('omitted expectedVersion accepts a different reported version and keeps diagnostics', async () => {
  const f = setup({ version: '9.8.7-preview.2' });
  try {
    await f.server.connect();
    assert.equal(f.server.connected, true);
    assert.equal(f.server.capabilities().version, '9.8.7-preview.2');
    assert.equal(f.server.capabilities().expectedVersion, null);
    assert.deepEqual(f.readLog().filter(x => x.kind === 'launch').map(x => x.args), [['--version'], ['app-server', 'proxy']]);
  } finally { await f.close(); }
});
test('version mismatch fails before proxy launch and never falls back to standalone app-server', async () => {
  const f = setup({ expectedVersion: 'different-version' });
  try {
    await assert.rejects(f.server.connect(), errorCode('VERSION_MISMATCH'));
    assert.equal(f.server.connected, false); assert.equal(f.server.capabilities().lastFailure, 'VERSION_MISMATCH');
    assert.deepEqual(f.readLog().filter(x => x.kind === 'launch').map(x => x.args), [['--version']]);
  } finally { await f.close(); }
});
test('RPC allowlist blocks shell/arbitrary methods without writing, and unsupported capability is negatively cached', async () => {
  const f = setup();
  try {
    await f.server.connect();
    for (const method of ['exec', 'shell', 'config/write', 'account/login/start', 'daemon/stop']) await assert.rejects(f.server.rpc(method, {}), errorCode('RPC_FORBIDDEN'));
    for (let i = 0; i < 2; i++) await assert.rejects(f.server.rpc('thread/queue/add', { threadId: 'shared-thread-1', input: [] }), errorCode('METHOD_UNSUPPORTED'));
    assert.ok((f.server.capabilities().unsupportedMethods as string[]).includes('thread/queue/add'));
    const calls = f.readLog().filter(x => x.kind === 'message').map(x => x.value.method);
    assert.equal(calls.filter(x => x === 'thread/queue/add').length, 1, 'known unsupported methods should not repeatedly hit the daemon');
    assert.ok(!calls.some(x => ['exec', 'shell', 'config/write', 'account/login/start', 'daemon/stop'].includes(x)));
  } finally { await f.close(); }
});
test('request timeout is uncertain and is never automatically resent', async () => {
  const f = setup({ timeout: 1000 });
  try {
    await f.server.connect();
    await assert.rejects(f.server.rpc('thread/read', { threadId: 'fixture-timeout' }), errorCode('RPC_OUTCOME_UNCERTAIN'));
    assert.equal(f.readLog().filter(x => x.kind === 'message' && x.value.params?.threadId === 'fixture-timeout').length, 1);
  } finally { await f.close(); }
});
test('proxy exit rejects in-flight work, emits old epoch, and reconnects with fresh epoch', async () => {
  const f = setup();
  try {
    await f.server.connect(); const oldEpoch = f.server.epoch;
    const oldChild = (f.server as unknown as { child: ChildProcessWithoutNullStreams }).child;
    const disconnected = once(f.server, 'disconnect');
    await assert.rejects(f.server.rpc('thread/read', { threadId: 'fixture-exit' }), errorCode('RPC_OUTCOME_UNCERTAIN'));
    assert.equal((await disconnected)[0], oldEpoch); assert.equal(f.server.connected, false);
    await f.server.connect(); assert.notEqual(f.server.epoch, oldEpoch); assert.equal(f.server.connected, true);
    // Delayed events from the old fake process must not mutate the new connection.
    oldChild.emit('close', 23); oldChild.emit('error', Error('delayed old-child error'));
    assert.equal(f.server.connected, true);
    assert.equal((await f.server.rpc('thread/read', { threadId: 'shared-thread-1' })).thread.id, 'shared-thread-1');
    assert.ok(f.readLog().filter(x => x.kind === 'launch' && x.args[0] === 'app-server').every(x => x.args[1] === 'proxy'));
  } finally { await f.close(); }
});
test('malformed proxy output fails closed rather than executing or falling back', async () => {
  const f = setup();
  try {
    await f.server.connect(); await assert.rejects(f.server.rpc('thread/read', { threadId: 'fixture-malformed' }), errorCode('RPC_OUTCOME_UNCERTAIN'));
    assert.equal(f.server.connected, false);
    assert.ok(f.readLog().filter(x => x.kind === 'launch' && x.args[0] === 'app-server').every(x => x.args[1] === 'proxy'));
  } finally { await f.close(); }
});
test('notifications and approval/input requests preserve session/turn/epoch, never auto-answer', async () => {
  const f = setup(); const requests: any[] = [], notifications: any[] = [];
  f.server.on('request', request => { requests.push(request); });
  f.server.on('notification', (method, params, epoch) => { notifications.push({ method, params, epoch }); });
  try {
    await f.server.connect();
    const approvalEvent = once(f.server, 'request');
    await f.server.rpc('turn/start', { threadId: 'shared-thread-1', input: [{ type: 'text', text: '[approval]' }] }); await approvalEvent;
    assert.equal(requests[0].epoch, f.server.epoch); assert.equal(requests[0].method, 'item/commandExecution/requestApproval'); assert.equal(requests[0].params.threadId, 'shared-thread-1'); assert.equal(requests[0].params.turnId, 'turn-1');
    assert.equal(f.readLog().filter(x => x.kind === 'message' && x.value.id === 'approval-1' && !x.value.method).length, 0);
    const answered = once(f.server, 'notification'); await f.server.respond('approval-1', { decision: 'decline' }); await answered;
    assert.equal(notifications.at(-1).params.result.decision, 'decline');
    const inputEvent = once(f.server, 'request'); await f.server.rpc('turn/start', { threadId: 'shared-thread-1', input: [{ type: 'text', text: '[input]' }] }); await inputEvent;
    assert.equal(requests[1].id, 42); assert.equal(requests[1].method, 'item/tool/requestUserInput'); assert.equal(requests[1].params.turnId, 'turn-2');
    const finalEvent = once(f.server, 'notification'); await f.server.rpc('turn/start', { threadId: 'shared-thread-1', input: [{ type: 'text', text: 'normal' }] }); await finalEvent;
    assert.ok(notifications.some(x => x.method === 'item/completed' && x.params.item.text === 'fixture answer' && x.epoch === f.server.epoch));
  } finally { await f.close(); }
});
test('close only ends owned proxy and prevents reconnect; no shared daemon stop or turn interruption', async () => {
  const f = setup();
  try {
    await f.server.connect(); await f.server.close();
    assert.equal(f.server.connected, false); await assert.rejects(f.server.connect(), errorCode('BACKEND_STOPPED'));
    const calls = f.readLog(); assert.ok(calls.some(x => x.kind === 'proxyClosed'));
    assert.ok(!calls.some(x => x.kind === 'launch' && x.args.includes('daemon')));
    assert.ok(!calls.some(x => x.kind === 'message' && x.value.method === 'turn/interrupt'));
  } finally { await f.close(); }
});
test('version probe and proxy omit Slack/API credentials from child environment', async () => {
  const keys = ['SLACK_APP_TOKEN', 'SLACK_BOT_TOKEN', 'CONNECTOR_TOKEN'] as const, previous = keys.map(key => process.env[key]);
  keys.forEach(key => { process.env[key] = 'dummy-test-only'; }); const f = setup();
  try { await f.server.connect(); assert.ok(f.readLog().filter(x => x.kind === 'launch').every(x => x.credentialPresent === false)); }
  finally { await f.close(); keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }); }
});
test('cross-platform executable resolution uses Node/native arguments without shell shims', () => {
  assert.deepEqual(codexLaunch('/usr/local/bin/codex', ['app-server', 'proxy']), { file: '/usr/local/bin/codex', args: ['app-server', 'proxy'] });
  assert.deepEqual(codexLaunch('C:\\Program Files\\Codex\\codex.js', ['app-server', 'proxy']), { file: process.execPath, args: ['C:\\Program Files\\Codex\\codex.js', 'app-server', 'proxy'] });
  for (const path of ['C:\\npm\\codex.cmd', 'C:\\npm\\codex.bat']) assert.throws(() => codexLaunch(path, []), errorCode('SHELL_SHIM_FORBIDDEN'));
});

test('invalid response envelopes disconnect and reject uncertain rather than resolve success', async () => {
  for (const threadId of ['fixture-missing-result', 'fixture-both-result-error', 'fixture-invalid-id', 'fixture-null-id', 'fixture-fractional-id', 'fixture-null-error', 'fixture-malformed-error']) {
    const f = setup();
    try {
      await f.server.connect(); const epoch = f.server.epoch; const disconnected = once(f.server, 'disconnect');
      await assert.rejects(f.server.rpc('thread/read', { threadId }), errorCode('RPC_OUTCOME_UNCERTAIN'), threadId);
      assert.equal((await disconnected)[0], epoch, threadId); assert.equal(f.server.connected, false, threadId);
      assert.equal(f.readLog().filter(x => x.kind === 'message' && x.value.params?.threadId === threadId).length, 1, 'invalid outcomes are never resent');
    } finally { await f.close(); }
  }
});
test('unsupported capability cache is re-probed once per fresh successful proxy epoch', async () => {
  const f = setup();
  try {
    await f.server.connect(); const epoch = f.server.epoch;
    await assert.rejects(f.server.rpc('thread/queue/add', { threadId: 'shared-thread-1', input: [] }), errorCode('METHOD_UNSUPPORTED'));
    assert.ok((f.server.capabilities().unsupportedMethods as string[]).includes('thread/queue/add'));
    await assert.rejects(f.server.rpc('thread/read', { threadId: 'fixture-exit' }), errorCode('RPC_OUTCOME_UNCERTAIN'));
    await f.server.connect(); assert.notEqual(f.server.epoch, epoch); assert.deepEqual(f.server.capabilities().unsupportedMethods, []);
    for (let i = 0; i < 2; i++) await assert.rejects(f.server.rpc('thread/queue/add', { threadId: 'shared-thread-1', input: [] }), errorCode('METHOD_UNSUPPORTED'));
    assert.equal(f.readLog().filter(x => x.kind === 'message' && x.value.method === 'thread/queue/add').length, 2, 'one capability probe is allowed in each successful epoch');
  } finally { await f.close(); }
});
test('explicit daemon autostart is fixed, version-gated, once-only, and never stop/update',async()=>{const f=setup({autoStartDaemon:true,expectedVersion:'0.166.0-alpha.1'});try{await f.server.connect();assert.deepEqual(f.readLog().filter(x=>x.kind==='launch').map(x=>x.args),[['--version'],['app-server','daemon','start'],['app-server','proxy']]);await assert.rejects(f.server.rpc('thread/read',{threadId:'fixture-exit'}));await f.server.connect();const launches=f.readLog().filter(x=>x.kind==='launch');assert.equal(launches.filter(x=>x.args.join(' ')==='app-server daemon start').length,1);assert.ok(!launches.some(x=>x.args.includes('stop')||x.args.includes('update')));assert.equal((f.server.capabilities().daemonStart as any).result,'started-or-already-running');}finally{await f.close();}});
test('daemon start failure is visible and not repeatedly retried; socket conflict fails closed',async()=>{const old=process.env.CONNECTOR_FIXTURE_DAEMON_FAIL;process.env.CONNECTOR_FIXTURE_DAEMON_FAIL='1';const f=setup({autoStartDaemon:true});try{await assert.rejects(f.server.connect(),errorCode('DAEMON_START_FAILED'));assert.equal(f.server.connected,false);await f.server.connect();assert.equal(f.readLog().filter(x=>x.kind==='launch'&&x.args.join(' ')==='app-server daemon start').length,1);}finally{await f.close();if(old===undefined)delete process.env.CONNECTOR_FIXTURE_DAEMON_FAIL;else process.env.CONNECTOR_FIXTURE_DAEMON_FAIL=old;}const conflict=setup({autoStartDaemon:true,socketPath:'/fixture/socket'});try{await assert.rejects(conflict.server.connect(),errorCode('DAEMON_START_SOCKET_CONFLICT'));assert.ok(!conflict.readLog().some(x=>x.kind==='launch'&&x.args.includes('daemon')));}finally{await conflict.close();}});
test('shutdown during optional daemon start cannot launch a proxy afterward',async()=>{const old=process.env.CONNECTOR_FIXTURE_DAEMON_DELAY;process.env.CONNECTOR_FIXTURE_DAEMON_DELAY='1';const f=setup({autoStartDaemon:true});try{const connecting=f.server.connect();connecting.catch(()=>{});for(let i=0;i<100&&!f.readLog().some(x=>x.kind==='launch'&&x.args.includes('daemon'));i++)await new Promise(r=>setTimeout(r,5));await f.server.close();await assert.rejects(connecting,errorCode('BACKEND_STOPPED'));assert.ok(!f.readLog().some(x=>x.kind==='launch'&&x.args.includes('proxy')));}finally{await f.close();if(old===undefined)delete process.env.CONNECTOR_FIXTURE_DAEMON_DELAY;else process.env.CONNECTOR_FIXTURE_DAEMON_DELAY=old;}});
