import { containsSensitiveContent } from './files.js';
import type { Work } from './types.js';
import { validRpcDiagnostic, type RpcDiagnostic } from './rpc-diagnostics.js';

/** Command completion is not message completion. This record contains only
 * acknowledgement/correlation metadata, never another copy of message text. */
export interface MessageDelivery {
  threadId: string;
  clientUserMessageId: string;
  queuedSubmissionId?: string;
  turnId?: string;
  admission: 'pending' | 'accepted' | 'rejected' | 'uncertain';
  start: 'not-requested' | 'pending' | 'accepted' | 'rejected' | 'uncertain';
  execution: 'unknown' | 'processing' | 'completed' | 'failed' | 'interrupted';
  evidence: 'submission-attempt' | 'queue-add-response' | 'queue-readback' | 'queue-start-response' | 'user-message' | 'turn-lifecycle';
  observedAt: string;
  observationGap: boolean;
  startError?: string;
  admissionError?: string;
  startDiagnostic?: RpcDiagnostic;
  admissionDiagnostic?: RpcDiagnostic;
  correlationConflict?: true;
}
export const deliveryId = (value: unknown): value is string => typeof value === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$(?![\s\S])/.test(value) && !containsSensitiveContent(value);
export const terminalExecution = (value: string) => ['completed', 'failed', 'interrupted'].includes(value);

export function deliveryStatus(work: Work): string {
  const d = work.messageDelivery;
  if (!d) return work.status === 'queued' ? 'queued' : work.status === 'failed' ? 'not-submitted' : 'unknown';
  if (d.correlationConflict) return 'uncertain';
  if (d.execution !== 'unknown') return d.execution;
  if (d.admission === 'rejected') return 'not-submitted';
  if (d.admission !== 'accepted' || ['pending', 'uncertain'].includes(d.start)) return 'uncertain';
  return 'accepted';
}
export function deliveryView(work: Work) {
  return {
    workId: work.id, requestId: work.request.id, sessionId: work.request.params.sessionId,
    commandStatus: work.status, deliveryStatus: deliveryStatus(work),
    ...(work.messageDelivery ? { ...work.messageDelivery } : {}),
    note: 'Command status describes the connector operation, not model completion. Accepted means queue admission was acknowledged, not that the message is still queued. Execution requires exact message/turn correlation. Do not resend with a new request ID to resolve uncertainty.',
  };
}

/** Monotonic correlated evidence. Unknown turn status, unrelated turns, empty
 * IDs, final assistant text and generic thread activity cannot prove delivery. */
export function observeMessage(d: MessageDelivery, threadId: unknown, turnId: unknown, item: any, now: string): boolean {
  if (threadId !== d.threadId || !deliveryId(turnId) || item?.type !== 'userMessage' ||
      item.clientId !== d.clientUserMessageId || !deliveryId(item.id)) return false;
  if (d.turnId && d.turnId !== turnId) { const changed = !d.correlationConflict; d.correlationConflict = true; return changed; }
  if (terminalExecution(d.execution)) return false;
  const changed = d.turnId !== turnId || d.execution !== 'processing';
  if (changed) { d.turnId = turnId; d.execution = 'processing'; d.evidence = 'user-message'; d.observedAt = now; }
  return changed;
}
export function observeTurn(d: MessageDelivery, threadId: unknown, turn: any, now: string): boolean {
  if (threadId !== d.threadId || !d.turnId || turn?.id !== d.turnId) return false;
  if (terminalExecution(d.execution)) {
    if (terminalExecution(turn.status) && turn.status !== d.execution) { const changed = !d.correlationConflict; d.correlationConflict = true; return changed; }
    return false;
  }
  const execution = turn.status === 'inProgress' ? 'processing' :
    ['completed', 'failed', 'interrupted'].includes(turn.status) ? turn.status as MessageDelivery['execution'] : undefined;
  if (!execution || execution === d.execution) return false;
  d.execution = execution; d.evidence = 'turn-lifecycle'; d.observedAt = now;
  return true;
}

export function validateMessageDelivery(work: Work) {
  const d = work.messageDelivery;
  if (d === undefined) return;
  const allowed = new Set(['threadId','clientUserMessageId','queuedSubmissionId','turnId','admission','start','execution','evidence','observedAt','observationGap','startError','admissionError','startDiagnostic','admissionDiagnostic','correlationConflict']);
  if (!d || typeof d !== 'object' || Array.isArray(d) || Object.keys(d).some(k => !allowed.has(k)) ||
      !['session.send','session.queue'].includes(work.request.command) || !deliveryId(d.threadId) ||
      d.clientUserMessageId !== work.id || !deliveryId(d.clientUserMessageId) ||
      (d.queuedSubmissionId !== undefined && !deliveryId(d.queuedSubmissionId)) ||
      (d.turnId !== undefined && !deliveryId(d.turnId)) ||
      !['pending','accepted','rejected','uncertain'].includes(d.admission) ||
      !['not-requested','pending','accepted','rejected','uncertain'].includes(d.start) ||
      !['unknown','processing','completed','failed','interrupted'].includes(d.execution) ||
      !['submission-attempt','queue-add-response','queue-readback','queue-start-response','user-message','turn-lifecycle'].includes(d.evidence) ||
      typeof d.observedAt !== 'string' || !Number.isFinite(Date.parse(d.observedAt)) ||
      typeof d.observationGap !== 'boolean' ||
      [d.startError,d.admissionError].some(v => v !== undefined && (typeof v !== 'string' || !/^[A-Z_]{1,80}$/.test(v))) ||
      [d.startDiagnostic,d.admissionDiagnostic].some(v => v !== undefined && !validRpcDiagnostic(v)) ||
      (d.startDiagnostic !== undefined && d.startError === undefined) ||
      (d.admissionDiagnostic !== undefined && d.admissionError === undefined) ||
      (d.correlationConflict !== undefined && d.correlationConflict !== true) ||
      (d.execution !== 'unknown' && !d.turnId)) throw Error('INVALID_MESSAGE_DELIVERY_STATE');
}
