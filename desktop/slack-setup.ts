import { LogLevel, WebClient } from '@slack/web-api';
export class SlackSetupError extends Error { constructor(readonly code:string) {super(code);} }
export type SlackFactory=(token:string)=>any;
export interface SlackMember { userId:string;name:string;isBot:boolean;botId?:string; }
export interface SlackChannel { channelId:string;name:string;isPrivate:boolean;isMember:boolean; }
const safeCodes:Record<string,string>={invalid_auth:'INVALID_AUTH',not_authed:'INVALID_AUTH',token_revoked:'TOKEN_REVOKED',account_inactive:'ACCOUNT_INACTIVE',missing_scope:'MISSING_SCOPE',not_allowed_token_type:'WRONG_TOKEN_TYPE',user_not_found:'USER_NOT_FOUND',bot_not_found:'BOT_NOT_FOUND',rate_limited:'RATE_LIMITED',ratelimited:'RATE_LIMITED',not_in_channel:'NOT_IN_CHANNEL',channel_not_found:'CHANNEL_NOT_FOUND',org_login_required:'ORG_LOGIN_REQUIRED'};
function sanitized(error:any):SlackSetupError {if(error instanceof SlackSetupError)return error;const code=error?.data?.error||error?.error;return new SlackSetupError(typeof code==='string'&&Object.hasOwn(safeCodes,code)?safeCodes[code]!:'SLACK_REQUEST_FAILED');}
function token(value:unknown,prefix:'xapp'|'xoxb'):asserts value is string {if(typeof value!=='string'||!new RegExp('^'+prefix+'-[A-Za-z0-9-]{8,4096}$').test(value))throw new SlackSetupError('INVALID_TOKEN_FORMAT');}
function id(value:unknown,prefix:string):value is string{return typeof value==='string'&&new RegExp('^['+prefix+'][A-Z0-9]{1,63}$').test(value);}
function label(value:unknown):string{return typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,160):'';}
function cursor(value:unknown):string|undefined{if(value===undefined||value===null||value==='')return undefined;if(typeof value!=='string'||value.length>1024||/[\r\n\0]/.test(value))throw new SlackSetupError('INVALID_CURSOR');return value;}
export class SlackSetup {
  constructor(private factory:SlackFactory=(value:string)=>new WebClient(value,{retryConfig:{retries:0},rejectRateLimitedCalls:true,timeout:10000,logLevel:LogLevel.ERROR,logger:{debug(){},info(){},warn(){},error(){},setLevel(){},getLevel(){return LogLevel.ERROR;},setName(){}}})) {}
  private client(value:unknown,prefix:'xapp'|'xoxb'='xoxb'):any{token(value,prefix);return this.factory(value);}
  private async call(operation:()=>Promise<any>):Promise<any>{try{const r=await operation();if(!r||r.ok!==true)throw r;return r;}catch(e){throw sanitized(e);}}
  async testTokens(appToken:string,botToken:string):Promise<{teamId:string;teamName:string;connectorUserId:string;connectorBotId:string;appTokenValid:boolean}> {
    const bot=this.client(botToken),app=this.client(appToken,'xapp');
    const auth=await this.call(()=>bot.auth.test());
    if(!id(auth.team_id,'T')||!id(auth.user_id,'U')||!id(auth.bot_id,'B'))throw new SlackSetupError('UNEXPECTED_SLACK_IDENTITY');
    // This only obtains a temporary Socket Mode URL to validate the app token. Never
    // return, persist, log or connect to that secret URL, and never start a listener here.
    const connection=await this.call(()=>app.apps.connections.open());
    if(typeof connection.url!=='string'||!connection.url.startsWith('wss://'))throw new SlackSetupError('SOCKET_MODE_UNAVAILABLE');
    return {teamId:auth.team_id,teamName:label(auth.team),connectorUserId:auth.user_id,connectorBotId:auth.bot_id,appTokenValid:true};
  }
  async resolveDot(botToken:string,userId:string):Promise<{userId:string;botId:string;appId:string;name:string;teamId?:string}> {
    if(!id(userId,'U'))throw new SlackSetupError('INVALID_USER_ID');const client=this.client(botToken);
    const info=await this.call(()=>client.users.info({user:userId})),user=info.user;
    if(!user||user.id!==userId||user.deleted||user.is_bot!==true||!id(user.profile?.bot_id,'B'))throw new SlackSetupError('DOT_MUST_BE_ACTIVE_BOT_USER');
    const response=await this.call(()=>client.bots.info({bot:user.profile.bot_id})),bot=response.bot;
    if(!bot||bot.deleted||bot.id!==user.profile.bot_id||bot.user_id!==userId||!id(bot.app_id,'A'))throw new SlackSetupError('BOT_IDENTITY_MISMATCH');
    return{userId,botId:bot.id,appId:bot.app_id,name:label(user.profile.display_name||user.real_name||user.name||bot.name),...(id(user.team_id,'T')?{teamId:user.team_id}:{})};
  }
  async listUsers(botToken:string,pageCursor?:string):Promise<{users:SlackMember[];nextCursor:string|null}> {
    const client=this.client(botToken),response=await this.call(()=>client.users.list({limit:100,cursor:cursor(pageCursor)}));
    if(!Array.isArray(response.members))throw new SlackSetupError('UNEXPECTED_SLACK_RESPONSE');
    const users:SlackMember[]=response.members.slice(0,100).filter((u:any)=>id(u.id,'U')&&!u.deleted).map((u:any)=>({userId:u.id,name:label(u.profile?.display_name||u.real_name||u.name),isBot:u.is_bot===true,...(id(u.profile?.bot_id,'B')?{botId:u.profile.bot_id}:{})}));
    return{users,nextCursor:cursor(response.response_metadata?.next_cursor)||null};
  }
  async listChannels(botToken:string,pageCursor?:string):Promise<{channels:SlackChannel[];nextCursor:string|null;manualEntryRequired:boolean;requiredScopes:string[];error?:string}> {
    const client=this.client(botToken);
    try {
      // Optional convenience only: the minimal server manifest deliberately does not
      // add these read scopes. A missing scope never changes Slack authorization.
      const response=await this.call(()=>client.conversations.list({limit:100,exclude_archived:true,types:'public_channel,private_channel',cursor:cursor(pageCursor)}));
      if(!Array.isArray(response.channels))throw new SlackSetupError('UNEXPECTED_SLACK_RESPONSE');
      return{channels:response.channels.slice(0,100).filter((c:any)=>id(c.id,'CG')&&!c.is_archived).map((c:any)=>({channelId:c.id,name:label(c.name),isPrivate:c.is_private===true,isMember:c.is_member===true})),nextCursor:cursor(response.response_metadata?.next_cursor)||null,manualEntryRequired:false,requiredScopes:[]};
    }catch(e){if(e instanceof SlackSetupError&&e.code==='MISSING_SCOPE')return{channels:[],nextCursor:null,manualEntryRequired:true,requiredScopes:['channels:read','groups:read'],error:'MISSING_SCOPE'};throw e;}
  }
}
