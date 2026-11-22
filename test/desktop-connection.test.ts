import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DesktopConnection } from '../desktop/connection.js';
import type { RuntimeSnapshot } from '../desktop/runtime.js';

function deferred<T = void>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(initial: RuntimeSnapshot = { state: 'running', owned: true }) {
  let state = initial, shutdown = false;
  const events: string[] = [];
  let stop: () => Promise<RuntimeSnapshot> = async () => { state = { state: 'stopped', owned: false }; return state; };
  let start: () => RuntimeSnapshot = () => { state = { state: 'starting', owned: true }; return state; };
  const runtime = { snapshot: () => state, stop: () => { events.push('stop'); return stop(); } };
  const connection = new DesktopConnection(runtime, () => { events.push('start'); return start(); }, () => shutdown);
  const prepare = () => { events.push('prepare'); return () => { events.push('commit'); }; };
  return { connection, runtime, events, prepare, setStop: (fn: typeof stop) => { stop = fn; }, setStart: (fn: typeof start) => { start = fn; }, state: (next: RuntimeSnapshot) => { state = next; }, quit: () => { shutdown = true; } };
}
test('connected save validates, confirms, stops, persists, and requests exactly one restart', async () => {
  const f = fixture();
  const result = await f.connection.save(f.prepare, async () => { f.events.push('confirm'); });
  assert.deepEqual(f.events, ['prepare', 'confirm', 'stop', 'commit', 'start']);
  assert.deepEqual(result, { saved: true, reconnect: 'starting' });
  assert.equal(f.connection.settingsBusy, false);
});
test('stopped, failed, and already stopping states never unexpectedly connect after save', async () => {
  for (const state of ['stopped', 'failed', 'stopping'] as const) for (const owned of [true, false]) {
    const f = fixture({ state, owned }); const result = await f.connection.save(f.prepare);
    assert.deepEqual(result, { saved: true, reconnect: 'not-needed' });
    assert.equal(f.events.includes('start'), false);
    assert.equal(f.events.includes('stop'), owned);
  }
});
test('a save during initial startup gracefully restarts instead of spawning concurrently', async () => {
  const f = fixture({ state: 'starting', owned: true });
  assert.equal((await f.connection.save(f.prepare)).reconnect, 'starting');
  assert.deepEqual(f.events, ['prepare', 'stop', 'commit', 'start']);
});
test('invalid input, secure-storage preparation failure and cancelled confirmation never interrupt connection', async () => {
  const f = fixture();
  await assert.rejects(f.connection.save(() => { throw Error('INVALID_CONFIGURATION'); }), /INVALID_CONFIGURATION/);
  await assert.rejects(f.connection.save(() => { throw Error('CREDENTIAL_SAVE_FAILED'); }), /CREDENTIAL_SAVE_FAILED/);
  await assert.rejects(f.connection.save(f.prepare, async () => { throw Error('CANCELLED'); }), /CANCELLED/);
  assert.deepEqual(f.events, ['prepare']); assert.equal(f.runtime.snapshot().state, 'running');
  assert.equal(f.connection.settingsBusy, false);
});
test('duplicate config/token saves and start are blocked throughout dialogs and shutdown wait', async () => {
  const f = fixture(), dialog = deferred(), stopped = deferred<RuntimeSnapshot>();
  f.setStop(() => stopped.promise);
  const saving = f.connection.save(f.prepare, () => dialog.promise);
  assert.equal(f.connection.settingsBusy, true);
  await assert.rejects(f.connection.save(f.prepare), /SETTINGS_BUSY/);
  assert.throws(() => f.connection.start(), /SETTINGS_BUSY/);
  dialog.resolve(); await Promise.resolve();
  await assert.rejects(f.connection.save(f.prepare), /SETTINGS_BUSY/);
  assert.throws(() => f.connection.start(), /SETTINGS_BUSY/);
  assert.deepEqual(f.events, ['prepare', 'stop']);
  f.state({ state: 'stopped', owned: false }); stopped.resolve(f.runtime.snapshot()); await saving;
  assert.deepEqual(f.events, ['prepare', 'stop', 'commit', 'start']);
});
test('manual stop during a native dialog saves afterward but cancels automatic reconnect', async () => {
  const f = fixture(), dialog = deferred();
  const saving = f.connection.save(f.prepare, () => dialog.promise);
  await f.connection.stop(); dialog.resolve();
  assert.deepEqual(await saving, { saved: true, reconnect: 'cancelled' });
  assert.deepEqual(f.events, ['prepare', 'stop', 'commit']);
});
test('manual stop while automatic stop is pending prevents a later restart', async () => {
  const f = fixture(), stopped = deferred<RuntimeSnapshot>();
  f.setStop(() => stopped.promise);
  const saving = f.connection.save(f.prepare); await Promise.resolve();
  const stopping = f.connection.stop();
  f.state({ state: 'stopped', owned: false }); stopped.resolve(f.runtime.snapshot());
  await stopping; assert.equal((await saving).reconnect, 'cancelled');
  assert.equal(f.events.includes('start'), false);
});
test('quit during a dialog or stop prevents persistence and reconnection', async () => {
  for (const phase of ['dialog', 'stop']) {
    const f = fixture(), gate = deferred();
    if (phase === 'stop') f.setStop(async () => { await gate.promise; f.state({ state: 'stopped', owned: false }); return f.runtime.snapshot(); });
    const saving = f.connection.save(f.prepare, phase === 'dialog' ? () => gate.promise : undefined);
    await Promise.resolve(); f.quit(); gate.resolve();
    await assert.rejects(saving, /CANCELLED/);
    assert.equal(f.events.includes('commit'), false); assert.equal(f.events.includes('start'), false);
    assert.throws(() => f.connection.start(), /CANCELLED/);
  }
});
test('unconfirmed stop cannot write settings or spawn another child, even if stop falsely resolves', async () => {
  for (const reject of [false, true]) {
    const f = fixture(); f.setStop(async () => { if (reject) throw Error('STOP_UNCONFIRMED'); return f.runtime.snapshot(); });
    await assert.rejects(f.connection.save(f.prepare), /STOP_UNCONFIRMED/);
    assert.deepEqual(f.events, ['prepare', 'stop']); assert.equal(f.connection.settingsBusy, false);
  }
});
test('write failure after stopping remains disconnected and reports a fixed non-secret error', async () => {
  const f = fixture();
  await assert.rejects(f.connection.save(() => () => { throw Error('xoxb-private-secret'); }), /^Error: SETTINGS_SAVE_FAILED_STOPPED$/);
  assert.deepEqual(f.events, ['stop']); assert.equal(f.runtime.snapshot().owned, false);
});
test('restart failure is distinguished from save failure and hides raw diagnostics', async () => {
  const f = fixture(); f.setStart(() => { throw Error('xoxb-private-secret /private/path'); });
  const result = await f.connection.save(f.prepare);
  assert.equal(result.saved, true); assert.equal(result.reconnect, 'failed');
  assert.equal(result.error?.code, 'DESKTOP_OPERATION_FAILED');
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.deepEqual(f.events, ['prepare', 'stop', 'commit', 'start']);
});

