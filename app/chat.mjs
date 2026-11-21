import fs from 'node:fs';
import {reconcileChatStatus} from './chat-store.mjs';
import {messageTarget,postURL} from './message-target.mjs';

const guildFile=process.env.MISTY_DISCORD_SERVER_IDS_FILE||new URL('../scripts/discord-server-ids.txt',import.meta.url);
const guilds=new Set((process.env.MISTY_DISCORD_SERVER_IDS||(fs.existsSync(guildFile)?fs.readFileSync(guildFile,'utf8'):'')).split(/\s*,\s*|\s+/).filter(Boolean));
export function chatCapability(room,allowedGuilds=guilds) {
  const maxLength=room?.platform==='discord'?2000:20000;
  let reason='';
  if(!room||!['discord','whatsapp'].includes(room.platform))reason='Sending is available for connected Discord and WhatsApp conversations.';
  // Room v12 uses a 43-character hash without a server suffix. The live Matrix
  // state check below still verifies membership and the bridge destination.
  else if(!/^!(?:[A-Za-z0-9_-]+:localhost|[A-Za-z0-9_-]{43})$/.test(room.id))reason='Choose a valid bridged room from the local archive.';
  else if(!['dm','group','channel'].includes(room.kind))reason='This room cannot receive chat messages.';
  else if(!room.connected||!room.source_joined)reason='Reconnect and join this chat before sending.';
  else if(room.encrypted)reason='Sending to encrypted Matrix rooms is not supported by this composer.';
  else if(room.platform==='discord'&&room.server_id&&!allowedGuilds.has(room.server_id))reason='This Discord server is excluded from Archival.';
  return {allowed:!reason,reason,maxLength,platform:room?.platform||''};
}

export function validateChatBody(room,body,allowedGuilds=guilds) {
  const cap=chatCapability(room,allowedGuilds);if(!cap.allowed)throw new Error(cap.reason);
  if(typeof body!=='string'||!body.trim()||body.includes('\0')||body.length>cap.maxLength)throw new Error(`Write a message of up to ${cap.maxLength.toLocaleString()} characters.`);
  return cap;
}

