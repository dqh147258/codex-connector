import type { Runtime } from './runtime.js';

interface SlackSocket {
  on(event: string, fn: (...args: any[]) => void): unknown;
  start(): Promise<unknown>;
  disconnect(): Promise<unknown>;
}
type Auth = { team_id?: string; user_id?: string; bot_id?: string };
const disabled = (code: string) => Object.assign(Error(code), { code });
/** One transport, never a source of backend/process authority. SDK automatic reconnect
 * is disabled: each replacement socket revalidates the workspace and Dot first. */
export class SlackLink {
  private current?: SlackSocket;
  private attempt?: Promise<void>;
  private ready = false;
  private permanent = false;
  private stopped = false;
  private nextTry = 0;
  constructor(private team: string, private runtime: Pick<Runtime,'accept'|'enableSlack'|'disableSlack'>,
    private authenticate: () => Promise<Auth>, private makeSocket: () => SlackSocket) {}
  connect(): Promise<void> {
    if (this.stopped || this.permanent || this.ready || Date.now() < this.nextTry) return Promise.resolve();
    return this.attempt ??= this.open().finally(()=>{this.attempt=undefined;});
  }
  private async open() {
    let socket: SlackSocket | undefined;
    try {
      const auth = await this.authenticate();
      if (this.stopped) return;
      if (auth.team_id !== this.team) throw disabled('WORKSPACE_MISMATCH');
      if (!auth.user_id || !auth.bot_id) throw disabled('SLACK_AUTH_FAILED');
      socket = this.makeSocket(); this.current = socket;
      const lost = () => {
        if (this.current !== socket) return;
        this.current = undefined; this.ready = false; this.nextTry = Date.now()+5000;
        this.runtime.disableSlack();
      };
      socket.on('disconnected', lost);
      socket.on('message', async ({body,ack}:any) => {
        if (this.stopped || !this.ready || this.current !== socket) return;
        try { this.runtime.accept(body); await ack(); }
        catch { console.error('Slack event could not be acknowledged; check durable storage.'); }
      });
      // The SDK may still be acquiring a WebSocket URL when close() runs.
      // Cancel a socket that starts connecting after cancellation; also bound a
      // remote peer that never sends hello, independently of loopback availability.
      const candidate=socket;
      socket.on('connecting',()=>{if(this.stopped||this.current!==candidate)queueMicrotask(()=>{void candidate.disconnect().catch(()=>{});});});
      let timer:NodeJS.Timeout|undefined;
      try {
        await Promise.race([socket.start(), new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(disabled('SLACK_UNAVAILABLE')),20000);})]);
      } finally {if(timer)clearTimeout(timer);}
      if (this.stopped) {await socket.disconnect().catch(()=>{});return;}
      if (this.current !== socket) throw disabled('SLACK_UNAVAILABLE');
      await this.runtime.enableSlack(auth.user_id,auth.bot_id);
      if (this.stopped || this.current !== socket) { this.runtime.disableSlack(); return; }
      this.ready = true;
    } catch (cause) {
      this.runtime.disableSlack(); this.ready=false;
      const e=cause as {code?:string;data?:{error?:string}} | undefined;
      this.permanent = e?.code === 'WORKSPACE_MISMATCH' || e?.code === 'SLACK_AUTH_FAILED' ||
        ['invalid_auth','token_revoked','account_inactive','not_authed'].includes(e?.data?.error || '');
      this.nextTry=Date.now()+30000;
      if(socket && this.current===socket){this.current=undefined;await socket.disconnect().catch(()=>{});}
      throw disabled(e?.code === 'WORKSPACE_MISMATCH' ? 'WORKSPACE_MISMATCH' : this.permanent ? 'SLACK_AUTH_FAILED' : 'SLACK_UNAVAILABLE');
    }
  }
  async close() {
    this.stopped=true; this.ready=false; this.runtime.disableSlack();
    const socket=this.current;this.current=undefined;
    if(socket)await socket.disconnect().catch(()=>{});
    await this.attempt?.catch(()=>{});
  }
}
