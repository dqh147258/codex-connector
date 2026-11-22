import type { MessageDelivery } from './session-delivery.js';
import type { ActivityRecord } from './session-activity.js';
import type { NativeDelivery, NativeShare, NativeShareCreation } from './native-share.js';
import type { Subscription } from './subscriptions.js';
import type { CommandEnvelope } from './protocol.js';
export interface Config {
  version: 2; instanceId: string; port: number;
  slack: { enabled?: boolean; servers?: string[]; teamId: string; inputChannel: string; outputChannel: string; allowedHumans: string[]; approvalUsers: string[];
    trustedBots: { botId: string; userId: string; appId: string }[]; dot: { name: string; userId?: string } };
  local?: { enabled?: boolean; agents?: { id: string; tokenHash: string; servers: string[]; projects: string[]; commands: string[] }[] };
  projects: Record<string, string>;
  sessionPolicy?: { allowAllSharedSessions: boolean };
  screenPolicy?: { enabled: boolean };
  filePolicy?: { allowAbsolutePaths: boolean };
  backend: { executable: string; socketPath?: string; codexHome?: string; aliases?: string[]; expectedVersion?: string; autoStartDaemon?: boolean };
  backends?: Record<string, Config['backend']>;
  defaultServerId?: string;
  approvalTimeoutSec: number;
}
export interface Source { kind: 'human' | 'bot' | 'local'; userId: string; channel: string; ts: string; threadTs: string; eventId: string }
export interface Session { localOwners?: string[]; id: string; threadId: string; project: string; cwd?: string; channel: string; threadTs?: string; createdAt: string }
export interface Work { slackMixedInput?:true; localGrant?: string; localResult?: unknown; messageDelivery?: MessageDelivery; id: string; eventId: string; request: CommandEnvelope; source: Source; status: 'queued'|'executing'|'completed'|'failed'|'uncertain'; createdAt: string; error?: string; resultRef?: {sessionId?:string;threadId?:string;turnId?:string;resultId?:string} }
export interface SlackTurnProof { kind:'live'; threadId:string; turnId:string; epoch:string; owner:Source }
export interface SlackVisibilityScope { policy:string; generation:string; proof?:SlackTurnProof }
export interface ResultSnapshot { rootCatalogVersion?:number; scopeVersion?:number; visibility?:SlackVisibilityScope; id:string; command:string; source:Source; createdAt:number; expiresAt:number; policy:string; text:string; nextQuery?:Record<string,unknown>; nextCommand?:'session.list'|'session.messages'|'session.search' }
export interface Delivery { nativeShare?:NativeDelivery; scopeVersion?:number; visibility?:SlackVisibilityScope; id: string; origin?: Source; sessionId?: string; channel: string; threadTs?: string; root: boolean; text: string; mention?:boolean; deliveryEvidence?:'slack-api-ack'|'operator-attested'; subscriptionId?:string; notificationThreadId?:string; status: 'queued'|'sending'|'sent'|'uncertain'|'failed'; attempts: number; nextAttemptAt: number; ts?: string; error?: string }
export interface Pending {
  slackOwner?: Source;
  deadlineOutcome?: 'decline-submitted'|'interrupt-submitted'|'not-attempted'|'outcome-uncertain';
  id: string; rpcId: string|number; epoch: string; sessionId: string; threadId: string; turnId: string;
  method: string; kind: 'command'|'file'|'input'|'unsupported'; status: 'pending'|'responding'|'resolved'|'stale'|'expired'|'local-required';
  details: Record<string, any>; expiresAt: number; decisions: string[];
}
export interface State { version: 2; nativeShares?:NativeShare[]; nativeShareCreations?:NativeShareCreation[]; slackVisibility?:{policy:string;generation:string}; activity?:ActivityRecord[]; subscriptions?:Subscription[]; subscriptionEvents?:Record<string,string[]>; results?:ResultSnapshot[]; sessions: Session[]; work: Work[]; outbox: Delivery[]; pending: Pending[]; seenEvents: Record<string, string>; seenNotifications: Record<string, true>; dot?: { userId: string; name: string; selector?: string } }
export interface Backend {
  epoch: string; connected: boolean;
  readonly observation?: { checkedAt:string|null; version:string|null; homeVerified?:boolean };
  connect(): Promise<void>; close(): Promise<void>; rpc(method: string, params: unknown): Promise<any>; respond(id: string|number, result: unknown): Promise<void>;
  capabilities(): Record<string, unknown>;
  on(event: 'notification'|'request'|'disconnect', listener: (...args: any[]) => void): this;
}
export interface SlackPort {
  uploadScreens?(channel: string, threadTs: string, images: import('./screens.js').ScreenImage[], requestId: string): Promise<void>;
  post(channel: string, text: string, options: { threadTs?: string; mentionUserId?: string; deliveryId: string }): Promise<string>;
  resolveDot(name: string, userId?: string): Promise<{userId: string; name: string}>;
  verifySharedRoot?(channel: string, threadTs: string): Promise<boolean>;
  threadExists(channel: string, threadTs: string): Promise<boolean>;
  humanMessage(channel: string, threadTs: string, ts: string): Promise<any>;
}

export interface LocalPrincipal { id:string; role:'agent'|'operator'; servers?:string[]; projects?:string[]; commands?:string[] }
export const OPERATOR:LocalPrincipal={id:'local',role:'operator'};
