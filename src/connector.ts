import { randomUUID } from 'node:crypto';
import type { CodexPort, Config, Job, Mode, Session, SlackPort } from './types.js';
import { Store } from './store.js';
const validId = /^[a-zA-Z0-9_-]{1,100}$/;
const validTs = /^\d+\.\d+$/;
export class Connector {
  private running = new Map<string, Promise<void>>();
  private creating = new Set<string>();
  private stopping = false;
  constructor(readonly config: Config, readonly store: Store, private slack: SlackPort, private codex: CodexPort) {}
  private project(alias: string): string {
    if (!Object.hasOwn(this.config.projects, alias)) throw Error('Unknown project alias');
    return this.config.projects[alias]!;
  }
  session(id: string): Session {
    const s = this.store.state.sessions.find(s => s.id === id);
    if (!s) throw Error('Unknown session'); return s;
  }
  async create(input: { id?: string; mode?: Mode; channel: string; project: string; title?: string; threadTs?: string }) {
    const id = input.id || randomUUID(), mode = input.mode || 'mailbox';
    if (!validId.test(id) || !['managed', 'mailbox'].includes(mode)) throw Error('Invalid session ID or mode');
    if (this.store.state.sessions.some(s => s.id === id) || this.creating.has(id)) throw Error('Session ID already exists');
    if (!this.config.allowedChannels.includes(input.channel)) throw Error('Channel is not allowed');
    this.project(input.project);
    if (input.threadTs && !validTs.test(input.threadTs)) throw Error('Invalid Slack thread timestamp');
    if (input.threadTs && this.store.state.sessions.some(s => s.channel === input.channel && s.threadTs === input.threadTs)) throw Error('Slack thread is already bound');
    this.creating.add(id);
    try {
      const threadTs = input.threadTs || await this.slack.post(input.channel, `Codex session: ${id}\nMode: ${mode}\nProject: ${input.project}\n${(input.title || '').slice(0, 1000)}`);
      const session: Session = { id, mode, channel: input.channel, threadTs, project: input.project, createdAt: new Date().toISOString() };
      this.store.state.sessions.push(session); this.store.save(); return session;
    } finally { this.creating.delete(id); }
  }
  async send(id: string, text: string) {
    const session = this.session(id); this.authorize(session); this.validateText(text);
    return { ts: await this.slack.post(session.channel, text, session.threadTs) };
  }
  private authorize(session: Session) {
    if (!this.config.allowedChannels.includes(session.channel)) throw Error('Session channel is no longer allowed');
    this.project(session.project);
  }
  private validateText(text: string) { if (typeof text !== 'string' || !text.trim() || text.length > 50000) throw Error('Text must contain 1–50000 characters'); }
  enqueue(id: string, text: string, user = 'local', eventId = randomUUID(), ts = ''): Job {
    this.validateText(text); const s = this.session(id); this.authorize(s);
    const previous = this.store.state.jobs.find(j => j.id === eventId);
    if (previous) return previous;
    if (this.store.state.jobs.filter(j => j.sessionId === id && ['queued', 'running'].includes(j.status)).length >= 100) throw Error('Session queue is full');
    const job: Job = { id: eventId, sessionId: s.id, user, text, ts, status: 'queued' };
    this.store.state.jobs.push(job); this.store.state.seen[eventId] = Date.now(); this.store.save();
    return job;
  }
  // Called before Socket Mode ack. Nothing is executed until the accepted job is durable.
  async accept(body: any): Promise<string | undefined> {
    if (body?.team_id !== this.config.teamId || typeof body?.event_id !== 'string') return;
    if (this.store.state.seen[body.event_id]) return;
    const e = body.event;
    if (!e || e.type !== 'message' || e.subtype || e.bot_id || e.app_id || typeof e.text !== 'string' || typeof e.user !== 'string') return;
    if (!this.config.allowedUsers.includes(e.user) || !this.config.allowedChannels.includes(e.channel)) return;
    let session = this.store.state.sessions.find(s => s.channel === e.channel && s.threadTs === (e.thread_ts || e.ts));
    if (!session && !e.thread_ts) {
      const match = /^!codex new ([a-zA-Z0-9_-]+)\s+([\s\S]+)$/.exec(e.text);
      if (!match || !validTs.test(e.ts)) return;
      // The user's root message is the Slack thread parent. No output is sent before ack.
      const alias = match[1]!, prompt = match[2]!;
      if (!Object.hasOwn(this.config.projects, alias)) return;
      session = await this.create({ id: `slack-${body.event_id}`, mode: 'managed', channel: e.channel, project: alias, threadTs: e.ts });
      e.text = prompt;
    }
    if (!session) return;
    if (!e.thread_ts && session.id === `slack-${body.event_id}`) e.text = e.text.replace(/^!codex new [a-zA-Z0-9_-]+\s+/, '');
    this.enqueue(session.id, e.text, e.user, body.event_id, e.ts);
    return session.id;
  }
  read(id: string) { this.session(id); return this.store.state.jobs.filter(j => j.sessionId === id && j.status === 'queued'); }
  ack(id: string, jobIds: string[]) {
    if (this.session(id).mode !== 'mailbox') throw Error('Only mailbox sessions support manual acknowledgement');
    if (!Array.isArray(jobIds) || jobIds.some(x => typeof x !== 'string')) throw Error('jobIds must be strings');
    for (const job of this.store.state.jobs) if (job.sessionId === id && jobIds.includes(job.id) && job.status === 'queued') job.status = 'done';
    this.store.save(); return { acknowledged: jobIds.length };
  }
  status(id?: string) {
    if (id) this.session(id);
    return { sessions: this.store.state.sessions.filter(s => !id || s.id === id), jobs: this.store.state.jobs.filter(j => !id || j.sessionId === id).map(({ text, ...j }) => j) };
  }
  pump(id: string) {
    if (this.stopping || this.running.has(id) || this.session(id).mode !== 'managed') return;
    const task = this.drain(id).catch(() => { /* Fail closed on storage/config failures; never replay automatically. */ }).finally(() => this.running.delete(id));
    this.running.set(id, task);
  }
  resumeQueues() { for (const s of this.store.state.sessions) this.pump(s.id); }
  private async drain(id: string) {
    const s = this.session(id);
    try { this.authorize(s); } catch { return; }
    const cwd = this.project(s.project);
    while (!this.stopping) {
      // Uncertain/failed jobs require an operator review; avoid running queued requests against unknown state.
      if (this.store.state.jobs.some(j => j.sessionId === id && ['uncertain', 'failed'].includes(j.status))) return;
      const job = this.store.state.jobs.find(j => j.sessionId === id && j.status === 'queued'); if (!job) return;
      if (job.user !== 'local' && !this.config.allowedUsers.includes(job.user)) return;
      job.status = 'running'; this.store.save();
      try {
        if (!s.codexThreadId) { s.codexThreadId = await this.codex.start(cwd); this.store.save(); }
        const response = await this.codex.run(s.codexThreadId, cwd, job.text, s.id);
        await this.slack.post(s.channel, response, s.threadTs);
        job.status = 'done'; this.store.save();
      } catch {
        // Error bodies may contain secrets. Surface a generic action plus a durable job identifier.
        job.status = 'failed'; job.error = 'Execution or Slack delivery failed. No automatic replay. Inspect local Codex/Slack, then resolve this job before continuing.';
        this.store.save();
        try { await this.slack.post(s.channel, `Connector paused this session (job ${job.id}). Execution, approval/input, or delivery needs local inspection. No automatic retry; use codex-connector status and resolve locally.`, s.threadTs); } catch { /* state remains authoritative */ }
        return;
      }
    }
  }
  resolve(id: string, jobId: string) {
    const job = this.store.state.jobs.find(j => j.sessionId === id && j.id === jobId);
    if (!job || !['uncertain', 'failed'].includes(job.status)) throw Error('Job is not paused');
    job.status = 'done'; job.error = 'Operator reviewed and resolved without replay'; this.store.save(); return { resolved: jobId };
  }
  async close() { this.stopping = true; await this.codex.close(); await Promise.all(this.running.values()); }
}
