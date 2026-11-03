import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { Connector } from '../src/connector.js';
import { START_MARKER, END_MARKER, type CommandEnvelope } from '../src/protocol.js';
import type { Backend, Config, SlackPort } from '../src/types.js';
export class FakeBackend extends EventEmitter implements Backend {
  connected=false;epoch='epoch-1';calls:{method:string;params:any}[]=[];responses:any[]=[];threads=new Map<string,any>();fault?:string;
  async connect(){this.connected=true;}async close(){this.connected=false;this.emit('disconnect',this.epoch);}
  capabilities(){return{connected:this.connected,epoch:this.epoch,transport:'fake-shared'};}
  async rpc(method:string,params:any):Promise<any>{this.calls.push({method,params});if(this.fault===method)throw Error('fake fault');
    if(method==='thread/list')return{data:[...this.threads.values()],nextCursor:null};
    if(method==='thread/loaded/list')return{data:[...this.threads.keys()],nextCursor:null};
    if(method==='thread/read'||method==='thread/resume'){const thread=this.threads.get(params.threadId);if(!thread)throw Error('not found');return{thread};}
    if(method==='thread/start'){const thread={id:randomUUID(),cwd:params.cwd,canAcceptDirectInput:true,status:{type:'idle'},model:'configured-model'};this.threads.set(thread.id,thread);return{thread};}
    if(method==='thread/items/list')return{data:[{turnId:'turn-1',item:{type:'agentMessage',text:'safe history'}}],nextCursor:null};
    if(method==='thread/queue/list'||method==='thread/turns/list')return{data:[],nextCursor:null};
    if(method==='thread/queue/add')return{queuedSubmission:{id:'queued-1',clientUserMessageId:params.clientUserMessageId,input:params.input}};
    if(method==='turn/start'||method==='turn/steer'||method==='thread/queue/start')return{turn:{id:'turn-1',status:'inProgress'}};
    return{};
  }
  async respond(id:string|number,result:unknown){this.responses.push({id,result});}
}
export function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'connector-v2-')),store=new Store(dir),backend=new FakeBackend(),posts:any[]=[];
  const config:Config={version:2,instanceId:'test',port:17381,projects:{repo:dir},backend:{executable:process.execPath},approvalTimeoutSec:30,slack:{teamId:'T1',inputChannel:'CIN',outputChannel:'COUT',allowedHumans:['UHUMAN'],approvalUsers:['UHUMAN'],trustedBots:[{botId:'BDOT',userId:'UDOT',appId:'ADOT'}],dot:{name:'dot',userId:'UDOT'}}};
  const slack:SlackPort={async post(channel,text,options){const ts=`100.${posts.length+1}`;posts.push({channel,text,...options,ts});return ts;},async resolveDot(){return{userId:'UDOT',name:'dot'};},async threadExists(){return true;},async humanMessage(){return undefined;}};
  const connector=new Connector(config,store,backend,slack,0);connector.selfUserId='USELF';connector.selfBotId='BSELF';
  return{dir,store,backend,config,slack,posts,connector,async cleanup(){await connector.close();store.close();rmSync(dir,{recursive:true,force:true});}};
}
export const request=(command:string,params:any={},id:string=randomUUID())=>({v:1,id,target:'test',command,params}) as CommandEnvelope;
export const envelope=(r:CommandEnvelope)=>`${START_MARKER}\n${JSON.stringify(r)}\n${END_MARKER}`;
export const event=(r:CommandEnvelope,overrides:any={})=>({team_id:'T1',event_id:randomUUID(),event:{type:'message',channel:'CIN',user:'UDOT',bot_id:'BDOT',app_id:'ADOT',subtype:'bot_message',ts:'90.1',text:envelope(r),...overrides}});
export async function waitFor(test:()=>boolean){for(let i=0;i<300;i++){if(test())return;await new Promise(r=>setTimeout(r,2));}throw Error('Test condition timed out');}
export async function ready(f:ReturnType<typeof fixture>){await f.connector.initialize();await run(f,'session.create',{project:'repo'});await waitFor(()=>Boolean(f.store.state.sessions[0]?.threadTs)&&f.posts.length>0);return f.store.state.sessions[0]!;}
export async function run(f:ReturnType<typeof fixture>,command:string,params:any={}){const r=f.connector.local(request(command,['session.create','session.attach'].includes(command)?{outputThreadTs:'100.1',...params}:params));await waitFor(()=>['completed','failed','uncertain'].includes(f.store.state.work.find(w=>w.id===r.id)?.status||''));return f.store.state.work.find(w=>w.id===r.id)!;}
export async function pending(f:ReturnType<typeof fixture>,s:any,params:any={},method='item/commandExecution/requestApproval'){
  f.backend.emit('request',{id:101,epoch:f.backend.epoch,method,params:{threadId:s.threadId,turnId:'turn-1',itemId:'item-1',command:'echo hello',cwd:f.dir,...params}});await waitFor(()=>f.store.state.pending.length>0);return f.store.state.pending.at(-1)!;
}
export const human=(r:CommandEnvelope,threadTs:string)=>event(r,{user:'UHUMAN',bot_id:undefined,app_id:undefined,subtype:undefined,channel:'COUT',thread_ts:threadTs});
