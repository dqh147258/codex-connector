export type LoginState={supported:boolean;enabled:boolean;reason?:string};
export interface LoginAdapter {getLoginItemSettings(options?:{path?:string;args?:string[]}):{openAtLogin:boolean;executableWillLaunchAtLogin?:boolean;status?:string};setLoginItemSettings(options:{openAtLogin:boolean;path?:string;args?:string[]}):void}
export function readLoginState(adapter:LoginAdapter,platform:string,packaged:boolean,path:string):LoginState{
  if(!['darwin','win32'].includes(platform))return{supported:false,enabled:false,reason:'此版本未提供 Linux 登录项开关；不会伪造系统状态。'};
  if(!packaged)return{supported:false,enabled:false,reason:'开发模式不注册登录项；请使用已安装的桌面应用。'};
  try{const s=adapter.getLoginItemSettings({path,args:['--background']});const enabled=s.openAtLogin&&(platform!=='win32'||s.executableWillLaunchAtLogin!==false)&&s.status!=='requires-approval';return{supported:true,enabled,reason:s.status==='requires-approval'?'需要在系统登录项设置中批准。':undefined};}catch{return{supported:false,enabled:false,reason:'无法读取系统登录项状态。'};}
}
export function updateLoginState(adapter:LoginAdapter,platform:string,packaged:boolean,path:string,enabled:boolean):LoginState{
  if(typeof enabled!=='boolean')throw Error('INVALID_ARGUMENT');const before=readLoginState(adapter,platform,packaged,path);if(!before.supported)throw Error('LOGIN_STARTUP_UNSUPPORTED');
  let priorRegistration:boolean;try{priorRegistration=adapter.getLoginItemSettings({path,args:['--background']}).openAtLogin;}catch{throw Error('LOGIN_STARTUP_FAILED');}
  try{adapter.setLoginItemSettings({openAtLogin:enabled,path,args:['--background']});}catch{throw Error('LOGIN_STARTUP_FAILED');}
  const after=readLoginState(adapter,platform,packaged,path);
  if(enabled&&after.reason==='需要在系统登录项设置中批准。')return after;
  if(after.enabled!==enabled){try{adapter.setLoginItemSettings({openAtLogin:priorRegistration,path,args:['--background']});}catch{}return{...readLoginState(adapter,platform,packaged,path),reason:after.reason||'系统未确认更改；请检查系统登录项设置。'};}
  return after;
}
