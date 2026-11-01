import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import type { CodexPort, Config } from './types.js';
interface Pending { resolve: (x: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
interface Active { resolve: (s: string) => void; reject: (e: Error) => void; texts: Map<string, string>; turnId?: string; timer: NodeJS.Timeout }
export class AppServer implements CodexPort {
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private sequence = 0;
  private terminating?: Promise<void>;
  private exited?: Promise<void>;
  private pending = new Map<number, Pending>();
  private active = new Map<string, Active>();
  private loaded = new Set<string>();
  constructor(private config: Config) {}
  private async connect() {
    if (this.terminating) await this.terminating;
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const env = { ...process.env };
      delete env.SLACK_APP_TOKEN; delete env.SLACK_BOT_TOKEN; delete env.CONNECTOR_TOKEN;
      const launch = codexLaunch(this.config.codexExecutable);
      const child = spawn(launch.executable, launch.args, { shell: false, env, stdio: 'pipe', detached: process.platform !== 'win32', cwd: Object.values(this.config.projects)[0] });
      this.child = child;
      this.exited = new Promise(resolve => child.once('close', () => resolve()));
      // Never echo stderr: it can contain project content or credential-bearing errors.
      child.stderr.on('data', () => {});
      createInterface({ input: child.stdout }).on('line', line => {
        try { this.message(JSON.parse(line)); } catch { this.fail(Error('Invalid app-server protocol output')); void this.terminate().catch(() => {}); }
      });
      child.on('error', () => this.fail(Error('Cannot start configured Codex executable')));
      child.on('close', () => { this.fail(Error('Codex app-server exited; running requests are not automatically replayed')); this.child = undefined; this.ready = undefined; this.loaded.clear(); });
      await this.request('initialize', { clientInfo: { name: 'codex_connector', title: 'Codex Connector', version: '0.1.0' } });
      this.write({ method: 'initialized', params: {} });
    })();
    try { await this.ready; } catch (e) { await this.terminate(); throw e; }
  }
  private write(value: unknown) {
    if (!this.child?.stdin.writable) throw Error('Codex app-server is not available');
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }
  private request(method: string, params: unknown): Promise<any> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`Codex ${method} timed out`)); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  private message(m: any) {
    if (m.id !== undefined && m.method) {
      const p = m.params || {};
      if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(m.method)) {
        this.write({ id: m.id, result: { decision: 'decline' } });
      } else {
        this.write({ id: m.id, error: { code: -32601, message: 'Interactive requests are not supported by this connector; use local Codex.' } });
      }
      const active = this.active.get(p.threadId);
      if (active) {
        this.finish(p.threadId, Error('Codex requested local approval or input. The connector did not approve it. Continue in local Codex after stopping this managed session.'));
        if (p.turnId || active.turnId) void this.request('turn/interrupt', { threadId: p.threadId, turnId: p.turnId || active.turnId }).catch(() => {});
      }
      return;
    }
    if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id); clearTimeout(p.timer);
      m.error ? p.reject(Error(`Codex protocol request failed (${m.error.code ?? 'unknown'})`)) : p.resolve(m.result);
      return;
    }
    const p = m.params || {}, active = this.active.get(p.threadId);
    if (!active || (active.turnId && p.turnId && active.turnId !== p.turnId)) return;
    if (m.method === 'item/completed' && p.item?.type === 'agentMessage' && typeof p.item.text === 'string') {
      // Prefer final answers; never forward reasoning, tool output, or raw process logs.
      if (!p.item.phase || p.item.phase === 'final_answer') active.texts.set(p.item.id || String(active.texts.size), p.item.text);
    }
    if (m.method === 'turn/completed') {
      if (active.turnId && p.turn?.id && p.turn.id !== active.turnId) return;
      p.turn?.status === 'completed' ? this.finish(p.threadId) : this.finish(p.threadId, Error(`Codex turn ${p.turn?.status || 'failed'}; inspect locally for details`));
    }
  }
  private finish(threadId: string, error?: Error) {
    const active = this.active.get(threadId); if (!active) return;
    this.active.delete(threadId); clearTimeout(active.timer);
    error ? active.reject(error) : active.resolve([...active.texts.values()].join('\n\n') || 'Codex completed without a final text response.');
  }
  private fail(error: Error) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    for (const id of this.active.keys()) this.finish(id, error);
  }
  private threadPolicy() {
    return this.config.sandbox === 'inherit' ? {} : { sandbox: this.config.sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite' };
  }
  private turnPolicy(cwd: string) {
    if (this.config.sandbox === 'inherit') return {};
    return { sandboxPolicy: this.config.sandbox === 'read-only' ? { type: 'readOnly' } : { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false } };
  }
  async start(cwd: string): Promise<string> {
    await this.connect();
    const r = await this.request('thread/start', { cwd, ...this.threadPolicy() });
    if (typeof r?.thread?.id !== 'string') throw Error('Codex did not return a thread ID');
    this.loaded.add(r.thread.id); return r.thread.id;
  }
  async run(threadId: string, cwd: string, text: string, sessionId: string): Promise<string> {
    await this.connect();
    if (this.active.has(threadId)) throw Error('Codex session already has an active turn');
    if (!this.loaded.has(threadId)) {
      await this.request('thread/resume', { threadId, cwd, excludeTurns: true, ...this.threadPolicy() });
      this.loaded.add(threadId);
    }
    const result = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const turnId = this.active.get(threadId)?.turnId;
        this.finish(threadId, Error('Codex turn exceeded 30 minutes; inspect locally before retrying'));
        void this.terminate().catch(() => {});
        if (turnId) void this.request('turn/interrupt', { threadId, turnId }).catch(() => {});
      }, 30 * 60 * 1000);
      this.active.set(threadId, { resolve, reject, texts: new Map(), timer });
    });
    // Attach immediately, including while turn/start is pending, to avoid unhandled rejection.
    result.catch(() => {});
    try {
      const r = await this.request('turn/start', {
        threadId, cwd,
        ...this.turnPolicy(cwd),
        input: [{ type: 'text', text: `Connector session ID: ${sessionId}. This turn came from its authorized Slack thread. Your final answer is relayed automatically. Use the codex-connector Skill only for explicit progress messages; do not send your final answer twice. Do not approve your own operations or bypass sandbox restrictions.\n\nUser message:\n${text}` }]
      });
      const active = this.active.get(threadId); if (active) active.turnId = r?.turn?.id;
    } catch (e) { this.finish(threadId, e instanceof Error ? e : Error('Cannot start turn')); }
    try { return await result; } catch (e) { await this.terminate(); throw e; }
  }
  private terminate(): Promise<void> {
    if (this.terminating) return this.terminating;
    const child = this.child; if (!child?.pid) return Promise.resolve();
    const exited = this.exited!;
    this.fail(Error('Codex app-server stopped; inspect running work before continuing'));
    this.terminating = (async () => {
      if (process.platform === 'win32') {
        // Only our spawned process tree, never a process-name/global kill.
        spawnSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
      } else { try { process.kill(-child.pid!, 'SIGTERM'); } catch { child.kill(); } }
      const wait = (ms: number) => new Promise<boolean>(resolve => {
        const timer = setTimeout(() => resolve(false), ms);
        void exited.then(() => { clearTimeout(timer); resolve(true); });
      });
      if (!await wait(2000)) {
        if (process.platform !== 'win32') { try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
        if (!await wait(2000)) throw Error('Codex process did not exit; do not start another connector until inspected');
      }
    })().finally(() => { this.terminating = undefined; });
    return this.terminating;
  }
  async close() {
    this.fail(Error('Connector is stopping; inspect running turns before retrying'));
    await this.terminate();
  }
}

export function codexLaunch(path: string): { executable: string; args: string[] } {
  if (/\.(cmd|bat)$/i.test(path)) throw Error('Use the absolute Codex bin/codex.js or native .exe path on Windows, not a .cmd/.bat shell shim');
  return /\.(mjs|cjs|js)$/i.test(path) ? { executable: process.execPath, args: [path, 'app-server'] } : { executable: path, args: ['app-server'] };
}