// Exercise the production settings/runtime boundary, not just the lifecycle port.
import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DesktopConfigDrafts, DesktopSettings } from '../desktop/settings.js';
import { DesktopRuntime } from '../desktop/runtime.js';
function integratedFixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'desktop-reconnect-')));
  const settings = new DesktopSettings(home, { isEncryptionAvailable: () => true, encryptString: value => Buffer.from([...Buffer.from(value)].map(x => x ^ 0x5a)), decryptString: bytes => Buffer.from([...bytes].map(x => x ^ 0x5a)).toString() });
  const config = settings.defaultConfig();
  config.slack = { teamId: 'TTEAM', inputChannel: 'CINPUT', outputChannel: 'COUTPUT', allowedHumans: ['UHUMAN'], approvalUsers: ['UHUMAN'], trustedBots: [{ botId: 'BBOT', userId: 'UDOT', appId: 'AAPP' }], dot: { name: 'dot', userId: 'UDOT' } };
  config.projects = { repo: home }; config.backend.executable = process.execPath;
  settings.saveConfig(config); settings.saveCredentials({ appToken: 'xapp-fixture-original', botToken: 'xoxb-fixture-original' });
  class Child extends EventEmitter {
    stdout = new EventEmitter(); stderr = new EventEmitter(); connected = true; messages: unknown[] = [];
    send(message: unknown, cb?: () => void) { this.messages.push(message); cb?.(); }
    kill() { throw Error('Must never force kill'); }
    close() { this.connected = false; rmSync(join(home, 'daemon.lock'), { force: true }); this.emit('close', 0); }
  }
  const children: Child[] = [], starts: { port: number; appToken: string; botToken: string }[] = [];
  const runtime = new DesktopRuntime(home, '/fixture/cli', '/fixture/executable', ((_exe: unknown, _args: unknown, options: any) => {
    starts.push({ port: settings.readConfig().port, appToken: options.env.SLACK_APP_TOKEN, botToken: options.env.SLACK_BOT_TOKEN });
    writeFileSync(join(home, 'daemon.lock'), 'fixture'); const child = new Child(); children.push(child); return child;
  }) as any, 100);
  const connection = new DesktopConnection(runtime, () => { settings.initRuntimeFiles(); return runtime.start(settings.readConfig(), settings.getCredentials()!); }, () => false);
  connection.start(); children[0]!.emit('message', { type: 'connector:ready' });
  return { home, settings, config, runtime, connection, children, starts, close: () => { children.at(-1)?.close(); rmSync(home, { force: true, recursive: true }); } };
}
test('production runtime waits for old child exit before writing and starts with the new saved port', async () => {
  const f = integratedFixture();
  try {
    const oldBytes = readFileSync(join(f.home, 'config.json'));
    const saving = f.connection.save(() => f.settings.prepareConfig({ ...f.config, port: 17382 })); await Promise.resolve();
    assert.equal(f.runtime.snapshot().state, 'stopping'); assert.equal(f.children.length, 1);
    assert.deepEqual(readFileSync(join(f.home, 'config.json')), oldBytes);
    assert.deepEqual(f.children[0]!.messages, [{ type: 'connector:stop' }]);
    f.children[0]!.close(); assert.equal((await saving).reconnect, 'starting');
    assert.equal(f.children.length, 2); assert.deepEqual(f.starts.map(s => s.port), [17381, 17382]);
    assert.equal(f.runtime.snapshot().state, 'starting');
    // Async startup failure is still observable, not overwritten with a success claim.
    f.children[1]!.emit('message', { type: 'connector:failure', code: 'SLACK_AUTH_FAILED' });
    assert.equal(f.runtime.snapshot().state, 'failed'); assert.equal(f.runtime.snapshot().lastError, 'SLACK_AUTH_FAILED');
    assert.equal(f.settings.readConfig().port, 17382);
  } finally { f.close(); }
});
test('validates the exact UTF-8 config size before interrupting a healthy connection', async () => {
  const f = integratedFixture();
  try {
    const limit = 128 * 1024;
    const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value, null, 2) + '\n');
    const fit = structuredClone(f.config);
    fit.port = 17382;
    fit.slack.allowedHumans.push(...Array.from({ length: 4000 }, (_, i) => 'UALLOWEDHUMAN' + String(i).padStart(7, '0')));
    const remaining = limit - bytes(fit) + Buffer.byteLength(fit.slack.dot.name);
    fit.slack.dot.name = '模'.repeat(Math.floor(remaining / 3)) + 'A'.repeat(remaining % 3);
    const oversized = structuredClone(fit);
    oversized.slack.dot.name += 'A';
    assert.equal(bytes(fit), limit);
    assert.equal(bytes(oversized), limit + 1);
    assert.ok(Buffer.byteLength(JSON.stringify(oversized)) < limit);
    const oldBytes = readFileSync(join(f.home, 'config.json'));
    await assert.rejects(f.connection.save(() => f.settings.prepareConfig(oversized)), /SETTINGS_TOO_LARGE/);
    assert.deepEqual(readFileSync(join(f.home, 'config.json')), oldBytes);
    assert.deepEqual(f.runtime.snapshot(), { state: 'running', owned: true, backend: undefined, lastError: undefined });
    assert.equal(f.children.length, 1);
    assert.deepEqual(f.children[0]!.messages, []);

    const saving = f.connection.save(() => f.settings.prepareConfig(fit));
    await Promise.resolve();
    assert.equal(f.runtime.snapshot().state, 'stopping');
    f.children[0]!.close();
    assert.equal((await saving).reconnect, 'starting');
    assert.equal(readFileSync(join(f.home, 'config.json')).length, limit);
    assert.equal(f.settings.readConfig().port, 17382);
    assert.deepEqual(f.starts.map(s => s.port), [17381, 17382]);
  } finally { f.close(); }
});
test('production reconnect uses replacement encrypted credentials and preserves the untouched token', async () => {
  const f = integratedFixture();
  try {
    const saving = f.connection.save(() => f.settings.prepareCredentials({ botToken: 'xoxb-fixture-replacement' })); await Promise.resolve();
    assert.equal(f.settings.getCredentials()?.botToken, 'xoxb-fixture-original');
    f.children[0]!.close(); const result = await saving;
    assert.equal(result.reconnect, 'starting');
    assert.deepEqual(f.starts[1], { port: 17381, appToken: 'xapp-fixture-original', botToken: 'xoxb-fixture-replacement' });
    assert.ok(!readFileSync(join(f.home, 'credentials.enc')).includes(Buffer.from('xoxb-fixture-replacement')));
    assert.ok(!JSON.stringify(result).includes('xoxb'));
  } finally { f.close(); }
});

