import { randomUUID } from 'node:crypto';
import { commandRequest } from './client.js';
import { loadConfig, readToken } from './config.js';
import { START_MARKER, END_MARKER, parseEnvelope } from './protocol.js';

const serverPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const instancePattern = /^[A-Za-z0-9_-]{1,80}$/;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export type LocalClient = ReturnType<typeof localClient>;

export function isObject(value: unknown): value is Record<string,unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function validServer(id: unknown) {
  if (id !== undefined && (typeof id !== 'string' || !serverPattern.test(id))) throw Error('Invalid server ID');
  return id as string | undefined;
}
export function withServer(params: unknown, server?: unknown) {
  if (!isObject(params)) throw Error('Params must be a JSON object');
  if (server !== undefined && Object.hasOwn(params,'serverId') && params.serverId !== server) throw Error('Conflicting server IDs');
  validServer(server ?? params.serverId);
  return server === undefined ? params : { ...params, serverId:server };
}
export function commandEnvelope(target: string, name: unknown, params: unknown, id: unknown = randomUUID()) {
  const envelope = {v:1, id, target, command:name, params};
  parseEnvelope(START_MARKER+'\n'+JSON.stringify(envelope)+'\n'+END_MARKER,target); // strict schema & size
  return envelope; // preserve caller's fields, including omitted defaults
}
function integer(value: unknown, min: number, max: number, field: string) {
  if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value<min || value>max)) throw Error('Invalid '+field);
  return value as number | undefined;
}
function checkKeys(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some(k=>!keys.includes(k))) throw Error('Unexpected argument');
}
export function localClient(portValue?: string, targetValue?: string) {
  if ((portValue === undefined) !== (targetValue === undefined)) throw Error('Use --port and --target together');
  // An agent using a scoped bearer does not need any access to the operator home.
  const config = portValue === undefined ? loadConfig() : undefined;
  const port = config?.port ?? Number(portValue), target=config?.instanceId ?? targetValue!;
  if (!Number.isSafeInteger(port) || port<1024 || port>65535 || !instancePattern.test(target)) throw Error('Invalid local endpoint');
  // Fail closed on missing/blank agent credentials when using an explicit agent endpoint.
  if ((portValue !== undefined || Object.hasOwn(process.env,'CONNECTOR_TOKEN')) && !process.env.CONNECTOR_TOKEN?.trim()) throw Error('Missing CONNECTOR_TOKEN');
  const token=readToken();
  const request=(payload:unknown,timeoutMs?:number)=>commandRequest(port,token,payload,timeoutMs);
  return {
    servers:()=>request({action:'servers'}),
    status:(serverId?:string)=>request({action:'status',serverId:validServer(serverId)}),
    command:(name:string,params:unknown,id?:unknown)=>request({action:'command',envelope:commandEnvelope(target,name,params,id)}),
    receipt:(args:Record<string,unknown>)=>{
      checkKeys(args,['serverId','workId']);
      if (typeof args.workId!=='string'||!idPattern.test(args.workId)) throw Error('Invalid workId');
      return request({action:'receipt',serverId:validServer(args.serverId),workId:args.workId});
    },
    events:(args:Record<string,unknown>)=>{
      checkKeys(args,['serverId','sessionId','cursor','waitMs','limit']);
      if (typeof args.sessionId!=='string' || !idPattern.test(args.sessionId)) throw Error('Invalid sessionId');
      if (args.cursor!==undefined && (typeof args.cursor!=='string'||!args.cursor.length||args.cursor.length>256)) throw Error('Invalid event cursor');
      const waitMs=integer(args.waitMs,0,30000,'waitMs');
      return request({action:'events',serverId:validServer(args.serverId),sessionId:args.sessionId,cursor:args.cursor,waitMs,limit:integer(args.limit,1,100,'limit')}, Math.max(30000,(waitMs??0)+5000));
    },
    unwatch:(args:Record<string,unknown>)=>{
      checkKeys(args,['serverId','sessionId','subscriptionId']);
      for(const k of ['sessionId','subscriptionId'])if(typeof args[k]!=='string'||!idPattern.test(args[k] as string))throw Error('Invalid '+k);
      return request({action:'unwatch',serverId:validServer(args.serverId),sessionId:args.sessionId,subscriptionId:args.subscriptionId});
    },
    nativeShare:(operation:'inspect'|'preview'|'grant'|'revoke',serverId:string,subscriptionId:string,approval?:{confirmationId:string;phrase:string})=>{
      if(!serverId||!validServer(serverId)||!idPattern.test(subscriptionId))throw Error('Supply an exact canonical --server and --subscription-id');
      return request({action:'native.share',operation,serverId,subscriptionId,...approval},45000);
    },
    recover:(kind:string,id:string,observedTs?:string,serverId?:string)=>request({action:'recover',kind,id,observedTs,serverId:validServer(serverId)})
  };
}