export class ChatSender {
  constructor(store,serial,matrix,{allowedGuilds=guilds,native=null,recover=true}={}) {
    this.store=store;this.serial=serial;this.matrix=matrix;this.native=native;this.allowedGuilds=allowedGuilds;this.jobs=new Map();this.closed=false;
    this.ready=this.serial(()=>recover&&this.store.statement("UPDATE chat_outgoing SET status='unknown',error='Archival stopped before local submission was confirmed. Check the native app before sending another copy.',updated_at=? WHERE status='sending'").run(Date.now()));
  }
  capability(room){return this.native?this.native.capability(room):chatCapability(room,this.allowedGuilds);}
  async inspect(room,{replyTo=''}={}){
    const capability=this.capability(room);
    if(replyTo&&(!this.native||room?.platform!=='discord'||!room.server_id))throw new Error('Reply references require an existing Discord server channel.');
    if(!capability.allowed)return {target:room?messageTarget(room):null,capability};
    const verified=this.native&&room.server_id?await this.native.verify(room,{replyTo}):{};
    const current=this.store.room(room.id);
    if(JSON.stringify(messageTarget(current))!==JSON.stringify(messageTarget(room))||current.server_id!==room.server_id)throw new Error('The selected destination changed.');
    const latest=this.capability(current);return {target:messageTarget(current,verified),capability:latest};
  }
  validate(room,body){
    if(!this.native)return validateChatBody(room,body,this.allowedGuilds);
    const cap=this.capability(room);if(!cap.allowed)throw new Error(cap.reason);
    if(typeof body!=='string'||!body.trim()||body.includes('\0')||body.length>cap.maxLength)throw new Error(`Write a message of up to ${cap.maxLength.toLocaleString()} characters.`);
    return cap;
  }
  outgoing(room='',id='') {
    const rows=id?this.store.statement('SELECT * FROM chat_outgoing WHERE id=?').all(id):this.store.statement('SELECT * FROM chat_outgoing WHERE room_id=? ORDER BY created_at DESC LIMIT 30').all(room);
    return rows;
  }
  async send({id,room,body,target:approvedTarget}) {
    await this.ready;if(this.closed)throw new Error('Archival is stopping.');
    if(typeof id!=='string'||!/^chat-[a-f0-9-]{36}$/i.test(id))throw new Error('Invalid message submission ID.');
    if(typeof room!=='string'||typeof body!=='string')throw new Error('Choose a conversation and write a message.');
    const row=await this.serial(()=>{
      const existing=this.store.statement('SELECT * FROM chat_outgoing WHERE id=?').get(id);
      if(existing){if(existing.room_id!==room||existing.body!==body||(existing.target_json?existing.target_json!==JSON.stringify(approvedTarget||null):approvedTarget?.guildId||approvedTarget?.replyTo))throw new Error('This submission ID belongs to a different message.');return {...existing,repeated:true};}
      const target=this.store.room(room);this.validate(target,body);
      if(this.native&&target.server_id&&(!approvedTarget||approvedTarget.guildId!==target.server_id||approvedTarget.channelId!==target.remote_id))throw new Error('A verified server destination preview is required.');
      if(approvedTarget&&JSON.stringify(messageTarget(target))!==JSON.stringify(Object.fromEntries(Object.entries(approvedTarget).filter(([k])=>['room','platform','kind','remoteId','name'].includes(k)))))throw new Error('The selected destination changed.');
      const now=Date.now();this.store.statement('INSERT INTO chat_outgoing(id,room_id,platform,body,created_at,updated_at,target_json,guild_id,channel_id,reply_id) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,room,target.platform,body,now,now,approvedTarget?JSON.stringify(approvedTarget):'',target.server_id||'',target.remote_id||'',approvedTarget?.replyTo?.messageId||'');
      return this.outgoing('',id)[0];
    });
    if(!row.repeated){
      const task=this.deliver(row).catch(()=>{});this.jobs.set(id,task);task.finally(()=>this.jobs.delete(id));
    }
    return this.outgoing('',id)[0];
  }
  async deliver(row) {
    if(this.native)return this.deliverNative(row);
    let attempted=false;
    try {
      await this.matrix.login();
      const room=await this.serial(()=>this.store.room(row.room_id));validateChatBody(room,row.body,this.allowedGuilds);
      await this.matrix.verifyChatRoom(room);
      // Recheck local preferences after network validation, before the actual mutation.
      await this.serial(()=>validateChatBody(this.store.room(row.room_id),row.body,this.allowedGuilds));
      if(this.closed)throw new Error('Archival stopped before sending.');
      attempted=true;
      const result=await this.matrix.sendChat(row.room_id,row.body,row.id);
      if(typeof result.event_id!=='string'||!result.event_id.startsWith('$'))throw new Error('No Matrix submission confirmation.');
      await this.serial(()=>{
        this.store.statement("UPDATE chat_outgoing SET status='pending',event_id=?,error='',updated_at=? WHERE id=?").run(result.event_id,Date.now(),row.id);
        reconcileChatStatus(this.store,row.id);
      });
    }catch(error){
      const unknown=attempted&&(!error.status||error.status>=500||error.status===408);
      const message=unknown?'Local submission is unconfirmed. Check the native app before sending another copy.':attempted?'Local Matrix rejected the message (HTTP '+error.status+'). Nothing will be retried automatically.':error.safe?error.message:'Message was not submitted. Check Docker, the connected account and room permissions.';
      await this.serial(()=>this.store.statement('UPDATE chat_outgoing SET status=?,error=?,updated_at=? WHERE id=?').run(unknown?'unknown':'failed',message,Date.now(),row.id));
    }
  }
  async deliverNative(row){
    let attempted=false;
    try{
      const room=await this.serial(()=>{const room=this.store.room(row.room_id);this.validate(room,row.body);return room;});
      const target=row.target_json?JSON.parse(row.target_json):null;
      const verified=await this.native.verify(room,{replyTo:target?.replyTo?.messageId||''});
      if(target&&JSON.stringify(messageTarget(room,verified))!==row.target_json)throw new Error('The approved destination or reply target changed. Request a new preview.');
      await this.serial(()=>{const current=this.store.room(row.room_id);this.validate(current,row.body);if(JSON.stringify(messageTarget(current))!==JSON.stringify(messageTarget(room))||current.server_id!==room.server_id)throw new Error('The selected destination changed.');});
      if(this.closed)throw new Error('Misty stopped before sending.');
      attempted=true;const message=await this.native.send(room,row.body,row.id,target||{});
      await this.serial(()=>{
        this.native.ingest(message);
        const url=room.server_id?postURL(room.server_id,room.remote_id,message.id):'';
        this.store.statement("UPDATE chat_outgoing SET status='sent',event_id=?,post_url=?,error='',updated_at=? WHERE id=?").run(message.id,url,Date.now(),row.id);
      });
    }catch(error){
      const unknown=attempted&&(!error.status||error.status>=500||error.status===408);
      const message=unknown?'Submission is unconfirmed. Check Discord before sending another copy.':error.safe?error.message:'Message was not submitted. Check the connection and conversation settings.';
      await this.serial(()=>this.store.statement('UPDATE chat_outgoing SET status=?,error=?,updated_at=? WHERE id=?').run(unknown?'unknown':'failed',message,Date.now(),row.id));
    }
  }
  async close(){this.closed=true;await this.ready;await Promise.allSettled([...this.jobs.values()]);}
}
