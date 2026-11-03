import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { parseConfig } from '../src/config.js';
import type { Config } from '../src/types.js';

export interface SecretCipher { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string; getSelectedStorageBackend?(): string }
export interface DesktopPreferences { autoConnect: boolean; closeToTray: boolean }
export interface Credentials { appToken: string; botToken: string }
export class SettingsError extends Error { constructor(readonly code: string) { super(code); } }
const fail = (code: string): never => { throw new SettingsError(code); };
const MAX_FILE = 128 * 1024;
function record(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID_SETTINGS');
}
function keys(value: unknown, allowed: readonly string[], required: readonly string[] = []): asserts value is Record<string, unknown> {
  record(value);
  if (Object.keys(value).some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(value, k))) fail('INVALID_SETTINGS');
}
function safeConfig(raw: unknown): Config {
  try { if (JSON.stringify(raw).length > MAX_FILE) fail('SETTINGS_TOO_LARGE'); } catch { return fail('INVALID_SETTINGS'); }
  keys(raw, ['version','instanceId','port','slack','projects','sessionPolicy','filePolicy','screenPolicy','backend','approvalTimeoutSec'], ['version','instanceId','port','slack','projects','backend','approvalTimeoutSec']);
  keys(raw.slack, ['teamId','inputChannel','outputChannel','allowedHumans','approvalUsers','trustedBots','dot'], ['teamId','inputChannel','outputChannel','allowedHumans','approvalUsers','trustedBots','dot']);
  keys(raw.slack.dot, ['name','userId'], ['name']);
  if (!Array.isArray(raw.slack.trustedBots) || raw.slack.trustedBots.length > 100) fail('INVALID_SETTINGS');
  for (const bot of raw.slack.trustedBots as unknown[]) keys(bot, ['botId','userId','appId'], ['botId','userId','appId']);
  keys(raw.backend, ['executable','socketPath','expectedVersion','autoStartDaemon'], ['executable']);
  if (raw.backend.expectedVersion !== undefined && (typeof raw.backend.expectedVersion !== 'string' || raw.backend.expectedVersion.length > 120)) fail('INVALID_SETTINGS');
  if (raw.screenPolicy !== undefined) keys(raw.screenPolicy, ['enabled'], ['enabled']);
  if (raw.filePolicy !== undefined) keys(raw.filePolicy, ['allowAbsolutePaths'], ['allowAbsolutePaths']);
  if (raw.sessionPolicy !== undefined) keys(raw.sessionPolicy, ['allowAllSharedSessions'], ['allowAllSharedSessions']);
  record(raw.projects);
  if (Object.keys(raw.projects).length > 100) fail('INVALID_SETTINGS');
  function inspect(value: unknown, depth = 0): void {
    if (depth > 8) fail('INVALID_SETTINGS');
    if (typeof value === 'string' && (value.length > 4096 || /(?:xapp-|xox[baprs]-)[A-Za-z0-9-]{6,}/.test(value))) fail('SECRETS_NOT_ALLOWED_IN_CONFIG');
    if (value && typeof value === 'object') for (const [k,v] of Object.entries(value)) {
      if (['__proto__','constructor','prototype'].includes(k)) fail('INVALID_SETTINGS');
      inspect(v, depth + 1);
    }
  }
  inspect(raw);
  try { return parseConfig(structuredClone(raw)); } catch { return fail('INVALID_CONFIGURATION'); }
}
function assertParents(path: string) {
  let current = resolve(path);
  for (;;) {
    if (existsSync(current)) {
      const st = lstatSync(current);
      if (st.isSymbolicLink() || !st.isDirectory()) fail('UNSAFE_SETTINGS_DIRECTORY');
    }
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
}
function privateHome(dir: string): string {
  if (!isAbsolute(dir) || resolve(dir) === parse(resolve(dir)).root) fail('UNSAFE_SETTINGS_DIRECTORY');
  assertParents(dir); mkdirSync(dir, {recursive:true,mode:0o700});
  const real=realpathSync(dir), st=statSync(real);
  if (typeof process.getuid === 'function' && (st.uid !== process.getuid() || (st.mode & 0o077) !== 0)) fail('SETTINGS_DIRECTORY_NOT_PRIVATE');
  return real;
}
function boundedRead(path: string, max = MAX_FILE): Buffer {
  const st=lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > max) fail('UNSAFE_SETTINGS_FILE');
  const fd=openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const actual=fstatSync(fd);
    if (actual.dev !== st.dev || actual.ino !== st.ino || actual.size > max || !actual.isFile()) fail('SETTINGS_CHANGED');
    const value=readFileSync(fd); if (value.length > max) fail('SETTINGS_TOO_LARGE'); return value;
  } finally { closeSync(fd); }
}
function atomicWrite(dir: string, name: string, bytes: Buffer|string) {
  const path=join(dir,name);
  if (existsSync(path)) boundedRead(path);
  const tmp=join(dir,`.${name}.${randomUUID()}.tmp`); let fd:number|undefined;
  try {
    fd=openSync(tmp,'wx',0o600);writeFileSync(fd,bytes);fsyncSync(fd);closeSync(fd);fd=undefined;
    if (existsSync(path)) boundedRead(path);
    renameSync(tmp,path);
  } finally { if(fd!==undefined)closeSync(fd);if(existsSync(tmp))unlinkSync(tmp); }
}
export function importConfigPreview(path: string): Config {
  if (typeof path !== 'string' || !isAbsolute(path)) fail('INVALID_IMPORT_PATH');
  try { return safeConfig(JSON.parse(boundedRead(path).toString('utf8'))); }
  catch(e) { if(e instanceof SettingsError)throw e;return fail('CONFIG_IMPORT_FAILED'); }
}
export class DesktopSettings {
  readonly homeDir: string;
  constructor(homeDir: string, private readonly cipher: SecretCipher) { this.homeDir=privateHome(homeDir); }
  defaultConfig(): Config { return { version:2,instanceId:'my-computer',port:17381,slack:{teamId:'',inputChannel:'',outputChannel:'',allowedHumans:[],approvalUsers:[],trustedBots:[],dot:{name:'',userId:''}},projects:{project:''},sessionPolicy:{allowAllSharedSessions:false},filePolicy:{allowAbsolutePaths:false},screenPolicy:{enabled:false},backend:{executable:'',autoStartDaemon:false},approvalTimeoutSec:300 }; }
  readConfig(): Config {
    if(!existsSync(join(this.homeDir,'config.json')))return this.defaultConfig();
    return importConfigPreview(join(this.homeDir,'config.json'));
  }
  saveConfig(raw:unknown): void { const value=safeConfig(raw);atomicWrite(this.homeDir,'config.json',JSON.stringify(value,null,2)+'\n'); }
  readPreferences(): DesktopPreferences {
    const path=join(this.homeDir,'desktop-preferences.json');if(!existsSync(path))return {autoConnect:false,closeToTray:true};
    try{return this.validatePreferences(JSON.parse(boundedRead(path).toString('utf8')));}catch{return fail('PREFERENCES_INVALID');}
  }
  private validatePreferences(value:unknown):DesktopPreferences { keys(value,['autoConnect','closeToTray'],['autoConnect','closeToTray']);if(typeof value.autoConnect!=='boolean'||typeof value.closeToTray!=='boolean')fail('INVALID_PREFERENCES');return {autoConnect:value.autoConnect as boolean,closeToTray:value.closeToTray as boolean}; }
  savePreferences(value:unknown):void { atomicWrite(this.homeDir,'desktop-preferences.json',JSON.stringify(this.validatePreferences(value),null,2)+'\n'); }
  private secureAvailable():boolean {try{return this.cipher.isEncryptionAvailable()&&this.cipher.getSelectedStorageBackend?.()!=='basic_text';}catch{return false;} }
  credentialStatus():{appToken:boolean;botToken:boolean;secureStorageAvailable:boolean} {
    const secureStorageAvailable=this.secureAvailable();if(!secureStorageAvailable)return{appToken:false,botToken:false,secureStorageAvailable};
    try{const value=this.getCredentials();return {appToken:!!value?.appToken,botToken:!!value?.botToken,secureStorageAvailable};}catch{return {appToken:false,botToken:false,secureStorageAvailable};}
  }
  saveCredentials(value:unknown):void {
    keys(value,['appToken','botToken']);
    if(!Object.keys(value).length)fail('INVALID_CREDENTIALS');
    if(!this.secureAvailable())fail('SECURE_STORAGE_UNAVAILABLE');
    const previous=value.appToken===undefined||value.botToken===undefined?this.getCredentials():null;
    const appToken=value.appToken===undefined?previous?.appToken:value.appToken;
    const botToken=value.botToken===undefined?previous?.botToken:value.botToken;
    if(typeof appToken!=='string'||!/^xapp-[A-Za-z0-9-]{8,4096}$/.test(appToken)||typeof botToken!=='string'||!/^xoxb-[A-Za-z0-9-]{8,4096}$/.test(botToken))fail('INVALID_CREDENTIALS');
    try{atomicWrite(this.homeDir,'credentials.enc',this.cipher.encryptString(JSON.stringify({appToken,botToken})));}catch{return fail('CREDENTIAL_SAVE_FAILED');}
  }
  getCredentials():Credentials|null {
    const path=join(this.homeDir,'credentials.enc');if(!existsSync(path))return null;
    if(!this.secureAvailable())fail('SECURE_STORAGE_UNAVAILABLE');
    try {
      const value:unknown=JSON.parse(this.cipher.decryptString(boundedRead(path)));
      keys(value,['appToken','botToken'],['appToken','botToken']);
      if(typeof value.appToken!=='string'||!/^xapp-[A-Za-z0-9-]{8,4096}$/.test(value.appToken)||typeof value.botToken!=='string'||!/^xoxb-[A-Za-z0-9-]{8,4096}$/.test(value.botToken))fail('INVALID_CREDENTIALS');
      return {appToken:value.appToken as string,botToken:value.botToken as string};
    }catch{return fail('CREDENTIAL_READ_FAILED');}
  }
  initRuntimeFiles():void {
    if(!existsSync(join(this.homeDir,'config.json')))fail('CONFIGURATION_REQUIRED');this.readConfig();
    const path=join(this.homeDir,'api.token');
    if(existsSync(path)){if(!/^[a-f0-9]{64}$/.test(boundedRead(path,1024).toString().trim()))fail('LOCAL_TOKEN_INVALID');return;}
    const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,randomBytes(32).toString('hex'));fsyncSync(fd);}finally{closeSync(fd);}
  }
}
export type PidState='alive'|'dead'|'unknown';
export type PidProbe=(pid:number)=>PidState;
const probePid:PidProbe=pid=>{try{process.kill(pid,0);return'alive';}catch(e){return (e as NodeJS.ErrnoException).code==='ESRCH'?'dead':'unknown';}};
export interface LockSnapshot { exists:boolean;pid:number|null;processState:PidState|null;owned:boolean;eligible:boolean;reason:string;identity?:{dev:number;ino:number;mtimeMs:number;size:number;uid:number}; }
export function inspectLock(homeDir:string,probe:PidProbe=probePid):LockSnapshot {
  const path=join(homeDir,'daemon.lock'),base:LockSnapshot={exists:false,pid:null,processState:null,owned:false,eligible:false,reason:'NO_LOCK'};
  try {
    assertParents(homeDir);let st;try{st=lstatSync(path);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return base;throw e;}base.exists=true;
    if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>32)return {...base,reason:'UNSAFE_LOCK'};
    const owned=typeof process.getuid==='function'&&st.uid===process.getuid();
    const text=boundedRead(path,32).toString();if(!/^[1-9]\d{0,9}$/.test(text)||Number(text)>2147483647)return {...base,owned,reason:'INVALID_LOCK_PID'};
    const pid=Number(text),processState=probe(pid),identity={dev:st.dev,ino:st.ino,mtimeMs:st.mtimeMs,size:st.size,uid:st.uid};
    return {exists:true,pid,processState,owned,eligible:owned&&processState==='dead',reason:!owned?'LOCK_OWNER_UNVERIFIED':processState==='dead'?'STALE_LOCK_CONFIRMED':processState==='alive'?'PROCESS_RUNNING':'PROCESS_UNVERIFIED',identity};
  }catch{return {...base,exists:true,reason:'LOCK_INSPECTION_FAILED'};}
}
export function recoverStaleLock(homeDir:string,expected:LockSnapshot,probe:PidProbe=probePid):{backupPath:string} {
  if(!expected?.eligible||!expected.identity)fail('LOCK_RECOVERY_NOT_ALLOWED');
  const now=inspectLock(homeDir,probe);
  if(!now.eligible||now.pid!==expected.pid||JSON.stringify(now.identity)!==JSON.stringify(expected.identity))fail('LOCK_CHANGED_OR_PROCESS_PRESENT');
  const path=join(homeDir,'daemon.lock'),backupPath=join(homeDir,`daemon.lock.stale.${Date.now()}.${randomUUID()}`);
  // Keep state/token untouched. Never kill a process; only a confirmed unchanged orphan is renamed.
  renameSync(path,backupPath);return{backupPath};
}