import { configuredServers } from '../src/servers.js';
import { runInNewContext } from 'node:vm';
test('main snapshot reads saved settings after asynchronous runtime refresh, not before', async () => {
  const source = readFileSync('desktop/main.ts', 'utf8'), begin = source.indexOf('async function snapshot()'), end = source.indexOf('\nasync function confirm(', begin);
  assert.ok(begin >= 0 && end > begin);
  const gate = deferred<RuntimeSnapshot>();
  let config = { instanceId: 'old', slack: {}, backend: { executable: '/fixture/codex' } }, tokens = false;
  const snapshot = runInNewContext(`(${source.slice(begin, end)})`, {
    draftConfig: new DesktopConfigDrafts(),runtime: { refresh: () => gate.promise }, settings: { readConfig: () => structuredClone(config), readPreferences: () => ({}), credentialStatus: () => ({ appToken: tokens, botToken: tokens, secureStorageAvailable: true }) },
    connection: { settingsBusy: false }, login: () => ({}), process: { platform: 'darwin' }, app: { isPackaged: false }
  }) as () => Promise<any>;
  const pending = snapshot(); config = { ...config, instanceId: 'new' }; tokens = true;
  gate.resolve({ state: 'starting', owned: true });
  const result = await pending; assert.equal(result.config.instanceId, 'new'); assert.equal(result.credentials.botToken, true); assert.equal(result.runtime.state, 'starting');
});
test('a post-save snapshot read failure does not reject an already persisted config and restart', async () => {
  const f = integratedFixture();
  try {
    writeFileSync(join(f.home, 'desktop-preferences.json'), 'broken preferences');
    const source = readFileSync('desktop/main.ts', 'utf8');
    const snapshotStart = source.indexOf('async function snapshot()');
    const snapshotEnd = source.indexOf('\nasync function confirm(', snapshotStart);
    const saveStart = source.indexOf('saveConfig:') + 'saveConfig:'.length;
    const saveEnd = source.indexOf(',\n  saveCredentials:', saveStart);
    const runtime = { refresh: async () => f.runtime.snapshot(), snapshot: () => f.runtime.snapshot() };
    const draftConfig=new DesktopConfigDrafts(),draft=draftConfig.snapshot(f.settings.readConfig());
    const snapshot = runInNewContext('(' + source.slice(snapshotStart, snapshotEnd) + ')', { runtime, settings: f.settings, connection: f.connection,draftConfig });
    const save = runInNewContext('(' + source.slice(saveStart, saveEnd) + ')', { runtime, settings: f.settings, connection: f.connection, snapshot,draftConfig,configuredServers }) as (value: unknown) => Promise<any>;
    const pending = save({ config:{...draft.config,port:17382},configDraftId:draft.configDraftId });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.runtime.snapshot().state, 'stopping');
    f.children[0]!.close();
    const result = await pending;
    assert.equal(result.save.saved, true);
    assert.equal(result.save.reconnect, 'starting');
    assert.equal(result.snapshotUnavailable, true);
    assert.equal(result.runtime.state, 'starting');
    assert.equal('preferences' in result, false);
    assert.equal(f.settings.readConfig().port, 17382);
    assert.deepEqual(f.starts.map(s => s.port), [17381, 17382]);
  } finally { f.close(); }
});
