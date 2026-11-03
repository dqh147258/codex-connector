/** Only closed classifications and the numeric JSON-RPC code leave the
 * transport boundary. Raw error.message/error.data are never retained. */
export const RPC_CLASSIFICATIONS = [
  'PARSE_ERROR', 'INVALID_REQUEST', 'METHOD_NOT_FOUND', 'INVALID_PARAMS', 'INTERNAL_ERROR',
  'QUEUE_ENTRY_NOT_FOUND', 'THREAD_BUSY', 'THREAD_RESUME_REQUIRED', 'QUEUE_UNAVAILABLE',
  'UNCLASSIFIED',
] as const;
export type RpcClassification = typeof RPC_CLASSIFICATIONS[number];
export interface RpcDiagnostic { rpcCode: number; classification: RpcClassification }

export function validRpcDiagnostic(value: unknown): value is RpcDiagnostic {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const d = value as RpcDiagnostic;
  return Object.keys(d).length === 2 && Object.hasOwn(d, 'rpcCode') && Object.hasOwn(d, 'classification') &&
    Number.isSafeInteger(d.rpcCode) && RPC_CLASSIFICATIONS.includes(d.classification);
}

export function classifyRpcError(method: string, rpcCode: number, message: string, queuedSubmissionId?: string): RpcDiagnostic {
  let classification: RpcClassification = ({
    [-32700]: 'PARSE_ERROR', [-32600]: 'INVALID_REQUEST', [-32601]: 'METHOD_NOT_FOUND',
    [-32602]: 'INVALID_PARAMS', [-32603]: 'INTERNAL_ERROR',
  } as Record<number, RpcClassification>)[rpcCode] || 'UNCLASSIFIED';
  // Match the exact upstream code, method and complete message. Never guess
  // from substrings, strip arbitrary prefixes, or emit the interpolated ID.
  if (method === 'thread/queue/start' && rpcCode === -32600) {
    if (queuedSubmissionId && message === `queued submission not found: ${queuedSubmissionId}`) classification = 'QUEUE_ENTRY_NOT_FOUND';
    else if (message === 'thread already has an active or pending turn') classification = 'THREAD_BUSY';
    else if (message === 'resume the thread before starting a queued message') classification = 'THREAD_RESUME_REQUIRED';
  }
  if (['thread/queue/add','thread/queue/start','thread/queue/list'].includes(method) && rpcCode === -32600 &&
      message === 'user message queue is unavailable') classification = 'QUEUE_UNAVAILABLE';
  return { rpcCode, classification };
}

export function formatRpcDiagnostic(value: unknown): string {
  return validRpcDiagnostic(value) ? `JSON-RPC ${value.rpcCode}; reason=${value.classification}` : 'RPC details unavailable';
}
