import { COMMANDS, type CommandName, type CommandSpec, type ParamSpec } from './protocol.js';
import { isObject, type LocalClient } from './local-client.js';

type Schema = Record<string,unknown>;
type Tool = { name:string; description:string; inputSchema:Schema; call:(args:Record<string,unknown>)=>Promise<unknown> };
const serverId={type:'string',minLength:1,maxLength:64,pattern:'^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$',description:'Explicit configured server ID or alias, not the connector instance ID.'};
const requestId={type:'string',minLength:8,maxLength:128,pattern:'^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$',description:'Stable idempotency key. Retry an uncertain admission only with this same key, server and identical arguments.'};
const handle={type:'string',minLength:1,maxLength:128,pattern:'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'};
const objectSchema=(properties:Schema,required:string[]=[])=>({type:'object',properties,required,additionalProperties:false});
const own=(o:object,k:string)=>Object.hasOwn(o,k);

function schema(p:ParamSpec):Schema {
  const s:Schema={type:p.type==='enum'?'string':p.type,description:p.description};
  if (p.type==='string'){if(p.min!==undefined)s.minLength=p.min;if(p.max!==undefined)s.maxLength=p.max;if(p.pattern)s.pattern=p.pattern;}
  if (p.type==='integer'){if(p.min!==undefined)s.minimum=p.min;if(p.max!==undefined)s.maximum=p.max;}
  if (p.type==='enum')s.enum=p.values;
  if (p.default!==undefined)s.default=p.default;
  return s;
}
// This is intentionally not a generic envelope/HTTP/RPC bridge. Only this fixed
// tool surface is available, even when the owner runs the adapter themselves.
function tools(client:LocalClient):Tool[] {
  const direct=(name:string,description:string,props:Schema,required:string[],call:Tool['call']):Tool=>({
    name,description,inputSchema:objectSchema(props,required),call:args=>{
      if (Object.keys(args).some(k=>!own(props,k))||required.some(k=>!own(args,k)))throw Error('Unexpected or missing tool argument');
      return call(args);
    }
  });
  const list:Tool[]=[
    direct('server_list','List only the configured servers this credential can select.',{},[],()=>client.servers()),
    direct('receipt_get','Read one exact work receipt with the original principal and server. Command completion is not model completion.',{serverId,workId:{...handle,description:'Exact work ID returned by command admission.'}},['workId'],args=>client.receipt(args)),
    direct('session_unwatch','Stop this local event subscription only. Does not interrupt the model or affect other owners. A new session_events call can subscribe again.',{serverId,sessionId:handle,subscriptionId:handle},['sessionId','subscriptionId'],args=>client.unwatch(args)),
    direct('session_events','Read or briefly wait for local final messages and terminal turns on one explicitly bound session. Pass its returned cursor unchanged; inspect gap and hasMore.',{
      serverId,sessionId:handle,cursor:{type:'string',minLength:1,maxLength:256},waitMs:{type:'integer',minimum:0,maximum:30000},limit:{type:'integer',minimum:1,maximum:100}
    },['sessionId'],args=>client.events(args))
  ];
  const commands:CommandName[]=['session.list','session.info','session.history','session.attach','session.create','session.send','session.queue','session.steer','session.interrupt','session.delivery'];
  for(const name of commands){
    const spec:CommandSpec=COMMANDS[name],properties:Schema={serverId,requestId};
    const required:string[]=spec.permission==='read'?[]:['requestId'];
    for(const [key,p] of Object.entries(spec.params)){
      if(key==='outputThreadTs'||key==='serverId')continue; // local tools do not publish to Slack
      properties[key]=schema(p);if(p.required)required.push(key);
    }
    const desc=name==='session.create'?'Create a new local session in an authorized project.':name==='session.attach'?'Bind an explicitly selected existing shared Codex thread locally.':spec.description;
    list.push(direct(name.replace('.','_'),desc+' Returns inbox admission. Use receipt_get with the returned server and work ID for the operation result.',properties,required,args=>{
      const {requestId:id,...params}=args;
      return client.command(name,params,id);
    }));
  }
  return list;
}

class RpcError extends Error {constructor(readonly code:number,message:string){super(message);}}
const versions=['2025-11-25','2025-06-18','2025-03-26','2024-11-05'];
type RpcId=string|number;
const isId=(x:unknown):x is RpcId=>typeof x==='string'||(typeof x==='number'&&Number.isSafeInteger(x));
const response=(data:unknown)=>new Promise<void>((resolve,reject)=>{
  process.stdout.write(JSON.stringify(data)+'\n',e=>e?reject(e):resolve());
});
const rpcError=(id:RpcId|null,code:number,message:string)=>response({jsonrpc:'2.0',id,error:{code,message}});

