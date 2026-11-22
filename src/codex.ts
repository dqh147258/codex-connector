import { EventEmitter } from 'node:events';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import WebSocket from 'ws';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { Backend, Config } from './types.js';
import { canonicalPath, type ServerObservation } from './servers.js';
import { classifyRpcError, validRpcDiagnostic, type RpcDiagnostic } from './rpc-diagnostics.js';
const runFile = promisify(execFile);
const METHODS = new Set(['thread/list','thread/loaded/list','thread/read','thread/start','thread/resume','thread/turns/list','thread/items/list','turn/start','turn/steer','turn/interrupt','thread/queue/add','thread/queue/start','thread/queue/list']);
export function isBackendResourceExhaustion(error:unknown):boolean {
  const code=error&&typeof error==='object'&&'code' in error?error.code:undefined;
  return typeof code==='string'&&['EMFILE','ENFILE','ENOMEM','ENOBUFS','EAGAIN','ENOSPC','EDQUOT'].includes(code);
}
export class BackendError extends Error {
  readonly diagnostic?: RpcDiagnostic;
  constructor(readonly code: string, message = code, diagnostic?: RpcDiagnostic) {
    super(message);
    if (validRpcDiagnostic(diagnostic)) this.diagnostic = Object.freeze({ rpcCode: diagnostic.rpcCode, classification: diagnostic.classification });
  }
}
export function codexLaunch(path: string, args: string[]) {
  if (/\.(cmd|bat)$/i.test(path)) throw new BackendError('SHELL_SHIM_FORBIDDEN');
  return /\.(js|mjs|cjs)$/i.test(path) ? { file: process.execPath, args: [path, ...args] } : { file: path, args };
}
// Give each proxy and version probe its own environment. Keep the provider/OS
// configuration of the selected Codex home, not the Connector's bearer credentials.
export function proxyEnvironment(profile: Config['backend'], parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(parent)) {
    if (/^SLACK_/i.test(k) || /(?:CONNECTOR|LOCAL_AGENT|MCP|AGENT).*(?:TOKEN|BEARER|SECRET|CREDENTIAL|PASSWORD|AUTH|API_?KEY)/i.test(k)
      || /(?:TOKEN|BEARER|SECRET|CREDENTIAL).*(?:SLACK|CONNECTOR|AGENT|MCP)/i.test(k)
      || /^(?:CONNECTOR_HOME|CONNECTOR_DESKTOP_CHILD)$/i.test(k)) continue;
    if (profile.codexHome && /^CODEX_HOME$/i.test(k)) continue;
    env[k] = v;
  }
  if (profile.codexHome) env.CODEX_HOME = profile.codexHome;
  return env;
}
export function verifyHandshakeHome(expected: string | undefined, reply: unknown): void {
  if (!expected) return; // Compatibility with older daemons reached by an unpinned official proxy.
  const reported = reply && typeof reply === 'object' && 'codexHome' in reply ? reply.codexHome : undefined;
  if (typeof reported !== 'string' || !reported) throw new BackendError('BACKEND_HOME_UNVERIFIED');
  // 'expected' was already canonicalized before any launch. Do not resolve it
  // again: retargeting a local symlink must not silently change the active pin.
  try { if (canonicalPath(reported) === expected) return; } catch { /* Do not leak either path. */ }
  throw new BackendError('BACKEND_HOME_MISMATCH');
}
export class SharedAppServer extends EventEmitter implements Backend {
  epoch = ''; connected = false;
  private child?: ChildProcessWithoutNullStreams; private socket?: WebSocket; private connecting?: Promise<void>; private counter = 0;
  private pending = new Map<number, {resolve:(x:any)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout;method:string;queuedSubmissionId?:string}>();
  private unsupported = new Set<string>(); private version = ''; private lastFailure = ''; private stopped = false; private daemonStartAttempted=false; private daemonStartResult='not-requested';
  private checkedAt: string | null = null;
  private failureStage: string | null = null;
  private verifiedHome = false;
  get observation(): ServerObservation { return { checkedAt: this.checkedAt, resourceExhausted:this.lastFailure==='BACKEND_RESOURCE_EXHAUSTED', homeVerified:this.connected && this.verifiedHome, version: /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]{1,64})?$/.test(this.version) ? this.version : null }; }
  private readonly expectedHome?:string;
  constructor(private config: Config['backend'], private timeoutMs = 30000, expectedHome?:string, private readonly observeHome?:string) {
    super();
    this.expectedHome=expectedHome ?? (config.codexHome ? canonicalPath(config.codexHome) : undefined);
  }
  capabilities() { return { transport:'shared-daemon-proxy', daemonStart:{enabled:this.config.autoStartDaemon===true,attempted:this.daemonStartAttempted,result:this.daemonStartResult}, connected:this.connected, homeVerified:this.observation.homeVerified, epoch:this.epoch, versionSource:'cli', version:this.version || null, expectedVersion:this.config.expectedVersion || null, lastFailure:this.lastFailure || null,lastFailureStage:this.failureStage, unsupportedMethods:[...this.unsupported], arbitraryRpc:false, policyOverrides:false, sharedTakeover:'requires runtime verification; no fallback to independent app-server' }; }
  async connect(): Promise<void> {
    if (this.stopped) throw new BackendError('BACKEND_STOPPED'); if (this.connected) return; if (this.connecting) return this.connecting;
    this.connecting = this.open().finally(() => { this.connecting = undefined; }); return this.connecting;
  }
  private async open() {
    let stage='version-probe',resourceExhausted=false;
    try {
      this.verifiedHome = false;
      const previous = this.child; this.child = undefined; this.socket?.terminate(); this.socket = undefined; previous?.stdin.end(); previous?.kill();
      const versionCommand = codexLaunch(this.config.executable, ['--version']);
      const env = proxyEnvironment(this.config);
      const v = await runFile(versionCommand.file, versionCommand.args, { env, timeout:10000, maxBuffer:4096, shell:false, windowsHide:true });
      if(this.stopped)throw new BackendError('BACKEND_STOPPED');
      this.version = v.stdout.trim().replace(/^codex(?:-cli)?\s+/, '');
      stage='version-check';
      if (this.config.expectedVersion && this.version !== this.config.expectedVersion) throw new BackendError('VERSION_MISMATCH');
      stage='daemon-start';
      if(this.config.autoStartDaemon&&this.config.socketPath)throw new BackendError('DAEMON_START_SOCKET_CONFLICT');
      if(this.config.autoStartDaemon&&!this.daemonStartAttempted){
        if(this.stopped)throw new BackendError('BACKEND_STOPPED');this.daemonStartAttempted=true;
        const start=codexLaunch(this.config.executable,['app-server','daemon','start']);
        try{await runFile(start.file,start.args,{env,timeout:15000,maxBuffer:8192,shell:false,windowsHide:true});this.daemonStartResult='started-or-already-running';}
        catch(e){this.daemonStartResult='failed-or-timeout; no automatic retry';throw new BackendError(isBackendResourceExhaustion(e)?'BACKEND_RESOURCE_EXHAUSTED':'DAEMON_START_FAILED');}
        if(this.stopped)throw new BackendError('BACKEND_STOPPED');
      }
      stage='proxy-launch';
      const cmd = codexLaunch(this.config.executable, ['app-server','proxy', ...(this.config.socketPath ? ['--sock',this.config.socketPath] : [])]);
      const child = spawn(cmd.file, cmd.args, { env, shell:false, stdio:'pipe', windowsHide:true }); this.child = child;
      const epoch = randomUUID(); this.epoch = epoch;
      child.stderr.on('data', () => {}); // Never leak raw local errors or credentials.
      child.stdin.on('error', () => { if(this.child===child) this.disconnect('PROXY_WRITE_FAILED'); });
      // The official proxy is a byte tunnel to a WebSocket endpoint, not the
      // newline-delimited JSON transport used by an independent stdio server.
      const stream = Duplex.from({readable:child.stdout,writable:child.stdin});
      stage='websocket-upgrade';
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
      child.on('error', e => {
        if(this.child===child){resourceExhausted=isBackendResourceExhaustion(e);this.disconnect(resourceExhausted?'BACKEND_RESOURCE_EXHAUSTED':'PROXY_START_FAILED');}
      });
      child.on('close', () => { socket.terminate(); if (this.child === child) { this.child = undefined; this.disconnect('PROXY_DISCONNECTED'); } });
      await new Promise<void>((resolve,reject)=>{
        socket.once('open',resolve);
        socket.once('error',()=>reject(new BackendError('PROXY_TRANSPORT_FAILED')));
        socket.once('close',()=>reject(new BackendError('PROXY_DISCONNECTED')));
      });
      if(this.stopped)throw new BackendError('BACKEND_STOPPED');
      stage='initialize';
      const hello = await this.request('initialize', {clientInfo:{name:'codex_connector',title:'Codex Connector',version:'0.2.0'},capabilities:{experimentalApi:true}});
      stage='home-verification';
      verifyHandshakeHome(this.expectedHome, hello); this.verifiedHome=!!this.expectedHome;
      // Existing unpinned single-home setups may still operate, but sharing
      // requires an affirmative independent Home match from initialize.
      if(!this.verifiedHome&&this.observeHome)try{verifyHandshakeHome(this.observeHome,hello);this.verifiedHome=true;}catch{/* No native sharing authority. */}
      stage='initialized';
      await this.write({method:'initialized',params:{}}); this.failureStage = null; this.checkedAt = new Date().toISOString(); this.connected = true; this.lastFailure = ''; this.unsupported.clear();
    } catch (e) {
      this.failureStage = stage;
      this.checkedAt = new Date().toISOString();
      this.lastFailure = resourceExhausted||isBackendResourceExhaustion(e)?'BACKEND_RESOURCE_EXHAUSTED':e instanceof BackendError ? e.code : 'SHARED_DAEMON_UNAVAILABLE';
      const failed = this.child; this.child = undefined;
      this.socket?.terminate(); failed?.kill(); throw new BackendError(this.lastFailure);
    }
  }
  private disconnect(code: string) {
    if(this.connected)this.failureStage = 'connected';
    const hadConnection = this.connected || this.pending.size > 0; this.connected = false; this.lastFailure = code; this.checkedAt = new Date().toISOString();
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
      const queuedSubmissionId = method === 'thread/queue/start' && params && typeof params === 'object' && 'queuedSubmissionId' in params && typeof params.queuedSubmissionId === 'string' ? params.queuedSubmissionId : undefined;
      this.pending.set(id,{resolve,reject,timer,method,queuedSubmissionId}); void this.write({id,method,params}).catch(e=>{ clearTimeout(timer);this.pending.delete(id);reject(e); });
    });
  }
  private message(m:any,epoch:string) {
    if(!m||typeof m!=='object'||Array.isArray(m)||('id' in m&&!(typeof m.id==='string'||Number.isSafeInteger(m.id))))throw new BackendError('INVALID_PROTOCOL');
    // Never dispatch notifications/approval requests from an unverified peer.
    if (typeof m?.method === 'string' && !this.connected) return;
    if (m?.id !== undefined && typeof m.method === 'string') { this.emit('request', {id:m.id,method:m.method,params:m.params||{},epoch}); return; }
    if (m?.id !== undefined) {
      const p=this.pending.get(m.id);if(!p)return;
      if(Object.hasOwn(m,'result')===Object.hasOwn(m,'error')||(Object.hasOwn(m,'error')&&(!m.error||typeof m.error!=='object'||Array.isArray(m.error)||!Number.isSafeInteger(m.error.code)||typeof m.error.message!=='string')))throw new BackendError('INVALID_PROTOCOL');
      this.pending.delete(m.id);clearTimeout(p.timer);
      m.error ? p.reject(new BackendError(m.error.code === -32601 ? 'METHOD_UNSUPPORTED' : 'RPC_REJECTED', undefined, classifyRpcError(p.method,m.error.code,m.error.message,p.queuedSubmissionId))) : p.resolve(m.result);return;
    }
    if (typeof m?.method === 'string') this.emit('notification',m.method,m.params||{},epoch);
  }
  async rpc(method:string,params:unknown):Promise<any> {
    if(!METHODS.has(method))throw new BackendError('RPC_FORBIDDEN');if(this.unsupported.has(method))throw new BackendError('METHOD_UNSUPPORTED');if(!this.connected)throw new BackendError('BACKEND_UNAVAILABLE');
    try{return await this.request(method,params);}catch(e){if(e instanceof BackendError&&e.code==='METHOD_UNSUPPORTED')this.unsupported.add(method);throw e;}
  }
  async respond(id:string|number,result:unknown,expectedEpoch?:string) { if(!this.connected||expectedEpoch!==undefined&&expectedEpoch!==this.epoch)throw new BackendError('BACKEND_UNAVAILABLE');await this.write({id,result}); }
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
