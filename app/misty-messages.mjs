import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {replyId,postURL} from './message-target.mjs';

const yes=body=>/^yes(?:\s+([a-f0-9]{10}))?[.!]?$/i.exec(body.trim());
const no=body=>/^(?:no|cancel)(?:\s+([a-f0-9]{10}))?[.!]?$/i.exec(body.trim());
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const approvalDigest=d=>hash({target:typeof d.target==='string'?JSON.parse(d.target):d.target,body:d.body,...(d.owner_channel?{ownerChannel:d.owner_channel}:{})});
const expiry=24*60*60*1000;
const snowflake=id=>/^\d{16,22}$/.test(id||'');
// Personal-account messages have their own approval journal. Codex task grants,
// model output, archive messages and workflow context cannot approve this outbox.
export class MistyMessages {
 constructor(relay,backend,{clock=Date.now}={}){
  this.r=relay;this.db=relay.db;this.backend=backend;this.clock=clock;this.refreshing=null;
  this.db.exec(`CREATE TABLE IF NOT EXISTS misty_message_drafts(
   code TEXT PRIMARY KEY,owner_id TEXT UNIQUE NOT NULL,submission_id TEXT UNIQUE NOT NULL,
   target TEXT NOT NULL,body TEXT NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL,
   created INTEGER NOT NULL,expires INTEGER NOT NULL,confirmation_id TEXT UNIQUE,
   receipt TEXT NOT NULL DEFAULT '{}');`);
  // Never resubmit after an interrupted network request. Status reconciliation is read-only.
  this.db.prepare("UPDATE misty_message_drafts SET state='unknown' WHERE state='submitting'").run();
  if(!this.db.prepare('PRAGMA table_info(misty_message_drafts)').all().some(c=>c.name==='owner_channel'))this.db.exec("ALTER TABLE misty_message_drafts ADD COLUMN owner_channel TEXT NOT NULL DEFAULT ''");
  this.db.exec(`CREATE TABLE IF NOT EXISTS misty_email_saved_drafts(
    owner_id TEXT PRIMARY KEY,input_digest TEXT NOT NULL,state TEXT NOT NULL,
    result TEXT NOT NULL DEFAULT '{}');`);
 }
 owner(id,{recent=30*60*1000}={}){
  const row=this.db.prepare("SELECT * FROM bot_turns WHERE id=? AND status IN ('external','external_sent')").get(id);
  const latest=this.db.prepare('SELECT id FROM bot_turns ORDER BY ts DESC,id DESC LIMIT 1').get();
  if(!snowflake(id)||!row||latest?.id!==id||row.ts>this.clock()+5000||this.clock()-row.ts>recent)throw Error('A current recorded owner DM is required.');
  return row;
 }
 get(code){const d=this.db.prepare('SELECT * FROM misty_message_drafts WHERE code=?').get(code);if(!d)throw Error('Message draft not found.');return d;}
 view(d){return {code:d.code,state:d.state,target:JSON.parse(d.target),body:d.body,digest:d.digest,created:d.created,expires:d.expires,receipt:JSON.parse(d.receipt),requiresAppApproval:d.state==='pending'};}
 inspect({room,replyTo=''}){return this.backend.call('inspect',{room,replyTo});}
 async emailAccounts(){return this.backend.call('email_accounts',{});}
 async saveEmailDraft(input){
  const ownerMessageId=String(input.ownerMessageId||'');this.owner(ownerMessageId);
  if(yes(this.owner(ownerMessageId).body))throw Error('A yes cannot create a Gmail draft. Request it in a new owner message.');
  const fields={account:input.account,to:input.to,cc:input.cc||'',bcc:input.bcc||'',subject:input.subject||'',body:input.body,replyTo:input.replyTo||''};
  const digest=hash(fields),old=this.db.prepare('SELECT * FROM misty_email_saved_drafts WHERE owner_id=?').get(ownerMessageId);
  if(old){if(old.input_digest!==digest)throw Error('This owner request already saved a different Gmail draft.');
   if(old.state==='saved')return JSON.parse(old.result);throw Error('Draft creation is unconfirmed. Check Gmail Drafts before requesting another copy.');}
  const inspected=await this.backend.call('email_inspect',fields);
  if(!inspected.target||typeof inspected.target.account!=='string')throw Error('Gmail draft destination could not be verified.');
  const accounts=await this.emailAccounts();
  if(!accounts.accounts.some(a=>a.id===inspected.target.account&&a.canDraft))throw Error('Reconnect Gmail with gmail.compose permission before saving a draft.');
  this.owner(ownerMessageId);
  this.db.prepare("INSERT INTO misty_email_saved_drafts(owner_id,input_digest,state) VALUES(?,?,'submitting')").run(ownerMessageId,digest);
  try{const result=await this.backend.call('email_save_draft',fields);
   this.db.prepare("UPDATE misty_email_saved_drafts SET state='saved',result=? WHERE owner_id=?").run(JSON.stringify(result),ownerMessageId);
   return result;
  }catch{this.db.prepare("UPDATE misty_email_saved_drafts SET state='unknown' WHERE owner_id=?").run(ownerMessageId);
   throw Error('Draft creation is unconfirmed. Check Gmail Drafts before requesting another copy.');}
 }
 async proposeEmail(input){
  const ownerMessageId=String(input.ownerMessageId||'');this.owner(ownerMessageId);
  if(yes(this.owner(ownerMessageId).body))throw Error('A yes cannot create or edit an email. Request the preview first.');
  if(typeof input.body!=='string'||!input.body.trim()||input.body.includes('\0')||input.body.length>20000)throw Error('Provide the exact email body.');
  const {target,capability}=await this.backend.call('email_inspect',input);
  if(target?.platform!=='gmail'||!capability?.allowed)throw Error(capability?.reason||'Gmail sending unavailable.');
  this.owner(ownerMessageId);
  return this.r.transaction(()=>{
   const old=this.db.prepare('SELECT * FROM misty_message_drafts WHERE owner_id=?').get(ownerMessageId);
   if(old){if(old.target!==JSON.stringify(target)||old.body!==input.body)throw Error('This request already has a different email preview. Ask for a new draft.');return this.view(old);}
   for(const d of this.db.prepare("SELECT code FROM misty_message_drafts WHERE state='pending'").all())this.retire(d.code,'replaced');
   const now=this.clock(),channel=this.owner(ownerMessageId).channel,d={code:randomBytes(5).toString('hex'),owner_id:ownerMessageId,submission_id:randomUUID(),target:JSON.stringify(target),body:input.body,digest:approvalDigest({target,body:input.body,owner_channel:channel}),state:'pending',created:now,expires:now+expiry,owner_channel:channel};
   this.db.prepare('INSERT INTO misty_message_drafts(code,owner_id,submission_id,target,body,digest,state,created,expires,owner_channel) VALUES(?,?,?,?,?,?,?,?,?,?)').run(...Object.values(d));
   this.previewText(d);
   return this.view(this.get(d.code));
  });
 }
 async propose({ownerMessageId,room,body,replyTo=''}){
  this.owner(ownerMessageId);
  if(yes(this.owner(ownerMessageId).body))throw Error('A yes cannot create or edit a message. Request the draft first.');
  if(typeof room!=='string'||typeof body!=='string'||!body.trim()||body.includes('\0')||body.length>20000)throw Error('Choose an existing chat and provide the exact text.');
  const old=this.db.prepare('SELECT * FROM misty_message_drafts WHERE owner_id=?').get(ownerMessageId);
  if(old){const target=JSON.parse(old.target);if(target.room!==room||old.body!==body||(target.replyTo?.messageId||'')!==replyId(replyTo,target.remoteId,target.guildId))throw Error('This request already has a different draft. Ask the owner to request an edit.');return this.view(old);}
  const {target,capability}=await this.inspect({room,replyTo});
  if(!capability?.allowed)throw Error(capability?.reason||'Sending unavailable.');
  const guild=target?.platform==='discord'&&target.kind==='channel'&&snowflake(target.guildId)&&target.channelId===target.remoteId&&target.mentions==='suppressed';
  if(!['discord','whatsapp'].includes(target?.platform)||!(['dm','group'].includes(target?.kind)||guild)||body.length>capability.maxLength)throw Error('Choose a connected Discord/WhatsApp chat or selected Discord server text channel within its message limit.');
  if(replyTo&&(!guild||target.replyTo?.messageId!==replyId(replyTo,target.remoteId,target.guildId)))throw Error('The exact server reply target was not verified.');
  this.owner(ownerMessageId);
  return this.r.transaction(()=>{
   const existing=this.db.prepare('SELECT * FROM misty_message_drafts WHERE owner_id=?').get(ownerMessageId);
   if(existing){if(existing.target!==JSON.stringify(target)||existing.body!==body)throw Error('A different draft already exists.');return this.view(existing);}
   for(const d of this.db.prepare("SELECT code FROM misty_message_drafts WHERE state='pending'").all())this.retire(d.code,'replaced');
   const now=this.clock(),channel=this.owner(ownerMessageId).channel,d={code:randomBytes(5).toString('hex'),owner_id:ownerMessageId,submission_id:'chat-'+randomUUID(),target:JSON.stringify(target),body,digest:approvalDigest({target,body,owner_channel:channel}),state:'pending',created:now,expires:now+expiry,owner_channel:channel};
   this.db.prepare('INSERT INTO misty_message_drafts(code,owner_id,submission_id,target,body,digest,state,created,expires,owner_channel) VALUES(?,?,?,?,?,?,?,?,?,?)').run(...Object.values(d));
   this.previewText(d);
   return this.view(this.get(d.code));
  });
 }
 retire(code,state){this.db.prepare("UPDATE misty_message_drafts SET state=? WHERE code=? AND state='pending'").run(state,code);this.db.prepare("UPDATE relay_notices SET status='superseded' WHERE source LIKE ? AND status='queued'").run(`personal:${code}:preview:%`);}
 pendingApprovals(){
  const now=this.clock();
  for(const d of this.db.prepare("SELECT code FROM misty_message_drafts WHERE state='pending' AND expires<?").all(now))this.retire(d.code,'expired');
  return {drafts:this.db.prepare("SELECT * FROM misty_message_drafts WHERE state='pending' ORDER BY created DESC LIMIT 30").all().map(d=>this.view(d))};
 }
 async proposeOverlayEmail(input){
  if(typeof input.body!=='string'||!input.body.trim()||input.body.includes('\0')||input.body.length>20000)throw Error('Provide the exact email body.');
  const {target,capability}=await this.backend.call('email_inspect',input);
  if(target?.platform!=='gmail'||!capability?.allowed)throw Error(capability?.reason||'Gmail sending unavailable.');
  return this.r.transaction(()=>{
   for(const d of this.db.prepare("SELECT code FROM misty_message_drafts WHERE state='pending'").all())this.retire(d.code,'replaced');
   const now=this.clock(),body=input.body,d={code:randomBytes(5).toString('hex'),owner_id:'overlay:'+randomUUID(),submission_id:randomUUID(),target:JSON.stringify(target),body,digest:approvalDigest({target,body}),state:'pending',created:now,expires:now+expiry,owner_channel:''};
   this.db.prepare('INSERT INTO misty_message_drafts(code,owner_id,submission_id,target,body,digest,state,created,expires,owner_channel) VALUES(?,?,?,?,?,?,?,?,?,?)').run(...Object.values(d));
   return this.view(this.get(d.code));
  });
 }
 cancelOverlay({code,digest}){
  const d=this.get(String(code||''));if(d.state!=='pending'||d.digest!==digest)throw Error('This preview changed or is no longer pending.');
  this.retire(d.code,'cancelled');return this.view(this.get(d.code));
 }
 async editOverlay({code,digest,fields={}}){
  const d=this.get(String(code||''));
  if(d.state!=='pending'||d.digest!==digest||this.clock()>d.expires)throw Error('This preview changed or expired.');
  if(typeof fields.body!=='string'||!fields.body.trim()||fields.body.includes('\0')||fields.body.length>20000)throw Error('Provide the exact message body.');
  const old=JSON.parse(d.target);
  const input=old.platform==='gmail'?{account:old.account,to:fields.to??old.to.join(', '),cc:fields.cc??old.cc.join(', '),
    bcc:fields.bcc??old.bcc.join(', '),subject:fields.subject??old.subject,replyTo:old.replyTo,body:fields.body}:null;
  const {target,capability}=input?await this.backend.call('email_inspect',input):await this.inspect({room:old.room,replyTo:old.replyTo?.messageId||''});
  if(!capability?.allowed||target?.platform!==old.platform)throw Error(capability?.reason||'Destination cannot be verified.');
  if(old.platform!=='gmail'&&(JSON.stringify(target)!==d.target||fields.body.length>capability.maxLength))throw Error('The chat destination changed.');
  return this.r.transaction(()=>{
   const current=this.get(d.code);if(current.state!=='pending'||current.digest!==digest)throw Error('This preview changed.');
   this.retire(d.code,'replaced');
   const now=this.clock(),next={code:randomBytes(5).toString('hex'),owner_id:'overlay:'+randomUUID(),submission_id:old.platform==='gmail'?randomUUID():'chat-'+randomUUID(),target:JSON.stringify(target),body:fields.body,
    digest:approvalDigest({target,body:fields.body,owner_channel:d.owner_channel}),state:'pending',created:now,expires:now+expiry,owner_channel:d.owner_channel};
   this.db.prepare('INSERT INTO misty_message_drafts(code,owner_id,submission_id,target,body,digest,state,created,expires,owner_channel) VALUES(?,?,?,?,?,?,?,?,?,?)').run(...Object.values(next));
   return this.view(this.get(next.code));
  });
 }
 async confirmOverlay({code,digest}){
  let d=this.get(String(code||''));
  if(d.state!=='pending'||d.digest!==digest||approvalDigest(d)!==digest||this.clock()>d.expires)throw Error('This preview changed or expired.');
  const saved=JSON.parse(d.target);
  const {target,capability}=saved.platform==='gmail'?await this.backend.call('email_inspect',{
   account:saved.account,to:saved.to.join(', '),cc:saved.cc.join(', '),bcc:saved.bcc.join(', '),subject:saved.subject,replyTo:saved.replyTo,body:d.body
  }):await this.inspect({room:saved.room,replyTo:saved.replyTo?.messageId||''});
  if(!capability?.allowed||JSON.stringify(target)!==d.target)throw Error('The destination or connection changed. Review a fresh preview.');
  this.r.transaction(()=>{
   d=this.get(d.code);
   if(d.state!=='pending'||d.digest!==digest||approvalDigest(d)!==digest||this.clock()>d.expires)throw Error('This preview changed or expired.');
   const changed=this.db.prepare("UPDATE misty_message_drafts SET state='submitting',confirmation_id=? WHERE code=? AND state='pending'").run('overlay:'+randomUUID(),d.code);
   if(changed.changes!==1)throw Error('This draft is already being submitted.');
  });
  try{
   const receipt=await this.backend.call(target.platform==='gmail'?'email_send':'send',{id:d.submission_id,room:target.room,body:d.body,target});
   this.saveReceipt(d,receipt);
  }catch{
   this.db.prepare("UPDATE misty_message_drafts SET state='unknown',receipt=? WHERE code=?").run(JSON.stringify({error:'Submission unconfirmed. Check Sent before composing another copy.'}),d.code);
  }
  return this.view(this.get(d.code));
 }
 saveReceipt(d,receipt){
  const target=JSON.parse(d.target);
  if(target.platform==='gmail'){
   if(receipt?.id!==d.submission_id||receipt.target_json!==d.target||receipt.body!==d.body||!['sent','sending','pending','failed','unknown'].includes(receipt.status))throw Error('Unexpected Gmail submission receipt.');
   this.db.prepare('UPDATE misty_message_drafts SET state=?,receipt=? WHERE code=?').run(receipt.status==='pending'?'sending':receipt.status,JSON.stringify({status:receipt.status,remoteId:receipt.remote_id||'',error:receipt.error||''}),d.code);
   return;
  }
  if(receipt?.id!==d.submission_id||receipt.room_id!==target.room||receipt.body!==d.body||!['sent','sending','pending','failed','unknown'].includes(receipt.status))throw Error('Unexpected submission receipt.');
  if(target.guildId&&(receipt.guild_id!==target.guildId||receipt.channel_id!==target.channelId||receipt.reply_id!==(target.replyTo?.messageId||'')||receipt.target_json!==d.target||(receipt.status==='sent'&&(!snowflake(receipt.event_id)||receipt.post_url!==postURL(target.guildId,target.channelId,receipt.event_id)))))throw Error('Unexpected server message receipt.');
  this.db.prepare('UPDATE misty_message_drafts SET state=?,receipt=? WHERE code=?').run(receipt.status==='pending'?'sending':receipt.status,JSON.stringify({status:receipt.status,eventId:receipt.event_id||'',error:receipt.error||'',...(target.guildId?{guildId:receipt.guild_id,channelId:receipt.channel_id,replyId:receipt.reply_id,url:receipt.post_url||''}:{})}),d.code);
 }
 previewTexts(d){
  const target=typeof d.target==='string'?JSON.parse(d.target):d.target;
  if(!d.owner_channel||!['discord','whatsapp','gmail'].includes(target.platform))throw Error('Text approval requires the original verified owner DM.');
  const email=target.platform==='gmail';
  const destination=email?['Send email from your Gmail account',`Account: ${target.account}`,`From: ${target.from}`,
   `To: ${target.to.join(', ')||'(none)'}`,`Cc: ${target.cc.join(', ')||'(none)'}`,`Bcc: ${target.bcc.join(', ')||'(none)'}`,
   `Subject: ${target.subject}`,`Reply to: ${target.replyTo||'(new email)'}`,`Thread: ${target.threadId||'(new thread)'}`]:
   [`Send from your ${target.platform} account`,`To: ${target.name}`,`Room: ${target.room}`];
  if(target.guildId)destination.push(`Guild: ${target.guildId}`,`Channel: ${target.channelId}`,`Mentions: suppressed`,
    target.replyTo?`Reply to: ${JSON.stringify(target.replyTo)}`:'New message');
  const split=text=>{const parts=[];for(let i=0;i<text.length;i+=1600)parts.push(text.slice(i,i+1600));return parts;};
  const headers=split(destination.join('\n')),parts=split(d.body),kind=email?'email':'message';
  return [...headers.map((part,i)=>`Draft: ${d.code} — destination (${i+1}/${headers.length}):\n${part}`),
   ...parts.map((part,i)=>`Exact ${kind} body (${i+1}/${parts.length}):\n${part}`),
   `End of ${kind} draft ${d.code}. Reply yes ${d.code} to send this exact ${kind}, or no ${d.code} to cancel. Text approval expires in 10 minutes. Nothing has been sent.`];
 }
 previewText(d){
  this.previewTexts(d).forEach((body,i)=>this.db.prepare('INSERT OR IGNORE INTO relay_notices(source,body,owner_channel) VALUES(?,?,?)')
   .run(`personal:${d.code}:preview:${String(i).padStart(4,'0')}`,body,d.owner_channel));
 }
 textPreview(d,row){
  if(d.state!=='pending'||!d.owner_channel||d.owner_channel!==row.channel||approvalDigest(d)!==d.digest||
     this.clock()>Math.min(d.expires,d.created+10*60*1000)||row.ts<=d.created)throw Error('This text preview changed, expired, or belongs to another DM.');
  const count=this.previewTexts(d).length;
  const previews=this.db.prepare('SELECT source,status,message_id,owner_channel FROM relay_notices WHERE source LIKE ? ORDER BY source')
   .all(`personal:${d.code}:preview:%`);
  if(previews.length!==count||previews.some((p,i)=>p.source!==`personal:${d.code}:preview:${String(i).padStart(4,'0')}`||
    p.status!=='sent'||p.owner_channel!==row.channel||!snowflake(p.message_id)||BigInt(p.message_id)>=BigInt(row.id)||
    Number((BigInt(p.message_id)>>22n)+1420070400000n)>row.ts))throw Error('The complete exact preview must be delivered here before a new yes.');
 }
 async confirmText(code,id){
  let row=this.owner(id,{recent:2*60*1000}),d=this.get(code);
  const match=yes(row.body);
  if(!match||(match[1]&&match[1]!==code))throw Error('A new owner yes to this exact preview is required.');
  this.textPreview(d,row);
  const saved=JSON.parse(d.target);
  if(!['discord','whatsapp','gmail'].includes(saved.platform))throw Error('Unsupported text approval platform.');
  const {target,capability}=saved.platform==='gmail'?await this.backend.call('email_inspect',{
   account:saved.account,to:saved.to.join(', '),cc:saved.cc.join(', '),bcc:saved.bcc.join(', '),subject:saved.subject,replyTo:saved.replyTo,body:d.body
  }):await this.inspect({room:saved.room,replyTo:saved.replyTo?.messageId||''});
  if(!capability?.allowed||JSON.stringify(target)!==d.target)throw Error('The destination or connection changed. Review a fresh preview.');
  this.r.transaction(()=>{
   row=this.owner(id,{recent:2*60*1000});d=this.get(code);this.textPreview(d,row);
   const changed=this.db.prepare("UPDATE misty_message_drafts SET state='submitting',confirmation_id=? WHERE code=? AND state='pending'")
    .run(id,code);
   if(changed.changes!==1)throw Error('This draft is already being submitted.');
  });
  try{const receipt=await this.backend.call(target.platform==='gmail'?'email_send':'send',{id:d.submission_id,room:target.room,body:d.body,target});this.saveReceipt(d,receipt);}
  catch{this.db.prepare("UPDATE misty_message_drafts SET state='unknown',receipt=? WHERE code=?")
   .run(JSON.stringify({error:'Submission unconfirmed. Check the native app before composing another copy.'}),code);}
  return this.view(this.get(code));
 }
 async observe(id){
  const row=this.owner(id,{recent:2*60*1000}),answer=yes(row.body),cancel=no(row.body);
  if(!answer&&!cancel)return;
  const code=(answer||cancel)[1];
  const drafts=this.db.prepare("SELECT * FROM misty_message_drafts WHERE state='pending' AND owner_channel=? ORDER BY created DESC")
   .all(row.channel).filter(d=>!code||d.code===code);
  if(drafts.length!==1)return;
  const d=drafts[0],preview=this.db.prepare('SELECT 1 FROM relay_notices WHERE source LIKE ? LIMIT 1')
   .get(`personal:${d.code}:preview:%`);
  if(!preview){this.r.notice('personal-app-only:'+id,'This draft has no complete chat preview. Review it in the Misty app. Nothing was approved here.');return;}
  if(cancel){this.retire(d.code,'cancelled');return;}
  try{await this.confirmText(d.code,id);}
  catch{this.r.notice('personal-text-rejected:'+id,'That confirmation could not be accepted. Check the draft status or request a fresh exact preview.');}
 }
 async refresh(){
  if(this.refreshing)return this.refreshing;
  this.refreshing=(async()=>{
   for(const d of this.db.prepare("SELECT * FROM misty_message_drafts WHERE state IN ('sending','pending','unknown') AND confirmation_id IS NOT NULL ORDER BY created DESC LIMIT 20").all()){
    try{const target=JSON.parse(d.target),receipt=await this.backend.call(target.platform==='gmail'?'email_status':'status',{id:d.submission_id});if(receipt)this.saveReceipt(d,receipt);}catch{}
   }
   for(const d of this.db.prepare("SELECT * FROM misty_message_drafts WHERE state IN ('sent','failed','unknown') AND confirmation_id IS NOT NULL ORDER BY created DESC LIMIT 20").all()){
    const target=JSON.parse(d.target);
    const text=d.state==='sent'?target.platform==='gmail'?`Email sent from ${target.from} to ${target.to.join(', ')||target.cc.join(', ')||target.bcc.join(', ')}.`:`Sent to ${target.name} on ${target.platform}.`:d.state==='failed'?`Message ${d.code} was not sent. Check the connection and request a fresh draft before trying again.`:`Message ${d.code}: delivery is unconfirmed. Check ${target.platform==='gmail'?'Gmail Sent':'the native app'} before sending another copy. I won't retry it automatically.`;
    this.db.prepare('INSERT OR IGNORE INTO relay_notices(source,body,owner_channel) VALUES(?,?,?)').run(`personal:${d.code}:receipt:${d.state}`,text,d.owner_channel||this.db.prepare('SELECT channel FROM bot_turns WHERE id=?').get(d.owner_id)?.channel||'');
   }
  })().finally(()=>{this.refreshing=null;});return this.refreshing;
 }
 status(code){return this.view(this.get(code));}
}
