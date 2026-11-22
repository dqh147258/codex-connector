import { mkdirSync, closeSync, openSync, unlinkSync, writeFileSync, realpathSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SharedAppServer } from './codex.js';
import { Connector, ConnectorError, type RuntimeContext } from './connector.js';
import { Store } from './store.js';
import { configuredServers, defaultServer, listServers, resolveServerId, targetFingerprint, validateIdentities } from './servers.js';
import { OPERATOR, type Config, type LocalPrincipal, type Backend, type SlackPort } from './types.js';
import type { ScreenPort } from './screens.js';
import type { CommandEnvelope } from './protocol.js';

// These names are Connector-owned. An alias for the explicitly selected
// home is resolved once, but a managed namespace/file must not lead outside
// that canonical tree. Check only known paths; do not enumerate the disk.
const managedFiles=['config.json','api.token','state.json','state.json.tmp','state.before-server-profiles.json','daemon.lock','runtime.lock'];
function assertManagedFiles(dir:string) {
  for(const name of managedFiles){
    const file=lstatSync(join(dir,name),{throwIfNoEntry:false});
    if(file&&(!file.isFile()||file.isSymbolicLink()||file.nlink!==1))throw Error('UNSAFE_CONNECTOR_HOME');
  }
}
export function pinRuntimeHome(dir:string):string {
  const pinned=realpathSync.native(resolve(dir));assertManagedFiles(pinned);return pinned;
}
function managedDirectory(parent:string,name:string):string {
  const dir=join(parent,name);mkdirSync(dir,{recursive:true,mode:0o700});
  const metadata=lstatSync(dir);if(!metadata.isDirectory()||metadata.isSymbolicLink())throw Error('UNSAFE_CONNECTOR_HOME');
  // Junctions and other aliases must never place managed state in project space.
  const canonical=realpathSync.native(dir);
  if(canonical!==dir)throw Error('UNSAFE_CONNECTOR_HOME');
  return dir;
}
type MakeBackend=(profile:Config['backend'],id:string)=>Backend;
type Page={serverId?:string;sessionId:string;cursor?:string;limit?:number;waitMs?:number};
/** Physical namespaces avoid ambiguous bare native IDs and preserve all old work,
 * notification, outbox and subscription keys in their original ledger. */
