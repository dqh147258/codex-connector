import { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, Tray, Menu, nativeImage, clipboard, session } from 'electron';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { DesktopSettings, importConfigPreview, inspectLock, recoverStaleLock } from './settings.js';
import { SlackSetup } from './slack-setup.js';
import { DesktopRuntime, probeCodex } from './runtime.js';
import { readLoginState, updateLoginState } from './login.js';
import { safeError, strictObject, textField, validSender, sessionListParams } from './ipc-policy.js';
let window:BrowserWindow|undefined,tray:Tray|undefined,quitting=false,shutdownRequested=false,quitTask:Promise<void>|undefined;
let settings:DesktopSettings,runtime:DesktopRuntime;
const slack=new SlackSetup();
const root=app.getAppPath(),uiPath=join(root,'desktop/ui/index.html'),uiUrl=pathToFileURL(uiPath).href;
const home=join(app.getPath('userData'),'connector');
function show(){if(window){window.show();window.focus();}}
function ensureStopped(){if(shutdownRequested)throw Error('CANCELLED');if(runtime.snapshot().owned)throw Error('SERVER_RUNNING');}
function credentials(){const value=settings.getCredentials();if(!value)throw Error('CREDENTIALS_REQUIRED');return value;}
function login(){return readLoginState(app,process.platform,app.isPackaged,process.execPath);}
function detectedExecutable(){for(const p of [join(homedir(),'.local/bin/codex'),'/opt/homebrew/bin/codex','/usr/local/bin/codex',join(homedir(),'.npm-global/bin/codex')]){try{if(existsSync(p))return realpathSync(p);}catch{}}return '';}
async function snapshot(){const config=settings.readConfig();if(!config.backend.executable)config.backend.executable=detectedExecutable();const c=settings.credentialStatus();return{config,preferences:settings.readPreferences(),credentials:{appToken:c.appToken,botToken:c.botToken,secureStorage:c.secureStorageAvailable},runtime:await runtime.refresh(),login:login(),platform:process.platform,packaged:app.isPackaged};}
async function confirm(title:string,message:string){const result=await dialog.showMessageBox(window!,{type:'question',title,message,buttons:['取消','确认'],defaultId:0,cancelId:0,noLink:true});if(result.response!==1)throw Error('CANCELLED');}
const methods:Record<string,(value:any)=>unknown|Promise<unknown>>={
  snapshot:()=>snapshot(),
  listSessions:value=>runtime.listSessions(sessionListParams(value)),
  saveConfig:async value=>{ensureStopped();const previous=settings.readConfig();if(value?.sessionPolicy?.allowAllSharedSessions===true&&!previous.sessionPolicy?.allowAllSharedSessions)await confirm('扩大共享会话管理范围','允许管理同账户、项目根以外的共享会话？只读文件范围不会扩大，原 Codex 沙箱不会改变。');if(value?.filePolicy?.allowAbsolutePaths===true&&previous.filePolicy?.allowAbsolutePaths!==true){await confirm('允许系统范围的绝对路径只读访问','高风险：配置中受信任的 Slack 用户和 bot 可以请求读取此操作系统账户可读的任意路径，并将内容发送到 Slack。敏感路径、秘密内容和文件类型防护仍然生效，但不构成完整的数据防泄漏保证；此开关不提升操作系统权限、不允许写入。仅在你明确接受这些接收者访问范围后确认。');ensureStopped();}if(value?.backend?.autoStartDaemon===true&&!previous.backend.autoStartDaemon)await confirm('允许启动共享 Codex daemon','连接时可运行官方 daemon start；它可能准备 daemon 包或管理 Codex 自身更新器。不提权、不停止共享 daemon。');ensureStopped();settings.saveConfig(value);return snapshot();},
  saveCredentials:value=>{ensureStopped();settings.saveCredentials(value);const c=settings.credentialStatus();return{appToken:c.appToken,botToken:c.botToken,secureStorage:c.secureStorageAvailable};},
  savePreferences:value=>{settings.savePreferences(value);return settings.readPreferences();},
  testSlack:async()=>{const c=credentials();const r=await slack.testTokens(c.appToken,c.botToken);return{...r,selfUserId:r.connectorUserId,selfBotId:r.connectorBotId};},
  lookupDot:async value=>{const v=strictObject(value,['userId']);return slack.resolveDot(credentials().botToken,textField(v.userId,64));},
  listUsers:async()=>{const r=await slack.listUsers(credentials().botToken);return{users:r.users.map(u=>({id:u.userId,name:u.name,isBot:u.isBot})),hasMore:!!r.nextCursor};},
  listChannels:async()=>{const r=await slack.listChannels(credentials().botToken);return{channels:r.channels.map(c=>({id:c.channelId,name:c.name,isMember:c.isMember})),manual:r.manualEntryRequired,requiredScopes:r.requiredScopes,hasMore:!!r.nextCursor};},
  choosePath:async value=>{const v=strictObject(value,['kind']);if(!['executable','project','import'].includes(String(v.kind)))throw Error('INVALID_ARGUMENT');const selected=await dialog.showOpenDialog(window!,{title:v.kind==='import'?'选择已有 connector config.json（仅预览）':v.kind==='project'?'选择允许只读访问的项目目录':'选择 Codex 可执行文件或 bin/codex.js',defaultPath:v.kind==='import'?join(homedir(),'.codex-connector/config.json'):undefined,properties:v.kind==='project'?['openDirectory']:['openFile'],filters:v.kind==='import'?[{name:'JSON configuration',extensions:['json']}]:undefined});if(selected.canceled)return{};const path=selected.filePaths[0]!;return v.kind==='import'?{path,config:importConfigPreview(path)}:{path:realpathSync(path)};},
  probeCodex:value=>{const v=strictObject(value,['executable']);return probeCodex(textField(v.executable));},
  start:()=>{ensureStopped();settings.initRuntimeFiles();return runtime.start(settings.readConfig(),credentials());},
  stop:()=>runtime.stop(),
  inspectLock:()=>inspectLock(home),
  recoverLock:async()=>{ensureStopped();const lock=inspectLock(home);if(!lock.eligible)throw Error('LOCK_RECOVERY_NOT_ALLOWED');await confirm('备份已确认失效的锁','仅在记录进程不存在、锁归当前用户且未变化时改名备份。不会删除会话、令牌或状态。');ensureStopped();const result=recoverStaleLock(home,lock);return{recovered:true,backup:result.backupPath};},
  setLoginStartup:async value=>{const v=strictObject(value,['enabled']);if(typeof v.enabled!=='boolean')throw Error('INVALID_ARGUMENT');await confirm(v.enabled?'开启登录自启动':'关闭登录自启动',v.enabled?'登录此系统账户后启动桌面应用。是否自动连接由另一个开关控制；这不是登录前服务。':'从系统登录项中移除此应用，不删除配置或令牌。');if(shutdownRequested)throw Error('CANCELLED');return updateLoginState(app,process.platform,app.isPackaged,process.execPath,v.enabled);},
  openHelp:async value=>{const v=strictObject(value,['topic']);const links:Record<string,string>={slackApps:'https://api.slack.com/apps',slackManifest:'https://api.slack.com/apps',guide:'https://github.com/dqh147258/codex-connector/blob/feat/electron-desktop/docs/DESKTOP.md',codex:'https://developers.openai.com/codex/cli/'};if(!Object.hasOwn(links,String(v.topic)))throw Error('INVALID_ARGUMENT');if(v.topic==='slackManifest')clipboard.writeText(readFileSync(join(root,'slack-app-manifest.json'),'utf8'));await shell.openExternal(links[String(v.topic)]!);return{opened:true,manifestCopied:v.topic==='slackManifest'};},
  quit:()=>{void requestQuit();return{quitting:true};}
};
async function requestQuit(){
  if(quitTask)return quitTask;shutdownRequested=true;
  quitTask=(async()=>{try{await runtime.stop();quitting=true;app.quit();}catch{show();await dialog.showMessageBox(window!,{type:'warning',message:'安全停止尚未完成。应用保持打开，请稍候再试；不会强杀共享 Codex 或删除锁。'});}})().finally(()=>{quitTask=undefined;});return quitTask;
}
if(!app.requestSingleInstanceLock())app.quit();else{
  app.on('second-instance',show);
  app.whenReady().then(async()=>{
    settings=new DesktopSettings(home,safeStorage);runtime=new DesktopRuntime(home,join(root,'dist/src/cli.js'));
    session.defaultSession.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));session.defaultSession.setPermissionCheckHandler(()=>false);
    window=new BrowserWindow({width:1180,height:820,minWidth:850,minHeight:660,title:'Codex Connector',backgroundColor:'#f5f6f8',show:false,webPreferences:{preload:join(root,'desktop/preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,allowRunningInsecureContent:false,devTools:!app.isPackaged}});
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',e=>e.preventDefault());window.webContents.on('will-attach-webview',e=>e.preventDefault());
    for(const[name,handler]of Object.entries(methods))ipcMain.handle('desktop:'+name,async(event,value)=>{
      try{if(!window||!validSender(event.sender,event.senderFrame,window.webContents,window.webContents.mainFrame,event.senderFrame?.url||'',uiUrl))throw Error('INVALID_ARGUMENT');if(JSON.stringify(value??null).length>131072)throw Error('INVALID_ARGUMENT');return{ok:true,value:await handler(value)};}catch(e){return{ok:false,error:safeError(e)};}
    });
    const pixels=Buffer.alloc(16*16*4);for(let y=0;y<16;y++)for(let x=0;x<16;x++){const r=Math.hypot(x-7.5,y-7.5);if(r>=4&&r<=6.5&&!(x>8&&Math.abs(y-7.5)<3)){const i=(y*16+x)*4;pixels[i]=pixels[i+1]=pixels[i+2]=32;pixels[i+3]=255;}}
    const icon=nativeImage.createFromBitmap(pixels,{width:16,height:16});icon.setTemplateImage(true);
    tray=new Tray(icon);tray.setToolTip('Codex Connector');tray.setContextMenu(Menu.buildFromTemplate([{label:'打开 Codex Connector',click:show},{label:'停止连接',click:()=>{void runtime.stop().catch(()=>show());}},{type:'separator'},{label:'退出（停止连接器）',click:()=>{void requestQuit();}}]));tray.on('click',show);
    window.on('close',event=>{if(quitting)return;event.preventDefault();if(settings.readPreferences().closeToTray&&tray){window?.hide();}else void requestQuit();});
    await window.loadFile(uiPath);const loginLaunch=process.platform==='darwin'&&app.getLoginItemSettings().wasOpenedAtLogin;if(!process.argv.includes('--background')&&!loginLaunch)show();
    if(settings.readPreferences().autoConnect){try{settings.initRuntimeFiles();runtime.start(settings.readConfig(),credentials());}catch{show();}}
  }).catch(()=>{dialog.showErrorBox('无法启动桌面应用','私有配置目录或系统安全组件不可用。没有读取或输出令牌。');quitting=true;app.quit();});
  app.on('activate',show);app.on('window-all-closed',()=>{});app.on('before-quit',event=>{if(quitting)return;event.preventDefault();if(runtime)void requestQuit();else{quitting=true;app.quit();}});
}
