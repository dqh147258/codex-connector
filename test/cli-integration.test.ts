import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../src/store.js';
import { Connector } from '../src/connector.js';
import { apiServer } from '../src/server.js';
import type { Config } from '../src/types.js';
const exec = promisify(execFile);
test('actual Skill CLI create/send/read/ack traverses authenticated HTTP to fake Slack', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'connector-cli-')), store = new Store(dir), token = 't'.repeat(64), posts: any[] = [];
  const config: Config = { teamId: 'T1', allowedUsers: ['U1'], allowedChannels: ['C1'], projects: { repo: dir }, port: 17381, codexExecutable: process.execPath, sandbox: 'read-only' };
  const connector = new Connector(config, store, { async post(channel, text, threadTs) { posts.push({ channel, text, threadTs }); return '123.456'; } }, { async start() { throw Error('No real Codex permitted'); }, async run() { throw Error('No real Codex permitted'); }, async close() {} });
  const server = apiServer(connector, token); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address(); assert.ok(address && typeof address !== 'string'); config.port = address.port;
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config)); writeFileSync(join(dir, 'api.token'), token);
  let proxyHits = 0; const proxy = createServer((_req, res) => { proxyHits++; res.writeHead(502); res.end(); });
  await new Promise<void>(r => proxy.listen(0, '127.0.0.1', r));
  const proxyAddress = proxy.address(); assert.ok(proxyAddress && typeof proxyAddress !== 'string');
  const env: NodeJS.ProcessEnv = { ...process.env, CONNECTOR_HOME: dir, NODE_USE_ENV_PROXY: '1', HTTP_PROXY: `http://127.0.0.1:${proxyAddress.port}`, http_proxy: `http://127.0.0.1:${proxyAddress.port}`, NO_PROXY: '', no_proxy: '' }; delete env.CONNECTOR_TOKEN;
  const cli = async (...args: string[]) => JSON.parse((await exec(process.execPath, [resolve('dist/src/cli.js'), ...args], { env })).stdout).result;
  try {
    const session = await cli('create', '--project', 'repo', '--channel', 'C1', '--session', 'skill-session', '--mode', 'mailbox');
    assert.equal(session.threadTs, '123.456');
    const textPath = join(dir, 'message.txt'); writeFileSync(textPath, 'literal `$(not-a-command)`\n你好');
    await cli('send', '--session', 'skill-session', '--text-file', textPath);
    assert.equal(posts.at(-1).text, 'literal `$(not-a-command)`\n你好');
    await connector.accept({ team_id: 'T1', event_id: 'E1', event: { type: 'message', channel: 'C1', user: 'U1', thread_ts: '123.456', ts: '123.999', text: 'next request' } });
    const inbox = await cli('read', '--session', 'skill-session'); assert.equal(inbox[0].text, 'next request');
    await cli('ack', '--session', 'skill-session', '--jobs', 'E1'); assert.deepEqual(await cli('read', '--session', 'skill-session'), []);
    assert.equal(proxyHits, 0, 'local bearer must never traverse an ambient proxy');
  } finally { await new Promise<void>(r => proxy.close(() => r())); await new Promise<void>(r => server.close(() => r())); await connector.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
