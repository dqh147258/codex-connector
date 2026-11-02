#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { SocketModeClient, LogLevel } from '@slack/socket-mode';
import { home, loadConfig, readToken } from './config.js';
import { Store } from './store.js';
import { SlackClient } from './slack.js';
import { SharedAppServer } from './codex.js';
import { Connector } from './connector.js';
import { apiServer } from './server.js';
import { commandRequest } from './client.js';
import { formatHelp, START_MARKER, END_MARKER, validateCommand } from './protocol.js';
import { generateService } from './services.js';
function options(args:string[]){const out:Record<string,string>={};for(let i=0;i<args.length;i+=2){const k=args[i],v=args[i+1];if(!k?.startsWith('--')||v===undefined)throw Error('Use --option value');out[k.slice(2)]=v;}return out;}
async function start(){
  const config=loadConfig(),token=readToken(),appToken=process.env.SLACK_APP_TOKEN,botToken=process.env.SLACK_BOT_TOKEN;
  if(!appToken?.startsWith('xapp-')||!botToken?.startsWith('xoxb-'))throw Error('Slack app/bot tokens required only in daemon environment');
  const store=new Store(home()),slack=new SlackClient(botToken),backend=new SharedAppServer(config.backend),connector=new Connector(config,store,backend,slack),server=apiServer(connector,token);
  const socket=new SocketModeClient({appToken,logLevel:LogLevel.ERROR});let stopping=false;let stopTask:Promise<void>|undefined;let timer:NodeJS.Timeout|undefined;let tick:Promise<void>|undefined;
  const stop=()=>stopTask??=(async()=>{stopping=true;if(timer)clearInterval(timer);await socket.disconnect().catch(()=>{});await new Promise<void>(r=>server.close(()=>r()));await tick;await connector.close();store.close();})();
  const onSignal=()=>{void stop().then(()=>{if(process.env.CONNECTOR_DESKTOP_CHILD==='1'&&process.connected)process.disconnect?.();}).catch(()=>{console.error('Shutdown uncertain; inspect proxy and lock before restart.');process.exitCode=1;});};process.on('SIGINT',onSignal);process.on('SIGTERM',onSignal);
  if(process.env.CONNECTOR_DESKTOP_CHILD==='1'&&process.send){
    process.on('message',m=>{if(m&&typeof m==='object'&&'type' in m&&m.type==='connector:stop'){if(process.connected)process.send?.({type:'connector:stopping'});void stop().then(()=>{if(process.connected)process.disconnect?.();}).catch(onSignal);}});
    process.once('disconnect',onSignal);
  }
  socket.on('message',async({body,ack}:any)=>{try{connector.accept(body);await ack();connector.pump();connector.flush();}catch{console.error('Event was not durably accepted; no acknowledgement. Check storage/queue.');}});
  socket.on('error',()=>console.error('Slack connection error; reconnect remains active.'));
  try{
    const auth=await slack.web.auth.test();if(stopping)return;if(auth.team_id!==config.slack.teamId)throw Error('WORKSPACE_MISMATCH');connector.selfUserId=auth.user_id||'';connector.selfBotId=auth.bot_id||'';
    await connector.initialize();if(stopping)return;await new Promise<void>((r,j)=>{server.once('error',j);server.listen(config.port,'127.0.0.1',r);});if(stopping)return;await socket.start();if(stopping){await socket.disconnect().catch(()=>{});return;}
    timer=setInterval(()=>{if(stopping||tick)return;tick=(async()=>{if(!backend.connected)await connector.reconnect();await connector.expire();connector.pump();connector.flush();})().catch(()=>console.error('Connector background operation unavailable; inspect status.')).finally(()=>{tick=undefined;});},5000);
    process.send?.({type:'connector:ready'});
    console.log(`Connector ${config.instanceId} online at127.0.0.1:${config.port}; shared backend connected=${backend.connected}. Use status for capability failures.`);
  }catch(e){await stop();const error=Error('Startup failed; check config, identities, tokens, port and network. Raw credentials/errors withheld.');const cause=e as any;Object.assign(error,{code:cause?.code==='EADDRINUSE'?'LOCAL_PORT_IN_USE':cause?.message==='WORKSPACE_MISMATCH'?'WORKSPACE_MISMATCH':cause?.data?.error==='invalid_auth'||cause?.data?.error==='token_revoked'?'SLACK_AUTH_FAILED':'SERVER_START_FAILED'});throw error;}
}
async function main(){
  const [cmd='help',...args]=process.argv.slice(2),f=options(args);if(f.home)process.env.CONNECTOR_HOME=resolve(f.home);
  if(cmd==='help'||cmd==='--help'){console.log(`codex-connector0.2\ninit | doctor | start [--home PATH] | status | command --name NAME --params JSON [--id ID] | envelope --name NAME --params JSON\nrecover --kind command|outbox --id ID [--observed-ts SLACK_TS] (local operator only)\nservice-template --platform linux|macos|windows --mode login|prelogin --user USER --node ABS --script ABS --cwd ABS [--home ABS]\n\n${formatHelp(f.command)}`);return;}
  if(cmd==='init'){
    const dir=home();mkdirSync(dir,{recursive:true,mode:0o700});
    const config={version:2,instanceId:'my-computer',port:17381,slack:{teamId:'T_REPLACE',inputChannel:'C_REPLACE',outputChannel:'C_REPLACE',allowedHumans:['U_REPLACE'],approvalUsers:['U_REPLACE'],trustedBots:[{botId:'B_REPLACE',userId:'U_DOT',appId:'A_REPLACE'}],dot:{name:'YOUR_DOT_NAME',userId:'U_DOT'}},projects:{demo:'/absolute/project'},sessionPolicy:{allowAllSharedSessions:false},filePolicy:{allowAbsolutePaths:false},backend:{executable:'/absolute/codex',autoStartDaemon:false},approvalTimeoutSec:300};
    if(!existsSync(join(dir,'config.json')))writeFileSync(join(dir,'config.json'),JSON.stringify(config,null,2),{mode:0o600,flag:'wx'});
    if(!existsSync(join(dir,'api.token')))writeFileSync(join(dir,'api.token'),randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});
    console.log(`Initialized private templates in${dir}. Existing files preserved; no service/Codex was started.`);return;
  }
  if(cmd==='service-template'){console.log(JSON.stringify(generateService({platform:f.platform as any,mode:f.mode as any,user:f.user,nodeExecutable:f.node||process.execPath,scriptPath:f.script||resolve('dist/src/cli.js'),workingDirectory:f.cwd||process.cwd(),configHome:home()}),null,2));return;}
  if(cmd==='doctor'){const c=loadConfig();readToken();if(!existsSync(c.backend.executable))throw Error('Configured executable missing');console.log('Local configuration valid. Codex was not launched; shared connectivity is checked only when you start the server.');return;}
  if(cmd==='start'){await start();return;}
  const config=loadConfig();let payload:any;
  if(cmd==='status')payload={action:'status'};
  else if(cmd==='recover')payload={action:'recover',kind:f.kind,id:f.id,observedTs:f['observed-ts']};
  else if(cmd==='command'||cmd==='envelope'){
    const params=JSON.parse(f['params-file']?readFileSync(f['params-file']==='-'?0:f['params-file'],'utf8'):f.params||'{}');validateCommand(f.name!,params);
    const envelope={v:1,id:f.id||randomUUID(),target:config.instanceId,command:f.name,params};
    if(cmd==='envelope'){console.log(`${START_MARKER}\n${JSON.stringify(envelope)}\n${END_MARKER}`);return;}payload={action:'command',envelope};
  }else throw Error('Unknown CLI command; use help');
  console.log(JSON.stringify(await commandRequest(config.port,readToken(),payload),null,2));
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Connector failure');process.exitCode=1;if(process.env.CONNECTOR_DESKTOP_CHILD==='1'&&process.connected){const c=(e as any)?.code;const code=c==='EEXIST'?'LOCK_EXISTS':c==='ENOENT'?'CONFIGURATION_INVALID':['LOCAL_PORT_IN_USE','WORKSPACE_MISMATCH','SLACK_AUTH_FAILED'].includes(c)?c:'SERVER_START_FAILED';process.send?.({type:'connector:failure',code},()=>{if(process.connected)process.disconnect?.();});}});
