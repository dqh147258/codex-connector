import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Config } from '../src/types.js';
import { commandRequest } from '../src/client.js';
import { codexLaunch } from '../src/codex.js';
const exec = promisify(execFile);
export type RuntimeSnapshot={state:'stopped'|'starting'|'running'|'stopping'|'failed';owned:boolean;backend?:Record<string,unknown>;lastError?:string};
export function desktopChildEnvironment(home:string,tokens:{appToken:string;botToken:string},base:NodeJS.ProcessEnv=process.env):NodeJS.ProcessEnv{
  const env={...base};for(const key of ['NODE_OPTIONS','NODE_PATH','ELECTRON_NO_ASAR','ELECTRON_ENABLE_LOGGING','CONNECTOR_TOKEN','CONNECTOR_HOME','SLACK_APP_TOKEN','SLACK_BOT_TOKEN'])delete env[key];
  return {...env,ELECTRON_RUN_AS_NODE:'1',CONNECTOR_DESKTOP_CHILD:'1',CONNECTOR_HOME:home,SLACK_APP_TOKEN:tokens.appToken,SLACK_BOT_TOKEN:tokens.botToken};
}
export class DesktopRuntime {
  private child?:ChildProcess;private state:RuntimeSnapshot['state']='stopped';private lastError?:string;private backend?:Record<string,unknown>;private stopping?:Promise<RuntimeSnapshot>;private config?:Config;
  constructor(private home:string,private cliPath:string,private executable=process.execPath,private spawnChild:typeof spawn=spawn,private stopTimeout=45000){}
  snapshot():RuntimeSnapshot{return{state:this.state,owned:!!this.child,backend:this.backend,lastError:this.lastError};}
  start(config:Config,tokens:{appToken:string;botToken:string}){
    if(this.child||this.stopping)throw Error('ALREADY_RUNNING');
    if(existsSync(join(this.home,'daemon.lock')))throw Error('LOCK_EXISTS');
    this.config=structuredClone(config);this.state='starting';this.backend=undefined;this.lastError=undefined;
    const child=this.spawnChild(this.executable,[this.cliPath,'start','--home',this.home],{env:desktopChildEnvironment(this.home,tokens),shell:false,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});this.child=child;
    // Never forward stdout/stderr: upstream diagnostics can contain private data.
    child.stdout?.on('data',()=>{});child.stderr?.on('data',()=>{});
    child.on('message',(m:any)=>{if(this.child!==child)return;if(m?.type==='connector:ready'&&this.state==='starting')this.state='running';if(m?.type==='connector:stopping')this.state='stopping';if(m?.type==='connector:failure'&&['LOCK_EXISTS','CONFIGURATION_INVALID','LOCAL_PORT_IN_USE','WORKSPACE_MISMATCH','SLACK_AUTH_FAILED','SERVER_START_FAILED'].includes(m.code)){this.lastError=m.code;this.state='failed';}});
    child.on('error',()=>{if(this.child===child){this.lastError='SERVER_START_FAILED';this.state='failed';}});
    child.on('close',(code)=>{if(this.child!==child)return;this.child=undefined;this.backend=undefined;const requested=this.state==='stopping';this.state=requested||code===0?'stopped':'failed';if(this.state==='failed'&&!this.lastError)this.lastError='SERVER_EXITED';});
    return this.snapshot();
  }
  async refresh(){
    if(this.state!=='running'||!this.child||!this.config)return this.snapshot();
    const child=this.child;
    try{const token=readFileSync(join(this.home,'api.token'),'utf8').trim();const result=await commandRequest(this.config.port,token,{action:'status'}) as any;
      if(this.child!==child||this.state!=='running')return this.snapshot();
      const c=result?.result?.capabilities;if(!c||typeof c.connected!=='boolean')throw Error();
      this.backend={connected:c.connected,version:c.version,expectedVersion:c.expectedVersion,lastFailure:c.lastFailure,daemonStart:c.daemonStart,unsupportedMethods:c.unsupportedMethods};
    }catch{if(this.child===child)this.lastError='STATUS_UNAVAILABLE';}
    return this.snapshot();
  }
  stop():Promise<RuntimeSnapshot>{
    if(this.stopping)return this.stopping;
    const child=this.child;if(!child){this.state='stopped';return Promise.resolve(this.snapshot());}
    this.state='stopping';
    this.stopping=new Promise<RuntimeSnapshot>((resolve,reject)=>{
      const done=()=>{clearTimeout(timer);resolve(this.snapshot());};const timer=setTimeout(()=>{child.off('close',done);this.lastError='STOP_UNCONFIRMED';reject(Error('STOP_UNCONFIRMED'));},this.stopTimeout);
      child.once('close',done);
      // IPC requests graceful cleanup on all OSes; Windows SIGTERM would terminate immediately.
      if(child.connected)child.send?.({type:'connector:stop'},()=>{});
      else{clearTimeout(timer);child.off('close',done);this.lastError='STOP_UNCONFIRMED';reject(Error('STOP_UNCONFIRMED'));}
    }).finally(()=>{this.stopping=undefined;});return this.stopping;
  }
}
export async function probeCodex(executable:string,run=exec){
  if(typeof executable!=='string'||!isAbsolute(executable)||executable.length>4096||/\.(cmd|bat)$/i.test(executable))throw Error('INVALID_EXECUTABLE');
  const env={...process.env,ELECTRON_RUN_AS_NODE:'1'};for(const k of ['SLACK_APP_TOKEN','SLACK_BOT_TOKEN','CONNECTOR_TOKEN','NODE_OPTIONS','NODE_PATH'])delete (env as NodeJS.ProcessEnv)[k];
  async function invoke(args:string[]){const c=codexLaunch(executable,args);return run(c.file,c.args,{env,timeout:10000,maxBuffer:65536,shell:false,windowsHide:true});}
  let version:string|null=null;
  try{const r=await invoke(['--version']);const match=String(r.stdout).trim().match(/^(?:codex(?:-cli)?\s+)?(\d+\.\d+\.\d+(?:[-+.][a-zA-Z0-9.]+)?)$/);version=match?.[1]??null;}catch{return{version:null,proxySupported:false,daemonStartSupported:false,error:'CODEX_VERSION_UNAVAILABLE'};}
  async function supports(args:string[]){try{await invoke(args);return true;}catch{return false;}}
  return{version,proxySupported:await supports(['app-server','proxy','--help']),daemonStartSupported:await supports(['app-server','daemon','start','--help']),error:version?undefined:'CODEX_VERSION_UNRECOGNIZED'};
}
