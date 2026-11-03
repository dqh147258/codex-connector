import { randomUUID } from 'node:crypto';
import { ScreenError, SCREEN_ERRORS, SCREEN_MAX_TOTAL_BYTES, validateScreenImages, type ScreenPort, type ScreenListing } from './screens.js';
/** Private parent/child IPC only. No HTTP endpoint, renderer API, disk spool or shell. */
export function desktopScreenPort(ipc: NodeJS.Process = process, timeoutMs = 30000): ScreenPort | undefined {
  if (ipc.env.CONNECTOR_DESKTOP_CHILD !== '1' || !ipc.send || !ipc.connected) return;
  const request = (operation: 'list'|'capture', displayId?:string) => new Promise<any>((resolve,reject) => {
    const id = randomUUID();
    const finish = (error?:ScreenError, value?:unknown) => { clearTimeout(timer); ipc.off('message',onMessage); ipc.off('disconnect',onDisconnect); error ? reject(error) : resolve(value); };
    const onDisconnect = () => finish(new ScreenError('SCREEN_CANCELLED'));
    const onMessage = (message:any) => {
      if (message?.type !== 'connector:screens:result' || message.id !== id) return;
      if (message.error) return finish(new ScreenError(SCREEN_ERRORS.includes(message.error) ? message.error : 'SCREEN_UNAVAILABLE'));
      finish(undefined,message.result);
    };
    const timer = setTimeout(() => finish(new ScreenError('SCREEN_TIMEOUT')),timeoutMs);
    ipc.on('message',onMessage); ipc.once('disconnect',onDisconnect);
    ipc.send!({type:'connector:screens',id,operation,displayId},error=>{if(error)finish(new ScreenError('SCREEN_CANCELLED'));});
  });
  return {
    async list() { const result = await request('list'); if (!result || !Array.isArray(result.displays) || result.displays.length > 8) throw new ScreenError('SCREEN_UNAVAILABLE'); return result as ScreenListing; },
    async capture(displayId) {
      const result = await request('capture',displayId);
      if (!Array.isArray(result) || result.length > 8 || result.reduce((n:any,i:any)=>n+(typeof i?.jpeg==='string'?i.jpeg.length:SCREEN_MAX_TOTAL_BYTES*2),0)>SCREEN_MAX_TOTAL_BYTES*1.4) throw new ScreenError('SCREEN_LIMIT_EXCEEDED');
      return validateScreenImages(result.map(i=>({...i,jpeg:typeof i.jpeg==='string'?Buffer.from(i.jpeg,'base64'):undefined})),displayId);
    }
  };
}
