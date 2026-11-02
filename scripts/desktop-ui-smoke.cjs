/* Native Electron renderer-only smoke: all IPC is a fixture, never real credentials,
 * connector startup, Slack, Codex or OS login-item changes. Screenshots are QA artifacts. */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
const root=path.resolve(__dirname,'..');const temp=fs.mkdtempSync(path.join(os.tmpdir(),'connector-ui-smoke-'));
fs.mkdirSync(path.join(temp,'profile'));app.setPath('userData',path.join(temp,'profile'));app.disableHardwareAcceleration();
const fixture={config:{version:2,instanceId:'my-mac',port:17381,slack:{teamId:'TEXAMPLE',inputChannel:'CINPUT',outputChannel:'COUTPUT',allowedHumans:['UHUMAN'],approvalUsers:['UHUMAN'],trustedBots:[{userId:'UDOT',botId:'BDOT',appId:'ADOT'}],dot:{userId:'UDOT',name:'我的 dot'}},projects:{project:'/Users/example/work/project'},backend:{executable:'/Users/example/.local/bin/codex',autoStartDaemon:false},approvalTimeoutSec:300,sessionPolicy:{allowAllSharedSessions:false}},preferences:{autoConnect:false,closeToTray:true},credentials:{appToken:false,botToken:false,secureStorage:true},runtime:{state:'stopped',owned:false},login:{supported:true,enabled:false},platform:'darwin',packaged:true};
const preload=path.join(temp,'mock-preload.cjs');fs.writeFileSync(preload,`const {contextBridge}=require('electron');contextBridge.exposeInMainWorld('connector',{snapshot:async()=>({ok:true,value:${JSON.stringify(fixture)}})});`);
const timer=setTimeout(()=>{console.error('Renderer smoke timed out');app.exit(1);},20000);
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1280,height:900,show:false,webPreferences:{preload,contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true}});
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 await win.loadFile(path.join(root,'desktop/ui/index.html'));
 await win.webContents.executeJavaScript('document.fonts.ready');
 await new Promise(r=>setTimeout(r,500));
 const out=path.join(root,'desktop-preview');fs.mkdirSync(out,{recursive:true});
 for(const view of ['overview','setup','startup']){
  await win.webContents.executeJavaScript(`document.querySelector('[data-view="${view}"]').click()`);
  await new Promise(r=>setTimeout(r,150));
  const image=await win.webContents.capturePage();if(image.isEmpty())throw Error('Empty screenshot');fs.writeFileSync(path.join(out,view+'.png'),image.toPNG());
 }
 const safety=await win.webContents.executeJavaScript(`({node:typeof process,require:typeof require,token:document.getElementById('app-token').value})`);
 if(safety.node!=='undefined'||safety.require!=='undefined'||safety.token!=='')throw Error('Renderer isolation mismatch');
 clearTimeout(timer);win.destroy();app.exit(0);
}).catch(()=>{console.error('Native renderer smoke failed; no credentials or integration were exercised');clearTimeout(timer);app.exit(1);});
