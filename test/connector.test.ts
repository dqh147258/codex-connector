import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Connector } from '../src/connector.js';
import { Store } from '../src/store.js';
import type { Config, CodexPort, SlackPort } from '../src/types.js';
import { apiServer } from '../src/server.js';
import { chunks } from '../src/slack.js';
import { codexLaunch } from '../src/codex.js';
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'connector-test-'));
  const store = new Store(dir);
  const config: Config = { teamId: 'T1', allowedUsers: ['U1'], allowedChannels: ['C1'], projects: { repo: dir }, port: 17381, codexExecutable: '/not-executed/codex', sandbox: 'read-only' };
  const posts: any[] = [], calls: string[] = [];
  const slack: SlackPort = { async post(channel, text, threadTs) { posts.push({ channel, text, threadTs }); return '100.001'; } };
  const codex: CodexPort = { async start() { return 'owned-codex-thread'; }, async run(_id, _cwd, text) { calls.push(text); return `Reply: ${text}`; }, async close() {} };
  const connector = new Connector(config, store, slack, codex);
  return { dir, store, config, posts, calls, slack, codex, connector, cleanup: async () => { await connector.close(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const event = (overrides: any = {}) => ({ team_id: 'T1', event_id: 'E1', event: { type: 'message', channel: 'C1', user: 'U1', text: '!codex new repo hello', ts: '100.100', ...overrides } });
async function settled(f: ReturnType<typeof fixture>) {
  for (let i = 0; i < 100 && f.store.state.jobs.some(j => ['queued', 'running'].includes(j.status)); i++) await new Promise(r => setTimeout(r, 5));
}
test('Slack root creates one durable managed session, reply is in its thread, duplicates ignored', async () => {
  const f = fixture(); try {
    const id = await f.connector.accept(event()); assert.ok(id); assert.equal(f.calls.length, 0);
    assert.equal(f.store.state.jobs[0]?.text, 'hello');
    assert.equal(await f.connector.accept(event()), undefined);
    f.connector.pump(id); await settled(f);
    assert.equal(f.calls.length, 1); assert.equal(f.posts[0].threadTs, '100.100');
    assert.equal(f.store.state.sessions[0]?.codexThreadId, 'owned-codex-thread');
  } finally { await f.cleanup(); }
});
test('wrong team, user, channel, bot, edit and unrelated messages never execute', async () => {
  const f = fixture(); try {
    for (const e of [event({ user: 'U2' }), event({ channel: 'C2' }), event({ bot_id: 'B1' }), event({ subtype: 'message_changed' }), event({ text: 'hello' }), { ...event(), team_id: 'T2' }]) assert.equal(await f.connector.accept(e), undefined);
    assert.equal(f.store.state.jobs.length, 0); assert.equal(f.posts.length, 0);
  } finally { await f.cleanup(); }
});
test('root event retry after mapping-only crash is recoverable', async () => {
  const f = fixture(); try {
    await f.connector.create({ id: 'slack-E1', mode: 'managed', channel: 'C1', project: 'repo', threadTs: '100.100' });
    assert.equal(await f.connector.accept(event()), 'slack-E1');
    assert.equal(f.store.state.jobs.length, 1);
  } finally { await f.cleanup(); }
});
test('mailbox Skill create/send/read/ack never launches Codex', async () => {
  const f = fixture(); try {
    await f.connector.create({ id: 'my-session', channel: 'C1', project: 'repo' });
    await f.connector.accept(event({ thread_ts: '100.001', text: 'next task' }));
    f.connector.pump('my-session');
    const inbox = f.connector.read('my-session'); assert.equal(inbox.length, 1);
    await f.connector.send('my-session', 'response'); f.connector.ack('my-session', inbox.map(j => j.id));
    assert.equal(f.connector.read('my-session').length, 0); assert.equal(f.calls.length, 0);
    assert.equal(f.posts.at(-1).threadTs, '100.001');
  } finally { await f.cleanup(); }
});
test('managed FIFO does not run turns concurrently', async () => {
  const f = fixture(); let current = 0, max = 0;
  f.codex.run = async (_id, _cwd, text) => { current++; max = Math.max(max, current); await new Promise(r => setTimeout(r, 15)); f.calls.push(text); current--; return text; };
  try {
    await f.connector.create({ id: 's', mode: 'managed', channel: 'C1', project: 'repo', threadTs: '100.1' });
    f.connector.enqueue('s', 'one'); f.connector.enqueue('s', 'two'); f.connector.pump('s'); f.connector.pump('s');
    await settled(f); assert.equal(max, 1); assert.deepEqual(f.calls, ['one', 'two']);
  } finally { await f.cleanup(); }
});
test('failed or uncertain turn pauses queue without replay, resolve does not replay', async () => {
  const f = fixture(); f.codex.run = async () => { throw Error('sensitive downstream failure'); };
  try {
    await f.connector.create({ id: 's', mode: 'managed', channel: 'C1', project: 'repo', threadTs: '100.1' });
    const first = f.connector.enqueue('s', 'one'); f.connector.enqueue('s', 'two'); f.connector.pump('s');
    await new Promise(r => setTimeout(r, 30)); assert.equal(first.status, 'failed'); assert.equal(f.store.state.jobs[1]?.status, 'queued');
    assert.ok(!JSON.stringify(f.connector.status()).includes('sensitive')); assert.ok(!JSON.stringify(f.posts).includes('sensitive'));
    f.connector.resolve('s', first.id); assert.equal(first.status, 'done'); assert.equal(f.store.state.jobs[1]?.status, 'queued');
  } finally { await f.cleanup(); }
});
test('revoked channel blocks send, enqueue, and persisted queue execution', async () => {
  const f = fixture(); try {
    await f.connector.create({ id: 's', mode: 'managed', channel: 'C1', project: 'repo', threadTs: '100.1' });
    f.connector.enqueue('s', 'one'); f.config.allowedChannels = [];
    await assert.rejects(f.connector.send('s', 'text')); assert.throws(() => f.connector.enqueue('s', 'two'));
    f.connector.resumeQueues(); await new Promise(r => setTimeout(r, 10)); assert.equal(f.posts.length, 0); assert.equal(f.calls.length, 0);
  } finally { await f.cleanup(); }
});
test('thread binding cannot be reused by another session', async () => {
  const f = fixture(); try {
    await f.connector.create({ id: 's', channel: 'C1', project: 'repo', threadTs: '100.1' });
    await assert.rejects(f.connector.create({ id: 't', channel: 'C1', project: 'repo', threadTs: '100.1' }));
  } finally { await f.cleanup(); }
});
test('state lock prevents two writers and restart marks running as uncertain', () => {
  const dir = mkdtempSync(join(tmpdir(), 'connector-state-'));
  const first = new Store(dir); assert.throws(() => new Store(dir));
  first.state.jobs.push({ id: 'j', sessionId: 's', user: 'U1', text: 'x', ts: '', status: 'running' }); first.save(); first.close();
  const second = new Store(dir); assert.equal(second.state.jobs[0]?.status, 'uncertain'); second.close(); rmSync(dir, { recursive: true });
});
test('local API rejects missing auth/browser origin and accepts authenticated commands', async () => {
  const f = fixture(), token = 'a'.repeat(64), server = apiServer(f.connector, token);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/v1/command`;
  try {
    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://evil.test' }, body: '{}' })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ command: 'status' }) })).status, 200);
    assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ command: 'send', session: 'missing', text: 'x' }) })).status, 400);
  } finally { await new Promise<void>((r, j) => server.close(e => e ? j(e) : r())); await f.cleanup(); }
});
test('outbound escaping prevents mentions and chunks preserve Unicode', () => {
  assert.deepEqual(chunks('<@U1> & hello'), ['&lt;@U1&gt; &amp; hello']);
  assert.deepEqual(chunks('😀😀😀', 2), ['😀😀', '😀']);
});
test('cross-platform launcher never invokes a shell shim', () => {
  assert.deepEqual(codexLaunch('/usr/bin/codex'), { executable: '/usr/bin/codex', args: ['app-server'] });
  assert.equal(codexLaunch('C:\\Users\\Name\\codex.js').executable, process.execPath);
  assert.throws(() => codexLaunch('C:\\Users\\Name\\codex.cmd'));
});
test('storage failure rolls back dedupe and fails closed until repaired restart', async () => {
  const f = fixture();
  try {
    await f.connector.create({ id: 'bound', mode: 'managed', channel: 'C1', project: 'repo', threadTs: '100.1' });
    const reply = event({ thread_ts: '100.1', text: 'must remain durable before acknowledgement' });
    // Force a real persistence error without depending on the test user's Unix permissions.
    const { mkdirSync } = await import('node:fs'); mkdirSync(join(f.dir, 'state.json.tmp'));
    await assert.rejects(f.connector.accept(reply));
    assert.equal(f.store.state.seen.E1, undefined); assert.equal(f.store.state.jobs.length, 0);
    rmSync(join(f.dir, 'state.json.tmp'), { recursive: true });
    for (let attempt = 0; attempt < 3; attempt++) {
      // Repairs alone cannot make this unhealthy process accept or falsely ACK a retry.
      await assert.rejects(f.connector.accept(reply));
      assert.equal(f.store.state.seen.E1, undefined);
      assert.equal(f.store.state.jobs.length, 0);
      assert.equal(JSON.parse(readFileSync(join(f.dir, 'state.json'), 'utf8')).jobs.length, 0);
    }
  } finally { await f.cleanup(); }
});
test('shutdown waits for an in-flight Slack post before releasing state ownership', async () => {
  const f = fixture(); let finish: (() => void) | undefined;
  f.slack.post = async () => { await new Promise<void>(r => { finish = r; }); return '100.1'; };
  await f.connector.create({ id: 's', mode: 'managed', channel: 'C1', project: 'repo', threadTs: '100.1' });
  f.connector.enqueue('s', 'hello'); f.connector.pump('s');
  while (!finish) await new Promise(r => setTimeout(r, 1));
  let closed = false; const pending = f.connector.close().then(() => { closed = true; });
  await new Promise(r => setTimeout(r, 10)); assert.equal(closed, false);
  finish(); await pending; assert.equal(closed, true); await f.cleanup();
});
