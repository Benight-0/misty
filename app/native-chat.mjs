import {OWNER_DISCORD_ID} from './owner-config.mjs';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {applyNativeEvent} from './native-ingest.mjs';
import {snowflake,replyId,verifiedReply,channelPermissions} from './message-target.mjs';

const owner=OWNER_DISCORD_ID;
const fail=(message,status)=>Object.assign(new Error(message),{safe:true,status});

export class NativeChat {
 constructor(store,{tokenFile='/etc/archival/discord-token',messageTokenFile=process.env.ARCHIVAL_MESSAGE_TOKEN_FILE,fetchImpl=fetch}={}){this.store=store;this.tokenFile=tokenFile;this.messageTokenFile=messageTokenFile;this.fetch=fetchImpl;}
 capability(room){
  if(room?.platform==='whatsapp'){
   let reason='';
   if(!this.messageTokenFile)reason='WhatsApp sending is unavailable.';
   else if(!['dm','group'].includes(room.kind)||!/^\d+(?:-\d+)?@(s\.whatsapp\.net|lid|g\.us)$/.test(room.remote_id))reason='Choose an existing WhatsApp DM or group DM.';
   else if(!room.connected||!room.tracked)reason='Connect and enable this conversation before sending.';
   else if(!this.store.get('native_whatsapp',{}).connected)reason='WhatsApp is reconnecting. Wait before sending.';
   else if(room.kind==='group'&&this.store.statement('SELECT treatment FROM whatsapp_group_policies WHERE room_id=?').get(room.id)?.treatment!=='G')reason='Choose a WhatsApp group classified as a group DM.';
   return {allowed:!reason,reason,maxLength:20000,platform:'whatsapp',transport:'native',ai:!reason};
  }
  let reason='';
  if(room?.platform!=='discord')reason='VM sending is currently available for Discord and WhatsApp.';
  else if(!snowflake(room.remote_id)||!(room.server_id?room.kind==='channel'&&snowflake(room.server_id):['dm','group'].includes(room.kind)))reason='Choose an existing Discord conversation or server text channel.';
  else if(!room.connected||!room.tracked)reason='Connect and enable this conversation before sending.';
  else if(room.server_id&&!['S','SP','G','GP'].includes(this.store.statement('SELECT treatment FROM discord_server_policies WHERE server_id=?').get(room.server_id)?.treatment))reason='This Discord server is ignored or unselected.';
  else if(!this.store.get('native_discord',{}).connected)reason='Discord is reconnecting. Wait for the connection before sending.';
  return {allowed:!reason,reason,maxLength:2000,platform:room?.platform||'',transport:'native',ai:!reason};
 }
 async request(path,{body}={}){
  let token;try{token=fs.readFileSync(this.tokenFile,'utf8').trim();}catch{throw fail('The Discord login is unavailable.');}
  if(!token)throw fail('The Discord login is unavailable.');
  let response;
  try{response=await this.fetch('https://discord.com/api/v9'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:token,'Content-Type':'application/json','User-Agent':'Misty/1.0'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});}
  catch{throw fail('Discord did not confirm the request. Check Discord before sending another copy.');}
  if(!response.ok)throw fail(response.status===429?'Discord rate limited the request. Wait before trying again.':'Discord rejected the request (HTTP '+response.status+').',response.status);
  try{return await response.json();}catch{throw fail('Discord returned an unreadable confirmation.');}
 }
 async verify(room,{replyTo=''}={}){
  if(room.platform==='whatsapp'){await this.whatsappRequest('/inspect',{chat:room.remote_id});return;}
  const me=await this.request('/users/@me');if(me.id!==owner)throw fail('The Discord login does not match your archive account.');
  const channel=await this.request('/channels/'+room.remote_id);
  if(!room.server_id){
   if(replyTo)throw fail('Reply references in this composer are supported for Discord server channels only.');
   if(channel.id!==room.remote_id||channel.guild_id||![1,3].includes(channel.type))throw fail('Discord did not confirm the selected private conversation.');
   return {};
  }
  if(channel.id!==room.remote_id||channel.guild_id!==room.server_id||![0,5,10,11,12].includes(channel.type))throw fail('Discord did not verify the expected guild text channel or thread.');
  const thread=[10,11,12].includes(channel.type);
  if(thread&&(channel.thread_metadata?.archived!==false||channel.thread_metadata?.locked!==false))throw fail('This thread is archived, locked or unavailable; it will not be reopened.');
  const parent=thread?await this.request('/channels/'+channel.parent_id):channel;
  if(thread&&(parent.id!==channel.parent_id||parent.guild_id!==room.server_id||![0,5,15,16].includes(parent.type)))throw fail('Discord did not verify the thread parent in the expected guild.');
  const guild=await this.request('/guilds/'+room.server_id);
  if(guild.id!==room.server_id||!snowflake(guild.owner_id))throw fail('Discord did not verify the expected guild.');
  const member=await this.request('/guilds/'+room.server_id+'/members/'+owner);
  if(member.user?.id!==owner||member.pending||Date.parse(member.communication_disabled_until||'')>Date.now())throw fail('The owner is unavailable, pending membership or timed out in this guild.');
  const roles=await this.request('/guilds/'+room.server_id+'/roles');
  const permissions=channelPermissions(parent,member,roles,guild,owner);
  const id=replyId(replyTo,channel.id,guild.id);
  const required=(1n<<10n)|(1n<<BigInt(thread?38:11))|(id?1n<<16n:0n);
  if((permissions&required)!==required)throw fail('The owner lacks permission to view, post or read the reply target in this destination.');
  if(channel.type===12){const membership=await this.request('/channels/'+channel.id+'/thread-members/@me');if(membership.user_id!==owner||membership.id!==channel.id)throw fail('The owner is not an existing member of this private thread.');}
  let replyToMessage=null;
  if(id){
   // Discord's history endpoint works for the existing user session; require the
   // exact ID rather than substituting an adjacent message or archive text.
   const messages=await this.request('/channels/'+channel.id+'/messages?around='+id+'&limit=1');
   replyToMessage=verifiedReply(Array.isArray(messages)?messages.find(m=>m.id===id):null,channel.id,guild.id,id);
  }
  if(thread){
   // Do not let the intervening permission/history reads turn an auto-archived
   // thread into an implicit reopen at the final mutation.
   const current=await this.request('/channels/'+channel.id);
   if(current.id!==channel.id||current.guild_id!==guild.id||current.type!==channel.type||current.parent_id!==parent.id||current.name!==channel.name||current.thread_metadata?.archived!==false||current.thread_metadata?.locked!==false)throw fail('The thread changed, locked or archived during verification. Request a fresh preview.');
  }
  return {guildId:guild.id,guildName:String(guild.name||room.server_name||guild.id).slice(0,150),channelId:channel.id,
   channelName:String(channel.name||channel.id).slice(0,150),channelType:channel.type,parentId:thread?parent.id:'',
   parentName:thread?String(parent.name||parent.id).slice(0,150):'',replyTo:replyToMessage,mentions:'suppressed'};
 }
 async send(room,body,id,target={}){
  if(room.platform==='whatsapp')return this.whatsappRequest('/send',{chat:room.remote_id,body,id});
  if(room.server_id&&(target.guildId!==room.server_id||target.channelId!==room.remote_id||target.mentions!=='suppressed'))throw fail('A verified server destination is required.');
  const nonce=createHash('sha256').update(id).digest('hex').slice(0,24);
  const reference=target.replyTo?{message_id:target.replyTo.messageId,channel_id:room.remote_id,guild_id:room.server_id,fail_if_not_exists:true}:undefined;
  const message=await this.request('/channels/'+room.remote_id+'/messages',{body:{content:body,nonce,enforce_nonce:true,allowed_mentions:{parse:[],...(room.server_id?{replied_user:false}:{})},...(reference?{message_reference:reference}:{})}});
  if(!/^\d{16,22}$/.test(message.id||'')||message.channel_id!==room.remote_id||message.author?.id!==owner||message.content!==body)throw fail('Discord returned an unexpected message confirmation. Check Discord before sending another copy.');
  const actual=message.message_reference;
  if((message.guild_id&&message.guild_id!==room.server_id)||(reference?actual?.message_id!==reference.message_id||actual?.channel_id!==reference.channel_id||actual?.guild_id!==reference.guild_id:actual?.message_id))throw fail('Discord returned an unexpected destination or reply confirmation. Check Discord before sending another copy.');
  if(room.server_id)message.guild_id=room.server_id;
  return message;
 }
 async whatsappRequest(path,body){
  let token;try{token=fs.readFileSync(this.messageTokenFile,'utf8').trim();}catch{throw fail('WhatsApp sending credential is unavailable.');}
  let response;try{response=await this.fetch('http://127.0.0.1:8796'+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(40000)});}catch{throw fail('WhatsApp did not confirm the request. Check WhatsApp before sending another copy.');}
  if(!response.ok)throw fail('WhatsApp rejected or could not confirm the request.',response.status);
  const result=await response.json();
  if(path==='/send'&&(result.kind!=='whatsapp_message'||result.chat!==body.chat||result.body!==body.body||result.is_me!==true||typeof result.id!=='string'||!result.id||!Number.isSafeInteger(result.at)))throw fail('Unexpected WhatsApp confirmation. Check WhatsApp before sending another copy.');
  return result;
 }
 ingest(message){applyNativeEvent(this.store,message.kind==='whatsapp_message'?message:{kind:'discord_message',message});}
}
