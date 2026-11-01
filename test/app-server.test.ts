import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { AppServer } from '../src/codex.js';
import type { Config } from '../src/types.js';
function adapter(sandbox: Config['sandbox'] = 'read-only') {
  const config: Config = { teamId: 'T1', allowedUsers: ['U1'], allowedChannels: ['C1'], projects: { test: process.cwd() }, port: 17381, codexExecutable: resolve('test/fixtures/app-server.cjs'), sandbox };
  return new AppServer(config);
}
test('mock app-server initialization, owned session, final-only relay, inherited approval policy', async () => {
  const a = adapter(); try {
    const id = await a.start(process.cwd()); assert.equal(id, 'test-thread');
    assert.equal(await a.run(id, process.cwd(), 'hello', 'connector-session'), 'safe final answer');
  } finally { await a.close(); }
});
test('mock resume follows captured thread ID without reading session files', async () => {
  const a = adapter(); try { assert.equal(await a.run('existing-owned-thread', process.cwd(), 'hello', 'session'), 'safe final answer'); } finally { await a.close(); }
});
test('interactive approval and unknown requests fail closed and stop the owned process', async () => {
  for (const marker of ['[approval]', '[unknown-request]', '[failed]', '[exit]']) {
    const a = adapter(); try {
      const id = await a.start(process.cwd()); await assert.rejects(a.run(id, process.cwd(), marker, 's'));
    } finally { await a.close(); }
  }
});
test('Slack and connector credentials are removed from Codex child environment', async () => {
  const names = ['SLACK_APP_TOKEN', 'SLACK_BOT_TOKEN', 'CONNECTOR_TOKEN'] as const;
  const old = names.map(n => process.env[n]); names.forEach(n => { process.env[n] = 'dummy-test-only'; });
  const a = adapter(); try { assert.equal(await a.start(process.cwd()), 'test-thread'); } finally {
    await a.close(); names.forEach((n, i) => { if (old[i] === undefined) delete process.env[n]; else process.env[n] = old[i]; });
  }
});

test('explicit inherit mode omits legacy policy overrides', async () => {
  const a = adapter('inherit'); try {
    const id = await a.start(process.cwd());
    assert.equal(await a.run(id, process.cwd(), '[inherit]', 'session'), 'safe final answer');
  } finally { await a.close(); }
});
