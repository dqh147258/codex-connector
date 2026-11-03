import { ScreenError, validateScreenImages, type ScreenImage } from './screens.js';
import { WebClient, LogLevel } from '@slack/web-api';
import type { SlackPort } from './types.js';
export const escapeSlack=(text:string)=>text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
export function chunks(text:string,limit=2800):string[]{const out:string[]=[];let part='';for(const cp of text){const escaped=escapeSlack(cp);if(part.length+escaped.length>limit){out.push(part);part='';}part+=escaped;}if(part||!out.length)out.push(part||'(empty)');return out;}
export class SlackClient implements SlackPort {
  readonly web:WebClient;
  constructor(token:string){this.web=new WebClient(token,{logLevel:LogLevel.ERROR,retryConfig:{retries:0},rejectRateLimitedCalls:true,timeout:10000});}
  async post(channel:string,text:string,opts:{threadTs?:string;mentionUserId?:string;deliveryId:string}){
    if(!opts.threadTs||!/^\d{1,20}\.\d{1,10}$/.test(opts.threadTs))throw Error('THREAD_DESTINATION_REQUIRED');
    const r=await this.web.chat.postMessage({channel,text:`${opts.mentionUserId?`<@${opts.mentionUserId}> `:''}${escapeSlack(text)}`,thread_ts:opts.threadTs,reply_broadcast:false,mrkdwn:true,parse:'none',link_names:false,unfurl_links:false,unfurl_media:false});
    if(!r.ts)throw Error('SLACK_OUTCOME_UNCERTAIN');return r.ts;
  }
  async uploadScreens(channel:string,threadTs:string,images:ScreenImage[],requestId:string){
    if(!/^[CG][A-Z0-9]+$/.test(channel)||!/^\d{1,20}\.\d{1,10}$/.test(threadTs))throw new ScreenError('SCREEN_SLACK_THREAD_REQUIRED');
    validateScreenImages(images,'all');
    try{
      const result=await this.web.filesUploadV2({channel_id:channel,thread_ts:threadTs,initial_comment:`Requested screen capture (${requestId}). Unredacted screenshots.`,file_uploads:images.map(image=>({file:image.jpeg,filename:`screen-${image.displayId}.jpg`,title:`Display ${image.displayId} (${image.width} × ${image.height})`,alt_text:`Requested screenshot of display ${image.displayId}`}))});
      if(!result.ok)throw new ScreenError('SCREEN_UPLOAD_UNCERTAIN');
    }catch(error:any){
      const rejected=['missing_scope','invalid_auth','token_revoked','account_inactive','not_authed','not_in_channel','channel_not_found','file_uploads_disabled','not_allowed_token_type'];
      if(error?.code==='slack_webapi_rate_limited_error'||error?.code==='slack_webapi_platform_error'&&rejected.includes(error?.data?.error))throw new ScreenError('SCREEN_UPLOAD_REJECTED');
      throw new ScreenError('SCREEN_UPLOAD_UNCERTAIN');
    }
  }
  async resolveDot(name:string,userId?:string){
    if(userId){const r=await this.web.users.info({user:userId});if(!r.user||r.user.deleted)throw Error('DOT_NOT_FOUND');return{userId,name:r.user.profile?.display_name||r.user.name||name};}
    const matches:{userId:string;name:string}[]=[];let cursor:string|undefined;
    do{const r=await this.web.users.list({limit:200,cursor});for(const u of r.members||[])if(!u.deleted&&u.id&&[u.name,u.profile?.display_name,u.profile?.real_name].includes(name))matches.push({userId:u.id,name});cursor=r.response_metadata?.next_cursor||undefined;}while(cursor);
    if(matches.length!==1)throw Error('DOT_NAME_AMBIGUOUS_OR_MISSING: configure a verified userId');return matches[0]!;
  }
  async threadExists(channel:string,threadTs:string){const r=await this.web.conversations.replies({channel,ts:threadTs,limit:1});return r.messages?.some(m=>m.ts===threadTs&&(!m.thread_ts||m.thread_ts===threadTs))===true;}
  async humanMessage(channel:string,threadTs:string,ts:string){
    const r=await this.web.conversations.replies({channel,ts:threadTs,oldest:ts,latest:ts,inclusive:true,limit:10});
    return r.messages?.find(m=>m.ts===ts);
  }
}
