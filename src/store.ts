import { closeSync, copyFileSync, constants, existsSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateMessageDelivery } from './session-delivery.js';
import { validateActivityRecords } from './session-activity.js';
import type { State } from './types.js';
const empty = (): State => ({ version: 2, sessions: [], work: [], outbox: [], pending: [], seenEvents: {}, seenNotifications: {} });
export class Store {
  private value: State; private lock: number; private poisoned = false; private closed = false;
  constructor(readonly dir: string, pin?:{id:string;fingerprint:string;allowLegacy:boolean}) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.lock = openSync(join(dir, 'daemon.lock'), 'wx', 0o600); writeFileSync(this.lock, String(process.pid));
    try {
      this.value = existsSync(join(dir, 'state.json')) ? JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) : empty();
      if (this.value.version !== 2 || !Array.isArray(this.value.sessions) || !this.value.seenEvents || typeof this.value.seenEvents!=='object' || Array.isArray(this.value.seenEvents) || !this.value.seenNotifications || typeof this.value.seenNotifications!=='object' || Array.isArray(this.value.seenNotifications) || !Array.isArray(this.value.work) || !Array.isArray(this.value.outbox) || !Array.isArray(this.value.pending)) throw Error('State v2 required; never overwrite old state. Back it up and migrate explicitly.');
      const statePath=join(dir,'state.json'),saved=(this.value as State & {targetPin?:{id:string;fingerprint:string}}).targetPin;
      if(pin&&saved&&(saved.id!==pin.id||saved.fingerprint!==pin.fingerprint))throw Error('TARGET_CHANGED');
      const legacy=Boolean(pin&&!saved&&existsSync(statePath));
      if(legacy&&!pin!.allowLegacy)throw Error('LEGACY_TARGET_AMBIGUOUS');
      if(legacy){const backup=join(dir,'state.before-server-profiles.json');if(!existsSync(backup))copyFileSync(statePath,backup,constants.COPYFILE_EXCL);}
      validateActivityRecords(this.value.activity);
      for (const work of this.value.work) validateMessageDelivery(work);
      this.transaction(s => {
        if(pin)(s as State & {targetPin?:unknown}).targetPin={id:pin.id,fingerprint:pin.fingerprint};
        if(legacy){
          for(const w of s.work)if(w.status==='queued'){w.status='uncertain';w.error='MIGRATION_REQUIRES_RECONCILIATION';}
          for(const o of s.outbox)if(o.status==='queued'){o.status='uncertain';o.error='MIGRATION_REQUIRES_RECONCILIATION';}
        }
        if(s.results!==undefined){if(!Array.isArray(s.results))throw Error('Invalid result snapshot state');s.results=s.results.filter(r=>r.expiresAt>Date.now()).slice(-10);}
        for (const w of s.work) if (w.messageDelivery) { w.messageDelivery.observationGap = true; if (w.messageDelivery.admission === 'pending') w.messageDelivery.admission = 'uncertain'; if (w.messageDelivery.start === 'pending') w.messageDelivery.start = 'uncertain'; }
        for (const w of s.work) if(w.status==='queued'&&w.request.command==='screen.capture'){w.status='failed';w.error='SCREEN_REQUEST_EXPIRED';}
        for (const w of s.work) if (w.status === 'executing') { w.status = 'uncertain'; w.error = 'Restart during execution; never auto-replay'; }
        for (const o of s.outbox) if (o.status === 'sending') { o.status = 'uncertain'; o.error = 'Delivery may have occurred; inspect Slack before recovery'; }
        for (const p of s.pending) if (['pending','responding'].includes(p.status) || p.status==='local-required' && p.slackOwner) p.status = 'stale';
      });
    } catch (e) { this.close(); throw e; }
  }
  get state(): Readonly<State> { return structuredClone(this.value); }
  assertHealthy() { if (this.poisoned || this.closed) throw Error('STORE_UNAVAILABLE: repair storage and restart safely'); }
  transaction<T>(change: (draft: State) => T): T {
    this.assertHealthy(); const draft = structuredClone(this.value); const result = change(draft);
    try {
      const path = join(this.dir, 'state.json'), temp = path + '.tmp';
      const previous=lstatSync(temp,{throwIfNoEntry:false,bigint:true});
      if(previous&&(!previous.isFile()||previous.nlink!==1n))throw Error('UNSAFE_STATE_TEMP');
      // Never truncate before checking the opened descriptor. A regular
      // leftover temp is reusable after a crash, but a link or device is not.
      const fd=openSync(temp,constants.O_WRONLY|constants.O_CREAT|(constants.O_NOFOLLOW||0)|(constants.O_NONBLOCK||0),0o600);
      try {
        const opened=fstatSync(fd,{bigint:true}),current=lstatSync(temp,{bigint:true});
        if(!opened.isFile()||opened.nlink!==1n||!current.isFile()||current.nlink!==1n||opened.ino!==current.ino||opened.dev!==current.dev||
          (previous&&(previous.ino!==opened.ino||previous.dev!==opened.dev)))throw Error('UNSAFE_STATE_TEMP');
        ftruncateSync(fd,0);writeFileSync(fd,JSON.stringify(draft,null,2));fsyncSync(fd);
      } finally { closeSync(fd); }
      renameSync(temp, path); this.value = draft;
    } catch (e) { this.poisoned = true; throw e; }
    return result;
  }
  close() { if (this.closed) return; this.closed = true; closeSync(this.lock); unlinkSync(join(this.dir, 'daemon.lock')); }
}
