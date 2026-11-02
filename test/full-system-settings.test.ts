import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { parseConfig } from '../src/config.js';
import { DesktopSettings, importConfigPreview } from '../desktop/settings.js';
import type { Config } from '../src/types.js';
const { JSDOM } = createRequire(import.meta.url)('jsdom');
const copy=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
function fixture(){
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'file-policy-settings-')));
  const settings=new DesktopSettings(dir,{isEncryptionAvailable:()=>false,encryptString:()=>Buffer.alloc(0),decryptString:()=>''});
  const config=settings.defaultConfig();config.slack={teamId:'TTEAM',inputChannel:'CINPUT',outputChannel:'COUTPUT',allowedHumans:['UHUMAN'],approvalUsers:['UHUMAN'],trustedBots:[{botId:'BDOT',userId:'UDOT',appId:'ADOT'}],dot:{name:'Dot',userId:'UDOT'}};config.projects={repo:dir};config.backend.executable=process.execPath;
  return{dir,settings,config,close:()=>rmSync(dir,{recursive:true,force:true})};
}
test('absolute file access is off in desktop, CLI and example defaults, and old imports never enable it',()=>{
  const f=fixture();try{
    assert.equal(f.settings.defaultConfig().filePolicy?.allowAbsolutePaths,false);
    assert.equal(JSON.parse(readFileSync('config.example.json','utf8')).filePolicy.allowAbsolutePaths,false);
    assert.match(readFileSync('src/cli.ts','utf8'),/filePolicy:\{allowAbsolutePaths:false\}/);
    const old=copy(f.config);delete old.filePolicy;
    assert.notEqual(parseConfig(copy(old)).filePolicy?.allowAbsolutePaths,true);
    const path=join(f.dir,'import.json');writeFileSync(path,JSON.stringify(old));
    assert.notEqual(importConfigPreview(path).filePolicy?.allowAbsolutePaths,true);
    f.settings.saveConfig(old);assert.notEqual(f.settings.readConfig().filePolicy?.allowAbsolutePaths,true);
  }finally{f.close();}
});
test('filePolicy requires an explicit boolean and rejects null, arrays, unknown or inherited fields',()=>{
  const f=fixture();try{
    for(const policy of [null,[],{},false,'yes',{allowAbsolutePaths:'true'},{allowAbsolutePaths:1},{allowAbsolutePaths:null},{allowAbsolutePaths:true,write:true},Object.create({allowAbsolutePaths:true})]){
      const raw={...f.config,filePolicy:policy};assert.throws(()=>parseConfig(raw as Config));assert.throws(()=>f.settings.saveConfig(raw));
    }
    for(const allowed of [false,true]){const c={...f.config,filePolicy:{allowAbsolutePaths:allowed}};f.settings.saveConfig(c);assert.equal(f.settings.readConfig().filePolicy?.allowAbsolutePaths,allowed);assert.equal(f.settings.readConfig().sessionPolicy?.allowAllSharedSessions,false);}
  }finally{f.close();}
});
function nativeSaveHarness(config:Config){
  const source=readFileSync('desktop/main.ts','utf8');
  const start=source.indexOf('saveConfig:async value=>')+'saveConfig:'.length;
  const end=source.indexOf(',\n  saveCredentials:',start);
  assert.ok(start>0&&end>start);
  let running=false,saves=0,confirmations:{title:string;message:string}[]=[],duringConfirm:()=>void=()=>{},cancel=false;
  const handler=runInNewContext('('+source.slice(start,end)+')',{
    ensureStopped:()=>{if(running)throw Error('SERVER_RUNNING');},
    settings:{readConfig:()=>copy(config),saveConfig:()=>{saves++;}},snapshot:()=>({}),
    confirm:async(title:string,message:string)=>{confirmations.push({title,message});duringConfirm();if(cancel)throw Error('CANCELLED');}
  }) as (value:Config)=>Promise<unknown>;
  return{handler,get saves(){return saves;},confirmations,setRunningDuringConfirm:()=>{duringConfirm=()=>{running=true;};},cancel:()=>{cancel=true;}};
}
test('native save requires explicit risk confirmation only when widening file access',async()=>{
  const f=fixture();try{
    const c=copy(f.config);c.filePolicy={allowAbsolutePaths:true};const h=nativeSaveHarness(f.config);await h.handler(c);
    assert.equal(h.saves,1);assert.equal(h.confirmations.length,1);
    assert.match(h.confirmations[0]!.message,/Slack 用户和 bot/);assert.match(h.confirmations[0]!.message,/操作系统账户/);assert.match(h.confirmations[0]!.message,/不允许写入/);
    const unchanged=nativeSaveHarness(c);await unchanged.handler(c);assert.equal(unchanged.confirmations.length,0);
    const denied=nativeSaveHarness(f.config);denied.cancel();await assert.rejects(denied.handler(c),/CANCELLED/);assert.equal(denied.saves,0);
  }finally{f.close();}
});
test('native permission change rechecks stopped state after dialog before persisting',async()=>{
  const f=fixture();try{const h=nativeSaveHarness(f.config);h.setRunningDuringConfirm();await assert.rejects(h.handler({...f.config,filePolicy:{allowAbsolutePaths:true}}),/SERVER_RUNNING/);assert.equal(h.saves,0);}finally{f.close();}
});
const settle=async()=>{for(let i=0;i<5;i++)await new Promise<void>(r=>setImmediate(r));};
test('desktop checkbox defaults off and roundtrips true/false without expanding session policy',async()=>{
  const f=fixture();let dom:any;
  try{
    const initial=copy(f.config);delete initial.filePolicy;
    const state:any={config:initial,preferences:{autoConnect:false,closeToTray:true},credentials:{appToken:false,botToken:false,secureStorage:false},runtime:{state:'stopped',owned:false,backend:{connected:false}},login:{supported:false,enabled:false},platform:'darwin',packaged:false};
    dom=new JSDOM(readFileSync('desktop/ui/index.html','utf8'),{url:'file:///fixture/index.html',runScripts:'outside-only'});
    const w=dom.window,saved:any[]=[];let rejectNext=true;w.scrollTo=()=>{};w.setInterval=()=>1;w.clearInterval=()=>{};
    w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
    w.connector={snapshot:async()=>({ok:true,value:copy(state)}),saveConfig:async(value:any)=>{if(rejectNext){rejectNext=false;return{ok:false,error:{code:'CANCELLED',message:'用户取消了授权。'}};}saved.push(copy(value));state.config=copy(value);return{ok:true,value:copy(state)};}};
    w.eval(readFileSync('desktop/ui/renderer.js','utf8'));await settle();
    const check=w.document.getElementById('allow-absolute-paths'),form=w.document.getElementById('config-form');
    assert.equal(check.checked,false);assert.match(check.closest('label').textContent,/默认关闭/);assert.match(check.closest('label').textContent,/不允许写入/);
    check.checked=true;check.dispatchEvent(new w.Event('change',{bubbles:true}));form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await settle();
    assert.equal(saved.length,0);assert.notEqual(state.config.filePolicy?.allowAbsolutePaths,true);assert.match(w.document.getElementById('dirty-label').textContent,/尚未保存/);
    for(const value of [true,false]){check.checked=value;check.dispatchEvent(new w.Event('change',{bubbles:true}));form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await settle();assert.equal(saved.at(-1).filePolicy.allowAbsolutePaths,value);assert.equal(saved.at(-1).sessionPolicy.allowAllSharedSessions,false);assert.equal(check.checked,value);}
  }finally{dom?.window.close();f.close();}
});
test('empty project roots require local absolute-file opt-in, including imported settings',()=>{
  const f=fixture();try{
    for(const policy of [undefined,{allowAbsolutePaths:false}]){const config={...f.config,projects:{},filePolicy:policy};assert.throws(()=>parseConfig(copy(config)));assert.throws(()=>f.settings.saveConfig(config));}
    const config={...f.config,projects:{},filePolicy:{allowAbsolutePaths:true}};
    assert.deepEqual(parseConfig(copy(config)).projects,{});f.settings.saveConfig(config);assert.deepEqual(f.settings.readConfig().projects,{});
    assert.equal(f.settings.readConfig().sessionPolicy?.allowAllSharedSessions,false);
    const path=join(f.dir,'import-empty-projects.json');writeFileSync(path,JSON.stringify(config));assert.deepEqual(importConfigPreview(path).projects,{});
    for(const projects of [null,[],undefined])assert.throws(()=>parseConfig({...config,projects} as unknown as Config));
  }finally{f.close();}
});
test('desktop may remove only the displayed project with explicit absolute opt-in and rejects partial pairs',async()=>{
  const f=fixture();let dom:any;
  try{
    const initial=copy(f.config);initial.projects={repo:f.dir,other:f.dir};
    const state:any={config:initial,preferences:{autoConnect:false,closeToTray:true},credentials:{},runtime:{state:'stopped',owned:false,backend:{connected:false}},login:{supported:false,enabled:false},platform:'darwin',packaged:false};
    dom=new JSDOM(readFileSync('desktop/ui/index.html','utf8'),{url:'file:///fixture/index.html',runScripts:'outside-only'});
    const w=dom.window,saved:any[]=[];w.scrollTo=()=>{};w.setInterval=()=>1;w.clearInterval=()=>{};
    w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
    w.connector={snapshot:async()=>({ok:true,value:copy(state)}),saveConfig:async(value:any)=>{parseConfig(copy(value));saved.push(copy(value));state.config=copy(value);return{ok:true,value:copy(state)};}};
    w.eval(readFileSync('desktop/ui/renderer.js','utf8'));await settle();
    const el=(id:string)=>w.document.getElementById(id),submit=async()=>{el('config-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await settle();};
    assert.equal(el('project-alias').required,true);assert.equal(el('project-path').required,true);
    el('allow-absolute-paths').checked=true;el('allow-absolute-paths').dispatchEvent(new w.Event('change',{bubbles:true}));
    assert.equal(el('project-alias').required,false);assert.equal(el('project-path').required,false);
    el('project-alias').value='';await submit();assert.equal(saved.length,0);
    el('project-path').value='';await submit();assert.deepEqual(saved.at(-1).projects,{other:f.dir});assert.equal(saved.at(-1).sessionPolicy.allowAllSharedSessions,false);
    assert.equal(el('project-alias').value,'other');el('project-alias').value='';el('project-path').value='';await submit();assert.deepEqual(saved.at(-1).projects,{});
    assert.equal(el('project-alias').value,'');assert.equal(el('project-path').value,'');
    el('allow-absolute-paths').checked=false;el('allow-absolute-paths').dispatchEvent(new w.Event('change',{bubbles:true}));await submit();assert.equal(saved.length,2);assert.equal(state.config.filePolicy.allowAbsolutePaths,true);assert.equal(el('project-alias').required,true);
  }finally{dom?.window.close();f.close();}
});
