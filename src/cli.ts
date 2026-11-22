#!/usr/bin/env node
import { desktopScreenPort } from './screen-ipc.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { join, resolve } from 'node:path';
import { SocketModeClient, LogLevel } from '@slack/socket-mode';
import { home, loadConfig, readToken } from './config.js';
import { Runtime, pinRuntimeHome } from './runtime.js';
import { SlackLink } from './slack-link.js';
import type { SlackPort } from './types.js';
import { SlackClient } from './slack.js';
import { apiServer } from './server.js';
import { commandEnvelope, localClient, withServer } from './local-client.js';
import { runMcp } from './mcp.js';
import { formatHelp, START_MARKER, END_MARKER } from './protocol.js';
import { generateService } from './services.js';
function options(args:string[]){
  const out:Record<string,string>=Object.create(null);
  for(let i=0;i<args.length;i+=2){const k=args[i],v=args[i+1];if(!k||!/^--[a-z][a-z-]*$/.test(k)||v===undefined||Object.hasOwn(out,k.slice(2)))throw Error('Expected unique --option value pairs');out[k.slice(2)]=v;}
  return out;
}
const allowedOptions:Record<string,string[]>={
  help:['command'],'--help':['command'],init:['mode'],start:[],doctor:[],'migration-preview':[],
  'service-template':['platform','mode','user','node','script','cwd'],
  servers:[],unwatch:['server','session-id','subscription-id'],status:['server'],receipt:['server','work-id'],events:['server','session-id','cursor','wait-ms','limit'],
  command:['name','params','params-file','id','server'],envelope:['name','params','params-file','id','server'],mcp:[],
  'native-share':['operation','server','subscription-id'],
  recover:['kind','id','observed-ts','server']
};

