import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRpcError, formatRpcDiagnostic, validRpcDiagnostic } from '../src/rpc-diagnostics.js';
import { BackendError } from '../src/codex.js';

test('queue diagnostics require exact method, code and full trusted reason', () => {
  const classify = (message: string, code = -32600, method = 'thread/queue/start', id = 'queue-1') => classifyRpcError(method, code, message, id);
  assert.deepEqual(classify('queued submission not found: queue-1'), { rpcCode: -32600, classification: 'QUEUE_ENTRY_NOT_FOUND' });
  assert.equal(classify('thread already has an active or pending turn').classification, 'THREAD_BUSY');
  assert.equal(classify('resume the thread before starting a queued message').classification, 'THREAD_RESUME_REQUIRED');
  assert.equal(classify('user message queue is unavailable').classification, 'QUEUE_UNAVAILABLE');
  for (const message of ['queued submission not found: other-queue', 'queued submission not found: queue-1\n', 'prefix thread already has an active or pending turn', 'thread already has an active or pending turn\nsecret', 'unrecognized message /private/path']) {
    assert.equal(classify(message).classification, 'INVALID_REQUEST');
  }
  assert.equal(classify('queued submission not found: queue-1', -32603).classification, 'INTERNAL_ERROR');
  assert.equal(classify('queued submission not found: queue-1', -32600, 'thread/queue/add').classification, 'INVALID_REQUEST');
  assert.equal(classify('queue is empty').classification, 'INVALID_REQUEST', 'no selected-entry absence is inferred');
});

test('known code classes and unknown codes retain no raw text or data', () => {
  const expected = [[-32700,'PARSE_ERROR'],[-32600,'INVALID_REQUEST'],[-32601,'METHOD_NOT_FOUND'],[-32602,'INVALID_PARAMS'],[-32603,'INTERNAL_ERROR'],[-32099,'UNCLASSIFIED']] as const;
  for (const [code, classification] of expected) {
    const d = classifyRpcError('thread/read', code, 'private prompt\n/private/path?token=fixture-secret');
    const error = new BackendError('RPC_REJECTED', undefined, d);
    assert.deepEqual(error.diagnostic, { rpcCode: code, classification });
    assert.equal(error.message, 'RPC_REJECTED');
    assert.doesNotMatch(JSON.stringify(error) + error.stack, /private prompt|private\/path|fixture-secret/);
    assert.match(formatRpcDiagnostic(d), new RegExp(String(code)));
  }
});

test('diagnostic validation fails closed on arbitrary fields, labels and invalid numeric codes', () => {
  for (const value of [null, [], {}, {rpcCode:-32600,classification:'private-data'}, {rpcCode:-32600,classification:'INVALID_REQUEST',message:'private-data'}, {rpcCode:'-32600',classification:'INVALID_REQUEST'}, {rpcCode:Infinity,classification:'INVALID_REQUEST'}, {rpcCode:1.5,classification:'INVALID_REQUEST'}, {rpcCode:Number.MAX_SAFE_INTEGER+1,classification:'INVALID_REQUEST'}]) {
    assert.equal(validRpcDiagnostic(value), false);
    assert.equal(formatRpcDiagnostic(value), 'RPC details unavailable');
    assert.equal(new BackendError('RPC_REJECTED', undefined, value as any).diagnostic, undefined);
  }
});
