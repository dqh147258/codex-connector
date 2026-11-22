import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validServerId } from './servers.js';

const invalid = () => Error('MIGRATION_PREVIEW_UNAVAILABLE: expected bounded, regular Connector v2 files');
function plain(value: unknown): value is Record<string,unknown> {
  return typeof value==='object' && value!==null && !Array.isArray(value);
}
// Read only the selected Connector directory's config and old root ledger. Never
// instantiate Store/loadConfig: those can take locks, write, or resolve backend paths.
function read(dir: string, name: 'state.json'|'config.json', limit: number): unknown {
  const path=join(dir,name);
  let stat;try{stat=lstatSync(path);}catch(e){if(name==='state.json'&&(e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw invalid();}
  if(!stat.isFile()||stat.nlink!==1||stat.size>limit)throw invalid();
  let fd:number|undefined;
  try {
    fd=openSync(path,constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const st=fstatSync(fd);
    if(!st.isFile()||st.nlink!==1||st.size>limit||st.dev!==stat.dev||st.ino!==stat.ino)throw invalid();
    const data=readFileSync(fd);if(data.length>limit)throw invalid();return JSON.parse(data.toString('utf8'));
  }catch{throw invalid();}finally{if(fd!==undefined)closeSync(fd);}
}
function oneDefault(raw: unknown): boolean {
  if(!plain(raw)||raw.version!==2||(raw.backends!==undefined&&!plain(raw.backends)))throw invalid();
  const ids=Object.keys(raw.backends??{});if(ids.some(id=>!validServerId(id)))throw invalid();
  if(raw.backend!==undefined){if(!plain(raw.backend)||ids.includes('default'))throw invalid();ids.push('default');}
  if(!ids.length|| (raw.defaultServerId!==undefined&&(!validServerId(raw.defaultServerId)||!ids.includes(raw.defaultServerId))))throw invalid();
  return ids.length===1&&ids[0]==='default';
}
export function migrationPreview(dir: string) {
  const data=read(dir,'state.json',64*1024*1024);
  const base={readOnly:true,scope:'legacy-root-ledger',validatesPhysicalTarget:false};
  if(data===undefined)return {...base,state:'absent',ambiguous:false,legacyRows:null,quarantine:null};
  if(!plain(data)||data.version!==2)throw invalid();
  if(data.targetPin!==undefined){
    if(!plain(data.targetPin)||!validServerId(data.targetPin.id)||typeof data.targetPin.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(data.targetPin.fingerprint))throw invalid();
    return {...base,state:'already-pinned',ambiguous:false,legacyRows:null,quarantine:null};
  }
  const array=(k:string,required=false): Record<string,unknown>[]=>{
    const value=data[k];if(value===undefined&&!required)return [];
    if(!Array.isArray(value)||!value.every(plain))throw invalid();return value;
  };
  if(!plain(data.seenEvents)||!plain(data.seenNotifications))throw invalid();
  const work=array('work',true), outbox=array('outbox',true), pending=array('pending',true);
  const legacyRows={sessions:array('sessions',true).length,work:work.length,outbox:outbox.length,pending:pending.length,
    subscriptions:array('subscriptions').length,activity:array('activity').length,results:array('results').length};
  const ambiguous=!oneDefault(read(dir,'config.json',256*1024));
  // Match Store's first-start reconciliation. Ambiguity blocks the ENTIRE old
  // ledger, so no command is replayed and no pending/outbox row is rewritten.
  const count=(rows:Record<string,unknown>[],statuses:string[])=>rows.filter(x=>typeof x.status==='string'&&statuses.includes(x.status)).length;
  return {...base,state:ambiguous?'legacy-blocked':'legacy-single-default',ambiguous,legacyRows,
    quarantine:ambiguous?{entireLegacyLedger:true}:
      {entireLegacyLedger:false,workMarkedUncertain:count(work,['queued','executing']),outboxMarkedUncertain:count(outbox,['queued','sending']),requestsMarkedStale:count(pending,['pending','responding'])}};
}
