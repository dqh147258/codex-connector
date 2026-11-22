import { randomBytes } from 'node:crypto';
import type { WebClient } from '@slack/web-api';
import type { KnownBlock, ModalView } from '@slack/types';

/** Only opaque, account-local capability handles may be rendered in Block Kit.
 * The native gateway must revalidate the full grant, posted message, pending
 * request, choice schema and owner-authorized human at open AND submission. */
export interface SlackQuestionAction { reference:string; questionCount:number }
export interface SlackQuestionOrigin {
  reference:string; teamId:string; appId:string; userId:string; channel:string; rootThreadTs:string; messageTs:string;
}
export interface SlackQuestionField {header:string;question:string;labels:readonly string[]}
export interface SlackQuestionGateway {
  openQuestion(origin:SlackQuestionOrigin):Promise<{questions:readonly SlackQuestionField[]}|undefined>;
  submitQuestion(origin:SlackQuestionOrigin,choices:readonly number[]):Promise<'submitted'|'closed'|'unconfirmed'|'denied'>;
}
export const validAction=(x:SlackQuestionAction)=>!!x && typeof x.reference==='string' && /^[A-Za-z0-9_-]{16,96}$/.test(x.reference)
  && Number.isInteger(x.questionCount) && x.questionCount>=1 && x.questionCount<=4;
const TS=/^\d{1,20}\.\d{1,10}$/, ID=/^[UW][A-Z0-9]{1,63}$/, VID=/^V[A-Z0-9]{1,63}$/;
const BTN='cc.question.open.v1', CB='cc.question.submit.v1', BLOCK='cc.question.card.v1';
const plain=(text:string)=>({type:'plain_text' as const,text,emoji:false});
export function questionBlocks(text:string,action:SlackQuestionAction):KnownBlock[] {
  if(!validAction(action)||!text||text.length>2900)throw Error('INVALID_SLACK_QUESTION_CARD');
  return [{type:'section',text:plain(text)},{type:'actions',block_id:BLOCK,elements:[
    {type:'button',action_id:BTN,text:plain('回答 Codex 问题'),value:action.reference},
  ]}];
}
interface Identity {teamId:string;appId:string;botId:string;botUserId:string}
interface Opened {origin:SlackQuestionOrigin;expires:number;counts:number[];viewId:string}
type Ack=(response?:unknown)=>Promise<void>;
const MAX_VIEWS=128, MAX_INFLIGHT=32, VIEW_TTL=5*60_000, TRIGGER_WINDOW=2700;
function fields(qs:readonly SlackQuestionField[]){
  const text=(v:unknown,max:number)=>typeof v==='string'&&v.trim().length>0&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
  return Array.isArray(qs)&&qs.length>=1&&qs.length<=4&&qs.every(q=>q&&text(q.header,128)&&text(q.question,600)
    &&Array.isArray(q.labels)&&q.labels.length>=1&&q.labels.length<=6&&q.labels.every((x:unknown)=>text(x,100)));
}
function modal(qs:readonly SlackQuestionField[],nonce:string):ModalView {
  const blocks:KnownBlock[]=[];
  qs.forEach((q,i)=>{
    // Slack option labels have a shorter limit than Codex. Keep long choices
    // complete in the private modal, then select by the corresponding number.
    const numbered=q.labels.some(l=>l.length>75);
    const description=q.header+'\n'+q.question+(numbered?'\n'+q.labels.map((o,j)=>(j+1)+'. '+o).join('\n'):'');
    blocks.push({type:'section',text:plain(description)},{type:'input',block_id:'q'+i,label:plain('问题 '+(i+1)+' 的答案'),
      element:{type:'static_select',action_id:'pick',placeholder:plain('请选择'),options:q.labels.map((l,j)=>({text:plain(numbered?'选项 '+(j+1):l),value:String(j)}))}});
  });
  return {type:'modal',callback_id:CB,private_metadata:nonce,title:plain('回答 Codex'),submit:plain('提交给 Codex'),
    close:plain('取消'),notify_on_close:true,blocks};
}
const messages={
  checking:'正在核对你是否可以回答此问题。暂不需要输入；如未出现选项，请在原生 Codex 中回答。',  pending:'正在核对。尚未确认 Codex 收到答复；如未显示结果，请查看原生 Codex，不要重复提交。',
  submitted:'已将答复发给 Codex。其他客户端也可能同时作答，请在原生会话查看最终结果。',
  closed:'问题已关闭；这不能证明 Codex 采用了你的 Slack 答复。',
  unconfirmed:'无法确认答复是否生效。未自动重试，请在原生 Codex 查看。',
  denied:'未发送答复。授权或问题状态可能已改变，请在原生 Codex 查看。',
} as const;
const status=(key:keyof typeof messages):ModalView=>({type:'modal',title:plain('Codex 答复状态'),close:plain('关闭'),
  blocks:[{type:'section',text:plain(messages[key])}]});

