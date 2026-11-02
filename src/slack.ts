import { WebClient, LogLevel } from '@slack/web-api';
import type { SlackPort } from './types.js';
export const escapeSlack=(text:string)=>text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
export function chunks(text:string,limit=2800):string[]{const out:string[]=[];let part='';for(const cp of text){const escaped=escapeSlack(cp);if(part.length+escaped.length>limit){out.push(part);part='';}part+=escaped;}if(part||!out.length)out.push(part||'(empty)');return out;}
export class SlackClient implements SlackPort {
  readonly web:WebClient;
  constructor(token:string){this.web=new WebClient(token,{logLevel:LogLevel.ERROR,retryConfig:{retries:0},rejectRateLimitedCalls:true});}
  async post(channel:string,text:string,opts:{threadTs?:string;mentionUserId:string;deliveryId:string}){
    const r=await this.web.chat.postMessage({channel,text:`<@${opts.mentionUserId}> ${escapeSlack(text)}`,thread_ts:opts.threadTs,mrkdwn:true,parse:'none',link_names:false,unfurl_links:false,unfurl_media:false});
    if(!r.ts)throw Error('SLACK_OUTCOME_UNCERTAIN');return r.ts;
  }
  async resolveDot(name:string,userId?:string){
    if(userId){const r=await this.web.users.info({user:userId});if(!r.user||r.user.deleted)throw Error('DOT_NOT_FOUND');return{userId,name:r.user.profile?.display_name||r.user.name||name};}
    const matches:{userId:string;name:string}[]=[];let cursor:string|undefined;
    do{const r=await this.web.users.list({limit:200,cursor});for(const u of r.members||[])if(!u.deleted&&u.id&&[u.name,u.profile?.display_name,u.profile?.real_name].includes(name))matches.push({userId:u.id,name});cursor=r.response_metadata?.next_cursor||undefined;}while(cursor);
    if(matches.length!==1)throw Error('DOT_NAME_AMBIGUOUS_OR_MISSING: configure a verified userId');return matches[0]!;
  }
  async humanMessage(channel:string,threadTs:string,ts:string){
    const r=await this.web.conversations.replies({channel,ts:threadTs,oldest:ts,latest:ts,inclusive:true,limit:10});
    return r.messages?.find(m=>m.ts===ts);
  }
}
