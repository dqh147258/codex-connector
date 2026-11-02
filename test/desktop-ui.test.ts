import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const { JSDOM } = createRequire(import.meta.url)('jsdom');
const html = readFileSync('desktop/ui/index.html', 'utf8');
const script = readFileSync('desktop/ui/renderer.js', 'utf8');
const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise<void>(r => setImmediate(r)); };
const initial = () => ({
  config: { version: 2, instanceId: 'my-computer', port: 17381,
    slack: { teamId: 'TTEAM', inputChannel: 'CINPUT', outputChannel: 'COUTPUT', allowedHumans: ['UHUMAN'], approvalUsers: ['UHUMAN'], trustedBots: [{ userId: 'UDOT', botId: 'BDOT', appId: 'ADOT' }], dot: { userId: 'UDOT', name: 'My dot' } },
    projects: { repo: '/fixture/project' }, backend: { executable: '/fixture/codex', autoStartDaemon: false }, approvalTimeoutSec: 300, sessionPolicy: { allowAllSharedSessions: false } },
  preferences: { autoConnect: false, closeToTray: true }, credentials: { appToken: true, botToken: true, secureStorage: true },
  runtime: { state: 'stopped', owned: false, backend: { connected: false, version: null, expectedVersion: null, lastFailure: null } },
  login: { supported: true, enabled: false }, platform: 'darwin', packaged: true
});
function fixture(handlers: Record<string, (arg?: any) => any> = {}, state: any = initial()) {
  const dom = new JSDOM(html, { url: 'file:///fixture/desktop/ui/index.html', runScripts: 'outside-only' });
  const w = dom.window, calls: { name: string; arg: any }[] = [], intervals: (() => void)[] = [];
  w.scrollTo = () => {};
  w.setInterval = (cb: () => void) => { intervals.push(cb); return intervals.length; };
  w.clearInterval = () => {};
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  Object.defineProperty(w, 'localStorage', { get() { throw Error('Renderer must not use localStorage'); } });
  Object.defineProperty(w, 'sessionStorage', { get() { throw Error('Renderer must not use sessionStorage'); } });
  const defaults: Record<string, (arg?: any) => any> = { snapshot: () => copy(state), saveConfig: c => { state.config = copy(c); return copy(state); }, saveCredentials: () => copy(state.credentials), savePreferences: p => { state.preferences = copy(p); return copy(p); }, setLoginStartup: p => { state.login.enabled = p.enabled; return copy(state.login); }, start: () => ({ state: 'running', owned: true, backend: { connected: false } }), stop: () => ({ state: 'stopped', owned: false }), choosePath: () => ({}), lookupDot: p => ({ userId: p.userId, botId: 'BAUTO', appId: 'AAUTO', name: 'Resolved dot' }), testSlack: () => ({ teamId: 'TTEAM', teamName: 'Workspace', appTokenValid: true }), listUsers: () => ({ users: [] }), listChannels: () => ({ channels: [] }), inspectLock: () => ({ exists: false, eligible: false }), recoverLock: () => ({ recovered: false }), openHelp: () => ({}), quit: () => ({}) };
  w.connector = Object.fromEntries(Object.entries({ ...defaults, ...handlers }).map(([name, fn]) => [name, async (arg: any) => { calls.push({ name, arg: copy(arg ?? null) }); const value = await fn(arg); return value?.ok === false ? value : { ok: true, value }; }]));
  w.eval(script);
  const $ = (id: string): any => w.document.getElementById(id);
  const input = (id: string, value: string) => { $(id).value = value; $(id).dispatchEvent(new w.Event('input', { bubbles: true })); };
  const change = (id: string, value: boolean) => { $(id).checked = value; $(id).dispatchEvent(new w.Event('change', { bubbles: true })); };
  return { dom, w, state, calls, $, input, change, tick: async () => { intervals[0]!(); await settle(); }, close: () => dom.window.close() };
}
test('desktop renderer uses restrictive local CSP and no generic IPC, remote scripts or HTML sinks', () => {
  assert.match(html, /connect-src 'none'/); assert.match(html, /form-action 'none'/); assert.match(html, /object-src 'none'/);
  assert.ok(!/script\s+src=["']https?:/i.test(html));
  assert.ok(!/innerHTML|outerHTML\s*=|insertAdjacentHTML|localStorage|sessionStorage|ipcRenderer|\beval\(/.test(script));
});
test('desktop snapshots distinguish local service from shared connection and never read back tokens', async () => {
  const f = fixture(); try { await settle(); assert.equal(f.$('app-token').value, ''); assert.equal(f.$('bot-token').value, '');
    f.state.runtime = { state: 'running', owned: true, backend: { connected: false, version: '1.2.3', lastFailure: 'PROXY_DISCONNECTED' } };
    await f.tick(); assert.match(f.$('connection-badge').textContent, /本地已启动.*待连接/); assert.equal(f.$('diagnostic-version').textContent, '1.2.3'); assert.equal(f.$('start-button').disabled, true); assert.equal(f.$('stop-button').disabled, false);
  } finally { f.close(); }
});
test('status polling never overwrites unsaved setup fields', async () => {
  const f = fixture(); try { await settle(); f.input('team-id', 'TUNSAVED'); f.state.config.slack.teamId = 'TREMOTE'; await f.tick(); assert.equal(f.$('team-id').value, 'TUNSAVED'); assert.match(f.$('dirty-label').textContent, /尚未保存/); } finally { f.close(); }
});
test('tokens clear immediately on submit and do not survive a failed storage operation', async () => {
  let resolve!: (value: any) => void; const pending = new Promise(r => { resolve = r; });
  const secret = 'xoxb-' + 'dummy'.repeat(8), f = fixture({ saveCredentials: () => pending });
  try { await settle(); f.$('bot-token').value = secret; f.$('save-tokens-button').click(); assert.equal(f.$('bot-token').value, ''); assert.equal(f.calls.filter(c => c.name === 'saveCredentials').length, 1); assert.equal(f.$('save-tokens-button').disabled, true);
    resolve({ ok: false, error: { code: 'STORE_FAILED', message: `Could not save ${secret}` } }); await settle();
    assert.equal(f.$('bot-token').value, ''); assert.ok(!f.w.document.body.textContent.includes(secret)); assert.match(f.$('global-notice').textContent, /令牌已隐藏/);
  } finally { f.close(); }
});
test('unavailable secure storage disables persistence instead of implying plaintext fallback', async () => {
  const state = initial(); state.credentials.secureStorage = false; const f = fixture({}, state);
  try { await settle(); assert.equal(f.$('save-tokens-button').disabled, true); assert.equal(f.$('secure-storage-warning').hidden, false); f.$('save-tokens-button').click(); assert.equal(f.calls.filter(c => c.name === 'saveCredentials').length, 0); } finally { f.close(); }
});
test('late dot lookup cannot overwrite a newer selected user', async () => {
  let resolve!: (value: any) => void; const f = fixture({ lookupDot: () => new Promise(r => { resolve = r; }) });
  try { await settle(); f.$('lookup-dot-button').click(); f.input('dot-user-id', 'UNEW'); resolve({ userId: 'UDOT', botId: 'BOLD', appId: 'AOLD', name: 'Old' }); await settle(); assert.equal(f.$('dot-user-id').value, 'UNEW'); assert.equal(f.$('dot-bot-id').value, 'BDOT'); assert.match(f.$('dot-result').textContent, /未应用旧结果/); } finally { f.close(); }
});
test('OS login settings reflect actual response and restore prior state on rejected change', async () => {
  const f = fixture({ setLoginStartup: () => ({ ok: false, error: { code: 'DENIED', message: '用户取消了系统设置更改。' } }) });
  try { await settle(); f.change('login-startup', true); await settle(); assert.equal(f.$('login-startup').checked, false); assert.match(f.$('global-notice').textContent, /取消/); assert.equal(f.state.preferences.autoConnect, false); } finally { f.close(); }
});
test('unsupported login startup is explicitly disabled, independent from auto-connect', async () => {
  const state: any = initial(); state.login = { supported: false, enabled: false, reason: 'Linux 不支持此系统接口' }; state.platform = 'linux'; const f = fixture({}, state);
  try { await settle(); assert.equal(f.$('login-startup').disabled, true); assert.match(f.$('login-status').textContent, /不支持/); f.change('auto-connect', true); await settle(); assert.equal(f.state.preferences.autoConnect, true); assert.equal(f.state.login.enabled, false); } finally { f.close(); }
});
test('configuration saving preserves additional projects and bots and can remove optional version pin', async () => {
  const state: any = initial(); state.config.projects.extra = '/fixture/other'; state.config.slack.trustedBots.push({ userId: 'UOTHER', botId: 'BOTHER', appId: 'AOTHER' }); state.config.backend.expectedVersion = 'old-version';
  const f = fixture({}, state); try { await settle(); f.input('expected-version', ''); f.input('project-path', '/fixture/new'); f.$('config-form').dispatchEvent(new f.w.Event('submit', { bubbles: true, cancelable: true })); await settle();
    const saved = f.calls.find(c => c.name === 'saveConfig')?.arg; assert.ok(saved); assert.equal(saved.projects.repo, '/fixture/new'); assert.equal(saved.projects.extra, '/fixture/other'); assert.ok(saved.slack.trustedBots.some((b: any) => b.userId === 'UOTHER')); assert.equal(Object.hasOwn(saved.backend, 'expectedVersion'), false); assert.equal(f.$('import-notice').hidden, true);
  } finally { f.close(); }
});
test('import with dirty form requires confirmation and stays a preview until saved', async () => {
  const imported = initial().config; imported.slack.teamId = 'TIMPORTED'; const f = fixture({ choosePath: () => ({ config: imported }) });
  try { await settle(); f.input('team-id', 'TDIRTY'); f.$('import-button').click(); await settle(); assert.equal(f.$('discard-dialog').open, true); f.$('discard-cancel').click(); await settle(); assert.equal(f.calls.filter(c => c.name === 'choosePath').length, 0); assert.equal(f.$('team-id').value, 'TDIRTY');
    f.$('import-button').click(); await settle(); f.$('discard-confirm').click(); await settle(); assert.equal(f.$('team-id').value, 'TIMPORTED'); assert.equal(f.$('import-notice').hidden, false); assert.equal(f.calls.filter(c => c.name === 'saveConfig').length, 0);
  } finally { f.close(); }
});
test('rapid repeated startup clicks issue one lifecycle request', async () => {
  let resolve!: (value: any) => void; const f = fixture({ start: () => new Promise(r => { resolve = r; }) });
  try { await settle(); f.$('start-button').click(); f.$('start-button').click(); assert.equal(f.calls.filter(c => c.name === 'start').length, 1); assert.equal(f.$('start-button').disabled, true); resolve({ state: 'starting', owned: true }); await settle(); } finally { f.close(); }
});
test('Slack names are rendered as text, not executable markup', async () => {
  const f = fixture({ testSlack: () => ({ teamId: 'TTEAM', teamName: '<img src=x onerror="window.pwned=true">', appTokenValid: true }) });
  try { await settle(); f.$('test-slack-button').click(); await settle(); assert.match(f.$('slack-test-result').textContent, /<img/); assert.equal(f.$('slack-test-result').querySelector('img'), null); assert.equal(f.w.pwned, undefined); } finally { f.close(); }
});

test('owned startup can be stopped while its initial start request is still pending', async () => {
  let finishStart!: (value: any) => void; const f = fixture({ start: () => new Promise(r => { finishStart = r; }), stop: () => { f.state.runtime = { state: 'stopped', owned: false }; return f.state.runtime; } });
  try { await settle(); f.$('start-button').click(); f.state.runtime = { state: 'starting', owned: true }; await f.tick(); assert.equal(f.$('stop-button').disabled, false); f.$('stop-button').click(); await settle(); assert.equal(f.calls.filter(c => c.name === 'stop').length, 1); finishStart({ state: 'stopped', owned: false }); await settle(); } finally { f.close(); }
});
test('partial Slack lists disclose truncation and retain manual ID fallback', async () => {
  const f = fixture({ listUsers: () => ({ users: [], hasMore: true }), listChannels: () => ({ channels: [], hasMore: true }) });
  try { await settle(); f.$('list-users-button').click(); f.$('list-channels-button').click(); await settle(); assert.match(f.$('dot-result').textContent, /并非完整/); assert.match(f.$('channel-result').textContent, /并非完整/); } finally { f.close(); }
});
