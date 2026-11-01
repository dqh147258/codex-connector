import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { State } from './types.js';
export class Store {
  state: State;
  private lock: number;
  private committed?: State;
  private failed = false;
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.lock = openSync(join(dir, 'daemon.lock'), 'wx', 0o600);
    writeFileSync(this.lock, String(process.pid));
    try {
      this.state = existsSync(join(dir, 'state.json')) ? JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) : { version: 1, sessions: [], jobs: [], seen: {} };
      if (this.state.version !== 1 || !Array.isArray(this.state.sessions) || !Array.isArray(this.state.jobs) || !this.state.seen) throw Error('Unsupported or corrupt state');
      // A crash can occur after Codex ran but before we recorded its completion. Never replay automatically.
      for (const j of this.state.jobs) if (j.status === 'running') { j.status = 'uncertain'; j.error = 'Daemon stopped during execution; inspect the session before issuing another request.'; }
      this.committed = structuredClone(this.state);
      this.save();
    } catch (e) { this.close(); throw e; }
  }
  save() {
    try {
      // Even a previously poisoned store must roll back callers' new mutations.
      // Otherwise a repeated failed enqueue can leave an undurable `seen` entry.
      if (this.failed) throw Error('State persistence failed; restart after repairing local storage.');
      const file = join(this.dir, 'state.json'), temp = `${file}.tmp`;
      const fd = openSync(temp, 'w', 0o600);
      try { writeFileSync(fd, JSON.stringify(this.state, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, file); chmodSync(file, 0o600);
      this.committed = structuredClone(this.state);
    } catch (e) {
      this.failed = true;
      if (this.committed) this.state = structuredClone(this.committed);
      throw e;
    }
  }
  close() { closeSync(this.lock); unlinkSync(join(this.dir, 'daemon.lock')); }
}
