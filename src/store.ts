import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { State } from './types.js';
const empty = (): State => ({ version: 2, sessions: [], work: [], outbox: [], pending: [], seenEvents: {}, seenNotifications: {} });
export class Store {
  private value: State; private lock: number; private poisoned = false; private closed = false;
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.lock = openSync(join(dir, 'daemon.lock'), 'wx', 0o600); writeFileSync(this.lock, String(process.pid));
    try {
      this.value = existsSync(join(dir, 'state.json')) ? JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) : empty();
      if (this.value.version !== 2 || !Array.isArray(this.value.sessions) || !this.value.seenEvents || typeof this.value.seenEvents!=='object' || Array.isArray(this.value.seenEvents) || !this.value.seenNotifications || typeof this.value.seenNotifications!=='object' || Array.isArray(this.value.seenNotifications) || !Array.isArray(this.value.work) || !Array.isArray(this.value.outbox) || !Array.isArray(this.value.pending)) throw Error('State v2 required; never overwrite old state. Back it up and migrate explicitly.');
      this.transaction(s => {
        for (const w of s.work) if (w.status === 'executing') { w.status = 'uncertain'; w.error = 'Restart during execution; never auto-replay'; }
        for (const o of s.outbox) if (o.status === 'sending') { o.status = 'uncertain'; o.error = 'Delivery may have occurred; inspect Slack before recovery'; }
        for (const p of s.pending) if (['pending','responding'].includes(p.status)) p.status = 'stale';
      });
    } catch (e) { this.close(); throw e; }
  }
  get state(): Readonly<State> { return structuredClone(this.value); }
  assertHealthy() { if (this.poisoned || this.closed) throw Error('STORE_UNAVAILABLE: repair storage and restart safely'); }
  transaction<T>(change: (draft: State) => T): T {
    this.assertHealthy(); const draft = structuredClone(this.value); const result = change(draft);
    try {
      const path = join(this.dir, 'state.json'), temp = path + '.tmp', fd = openSync(temp, 'w', 0o600);
      try { writeFileSync(fd, JSON.stringify(draft, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, path); this.value = draft;
    } catch (e) { this.poisoned = true; throw e; }
    return result;
  }
  close() { if (this.closed) return; this.closed = true; closeSync(this.lock); unlinkSync(join(this.dir, 'daemon.lock')); }
}