async function start(){
  const dir=pinRuntimeHome(home()),config=loadConfig(dir), local=config.local?.enabled!==false, wantsSlack=config.slack.enabled!==false;
  // Slack-only mode neither reads a local token nor opens a loopback listener.
  const token=local?readToken(dir):undefined;
  if(token && config.local?.agents?.some(a=>a.tokenHash===createHash('sha256').update(token).digest('hex')))throw Error('Operator and scoped agent tokens must be distinct');
  const appToken=wantsSlack?process.env.SLACK_APP_TOKEN:undefined, botToken=wantsSlack?process.env.SLACK_BOT_TOKEN:undefined;
  const slack=wantsSlack&&appToken?.startsWith('xapp-')&&botToken?.startsWith('xoxb-')?new SlackClient(botToken):undefined;
  if(wantsSlack&&!slack&&!local)throw Object.assign(Error('Slack-only mode needs valid app and bot tokens'),{code:'SLACK_AUTH_FAILED'});
  const unavailable=async()=>{throw Error('SLACK_UNAVAILABLE');};
  const inert:SlackPort={post:unavailable,resolveDot:unavailable,humanMessage:unavailable,threadExists:unavailable};
  const runtime=new Runtime(config,dir,slack??inert,desktopScreenPort());
  let server:ReturnType<typeof apiServer>|undefined;
  const link=slack?new SlackLink(config.slack.teamId,runtime,()=>slack.web.auth.test(),()=>new SocketModeClient({
    appToken:appToken!,logLevel:LogLevel.ERROR,autoReconnectEnabled:false,clientOptions:{retryConfig:{retries:0},rejectRateLimitedCalls:true,timeout:10000}
  })):undefined;
  let stopping=false,stopTask:Promise<void>|undefined,timer:NodeJS.Timeout|undefined;
  let tick:Promise<void>|undefined,connecting:Promise<void>|undefined,slackTask:Promise<void>|undefined;
  const stop=()=>stopTask??=(async()=>{
    stopping=true;if(timer)clearInterval(timer);
    runtime.stopConnecting();runtime.disableSlack();
    const closeHTTP=server?new Promise<void>(r=>{server!.close(()=>r());server!.closeAllConnections();}):Promise.resolve();
    await Promise.all([closeHTTP,link?.close(),tick,connecting,slackTask?.catch(()=>{})]);
    await runtime.close();
  })();
  const onSignal=()=>{void stop().then(()=>{if(process.env.CONNECTOR_DESKTOP_CHILD==='1'&&process.connected)process.disconnect?.();})
    .catch(()=>{console.error('Shutdown uncertain; inspect proxy and lock before restart.');process.exitCode=1;});};
  process.on('SIGINT',onSignal);process.on('SIGTERM',onSignal);
  if(process.env.CONNECTOR_DESKTOP_CHILD==='1'&&process.send){
    process.on('message',m=>{if(m&&typeof m==='object'&&'type' in m&&m.type==='connector:stop'){if(process.connected)process.send?.({type:'connector:stopping'});onSignal();}});
    process.once('disconnect',onSignal);
  }
  const degraded=()=>console.error('Slack unavailable. No Slack commands or deliveries will be processed until reverified.');
  try{
    if(token){
      server=apiServer(runtime,token);
      await new Promise<void>((r,j)=>{server!.once('error',j);server!.listen(config.port,'127.0.0.1',r);});if(stopping)return;
    }
    if(!local&&link){slackTask=link.connect();await slackTask;slackTask=undefined;if(stopping)return;}
    if(wantsSlack&&!link)degraded();
    connecting=runtime.connectLocal().catch(()=>console.error('A configured backend is unavailable; inspect server status.')).finally(()=>{connecting=undefined;});
    if(local&&link){slackTask=link.connect().catch(degraded).finally(()=>{slackTask=undefined;});}
    timer=setInterval(()=>{
      if(stopping)return;
      if(link&&!slackTask)slackTask=link.connect().catch(degraded).finally(()=>{slackTask=undefined;});
      if(!tick)tick=runtime.tick().catch(()=>console.error('Connector background operation unavailable; inspect status.')).finally(()=>{tick=undefined;});
    },5000);
    if(process.connected)process.send?.({type:'connector:ready'});
    console.log('Connector '+config.instanceId+' running; '+(local?'local endpoint 127.0.0.1:'+config.port:'Slack only, no local listener')+'.');
  }catch(e){
    await stop();const cause=e as NodeJS.ErrnoException;
    const code=cause?.code==='EADDRINUSE'?'LOCAL_PORT_IN_USE':['WORKSPACE_MISMATCH','SLACK_AUTH_FAILED'].includes(cause?.code||'')?cause.code:'SERVER_START_FAILED';
    throw Object.assign(Error('Startup failed; check configuration, identities, port and network.'),{code});
  }
}
async function main(){
  const [cmd='help',...args]=process.argv.slice(2),f=options(args);if(f.home)process.env.CONNECTOR_HOME=resolve(f.home);
  if(!Object.hasOwn(allowedOptions,cmd))throw Error('Unknown CLI command; use help');
  const clientCommand=['servers','status','receipt','events','unwatch','command','mcp','recover'].includes(cmd);
  const allowed=new Set(['home',...allowedOptions[cmd]!,...(clientCommand?['port','target']:[])]);
  if(Object.keys(f).some(k=>!allowed.has(k)))throw Error('Unknown option for '+cmd+'; use help');
  if(cmd==='help'||cmd==='--help'){console.log(`codex-connector 0.2
init [--mode local|slack|dual] | doctor | migration-preview [--home PATH] | start [--home PATH] | servers | status [--server ID]
command --name NAME [--params JSON | --params-file FILE|-] [--server ID] [--id REQUEST_ID]
receipt --work-id ID [--server ID]
events --session-id ID [--server ID] [--cursor CURSOR] [--wait-ms 0..30000] [--limit 1..100]
unwatch --session-id ID --subscription-id ID [--server ID]
native-share --operation inspect|create|revoke --server CANONICAL_ID --subscription-id ID (local operator; create requires consent to a new, dedicated session)
mcp (stdio; use a scoped CONNECTOR_TOKEN for agents)
Local clients may use --port PORT --target INSTANCE with CONNECTOR_TOKEN instead of accessing operator files.
envelope --name NAME --params JSON [--server ID] [--id ID]
recover --kind command|outbox --id ID [--server ID] [--observed-ts SLACK_TS] (operator only)
service-template --platform linux|macos|windows --mode login|prelogin --user USER --node ABS --script ABS --cwd ABS [--home ABS]

${formatHelp(f.command)}`);return;}
  if(cmd==='init'){
    if(f.mode!==undefined&&!['local','slack','dual'].includes(f.mode))throw Error('init --mode must be local, slack or dual');
    const dir=home();mkdirSync(dir,{recursive:true,mode:0o700});
    const config={version:2,instanceId:'my-computer',port:17381,slack:{teamId:'T_REPLACE',inputChannel:'C_REPLACE',outputChannel:'C_REPLACE',allowedHumans:['U_REPLACE'],approvalUsers:['U_REPLACE'],trustedBots:[{botId:'B_REPLACE',userId:'U_DOT',appId:'A_REPLACE'}],dot:{name:'YOUR_DOT_NAME',userId:'U_DOT'}},projects:{demo:'/absolute/project'},sessionPolicy:{allowAllSharedSessions:false},filePolicy:{allowAbsolutePaths:false},screenPolicy:{enabled:false},backend:{executable:'/absolute/codex',autoStartDaemon:false},approvalTimeoutSec:300};
    const template=f.mode==='local'?{...config,slack:{enabled:false},local:{enabled:true,agents:[]}}:
      f.mode==='slack'?{...config,local:{enabled:false},slack:{...config.slack,enabled:true}}:
      f.mode==='dual'?{...config,local:{enabled:true,agents:[]},slack:{...config.slack,enabled:true}}:config;
    if(!existsSync(join(dir,'config.json')))writeFileSync(join(dir,'config.json'),JSON.stringify(template,null,2),{mode:0o600,flag:'wx'});
    if(f.mode!=='slack'&&!existsSync(join(dir,'api.token')))writeFileSync(join(dir,'api.token'),randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});
    console.log(`Initialized private templates in ${dir}. Existing files preserved; no service/Codex was started.`);return;
  }
  if(cmd==='migration-preview'){const {migrationPreview}=await import('./migration-preview.js');console.log(JSON.stringify(migrationPreview(home()),null,2));return;}
  if(cmd==='service-template'){console.log(JSON.stringify(generateService({platform:f.platform as any,mode:f.mode as any,user:f.user,nodeExecutable:f.node||process.execPath,scriptPath:f.script||resolve('dist/src/cli.js'),workingDirectory:f.cwd||process.cwd(),configHome:home()}),null,2));return;}
  if(cmd==='doctor'){const c=loadConfig();if(c.local?.enabled!==false)readToken();for(const [id,profile] of (await import('./servers.js')).configuredServers(c))if(!existsSync(profile.executable))throw Error('Configured executable missing for server '+id);console.log('Local configuration valid. Codex was not launched; shared connectivity is checked only when you start the server.');return;}
  if(cmd==='start'){await start();return;}
  if(cmd==='command'||cmd==='envelope'){
    if(f.params!==undefined&&f['params-file']!==undefined)throw Error('Choose --params or --params-file, not both');
    let parsed:unknown;
    try{parsed=JSON.parse(f['params-file']?readFileSync(f['params-file']==='-'?0:f['params-file'],'utf8'):f.params??'{}');}catch{throw Error('Cannot read valid JSON parameters');}
    const params=withServer(parsed,f.server);
    if(!f.name)throw Error('--name is required');
    if(cmd==='envelope'){
      const envelope=commandEnvelope(loadConfig().instanceId,f.name,params,f.id);
      console.log(START_MARKER+'\n'+JSON.stringify(envelope)+'\n'+END_MARKER);return;
    }
    console.log(JSON.stringify(await localClient(f.port,f.target).command(f.name,params,f.id),null,2));return;
  }
  if(cmd==='native-share'){
    if(f.operation==='grant')throw Error('Existing Codex sessions remain status-only in Slack. Use native-share --operation create to explicitly create a new dedicated sharing session.');
    if(Object.hasOwn(process.env,'CONNECTOR_TOKEN')||!['inspect','create','revoke'].includes(f.operation??'')||!f.server||!f['subscription-id'])throw Error('Use the local operator terminal: native-share --operation inspect|create|revoke --server CANONICAL_ID --subscription-id ID (no CONNECTOR_TOKEN)');
    const owner=localClient(),subscriptionId=f['subscription-id'];
    if(f.operation==='create'){
      if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error('Native sharing requires an interactive local operator terminal; no automatic consent');
      const offer=await owner.nativeShare('preview-create',f.server,subscriptionId) as {confirmationId:string;confirmationPhrase:string;disclosure:string;serverId:string;nativeThreadId:string;workspaceId:string;channel:string;rootThreadTs:string;project:string};
      console.log(`Verified server: ${offer.serverId}; project: ${offer.project}
Existing route reference (not shared): ${offer.nativeThreadId}
Slack destination: ${offer.workspaceId} / ${offer.channel} / ${offer.rootThreadTs}
${offer.disclosure}
Type the exact confirmation below to create and share a separate new session, or press Enter to cancel:
${offer.confirmationPhrase}`);
      const terminal=createInterface({input:process.stdin,output:process.stdout,terminal:true});
      let answer:string;try{answer=await terminal.question('> ');}finally{terminal.close();}
      if(answer!==offer.confirmationPhrase){console.log('Not shared.');return;}
      console.log(JSON.stringify(await owner.nativeShare('create',f.server,subscriptionId,{confirmationId:offer.confirmationId,phrase:answer}),null,2));return;
    }
    console.log(JSON.stringify(await owner.nativeShare(f.operation as 'inspect'|'revoke',f.server,subscriptionId),null,2));return;
  }
  if(cmd==='mcp'&&!process.env.CONNECTOR_TOKEN?.trim())throw Error('Missing CONNECTOR_TOKEN for MCP; use a scoped agent credential');
  const client=localClient(f.port,f.target);
  if(cmd==='mcp'){await runMcp(client);return;}
  let result:unknown;
  if(cmd==='servers')result=await client.servers();
  else if(cmd==='status')result=await client.status(f.server);
  else if(cmd==='receipt')result=await client.receipt({serverId:f.server,workId:f['work-id']});
  else if(cmd==='events')result=await client.events({serverId:f.server,sessionId:f['session-id'],cursor:f.cursor,waitMs:f['wait-ms']===undefined?undefined:Number(f['wait-ms']),limit:f.limit===undefined?undefined:Number(f.limit)});
  else if(cmd==='unwatch')result=await client.unwatch({serverId:f.server,sessionId:f['session-id'],subscriptionId:f['subscription-id']});
  else if(cmd==='recover')result=await client.recover(f.kind!,f.id!,f['observed-ts'],f.server);
  console.log(JSON.stringify(result,null,2));
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Connector failure');process.exitCode=1;if(process.env.CONNECTOR_DESKTOP_CHILD==='1'&&process.connected){const c=(e as any)?.code;const code=c==='EEXIST'?'LOCK_EXISTS':c==='ENOENT'?'CONFIGURATION_INVALID':['LOCAL_PORT_IN_USE','WORKSPACE_MISMATCH','SLACK_AUTH_FAILED'].includes(c)?c:'SERVER_START_FAILED';process.send?.({type:'connector:failure',code},()=>{if(process.connected)process.disconnect?.();});}});