export class Runtime {
  readonly cores=new Map<string,Connector>();
  readonly backends=new Map<string,Backend>();
  private lock:number;private closed=false;private slackReady=false;private slackEpoch=0;
  private readonly blocked=new Set<string>();
  private readonly dir:string;
  private readonly slackIds:string[];
  constructor(readonly config:Config,dir:string,slack:SlackPort,screens?:ScreenPort,
    makeBackend?:MakeBackend){
    const profiles=configuredServers(config),preferred=defaultServer(config),targets=validateIdentities(profiles);
    const selected=resolve(dir);
    mkdirSync(selected,{recursive:true,mode:0o700});
    this.dir=pinRuntimeHome(selected);
    // Even if projects include this directory (or an ancestor), none of the
    // root, per-server ledgers, backups or atomic temp writes are file tools' data.
    const protectedHomes=[...new Set([selected,this.dir,...[...targets.values()].map(t=>t.home).filter((home):home is string=>home!==null)])];
    const unknownHome=[...targets.values()].some(target=>target.home===null);
    this.slackIds=config.slack.servers??(preferred?[preferred]:[]);
    this.lock=openSync(join(this.dir,'runtime.lock'),'wx',0o600);
    try{
      writeFileSync(this.lock,String(process.pid));
      for(const [id,profile] of profiles){
        const target=targets.get(id)!;
        const subdir=id==='default'?this.dir:managedDirectory(managedDirectory(this.dir,'servers'),id);
        if(id!=='default')assertManagedFiles(subdir);
        let store:Store;
        try{store=new Store(subdir,{id,fingerprint:targetFingerprint(profile,target),allowLegacy:id==='default'&&profiles.size===1});}
        catch(e){if(['TARGET_CHANGED','LEGACY_TARGET_AMBIGUOUS'].includes((e as Error).message)){this.blocked.add(id);continue;}throw e;}
        try{
          const requireHome=profiles.size>1||!!profile.codexHome;
          const backend=makeBackend?makeBackend(profile,id):new SharedAppServer(profile,undefined,requireHome?target.home!:undefined);
          this.backends.set(id,backend);
          const context:RuntimeContext={id,protectedHomes,unknownHome,defaultRoute:id===this.slackIds.find(a=>!this.blocked.has(a)),
            slackReady:()=>this.slackReady&&this.slackIds.includes(id),
            principal:principal=>this.principal(principal),
            servers:source=>source.kind==='local'?this.servers(this.principal(source.userId)!):this.projectServers(this.slackIds),
            route:(selector,command)=>{
              const first=this.slackIds.find(a=>this.cores.has(a));
              const invalid=()=>id===first?'reject' as const:'other' as const;
              try{const dest=selector===undefined&&command==='server.list'?first:resolveServerId(config,selector as string|undefined);if(!dest||!this.cores.has(dest)||!this.slackIds.includes(dest))return invalid();return dest===id?'accept':'other';}catch{return invalid();}
            }};
          this.cores.set(id,new Connector(config,store,backend,slack,1100,screens,context));
        }catch(e){store.close();throw e;}
      }
    }catch(e){for(const c of this.cores.values())c.store.close();closeSync(this.lock);unlinkSync(join(this.dir,'runtime.lock'));throw e;}
  }
  principal(id:string):LocalPrincipal|undefined{
    if(id==='local')return OPERATOR;
    const g=this.config.local?.agents?.find(x=>`agent:${x.id}`===id);
    return g?{id,role:'agent',servers:g.servers,projects:g.projects,commands:g.commands}:undefined;
  }
  private projectServers(ids:string[]){return listServers(this.config,ids,this.backends).map(row=>this.blocked.has(row.serverId)?{...row,connected:false,status:'blocked'}:row);}
  servers(p=OPERATOR){if(p.role==='agent'&&!p.commands?.includes('server.list'))throw new ConnectorError('LOCAL_SCOPE_DENIED');return this.projectServers(p.role==='operator'?[...configuredServers(this.config).keys()]:(p.servers??[]));}
  core(selector:unknown,p=OPERATOR){
    if(selector!==undefined&&typeof selector!=='string')throw new ConnectorError('SERVER_UNAVAILABLE');
    const id=resolveServerId(this.config,selector as string|undefined);
    if(p.role==='agent'&&!p.servers?.includes(id))throw new ConnectorError('SERVER_UNAVAILABLE');
    const core=this.cores.get(id);if(!core)throw new ConnectorError('SERVER_UNAVAILABLE');return core;
  }
  local(request:CommandEnvelope,p=OPERATOR){
    const selector=request.params.serverId;
    // server.list itself needs no single default route. Only its receipt uses a
    // permitted physical ledger; choose deterministically, never reroute a write.
    const home=selector===undefined&&request.command==='server.list'?this.servers(p).find(x=>this.cores.has(x.serverId))?.serverId:selector;
    const core=this.core(home,p);const normalized={...request,params:{...request.params,serverId:core.runtime!.id}};
    return core.local(normalized,p);
  }
  receipt(params:{serverId?:string;workId:string},p:LocalPrincipal){return this.core(params.serverId,p).receipt(params.workId,p);}
  events(params:Page,p:LocalPrincipal,signal?:AbortSignal){return this.core(params.serverId,p).readEvents(params,p,signal);}
  unwatch(params:{serverId?:string;sessionId:string;subscriptionId:string},p:LocalPrincipal){return this.core(params.serverId,p).unwatch(params,p);}
  status(serverId?:string){const selected=serverId===undefined?defaultServer(this.config):resolveServerId(this.config,serverId);if(serverId!==undefined&&!this.cores.has(selected!))throw new ConnectorError('SERVER_UNAVAILABLE');const core=selected?this.cores.get(selected):undefined;return{...(core?.status()??{}),serverId:selected??null,servers:this.servers(),slackConnected:this.slackReady};}
  sessionPage(params:Record<string,unknown>={}){const {serverId,...rest}=params;return this.core(serverId).sessionPage(rest);}
  recover(kind:'command'|'outbox',id:string,ts?:string,serverId?:string){this.core(serverId).recover(kind,id,ts);}
  async connectLocal(){await Promise.all([...this.cores.values()].map(c=>c.reconnect()));}
  async enableSlack(userId:string,botId:string){
    if(this.config.slack.enabled===false||!userId)throw Error('SLACK_UNAVAILABLE');
    const epoch=++this.slackEpoch;this.slackReady=false;
    const allowed=[...this.cores].filter(([id])=>this.slackIds.includes(id)).map(([,c])=>c);
    for(const c of allowed){c.selfUserId=userId;c.selfBotId=botId;await c.initializeSlack();}
    if(this.closed||this.slackEpoch!==epoch)throw Error("SLACK_IDENTITY_CHANGED");this.slackReady=true;
    await Promise.all(allowed.map(async c=>{if(c.backend.connected)await c.subscriptions.rejoin();c.pump();c.flush();}));
  }
  disableSlack(){this.slackEpoch++;this.slackReady=false;}
  accept(body:unknown){if(!this.slackReady)return false;for(const id of this.slackIds){const c=this.cores.get(id);if(c?.accept(body)){c.pump();c.flush();return true;}}return false;}
  async tick(){await Promise.all([...this.cores.values()].map(async c=>{if(!c.backend.connected)await c.reconnect();await c.expire();c.pump();c.flush();}));}
  async close(){if(this.closed)return;this.closed=true;this.disableSlack();try{await Promise.all([...this.cores.values()].map(async c=>{try{await c.close();}finally{c.store.close();}}));}finally{closeSync(this.lock);unlinkSync(join(this.dir,'runtime.lock'));}}
}