export async function runMcp(client:LocalClient):Promise<void> {
  const registry=new Map(tools(client).map(tool=>[tool.name,tool]));
  let phase:'new'|'initializing'|'ready'='new';
  const pending=new Set<RpcId>();
  async function dispatch(line:Buffer){
    let m:unknown;
    try{m=JSON.parse(line.toString('utf8'));}catch{return rpcError(null,-32700,'Parse error');}
    if(!isObject(m)||m.jsonrpc!=='2.0'||typeof m.method!=='string'||(own(m,'id')&&!isId(m.id)))return rpcError(null,-32600,'Invalid request');
    if(!own(m,'id')){
      if(m.method==='notifications/initialized'&&phase==='initializing')phase='ready';
      return; // notifications, including unknown ones, never trigger a tool or receive a reply
    }
    const id=m.id as RpcId;
    if(pending.has(id))return rpcError(null,-32600,'Duplicate in-flight request ID');
    pending.add(id);
    try{
      const params=m.params===undefined?{}:m.params;
      if(!isObject(params))throw new RpcError(-32602,'Expected parameter object');
      let result:unknown;
      if(m.method==='ping')result={};
      else if(m.method==='initialize'){
        if(phase!=='new')throw new RpcError(-32600,'Already initialized');
        if(typeof params.protocolVersion!=='string'||!isObject(params.capabilities)||!isObject(params.clientInfo)||typeof params.clientInfo.name!=='string'||typeof params.clientInfo.version!=='string')throw new RpcError(-32602,'Invalid initialization parameters');
        const version=versions.includes(params.protocolVersion)?params.protocolVersion:versions[0];
        result={protocolVersion:version,capabilities:{tools:{}},serverInfo:{name:'codex-connector',version:'0.2.0'},instructions:'Select an authorized server and exact session. Admission is not model completion. Inspect receipt_get, message delivery evidence and cursor-based session_events. No raw RPC or approvals.'};
        phase='initializing';
      }else{
        if(phase!=='ready')throw new RpcError(-32002,'Initialize and send notifications/initialized first');
        if(m.method==='tools/list'){
          if(params.cursor!==undefined)throw new RpcError(-32602,'No continuation for this tool list');
          result={tools:[...registry.values()].map(({call,...tool})=>tool)};
        }else if(m.method==='tools/call'){
          if(typeof params.name!=='string'||!registry.has(params.name))throw new RpcError(-32602,'Unknown tool');
          const args=params.arguments===undefined?{}:params.arguments;
          if(!isObject(args))throw new RpcError(-32602,'Expected tool arguments object');
          try{
            const value=await registry.get(params.name)!.call(args);
            if(!isObject(value)||value.ok!==true||!own(value,'result'))throw Error('Invalid connector response');
            result={content:[{type:'text',text:JSON.stringify(value.result)}]};
          }catch(error){
            result={isError:true,content:[{type:'text',text:error instanceof Error?error.message:'Local connector request failed'}]};
          }
        }else throw new RpcError(-32601,'Method not found');
      }
      await response({jsonrpc:'2.0',id,result});
    }catch(error){
      if(!(error instanceof RpcError))throw error;
      await rpcError(id,error.code,error.message);
    }finally{pending.delete(id);}
  }
  // NDJSON stdio transport: reject oversized frames without accumulating them.
  // Bounded concurrency lets a receipt/ping complete during another call's poll.
  const active=new Set<Promise<void>>();
  const enqueue=(job:Promise<void>)=>{active.add(job);job.then(()=>active.delete(job),()=>active.delete(job));};
  const maxFrame=65536;let chunks:Buffer[]=[],length=0,discard=false;
  for await(const input of process.stdin){
    const chunk=Buffer.isBuffer(input)?input:Buffer.from(input);
    for(let start=0;start<chunk.length;){
      const end=chunk.indexOf(10,start),part=chunk.subarray(start,end<0?chunk.length:end);start=end<0?chunk.length:end+1;
      if(!discard){
        length+=part.length;
        if(length>maxFrame){discard=true;chunks=[];}
        else if(part.length)chunks.push(part);
      }
      if(end!==-1){
        if(active.size>=16)await Promise.race(active);
        if(discard)enqueue(rpcError(null,-32600,'Request frame exceeds 64 KiB'));
        else if(length)enqueue(dispatch(Buffer.concat(chunks,length)));
        chunks=[];length=0;discard=false;
      }
    }
  }
  // EOF closes stdio; never execute an unfinished frame and never abort/replay
  // an admitted command. Pending event waits naturally finish within their cap.
  await Promise.all(active);
}
