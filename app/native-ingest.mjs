import {OWNER_DISCORD_ID,OWNER_WHATSAPP_PHONE} from './owner-config.mjs';
import {addDiscordServerChannel} from './discord-server-policies.mjs';
import {serverSummarySchema} from './misty-server-summaries.mjs';
import {ingestDiscord,deleteDiscord} from './discord-history-store.mjs';
import {historyGroupRoom,groupImportStatus} from './whatsapp-groups.mjs';
import {createHash} from 'node:crypto';

const discordSelf=OWNER_DISCORD_ID,waSelf=OWNER_WHATSAPP_PHONE;
export function nativeSchema(store){serverSummarySchema(store.db);store.db.exec(`
 CREATE TABLE IF NOT EXISTS native_message_links(platform TEXT NOT NULL,chat_id TEXT NOT NULL,remote_id TEXT NOT NULL,message_id TEXT NOT NULL,PRIMARY KEY(platform,chat_id,remote_id));
 CREATE TABLE IF NOT EXISTS native_whatsapp_raw(message_id TEXT PRIMARY KEY,raw_json TEXT NOT NULL,updated_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS native_chat_aliases(platform TEXT NOT NULL,remote_id TEXT NOT NULL,room_id TEXT NOT NULL,PRIMARY KEY(platform,remote_id));
 CREATE TABLE IF NOT EXISTS native_discord_cursors(channel_id TEXT PRIMARY KEY,after_id TEXT NOT NULL DEFAULT '',updated_at INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS openai_usage(request_id TEXT PRIMARY KEY,room_id TEXT NOT NULL,model TEXT NOT NULL,input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,cached_tokens INTEGER NOT NULL,at INTEGER NOT NULL,status TEXT NOT NULL);
`);}
function discordRoom(store,channel){return store.statement("SELECT * FROM conversations WHERE platform='discord' AND remote_id=? AND ((server_id='' AND kind IN ('dm','group')) OR (kind='channel' AND connected=1 AND tracked=1 AND server_id IN (SELECT server_id FROM discord_server_policies WHERE treatment IN ('G','GP','S','SP'))))").get(channel);}
function privateWhatsAppChat(id){return /^\d+@(lid|s\.whatsapp\.net)$/.test(id);}
function whatsappRoom(store,event){
 if(/^\d+(?:-\d+)?@g\.us$/.test(event.chat||'')){
  if(store.get('misty_live_servers',false)){
   const server=store.statement("SELECT c.*,s.from_ts FROM whatsapp_group_policies p JOIN conversations c ON c.id=p.room_id JOIN misty_server_channels s ON s.room_id=c.id WHERE p.chat_id=? AND p.treatment='S' AND c.connected=1 AND c.tracked=1 AND s.enabled=1").get(event.chat);
   if(server){
    if(!Number.isSafeInteger(event.at)||event.at<server.from_ts)return null;
    // A linked-device replay must not restore raw text already summarized and
    // expired. Real edits with a different hash can still correct the summary.
    if(event.body&&event.at<Date.now()-86400000){const covered=store.statement('SELECT body_hash FROM misty_server_covered WHERE message_id=?').get('whatsapp:'+server.remote_id+':'+event.id);if(covered?.body_hash===createHash('sha256').update(event.body).digest('hex'))return null;}
    return server;
   }
  }
  if(!store.get('misty_live_groups',false))return null;
  return store.statement("SELECT c.* FROM whatsapp_group_policies p JOIN conversations c ON c.id=p.room_id WHERE p.chat_id=? AND p.treatment='G' AND c.connected=1 AND c.tracked=1").get(event.chat)||null;
 }
 const ids=[...new Set([event.chat,...event.aliases||[]])].filter(privateWhatsAppChat);
 if(!ids.length)return null;
 let room;
 for(const id of ids){room=store.statement("SELECT c.* FROM native_chat_aliases a JOIN conversations c ON c.id=a.room_id WHERE a.platform='whatsapp' AND a.remote_id=?").get(id)||store.statement("SELECT * FROM conversations WHERE platform='whatsapp' AND kind='dm' AND remote_id=?").get(id);if(room)break;}
 if(!room){
  const remote=ids.find(id=>id.endsWith('@lid'))||ids[0],id='whatsapp:dm:'+remote;
  store.statement("INSERT INTO conversations(id,name,platform,kind,remote_id,updated_at) VALUES(?,?,'whatsapp','dm',?,?)").run(id,!event.is_me&&event.name?event.name:'WhatsApp direct chat',remote,Date.now());room=store.room(id);
 }
 for(const id of ids)store.statement("INSERT INTO native_chat_aliases VALUES('whatsapp',?,?) ON CONFLICT(platform,remote_id) DO UPDATE SET room_id=excluded.room_id").run(id,room.id);
 if(!event.is_me&&event.name)store.statement("UPDATE conversations SET name=? WHERE id=? AND name IN ('WhatsApp direct chat','')").run(event.name,room.id);
 return room;
}
export function nativePlans(store){
 nativeSchema(store);
 // Persist the starting watermark before the gateway can deliver newer messages.
 store.db.exec(`INSERT OR IGNORE INTO native_discord_cursors(channel_id,after_id)
 SELECT remote_id,coalesce((SELECT max(remote_id) FROM discord_remote WHERE channel_id=c.remote_id),'')
 FROM conversations c WHERE platform='discord' AND server_id='' AND kind IN ('dm','group');`);
 return store.statement(`SELECT c.remote_id id,coalesce(k.after_id,(SELECT max(remote_id) FROM discord_remote WHERE channel_id=c.remote_id),'') after,
 coalesce(j.before_id,'') before,coalesce(j.complete,0) complete FROM conversations c
 LEFT JOIN native_discord_cursors k ON k.channel_id=c.remote_id LEFT JOIN discord_history_jobs j ON j.room_id=c.id
 WHERE c.platform='discord' AND c.server_id='' AND c.kind IN ('dm','group') AND c.connected=1 AND c.tracked=1`).all().map(p=>({...p,complete:!!p.complete}));
}
export function applyNativeEvent(store,event){
 nativeSchema(store);
 if(!event||typeof event.kind!=='string')throw new Error('Invalid collector event.');
 store.begin();
 try{
  const now=Date.now();
  if(event.kind==='whatsapp_group_import_status')groupImportStatus(store,event);
  if(event.kind==='whatsapp_group_inventory'){
   if(!Number.isSafeInteger(event.at)||!Array.isArray(event.groups)||event.groups.length>5000)throw new Error('Invalid WhatsApp group inventory.');
   const groups=new Map();
   for(const g of event.groups){
    if(!g||!/^\d+(?:-\d+)?@g\.us$/.test(g.id)||typeof g.name!=='string'||g.name.length>1024||typeof g.community!=='boolean'||typeof g.announcement!=='boolean'||typeof g.parent!=='string'||(g.parent&&!/^\d+(?:-\d+)?@g\.us$/.test(g.parent)))throw new Error('Invalid WhatsApp group inventory entry.');
    groups.set(g.id,{id:g.id,name:g.name,community:g.community,announcement:g.announcement,parent:g.parent});
   }
   // Metadata snapshot only: no conversation selection, history import or analysis changes.
   store.set('whatsapp_group_inventory',{at:event.at,source:'whatsapp_joined_groups',groups:[...groups.values()]});
   store.set('whatsapp_group_inventory_error',null);
  }
  if(event.kind==='whatsapp_group_inventory_error')store.set('whatsapp_group_inventory_error',{at:now,error:'Membership request failed; last successful snapshot retained.'});
  if(event.kind==='discord_identity'&&event.id!==discordSelf)throw new Error('Collector Discord account does not match the archive owner.');
  if(event.kind==='whatsapp_identity'&&!event.id?.startsWith(waSelf+':')&&!event.id?.startsWith(waSelf+'@'))throw new Error('Collector WhatsApp account does not match the archive owner.');
  if(event.kind==='status'){
   if(!['discord','whatsapp'].includes(event.platform))throw new Error('Unknown collector platform.');
   const prior=store.get('native_'+event.platform,{}),connected=['connected','gateway_connected','history_received'].includes(event.state)?true:['reconnecting','logged_out','connection_retry','session_database_error','session_load_error','pairing_required','credential_missing','client_outdated'].includes(event.state)?false:prior.connected;
   store.set('native_'+event.platform,{state:event.state,at:now,connected:!!connected});
   if(event.platform==='whatsapp'&&connected)store.set('whatsapp_pairing',null);
  }
  if(event.kind==='whatsapp_pair_code'){
   if(!/^[A-Z0-9-]{8,12}$/.test(event.code)||!Number.isSafeInteger(event.expires))throw new Error('Invalid pairing response.');
   store.set('whatsapp_pairing',{code:event.code,expires:event.expires});
  }
  if(event.kind==='discord_server_channel')addDiscordServerChannel(store,event.channel,now);
  if(event.kind==='discord_channel'){
   const c=event.channel;if(!c||![1,3].includes(c.type)||!/^\d{16,22}$/.test(c.id))throw new Error('Invalid private Discord channel.');
   const old=discordRoom(store,c.id),id=old?.id||'discord:dm:'+c.id;
   const name=c.name||(c.recipients||[]).filter(p=>p.id!==discordSelf).map(p=>p.global_name||p.username).join(', ')||old?.name||'Discord direct chat';
   store.statement("INSERT INTO conversations(id,name,platform,kind,remote_id,updated_at) VALUES(?,?,'discord',?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at").run(id,name,c.type===3?'group':'dm',c.id,now);
   store.statement('INSERT OR IGNORE INTO discord_history_jobs(room_id,channel_id) VALUES(?,?)').run(id,c.id);
   store.statement('INSERT OR IGNORE INTO native_discord_cursors(channel_id,after_id) VALUES(?,?)').run(c.id,store.statement('SELECT max(remote_id) id FROM discord_remote WHERE channel_id=?').get(c.id).id||'');
  }
  if(event.kind==='discord_message'){
   const m=event.message;
   const room=discordRoom(store,m?.channel_id);if(room&&(!room.server_id||m.guild_id===room.server_id))ingestDiscord(store,room.id,m,[],now);
  }
  if(event.kind==='discord_delete'){
   const room=discordRoom(store,event.channel);if(room)for(const id of event.ids||[])deleteDiscord(store,room.id,id);
  }
  if(event.kind==='discord_cursor'){
   const room=discordRoom(store,event.channel);if(!room)throw new Error('Unknown catch-up channel.');
   if(event.after&&!/^\d{16,22}$/.test(event.after))throw new Error('Invalid catch-up cursor.');
   store.statement('INSERT INTO native_discord_cursors VALUES(?,?,?) ON CONFLICT(channel_id) DO UPDATE SET after_id=excluded.after_id,updated_at=excluded.updated_at').run(event.channel,event.after,now);
  }
  if(event.kind==='discord_history'){
   const room=discordRoom(store,event.channel);if(room)store.statement("UPDATE discord_history_jobs SET before_id=?,fetched=fetched+?,complete=?,error='',updated_at=? WHERE room_id=?").run(event.before,event.count,+event.complete,now,room.id);
  }
  if(['whatsapp_message','whatsapp_delete','whatsapp_group_history_message','whatsapp_group_history_delete'].includes(event.kind)){
   const historical=event.kind.startsWith('whatsapp_group_history_');
   const room=historical?historyGroupRoom(store,event):whatsappRoom(store,event);
   if(room?.connected&&(historical||room.tracked)){
    const ids=historical||room.kind==='group'?[event.chat]:[...new Set([event.chat,...event.aliases||[]])].filter(privateWhatsAppChat);
    let linked;
    for(const id of ids){linked=store.statement("SELECT message_id FROM native_message_links WHERE platform='whatsapp' AND chat_id=? AND remote_id=?").get(id,event.id);if(linked)break;}
    const id=linked?.message_id||'whatsapp:'+room.remote_id+':'+event.id;
    if(event.kind.endsWith('_delete')){store.redact(id,{direct:true});store.statement('DELETE FROM native_whatsapp_raw WHERE message_id=?').run(id);}
    else if(!store.statement('SELECT 1 FROM tombstones WHERE id=?').get(id)){
     if(!event.id||!privateWhatsAppChat(event.sender)||!Number.isSafeInteger(event.at)||typeof event.body!=='string')throw new Error('Invalid WhatsApp message.');
     const sender=event.is_me?'@owner:localhost':'@whatsapp_'+(event.sender.endsWith('@lid')?'lid-':'')+event.sender.split('@')[0]+':localhost';
     store.statement("INSERT INTO identities(id,platform,remote_id,name) VALUES(?,'whatsapp',?,?) ON CONFLICT(id) DO UPDATE SET name=CASE WHEN excluded.name<>'' AND identities.is_me=0 THEN excluded.name ELSE identities.name END").run(sender,event.sender,event.is_me?'You':event.name||'WhatsApp contact');
     store.statement(`INSERT INTO messages(id,room_id,sender,ts,body,original_body,type,is_me,edited,source_received) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET sender=excluded.sender,body=excluded.body,type=excluded.type,is_me=excluded.is_me,edited=excluded.edited`).run(id,room.id,sender,event.at,event.body,event.body,event.type,+!!event.is_me,+!!event.edited,now);
     store.statement('INSERT INTO native_whatsapp_raw VALUES(?,?,?) ON CONFLICT(message_id) DO UPDATE SET raw_json=excluded.raw_json,updated_at=excluded.updated_at').run(id,JSON.stringify(event.raw||{}),now);
     for(const alias of ids)store.statement("INSERT INTO native_message_links VALUES('whatsapp',?,?,?) ON CONFLICT(platform,chat_id,remote_id) DO UPDATE SET message_id=excluded.message_id").run(alias,event.id,id);
     store.touched.add(room.id);
    }
   }
  }
  store.refreshCounts();
  if(['discord_message','discord_delete','whatsapp_message','whatsapp_delete','whatsapp_group_history_message','whatsapp_group_history_delete'].includes(event.kind))store.set('discord_history_revision',now);
  const discord=store.get('native_discord',{}),whatsapp=store.get('native_whatsapp',{});
  store.set('sync_status',{ok:!!discord.connected&&!!whatsapp.connected,at:now,records:1,source:'native-dm-collectors',discord,whatsapp});
  store.commit();
 }catch(error){store.rollback();throw error;}
}
