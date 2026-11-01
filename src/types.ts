export type Mode = 'managed' | 'mailbox';
export interface Session {
  id: string; mode: Mode; channel: string; threadTs: string; project: string;
  codexThreadId?: string; createdAt: string;
}
export interface Job {
  id: string; sessionId: string; user: string; text: string; ts: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'uncertain';
  error?: string;
}
export interface State {
  version: 1; sessions: Session[]; jobs: Job[]; seen: Record<string, number>;
}
export interface Config {
  teamId: string; allowedUsers: string[]; allowedChannels: string[];
  projects: Record<string, string>; port: number; codexExecutable: string;
  sandbox: 'read-only' | 'workspace-write' | 'inherit';
}
export interface SlackPort {
  post(channel: string, text: string, threadTs?: string): Promise<string>;
}
export interface CodexPort {
  start(cwd: string): Promise<string>;
  run(threadId: string, cwd: string, text: string, sessionId: string): Promise<string>;
  close(): Promise<void>;
}