/** Slack-owned Socket Mode authenticated transport, instantiated once per link
 * incarnation; no socket secrets, message text, or selected answers are saved.
 * https://docs.slack.dev/reference/interaction-payloads/block_actions-payload/
 * https://docs.slack.dev/reference/interaction-payloads/view-interactions-payload/ */
export class SlackQuestionTransport {
  private modals=new Map<string,Opened>();
  private inflight=0;
  constructor(private web:WebClient,private id:Identity,private gateway:SlackQuestionGateway,private current:()=>boolean){}
  private prune(){for(const [n,m] of this.modals)if(m.expires<=Date.now())this.modals.delete(n);}
  private actor(b:any){
    const u=b?.user;
    return this.current()&&b?.team?.id===this.id.teamId&&b.api_app_id===this.id.appId&&(!b.team_id||b.team_id===this.id.teamId)
      &&(!u?.team_id||u.team_id===this.id.teamId)&&ID.test(u?.id??'')&&u.id!==this.id.botUserId&&!u.is_bot&&!u.bot_id&&!u.is_app_user;
  }
  private async human(userId:string){
    const {ok,user:u}=await this.web.users.info({user:userId});
    return ok===true&&u?.id===userId&&u.team_id===this.id.teamId&&u.deleted===false&&u.is_bot===false&&u.is_app_user===false
      &&!u.is_connector_bot&&!u.is_workflow_bot&&!u.profile?.bot_id&&!u.profile?.api_app_id;
  }
  private readOrigin(b:any):SlackQuestionOrigin|undefined {
    if(!this.actor(b)||b.type!=='block_actions'||b.view||!Array.isArray(b.actions)||b.actions.length!==1)return;
    const c=b.container,m=b.message,a=b.actions[0],channel=b.channel?.id;
    if(c?.type!=='message'||c.is_ephemeral||!/^([CG])[A-Z0-9]{1,63}$/.test(channel??'')||channel!==c.channel_id||
      m?.type!=='message'||m.bot_id!==this.id.botId||m.user!==this.id.botUserId||m.app_id&&m.app_id!==this.id.appId||m.edited||
      !TS.test(m.ts??'')||m.ts!==c.message_ts||!TS.test(m.thread_ts??'')||m.thread_ts===m.ts||
      c.thread_ts&&c.thread_ts!==m.thread_ts||a?.type!=='button'||a.action_id!==BTN||a.block_id!==BLOCK||
      !validAction({reference:a.value,questionCount:1})||typeof b.trigger_id!=='string'||!b.trigger_id||b.trigger_id.length>512)return;
    return {teamId:this.id.teamId,appId:this.id.appId,userId:b.user.id,channel,rootThreadTs:m.thread_ts,messageTs:m.ts,reference:a.value};
  }
  async accept(b:any,ack:Ack){
    const start=Date.now();
    this.prune();
    if(b?.type==='view_submission'||b?.type==='view_closed'){await this.view(b,ack);return;}
    const origin=this.readOrigin(b);
    // Must ACK immediately. A socket ACK acknowledges transport receipt, not
    // human authorization, native acceptance, or the result of a submission.
    await ack();
    if(!origin||!this.current()||this.inflight>=MAX_INFLIGHT||this.modals.size+this.inflight>=MAX_VIEWS)return;
    this.inflight++;
    try{
      if(Date.now()-start>=TRIGGER_WINDOW)return;
      // Slack trigger IDs expire in ~3 s. Open a fixed private loading view
      // before doing any Web API identity/native reads. No question body,
      // controls or native action until the exact opener is authorized.
      const nonce=randomBytes(24).toString('base64url');
      const loading:ModalView={...status('checking'),callback_id:'cc.question.check.v1',private_metadata:nonce};
      const {ok,view}=await this.web.views.open({trigger_id:b.trigger_id,view:loading});
      if(!ok||!this.current()||!view?.id||!VID.test(view.id)||view.app_id&&view.app_id!==this.id.appId||
        view.team_id&&view.team_id!==this.id.teamId||view.private_metadata!==nonce||view.callback_id!==loading.callback_id)return;
      const viewId=view.id;
      let schema:Awaited<ReturnType<SlackQuestionGateway['openQuestion']>>;
      try{
        if(await this.human(origin.userId)&&this.current())schema=await this.gateway.openQuestion(origin);
      }catch{/* Do not relay the cause or any native/user content. */}
      if(!this.current())return;
      if(!schema||!fields(schema.questions)){
        await this.web.views.update({view_id:viewId,view:status('denied')});return;
      }
      const opened={origin,viewId,counts:schema.questions.map(q=>q.labels.length),expires:Date.now()+VIEW_TTL};
      // The ID is already bound to the loading view and only the authorized
      // person can acquire the new submit control. Register before the await
      // to avoid dropping a genuine quick submission on a slow API response.
      this.modals.set(nonce,opened);
      try{
        const updated=await this.web.views.update({view_id:viewId,view:modal(schema.questions,nonce)});
        if(!updated.ok||!this.current())this.modals.delete(nonce);
      }catch{this.modals.delete(nonce);}
    }finally{this.inflight--;}
  }
  private async view(b:any,ack:Ack){
    const v=b.view,nonce=v?.private_metadata;
    if(!this.actor(b)||v?.type!=='modal'||v.callback_id!==CB||v.team_id&&v.team_id!==this.id.teamId||v.app_id&&v.app_id!==this.id.appId||
      typeof nonce!=='string'||!/^[A-Za-z0-9_-]{32}$/.test(nonce)){await ack();return;}
    const m=this.modals.get(nonce);
    if(!m||m.viewId!==v.id||m.origin.userId!==b.user.id){await ack();return;}
    // Consume a specific local modal once. The native gateway consumes the
    // question reference itself; multiple genuine openings cannot allow retries.
    this.modals.delete(nonce);
    if(b.type==='view_closed'){await ack();return;}
    const val=v.state?.values,answers:number[]=[];
    if(val&&typeof val==='object'&&!Array.isArray(val)&&Object.keys(val).length===m.counts.length)
      for(const [i,n] of m.counts.entries()){
        const f=val['q'+i],e=f?.pick,opt=e?.selected_option?.value;
        if(!f||Object.keys(f).length!==1||e?.type!=='static_select'||typeof opt!=='string'||!/^\d$/.test(opt)||+opt>=n)break;
        answers.push(+opt);
      }
    if(answers.length!==m.counts.length||this.inflight>=MAX_INFLIGHT||!this.current()){
      await ack({response_action:'update',view:status('denied')});return;
    }
    this.inflight++;
    try{
      await ack({response_action:'update',view:status('pending')});
      if(!this.current())return;
      let receipt:'submitted'|'closed'|'unconfirmed'|'denied'='denied';
      try{
        if(await this.human(m.origin.userId)&&this.current()&&Date.now()<m.expires)
          receipt=await this.gateway.submitQuestion(m.origin,answers);
      }catch{receipt='unconfirmed';}
      if(this.current())await this.web.views.update({view_id:m.viewId,view:status(receipt)});
    }finally{this.inflight--;}
  }
}
