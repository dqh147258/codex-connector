import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, END_MARKER, MAX_ENVELOPE_BYTES, ProtocolError, START_MARKER, commandHelp, formatHelp, parseEnvelope, validateCommand } from '../src/protocol.js';
const target = 'connector-home';
const envelope = (command = 'help', params: unknown = {}, extra: Record<string, unknown> = {}) => `${START_MARKER}\n${JSON.stringify({ v: 1, id: 'request-00000001', target, command, params, ...extra })}\n${END_MARKER}`;
const throwsCode = (fn: () => unknown, code: string) => assert.throws(fn, e => e instanceof ProtocolError && e.code === code);
test('strict envelope accepts valid command and CRLF, preserves literal user text', () => {
  const text = 'A quoted `$(not-executed)` instruction\n你好 & <@U123>'; const parsed = parseEnvelope(envelope('session.send', { sessionId: 'session-1', text }), target);
  assert.equal(parsed.command, 'session.send'); assert.equal(parsed.params.text, text); assert.equal(parsed.id, 'request-00000001');
  assert.deepEqual(parseEnvelope(envelope().replaceAll('\n', '\r\n'), target), parseEnvelope(envelope(), target));
});
test('requires exactly one whole-message start/end pair without prefix, suffix, code fences or blank lines', () => {
  const valid = envelope();
  for (const value of [`prefix\n${valid}`, `${valid}\nsuffix`, ` ${valid}`, `${valid}\n`, `\n${valid}`, `\`\`\`json\n${valid}\n\`\`\``, valid + '\n' + valid, valid.replace(START_MARKER, 'BEGIN'), valid.replace(END_MARKER, 'END'), valid.replaceAll('\n', '\r')]) throwsCode(() => parseEnvelope(value, target), 'invalid_envelope');
});
test('reserved delimiters are forbidden even inside JSON text strings', () => {
  for (const marker of [START_MARKER, END_MARKER]) {
    throwsCode(() => parseEnvelope(envelope('session.send', { sessionId: 'session-1', text: marker }), target), 'invalid_envelope');
    const json = JSON.stringify({ v: 1, id: 'request-00000001', target, command: 'session.send', params: { sessionId: 's1', text: marker } }).replaceAll('C', '\\u0043');
    throwsCode(() => parseEnvelope(`${START_MARKER}\n${json}\n${END_MARKER}`, target), 'invalid_envelope');
  }
});
test('requires exact envelope keys/version/target and safe unique-command ID format', () => {
  throwsCode(() => parseEnvelope(envelope('help', {}, { actor: 'trusted-admin' }), target), 'invalid_envelope');
  throwsCode(() => parseEnvelope(envelope('help', {}, { user: 'U123' }), target), 'invalid_envelope');
  throwsCode(() => parseEnvelope(envelope('help', {}, { v: 2 }), target), 'unsupported_version');
  throwsCode(() => parseEnvelope(envelope(), 'different-connector'), 'wrong_target');
  for (const id of ['short', 'with spaces', '../../traverse', 'a'.repeat(129), 42]) throwsCode(() => parseEnvelope(envelope('help', {}, { id }), target), 'invalid_envelope');
  throwsCode(() => parseEnvelope(`${START_MARKER}\n[]\n${END_MARKER}`, target), 'invalid_envelope');
});
test('rejects duplicate and escaped duplicate JSON keys before choosing command or target', () => {
  const body = '{"v":1,"id":"request-00000001","target":"connector-home","command":"help","params":{}}';
  for (const changed of [body.replace('"v":1', '"v":1,"v":1'), body.replace('"target":"connector-home"', '"target":"evil","tar\\u0067et":"connector-home"'), body.replace('"params":{}', '"params":{"command":"help","command":"session.send"}')]) throwsCode(() => parseEnvelope(`${START_MARKER}\n${changed}\n${END_MARKER}`, target), 'invalid_json');
});
test('rejects prototype-pollution keys, including nested input answer keys', () => {
  const raw = envelope('input.respond', { requestId: 'pending-1', epoch: 'epoch-1', sessionId: 's1', turnId: 't1', answers: { safe: ['ok'] } });
  for (const key of ['__proto__', 'constructor', 'prototype']) throwsCode(() => parseEnvelope(raw.replace('"safe"', `"${key}"`), target), 'invalid_json');
  assert.equal(({} as any).polluted, undefined);
  throwsCode(() => validateCommand('help', JSON.parse('{"__proto__":{}}')), 'invalid_params');
});
test('rejects malformed/trailing/deep JSON and byte-oversized input', () => {
  for (const body of ['{', '{"v":1,}', '{} {}', '{"x":"unescaped\nnewline"}', '{"x":[1,]}', '{"x":01}', '{"x":undefined}', '{"x":' + '['.repeat(20) + '0' + ']'.repeat(20) + '}']) throwsCode(() => parseEnvelope(`${START_MARKER}\n${body}\n${END_MARKER}`, target), 'invalid_json');
  throwsCode(() => parseEnvelope(envelope('session.send', { sessionId: 's1', text: '字'.repeat(MAX_ENVELOPE_BYTES / 2) }), target), 'too_large');
});
test('command registry denies arbitrary shell/RPC and unknown or claimed-actor params', () => {
  for (const command of ['shell', 'exec', 'rpc', 'thread/start', 'session.delete', '__proto__', 'constructor']) throwsCode(() => parseEnvelope(envelope(command), target), 'unknown_command');
  for (const extra of [{ actor: 'U123' }, { cwd: '/tmp/arbitrary' }, { executable: '/bin/sh' }, { sandbox: 'danger-full-access' }, { approvalPolicy: 'never' }, { command: 'rm -rf' }]) throwsCode(() => parseEnvelope(envelope('session.send', { sessionId: 's1', text: 'test', ...extra }), target), 'invalid_params');
  for (const params of [null, [], 'text', new Date(), Object.create({ inherited: true })]) throwsCode(() => validateCommand('help', params), 'invalid_params');
});
test('session control validates bounded IDs, text, optional queue resume and exact active-turn correlation', () => {
  assert.equal(validateCommand('session.queue', { sessionId: 's1', text: 'later', resume: true }).resume, true);
  for (const params of [{ sessionId: 's1' }, { sessionId: 's1', text: '' }, { sessionId: 's1', text: ' '.repeat(3) }, { sessionId: 's1', text: 'x'.repeat(20001) }]) throwsCode(() => validateCommand('session.send', params), 'invalid_params');
  throwsCode(() => validateCommand('session.steer', { sessionId: 's1', text: 'x' }), 'invalid_params');
  throwsCode(() => validateCommand('session.interrupt', { sessionId: 's1' }), 'invalid_params');
  throwsCode(() => validateCommand('session.queue', { sessionId: 's1', text: 'x', resume: 'yes' }), 'invalid_params');
  throwsCode(() => validateCommand('session.create', { project: '../escape' }), 'invalid_params');
});
test('approval decisions require complete exact correlation and never accept broader scopes', () => {
  const correlation = { requestId: 'pending-1', epoch: 'epoch-1', sessionId: 's1', turnId: 't1' };
  for (const decision of ['accept', 'decline', 'cancel']) assert.equal(validateCommand('approval.respond', { ...correlation, decision }).decision, decision);
  for (const decision of ['acceptForSession', 'always', 'allow-all', { accept: true }]) throwsCode(() => validateCommand('approval.respond', { ...correlation, decision }), 'invalid_params');
  for (const key of Object.keys(correlation)) { const params: Record<string, unknown> = { ...correlation, decision: 'accept' }; delete params[key]; throwsCode(() => validateCommand('approval.respond', params), 'invalid_params'); }
  throwsCode(() => validateCommand('approval.respond', { ...correlation, decision: 'accept', permissions: { network: true } }), 'invalid_params');
});
test('input responses validate question/answer shape, while runtime owns advertised-option validation', () => {
  const correlation = { requestId: 'pending-1', epoch: 'epoch-1', sessionId: 's1', turnId: 't1' };
  assert.deepEqual(validateCommand('input.respond', { ...correlation, answers: { question1: ['yes'] } }).answers, { question1: ['yes'] });
  for (const answers of [{}, [], { question1: 'yes' }, { question1: [1] }, { question1: ['x'.repeat(4001)] }, { question1: Array(17).fill('yes') }, Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`q${i}`, ['yes']]))]) throwsCode(() => validateCommand('input.respond', { ...correlation, answers }), 'invalid_params');
});
test('readonly file command bounds reject widening options, regex and arbitrary roots', () => {
  assert.equal(validateCommand('files.read', { root: 'project-a', path: 'src/a.ts', maxBytes: 4096 }).maxBytes, 4096);
  for (const params of [{ root: '/etc', path: 'passwd' }, { root: 'repo', path: 'a', maxBytes: 65537 }, { root: 'repo', path: 'a', offset: -1 }, { root: 'repo', path: 'a', offset: 1.5 }]) throwsCode(() => validateCommand('files.read', params), 'invalid_params');
  throwsCode(() => validateCommand('files.search', { root: 'repo', query: 'x', regex: true }), 'invalid_params');
  throwsCode(() => validateCommand('files.search', { root: 'repo', query: 'x', maxDepth: 9 }), 'invalid_params');
});
test('help is generated from the same registry, includes params/errors/examples/permissions/capabilities', () => {
  const help = commandHelp(); assert.equal(help.commands.length, Object.keys(COMMANDS).length);
  for (const spec of help.commands) { assert.ok(spec.permission); assert.ok(spec.capability); assert.ok(spec.errors.length); assert.ok(spec.examples.length); assert.ok(formatHelp(spec.name).includes(spec.name)); validateCommand(spec.name, spec.examples[0]); }
  const text = formatHelp('approval.respond'); assert.ok(text.includes('epoch')); assert.ok(text.includes('required')); assert.ok(text.includes('accept|decline|cancel')); assert.ok(text.includes('Errors:')); assert.ok(text.includes('Example params:')); assert.ok(text.includes('approval-decision'));
  throwsCode(() => commandHelp('unknown'), 'unknown_command');
});

