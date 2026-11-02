import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, link, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadonlyFiles, FileAccessError, validateRootSyntax } from '../src/files.js';
async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'connector-readonly-'))), root = join(base, 'project'); await mkdir(root);
  await writeFile(join(root, 'readme.txt'), 'hello world\nfind needle here\nsecond needle\n');
  await mkdir(join(root, 'sub')); await writeFile(join(root, 'sub', 'a.txt'), 'more needle');
  return { base, root, files: new ReadonlyFiles({ demo: root }), cleanup: () => rm(base, { recursive: true, force: true }) };
}
const code = (expected: string) => (error: unknown) => error instanceof FileAccessError && error.code === expected;
test('readonly list/stat/read/search operate within explicit project alias', async () => {
  const f = await fixture(); try {
    assert.deepEqual((await f.files.list('demo')).entries.map(x => x.path), ['readme.txt', 'sub']);
    assert.equal((await f.files.stat('demo', 'readme.txt')).type, 'file');
    const r = await f.files.read('demo', 'readme.txt', { offset: 6, maxBytes: 5 });
    assert.equal(r.text, 'world'); assert.equal(r.truncated, true); assert.equal(r.nextOffset, 11);
    const matches = await f.files.search('demo', '.', 'needle', { limit: 10, maxDepth: 3 });
    assert.equal(matches.matches.length, 3); assert.equal(matches.scannedFiles, 2);
  } finally { await f.cleanup(); }
});
test('path traversal, absolute paths, Windows ADS/devices and unknown roots fail closed', async () => {
  const f = await fixture(); try {
    for (const path of ['../readme.txt', 'sub/../../outside', '/etc/passwd', 'C:\\Windows\\win.ini', 'sub\\a.txt', 'readme.txt:secret', 'NUL', 'COM1.txt', 'sub/./a.txt', 'readme.txt\0']) {
      await assert.rejects(f.files.read('demo', path), code('PATH_FORBIDDEN'));
    }
    await assert.rejects(f.files.read('__proto__', 'readme.txt'), code('ROOT_UNKNOWN'));
    assert.throws(() => new ReadonlyFiles({ sessions: '/home/agent/.codex/sessions' }), code('PATH_FORBIDDEN'));
    assert.throws(() => new ReadonlyFiles({ device: '/dev' }), code('PATH_FORBIDDEN'));
  } finally { await f.cleanup(); }
});
test('secret files and credential content are withheld including search and offset attempts', async () => {
  const f = await fixture(); try {
    for (const name of ['.env', '.env.example', '.npmrc', 'auth.json', 'id_rsa', 'private.pem', 'service.env']) await writeFile(join(f.root, name), 'needle sensitive');
    await mkdir(join(f.root, '.codex')); await writeFile(join(f.root, '.codex', 'anything.txt'), 'sensitive');
    await writeFile(join(f.root, 'plain.txt'), 'prefix\npassword = "not-a-real-secret-but-sensitive"\nneedle');
    const names = (await f.files.list('demo')).entries.map(x => x.path);
    assert.ok(!names.some(n => n.startsWith('.env') || n === '.codex' || n === 'service.env'));
    for (const name of ['.env', 'auth.json', '.codex/anything.txt']) await assert.rejects(f.files.read('demo', name), code('PATH_FORBIDDEN'));
    await assert.rejects(f.files.read('demo', 'plain.txt', { offset: 6, maxBytes: 6 }), code('SENSITIVE_CONTENT'));
    const results = await f.files.search('demo', '.', 'needle'); assert.equal(results.matches.length, 3); assert.equal(results.skippedFiles, 1);
  } finally { await f.cleanup(); }
});
test('symlinks, junctions and hardlinks do not expose files outside roots', async t => {
  const f = await fixture(); try {
    const outside = join(f.base, 'outside'); await mkdir(outside); await writeFile(join(outside, 'secret.txt'), 'secret');
    try {
      await symlink(outside, join(f.root, 'linked-dir'), process.platform === 'win32' ? 'junction' : 'dir');
      await symlink(join(outside, 'secret.txt'), join(f.root, 'linked-file'), 'file');
      await link(join(outside, 'secret.txt'), join(f.root, 'hardlink'));
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EPERM') { t.skip('OS account cannot create test links'); return; } throw e; }
    const aliasedRoot = new ReadonlyFiles({ demo: join(f.root, 'linked-dir') });
    await assert.rejects(aliasedRoot.list('demo'), code('PATH_FORBIDDEN'));
    for (const path of ['linked-dir/secret.txt', 'linked-file', 'hardlink']) await assert.rejects(f.files.read('demo', path), code('PATH_FORBIDDEN'));
    assert.ok(!(await f.files.list('demo')).entries.some(x => x.path.startsWith('linked') || x.path === 'hardlink'));
    assert.equal((await f.files.search('demo', '.', 'secret')).matches.length, 0);
  } finally { await f.cleanup(); }
});
test('binary, huge files, invalid budgets and bounded search output are rejected or truncated', async () => {
  const f = await fixture(); try {
    await writeFile(join(f.root, 'binary'), Buffer.from([0, 1, 2])); await writeFile(join(f.root, 'large'), 'a'.repeat(1024 * 1024 + 1));
    await assert.rejects(f.files.read('demo', 'binary'), code('NOT_REGULAR'));
    await assert.rejects(f.files.read('demo', 'large'), code('LIMIT_EXCEEDED'));
    await assert.rejects(f.files.read('demo', 'readme.txt', { maxBytes: 65537 }), code('INVALID_ARGUMENT'));
    await assert.rejects(f.files.search('demo', '.', '\n'), code('INVALID_ARGUMENT'));
    const limited = await f.files.search('demo', '.', 'needle', { limit: 1 }); assert.equal(limited.matches.length, 1); assert.equal(limited.truncated, true);
    assert.equal((await f.files.list('demo', '.', { limit: 1 })).entries.length, 1);
  } finally { await f.cleanup(); }
});
test('search is literal, never a regular expression or external command', async () => {
  const f = await fixture(); try {
    await writeFile(join(f.root, 'literal.txt'), '$(do-not-run) [a-z]+ **');
    assert.equal((await f.files.search('demo', '.', '$(do-not-run)')).matches.length, 1);
    assert.equal((await f.files.search('demo', '.', '[a-z]+')).matches.length, 1);
  } finally { await f.cleanup(); }
});

test('Windows root syntax preserves drive anchors but rejects UNC, device and secret roots', () => {
  assert.doesNotThrow(() => validateRootSyntax('C:\\Users\\alice\\project', true));
  assert.doesNotThrow(() => validateRootSyntax('D:/repos/project', true));
  for (const root of ['C:\\', '\\\\server\\share', '\\\\?\\C:\\project', 'C:\\Users\\alice\\.codex\\sessions']) assert.throws(() => validateRootSyntax(root, true), code('PATH_FORBIDDEN'));
});

test('depth zero searches only root files and traversal budget counts directories', async () => {
  const f = await fixture(); try {
    const flat = await f.files.search('demo', '.', 'needle', { maxDepth: 0 });
    assert.equal(flat.matches.length, 2); assert.ok(flat.matches.every(x => x.path === 'readme.txt'));
    for (let i = 0; i < 10; i++) await mkdir(join(f.root, `empty-${i}`));
    const bounded = new ReadonlyFiles({ demo: f.root }, { maxFiles: 3 });
    assert.equal((await bounded.search('demo', '.', 'absent')).truncated, true);
  } finally { await f.cleanup(); }
});

test('UTF-8 pagination preserves multibyte characters with byte-accurate cursors', async () => {
  const f = await fixture(); try {
    await writeFile(join(f.root, 'unicode.txt'), '你好');
    const first = await f.files.read('demo', 'unicode.txt', { maxBytes: 5 });
    assert.deepEqual({ text: first.text, bytes: first.bytes, nextOffset: first.nextOffset, truncated: first.truncated }, { text: '你', bytes: 3, nextOffset: 3, truncated: true });
    const second = await f.files.read('demo', 'unicode.txt', { offset: first.nextOffset, maxBytes: 5 });
    assert.deepEqual({ text: second.text, bytes: second.bytes, nextOffset: second.nextOffset, truncated: second.truncated }, { text: '好', bytes: 3, nextOffset: 6, truncated: false });
    const eof = await f.files.read('demo', 'unicode.txt', { offset: second.nextOffset, maxBytes: 1 });
    assert.deepEqual({ text: eof.text, bytes: eof.bytes, nextOffset: eof.nextOffset, truncated: eof.truncated }, { text: '', bytes: 0, nextOffset: 6, truncated: false });
  } finally { await f.cleanup(); }
});
test('emoji and mixed UTF-8 pages never exceed byte budget or return a stuck cursor', async () => {
  const f = await fixture(); try {
    const text = 'A😀你éB🚀'; await writeFile(join(f.root, 'emoji.txt'), text);
    let offset = 0, reconstructed = '';
    for (let i = 0; i < 20; i++) {
      const page = await f.files.read('demo', 'emoji.txt', { offset, maxBytes: 5 });
      assert.ok(page.bytes <= 5); assert.equal(Buffer.byteLength(page.text, 'utf8'), page.bytes);
      assert.ok(!page.text.includes('�')); reconstructed += page.text;
      if (!page.truncated) { assert.equal(page.nextOffset, Buffer.byteLength(text)); break; }
      assert.ok(page.nextOffset > offset); offset = page.nextOffset;
    }
    assert.equal(reconstructed, text);
  } finally { await f.cleanup(); }
});
test('UTF-8 continuation offsets and too-small pages are rejected explicitly', async () => {
  const f = await fixture(); try {
    await writeFile(join(f.root, 'unicode.txt'), '你😀');
    for (const offset of [1, 2, 4, 5, 6, 8]) await assert.rejects(f.files.read('demo', 'unicode.txt', { offset, maxBytes: 5 }), code('INVALID_ARGUMENT'));
    await assert.rejects(f.files.read('demo', 'unicode.txt', { maxBytes: 2 }), code('INVALID_ARGUMENT'));
    await assert.rejects(f.files.read('demo', 'unicode.txt', { offset: 3, maxBytes: 3 }), code('INVALID_ARGUMENT'));
    const emoji = await f.files.read('demo', 'unicode.txt', { offset: 3, maxBytes: 4 });
    assert.equal(emoji.text, '😀'); assert.equal(emoji.bytes, 4); assert.equal(emoji.nextOffset, 7);
  } finally { await f.cleanup(); }
});
