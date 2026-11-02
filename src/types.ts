import type { CommandEnvelope } from './protocol.js';
export interface Config {
  version: 2; instanceId: string; port: number;
  slack: { teamId: string; inputChannel: string; outputChannel: string; allowedHumans: string[]; approvalUsers: string[];
    trustedBots: { botId: string; userId: string; appId: string }[]; dot: { name: string; userId?: string } };
  projects: Record<string, string>;
  sessionPolicy?: { allowAllSharedSessions: boolean };
  backend: { executable: string; socketPath?: string; expectedVersion?: string; autoStartDaemon?: boolean };
  approvalTimeoutSec: number;
}
export interface Source { kind: 'human' | 'bot' | 'local'; userId: string; channel: string; ts: string; threadTs: string; eventId: string }
export interface Session { id: string; threadId: string; project: string; cwd?: string; channel: string; threadTs?: string; createdAt: string }
export interface Work { id: string; eventId: string; request: CommandEnvelope; source: Source; status: 'queued'|'executing'|'completed'|'failed'|'uncertain'; createdAt: string; error?: string; resultRef?: {sessionId?:string;threadId?:string;turnId?:string} }
export interface Delivery { id: string; sessionId?: string; channel: string; threadTs?: string; root: boolean; text: string; status: 'queued'|'sending'|'sent'|'uncertain'|'failed'; attempts: number; nextAttemptAt: number; ts?: string; error?: string }
export interface Pending {
  id: string; rpcId: string|number; epoch: string; sessionId: string; threadId: string; turnId: string;
  method: string; kind: 'command'|'file'|'input'|'unsupported'; status: 'pending'|'responding'|'resolved'|'stale'|'expired'|'local-required';
  details: Record<string, any>; expiresAt: number; decisions: string[];
}
export interface State { version: 2; sessions: Session[]; work: Work[]; outbox: Delivery[]; pending: Pending[]; seenEvents: Record<string, string>; seenNotifications: Record<string, true>; dot?: { userId: string; name: string; selector?: string } }
export interface Backend {
  epoch: string; connected: boolean;
  connect(): Promise<void>; close(): Promise<void>; rpc(method: string, params: unknown): Promise<any>; respond(id: string|number, result: unknown): Promise<void>;
  capabilities(): Record<string, unknown>;
  on(event: 'notification'|'request'|'disconnect', listener: (...args: any[]) => void): this;
}
export interface SlackPort {
  post(channel: string, text: string, options: { threadTs?: string; mentionUserId: string; deliveryId: string }): Promise<string>;
  resolveDot(name: string, userId?: string): Promise<{userId: string; name: string}>;
  humanMessage(channel: string, threadTs: string, ts: string): Promise<any>;
}