test('bot relay proof is only a bounded timestamp locator on decision commands, never claimed authority', () => {
  const correlation = { requestId: 'pending-1', epoch: 'epoch-1', sessionId: 's1', turnId: 't1' };
  assert.equal(validateCommand('approval.respond', { ...correlation, decision: 'decline', humanMessageTs: '1700000000.123456' }).humanMessageTs, '1700000000.123456');
  for (const humanMessageTs of ['https://slack.test/message', '<@U1>', 1700000000, '1700000000']) throwsCode(() => validateCommand('approval.respond', { ...correlation, decision: 'decline', humanMessageTs }), 'invalid_params');
  throwsCode(() => validateCommand('session.send', { sessionId: 's1', text: 'hello', humanMessageTs: '1700000000.123456' }), 'invalid_params');
  throwsCode(() => validateCommand('approval.respond', { ...correlation, decision: 'decline', humanMessageTs: '1700000000.123456', humanUserId: 'U123' }), 'invalid_params');
});

test('session.reply sends literal progress only to an existing mapped session, without routing overrides', () => {
  const parsed = parseEnvelope(envelope('session.reply', { sessionId: 'session-demo', text: 'Progress: done.' }), target);
  assert.equal(parsed.command, 'session.reply');
  assert.equal(parsed.params.text, 'Progress: done.');
  assert.equal(COMMANDS['session.reply'].capability, 'session.reply');
  assert.ok(formatHelp('session.reply').includes('without invoking Codex'));
  throwsCode(() => validateCommand('session.reply', { sessionId: 'session-demo' }), 'invalid_params');
  for (const extra of [{ channel: 'COTHER' }, { threadTs: '1700000000.123456' }, { mentionUserId: 'UOTHER' }]) throwsCode(() => validateCommand('session.reply', { sessionId: 'session-demo', text: 'Progress', ...extra }), 'invalid_params');
});
