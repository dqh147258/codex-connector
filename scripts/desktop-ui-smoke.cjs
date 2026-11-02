/* Native Electron renderer-only smoke: all IPC is a fixture, never real credentials,
 * connector startup, Slack, Codex or OS login-item changes. Screenshots are QA artifacts. */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
const root=path.resolve(__dirname,'..');const temp=fs.mkdtempSync(path.join(os.tmpdir(),'connector-ui-smoke-'));
fs.mkdirSync(path.join(temp,'profile'));app.setPath('userData',path.join(temp,'profile'));app.disableHardwareAcceleration();
const fixture={config:{version:2,instanceId:'my-mac',port:17381,slack:{teamId:'TEXAMPLE',inputChannel:'CINPUT',outputChannel:'COUTPUT',allowedHumans:['UHUMAN'],approvalUsers:['UHUMAN'],trustedBots:[{userId:'UDOT',botId:'BDOT',appId:'ADOT'}],dot:{userId:'UDOT',name:'我的 dot'}},projects:{project:'/Users/example/work/project'},backend:{executable:'/Users/example/.local/bin/codex',autoStartDaemon:false},approvalTimeoutSec:300,sessionPolicy:{allowAllSharedSessions:false},filePolicy:{allowAbsolutePaths:false}},preferences:{autoConnect:false,closeToTray:true},credentials:{appToken:false,botToken:false,secureStorage:true},runtime:{state:'stopped',owned:false},login:{supported:true,enabled:false},platform:'darwin',packaged:true};
// Deliberately distinct runtime observations, not real sessions or transcript data.
const sessions={sessions:[
 {id:'fixture-active',name:'正在执行 · 已加载',cwd:'/Users/example/work/project',source:'cli',model:'fixture-model',loaded:true,status:{type:'active'},manageable:true,canAcceptDirectInput:true,discoverySources:['loaded','stored'],binding:{channel:'COUTPUT',threadTs:'1700000000.000001'}},
 {id:'fixture-idle',name:'空闲 · 不等于执行中',cwd:'/Users/example/work/project',source:'cli',loaded:true,status:{type:'idle'},manageable:true,canAcceptDirectInput:true,discoverySources:['loaded']},
 {id:'fixture-history',name:'历史记录 · 不声称仍在运行',cwd:'/Users/example/archive',source:'cli',loaded:false,status:{type:'active'},manageable:false,reason:'工作目录不在允许的项目范围内',discoverySources:['stored']},
 {id:'fixture-unknown',name:'已发现 · 加载状态未确认',cwd:'/Users/example/work/project',source:'unknown',loaded:null,status:{type:'unknown'},manageable:true,discoverySources:['stored']}
],nextCursor:'fixture-page-2',scope:'仅 fixture 元数据；stored / loaded 分别分页，当前不是完整列表'};
const nextSessions={sessions:[
 {...sessions.sessions[1],loaded:false,discoverySources:['stored']},
 {id:'fixture-not-loaded',name:'历史会话 · 返回未加载',cwd:'/Users/example/work/project',loaded:false,status:{type:'notLoaded'},manageable:true,discoverySources:['stored']}
],nextCursor:null,scope:sessions.scope};
const preload=path.join(temp,'mock-preload.cjs');fs.writeFileSync(preload,`
const {contextBridge}=require('electron');
const unavailable=async()=>({ok:false,error:{code:'FIXTURE_ONLY',message:'此截图测试不执行本机或外部操作。'}});
const bridge={};
// Optional renderer actions always fail closed in this fixture, never reach IPC.
for(const name of ['saveConfig','saveCredentials','savePreferences','testSlack','lookupDot','listUsers','listChannels','choosePath','probeCodex','start','stop','inspectLock','recoverLock','setLoginStartup','openHelp','quit']) bridge[name]=unavailable;
bridge.snapshot=async()=>({ok:true,value:${JSON.stringify(fixture)}});
bridge.listSessions=async params=>params?.cursor&&params.cursor!=='fixture-page-2'
 ? unavailable() : ({ok:true,value:params?.cursor?${JSON.stringify(nextSessions)}:${JSON.stringify(sessions)}});
contextBridge.exposeInMainWorld('connector',Object.freeze(bridge));
`);
const timer=setTimeout(()=>{console.error('Renderer smoke timed out');app.exit(1);},20000);
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1280,height:900,show:false,webPreferences:{preload,contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true}});
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 await win.loadFile(path.join(root,'desktop/ui/index.html'));
 await win.webContents.executeJavaScript('document.fonts.ready');
 await new Promise(r=>setTimeout(r,500));
 const out=path.join(root,'desktop-preview');fs.mkdirSync(out,{recursive:true});
 for(const view of ['overview','setup','startup','sessions']){
  await win.webContents.executeJavaScript(`document.querySelector('[data-view="${view}"]').click()`);
  if(view==='sessions'){
   await win.webContents.executeJavaScript(`document.getElementById('sessions-refresh').click()`);
   await new Promise(r=>setTimeout(r,150));
   const state=await win.webContents.executeJavaScript(`({count:document.querySelectorAll('#sessions-list article').length,partial:document.getElementById('sessions-pagination').textContent,more:!document.getElementById('sessions-more').hidden,text:document.getElementById('sessions-list').textContent})`);
   if(state.count!==4||!state.more||!state.partial.includes('不是全部结果')||!state.text.includes('读取时空闲')||!state.text.includes('非当前运行状态'))throw Error('Session fixture did not render partial runtime/history distinctions');
   // Capture every fixture card and the pagination controls, not only the first fold.
   const height=await win.webContents.executeJavaScript('document.documentElement.scrollHeight');
   if(height>6000)throw Error('Unexpected session fixture layout height');
   win.setContentSize(1280,Math.max(900,height));
  }
  await new Promise(r=>setTimeout(r,150));
  const image=await win.webContents.capturePage();if(image.isEmpty())throw Error('Empty screenshot');fs.writeFileSync(path.join(out,view+'.png'),image.toPNG());
 }
 // Exercise manual pagination and deduplication without changing the partial screenshot.
 await win.webContents.executeJavaScript(`document.getElementById('sessions-more').click()`);
 await new Promise(r=>setTimeout(r,150));
 const paged=await win.webContents.executeJavaScript(`({count:document.querySelectorAll('#sessions-list article').length,more:document.getElementById('sessions-more').hidden,idle:document.querySelector('[data-thread-id="fixture-idle"]').textContent})`);
 if(paged.count!==5||!paged.more||!paged.idle.includes('读取时空闲'))throw Error('Session pagination/deduplication smoke failed');
 const safety=await win.webContents.executeJavaScript(`({node:typeof process,require:typeof require,token:document.getElementById('app-token').value})`);
 if(safety.node!=='undefined'||safety.require!=='undefined'||safety.token!=='')throw Error('Renderer isolation mismatch');
 clearTimeout(timer);win.destroy();app.exit(0);
}).catch(()=>{console.error('Native renderer smoke failed; no credentials or integration were exercised');clearTimeout(timer);app.exit(1);});
