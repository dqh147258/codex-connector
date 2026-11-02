import { EventEmitter } from 'node:events';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import WebSocket from 'ws';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { Backend, Config } from './types.js';
const runFile = promisify(execFile);
const METHODS = new Set(['thread/list','thread/loaded/list','thread/read','thread/start','thread/resume','thread/turns/list','thread/items/list','turn/start','turn/steer','turn/interrupt','thread/queue/add','thread/queue/start']);
export class BackendError extends Error { constructor(readonly code: string, message = code) { super(message); } }
export function codexLaunch(path: string, args: string[]) {
  if (/\.(cmd|bat)$/i.test(path)) throw new BackendError('SHELL_SHIM_FORBIDDEN');
  return /\.(js|mjs|cjs)$/i.test(path) ? { file: process.execPath, args: [path, ...args] } : { file: path, args };
}
export class SharedAppServer extends EventEmitter implements Backend {
  epoch = ''; connected = false;
  private child?: ChildProcessWithoutNullStreams; private socket?: WebSocket; private connecting?: Promise<void>; private counter = 0;
  private pending = new Map<number, {resolve:(x:any)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}>();
  private unsupported = new Set<string>(); private version = ''; private lastFailure = ''; private stopped = false; private daemonStartAttempted=false; private daemonStartResult='not-requested';
  constructor(private config: Config['backend'], private timeoutMs = 30000) { super(); }
  capabilities() { return { transport:'shared-daemon-proxy', daemonStart:{enabled:this.config.autoStartDaemon===true,attempted:this.daemonStartAttempted,result:this.daemonStartResult}, connected:this.connected, epoch:this.epoch, version:this.version || null, expectedVersion:this.config.expectedVersion || null, lastFailure:this.lastFailure || null, unsupportedMethods:[...this.unsupported], arbitraryRpc:false, policyOverrides:false, sharedTakeover:'requires runtime verification; no fallback to independent app-server' }; }
  async connect(): Promise<void> {
    if (this.stopped) throw new BackendError('BACKEND_STOPPED'); if (this.connected) return; if (this.connecting) return this.connecting;
    this.connecting = this.open().finally(() => { this.connecting = undefined; }); return this.connecting;
  }
  private async open() {
    try {
      const previous = this.child; this.child = undefined; this.socket?.terminate(); this.socket = undefined; previous?.stdin.end(); previous?.kill();
      const versionCommand = codexLaunch(this.config.executable, ['--version']);
      const env = {...process.env}; delete env.SLACK_APP_TOKEN; delete env.SLACK_BOT_TOKEN; delete env.CONNECTOR_TOKEN;
      const v = await runFile(versionCommand.file, versionCommand.args, { env, timeout:10000, maxBuffer:4096, shell:false, windowsHide:true });
      if(this.stopped)throw new BackendError('BACKEND_STOPPED');
      this.version = v.stdout.trim().replace(/^codex(?:-cli)?\s+/, '');
      if (this.config.expectedVersion && this.version !== this.config.expectedVersion) throw new BackendError('VERSION_MISMATCH');
      if(this.config.autoStartDaemon&&this.config.socketPath)throw new BackendError('DAEMON_START_SOCKET_CONFLICT');
      if(this.config.autoStartDaemon&&!this.daemonStartAttempted){
        if(this.stopped)throw new BackendError('BACKEND_STOPPED');this.daemonStartAttempted=true;
        const start=codexLaunch(this.config.executable,['app-server','daemon','start']);
        try{await runFile(start.file,start.args,{env,timeout:15000,maxBuffer:8192,shell:false,windowsHide:true});this.daemonStartResult='started-or-already-running';}
        catch{this.daemonStartResult='failed-or-timeout; no automatic retry';throw new BackendError('DAEMON_START_FAILED');}
        if(this.stopped)throw new BackendError('BACKEND_STOPPED');
      }
      const cmd = codexLaunch(this.config.executable, ['app-server','proxy', ...(this.config.socketPath ? ['--sock',this.config.socketPath] : [])]);
      const child = spawn(cmd.file, cmd.args, { env, shell:false, stdio:'pipe', windowsHide:true }); this.child = child;
      const epoch = randomUUID(); this.epoch = epoch;
      child.stderr.on('data', () => {}); // Never leak raw local errors or credentials.
      child.stdin.on('error', () => { if(this.child===child) this.disconnect('PROXY_WRITE_FAILED'); });
      // The official proxy is a byte tunnel to a WebSocket endpoint, not the
      // newline-delimited JSON transport used by an independent stdio server.
      const stream = Duplex.from({readable:child.stdout,writable:child.stdin});
      const socket = new WebSocket('ws://localhost/', {
        // ws/http accept a Duplex here; no TCP connection is made.
        createConnection: () => stream as Socket,
        handshakeTimeout:this.timeoutMs, maxPayload:8*1024*1024, perMessageDeflate:false,
      }); this.socket = socket;
      // Reject HTTP failures before Node tries to keep this non-TCP stream alive.
      socket.on('unexpected-response', (_request,response) => { response.destroy(); socket.terminate(); });
      socket.on('error', () => { if(this.child===child) this.disconnect('PROXY_TRANSPORT_FAILED'); });
      socket.on('close', () => { if(this.child===child) this.disconnect('PROXY_DISCONNECTED'); });
      socket.on('message', (data, isBinary) => {
        if(this.child!==child || this.epoch!==epoch) return;
        try { if(isBinary)throw new BackendError('INVALID_PROTOCOL'); this.message(JSON.parse(data.toString()),epoch); }
        catch { this.disconnect('INVALID_PROTOCOL'); socket.terminate(); child.kill(); }
      });
      child.on('error', () => { if(this.child===child) this.disconnect('PROXY_START_FAILED'); });
      child.on('close', () => { socket.terminate(); if (this.child === child) { this.child = undefined; this.disconnect('PROXY_DISCONNECTED'); } });
      await new Promise<void>((resolve,reject)=>{
        socket.once('open',resolve);
        socket.once('error',()=>reject(new BackendError('PROXY_TRANSPORT_FAILED')));
        socket.once('close',()=>reject(new BackendError('PROXY_DISCONNECTED')));
      });
      if(this.stopped)throw new BackendError('BACKEND_STOPPED');
      await this.request('initialize', {clientInfo:{name:'codex_connector',title:'Codex Connector',version:'0.2.0'},capabilities:{experimentalApi:true}});
      await this.write({method:'initialized',params:{}}); this.connected = true; this.lastFailure = ''; this.unsupported.clear();
    } catch (e) {
      this.lastFailure = e instanceof BackendError ? e.code : 'SHARED_DAEMON_UNAVAILABLE';
      this.socket?.terminate(); this.child?.kill(); throw new BackendError(this.lastFailure);
    }
  }
  private disconnect(code: string) {
    const hadConnection = this.connected || this.pending.size > 0; this.connected = false; this.lastFailure = code;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new BackendError('RPC_OUTCOME_UNCERTAIN')); } this.pending.clear();
    if (hadConnection) this.emit('disconnect', this.epoch);
  }
  private write(message: unknown): Promise<void> {
    return new Promise((resolve,reject) => {
      if (this.socket?.readyState !== WebSocket.OPEN) { reject(new BackendError('BACKEND_UNAVAILABLE')); return; }
      this.socket.send(JSON.stringify(message), e => e ? reject(new BackendError('RPC_OUTCOME_UNCERTAIN')) : resolve());
    });
  }
  private request(method: string, params: unknown): Promise<any> {
    const id = ++this.counter;
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new BackendError('RPC_OUTCOME_UNCERTAIN')); },this.timeoutMs);
      this.pending.set(id,{resolve,reject,timer}); void this.write({id,method,params}).catch(e=>{ clearTimeout(timer);this.pending.delete(id);reject(e); });
    });
  }
  private message(m:any,epoch:string) {
    if(!m||typeof m!=='object'||Array.isArray(m)||('id' in m&&!(typeof m.id==='string'||Number.isSafeInteger(m.id))))throw new BackendError('INVALID_PROTOCOL');
    if (m?.id !== undefined && typeof m.method === 'string') { this.emit('request', {id:m.id,method:m.method,params:m.params||{},epoch}); return; }
    if (m?.id !== undefined) {
      const p=this.pending.get(m.id);if(!p)return;
      if(Object.hasOwn(m,'result')===Object.hasOwn(m,'error')||(Object.hasOwn(m,'error')&&(!m.error||typeof m.error!=='object'||Array.isArray(m.error)||!Number.isInteger(m.error.code)||typeof m.error.message!=='string')))throw new BackendError('INVALID_PROTOCOL');
      this.pending.delete(m.id);clearTimeout(p.timer);
      m.error ? p.reject(new BackendError(m.error.code === -32601 ? 'METHOD_UNSUPPORTED' : 'RPC_REJECTED')) : p.resolve(m.result);return;
    }
    if (typeof m?.method === 'string') this.emit('notification',m.method,m.params||{},epoch);
  }
  async rpc(method:string,params:unknown):Promise<any> {
    if(!METHODS.has(method))throw new BackendError('RPC_FORBIDDEN');if(this.unsupported.has(method))throw new BackendError('METHOD_UNSUPPORTED');if(!this.connected)throw new BackendError('BACKEND_UNAVAILABLE');
    try{return await this.request(method,params);}catch(e){if(e instanceof BackendError&&e.code==='METHOD_UNSUPPORTED')this.unsupported.add(method);throw e;}
  }
  async respond(id:string|number,result:unknown) { if(!this.connected)throw new BackendError('BACKEND_UNAVAILABLE');await this.write({id,result}); }
  async close() {
    this.stopped=true;if(this.connecting)await this.connecting.catch(()=>{});const child=this.child;this.disconnect('STOPPED');if(!child)return;
    // End only this proxy connection. Never daemon stop, process-name kills, or shared-turn interruption.
    this.socket?.close();
    child.stdin.end();
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>{ child.kill(); const force=setTimeout(()=>reject(new BackendError('PROXY_CLOSE_UNCONFIRMED')),2000);child.once('close',()=>{clearTimeout(force);resolve();}); },2000);
      child.once('close',()=>{clearTimeout(timer);resolve();});
    });
  }
}
