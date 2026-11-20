import type { RuntimeSnapshot } from './runtime.js';
import { safeError } from './ipc-policy.js';

interface RuntimePort {
  snapshot(): RuntimeSnapshot;
  stop(): Promise<RuntimeSnapshot>;
}
export interface SettingsSaveResult {
  saved: true;
  reconnect: 'not-needed' | 'starting' | 'cancelled' | 'failed';
  error?: ReturnType<typeof safeError>;
}
/** Owns settings changes and connection intent across asynchronous native dialogs/stops. */
export class DesktopConnection {
  private saving = false;
  private stopIntent = 0;
  constructor(private runtime: RuntimePort, private startRuntime: () => RuntimeSnapshot, private shuttingDown: () => boolean) {}
  get settingsBusy() { return this.saving; }
  assertIdle() {
    if (this.shuttingDown()) throw Error('CANCELLED');
    if (this.saving) throw Error('SETTINGS_BUSY');
  }
  start(): RuntimeSnapshot {
    this.assertIdle();
    return this.startRuntime();
  }
  stop(): Promise<RuntimeSnapshot> {
    // Stop/quit always wins over a pending save, including while a dialog is open.
    this.stopIntent++;
    return this.runtime.stop();
  }
  async save(prepare: () => () => void, confirm: () => Promise<void> = async () => {}): Promise<SettingsSaveResult> {
    this.assertIdle();
    this.saving = true;
    const before = this.runtime.snapshot(), intent = this.stopIntent;
    const reconnect = before.owned && (before.state === 'running' || before.state === 'starting');
    let stopped = false;
    try {
      // Validate and prepare encryption before interrupting a healthy connection.
      const commit = prepare();
      await confirm();
      if (this.shuttingDown()) throw Error('CANCELLED');
      if (this.runtime.snapshot().owned) { await this.runtime.stop(); stopped = true; }
      if (this.shuttingDown()) throw Error('CANCELLED');
      // A stop is only confirmed once ownership is released. Never start two children.
      if (this.runtime.snapshot().owned) throw Error('STOP_UNCONFIRMED');
      try { commit(); } catch (error) {
        if (stopped) throw Error('SETTINGS_SAVE_FAILED_STOPPED');
        throw error;
      }
      if (!reconnect) return { saved: true, reconnect: 'not-needed' };
      if (this.stopIntent !== intent || this.shuttingDown()) return { saved: true, reconnect: 'cancelled' };
      try {
        this.startRuntime();
        // This is a start request, not evidence of Slack or Codex readiness.
        return { saved: true, reconnect: 'starting' };
      } catch (error) { return { saved: true, reconnect: 'failed', error: safeError(error) }; }
    } finally { this.saving = false; }
  }
}
