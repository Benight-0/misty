import {OWNER_DISCORD_ID} from './owner-config.mjs';
import {createHash} from 'node:crypto';
const ownDiscord=OWNER_DISCORD_ID;
export function historySchema(db){db.exec(`
  CREATE TABLE IF NOT EXISTS discord_remote(channel_id TEXT NOT NULL,remote_id TEXT NOT NULL,room_id TEXT NOT NULL,message_id TEXT NOT NULL,raw_json TEXT NOT NULL,version INTEGER NOT NULL,fetched_at INTEGER NOT NULL,PRIMARY KEY(channel_id,remote_id));
  CREATE INDEX IF NOT EXISTS discord_remote_message ON discord_remote(message_id);
  CREATE TABLE IF NOT EXISTS discord_matrix_links(event_id TEXT PRIMARY KEY,message_id TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS discord_source_links(channel_id TEXT NOT NULL,remote_id TEXT NOT NULL,event_id TEXT NOT NULL,PRIMARY KEY(channel_id,remote_id,event_id));
  CREATE TABLE IF NOT EXISTS discord_deleted(channel_id TEXT NOT NULL,remote_id TEXT NOT NULL,PRIMARY KEY(channel_id,remote_id));
  CREATE TABLE IF NOT EXISTS discord_history_jobs(room_id TEXT PRIMARY KEY,channel_id TEXT NOT NULL,before_id TEXT NOT NULL DEFAULT '',fetched INTEGER NOT NULL DEFAULT 0,complete INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '',updated_at INTEGER NOT NULL DEFAULT 0);
`);}
export function discordBody(raw){
  const parts=[String(raw.content||'').trim()];
  for(const a of raw.attachments||[])parts.push(`[Attachment: ${a.filename||'file'}]\n${a.url||''}`);
  for(const s of raw.sticker_items||[])parts.push(`[Sticker: ${s.name||s.id}]`);
  for(const e of raw.embeds||[]){const text=[e.title,e.description,e.url].filter(Boolean).join('\n');if(text&&!parts.includes(text))parts.push(text);}
  return parts.filter(Boolean).join('\n\n')||`[Discord event type ${raw.type??0}]`;
}
export function resolveDiscordId(store,id){return store.statement('SELECT message_id FROM discord_matrix_links WHERE event_id=?').get(id)?.message_id||id;}
export function ingestDiscord(store,roomId,raw,links=[],fetchedAt=Date.now()){
  const room=store.room(roomId);
  if(!room||!room.connected||!room.tracked||room.platform!=='discord')return;
  if(room.server_id&&!['S','SP','G','GP'].includes(room.discordPolicy?.treatment))return;
  if(room.server_id&&raw.guild_id&&raw.guild_id!==room.server_id)return;
  const channel=String(raw.channel_id||room.remote_id),remote=String(raw.id||'');
  if(!/^\d{16,22}$/.test(remote)||channel!==room.remote_id)return;
  if(store.statement('SELECT 1 FROM discord_deleted WHERE channel_id=? AND remote_id=?').get(channel,remote))return;
  links=[...new Map([...links,...store.statement('SELECT event_id FROM discord_source_links WHERE channel_id=? AND remote_id=?').all(channel,remote)].map(l=>[l.event_id,l])).values()];
  const originalTs=Date.parse(raw.timestamp)||Number((BigInt(remote)>>22n)+1420070400000n);
  if(room.server_id&&['S','SP'].includes(room.discordPolicy.treatment)){
   if(originalTs<room.discordPolicy.from_ts)return;
   if(originalTs<Date.now()-86400000){const covered=store.statement('SELECT body_hash FROM misty_server_covered WHERE message_id=?').get(`discord:${channel}:${remote}`);if(covered?.body_hash===createHash('sha256').update(discordBody(raw)).digest('hex'))return;}
  }
  const old=store.statement('SELECT * FROM discord_remote WHERE channel_id=? AND remote_id=?').get(channel,remote);
  // Preserve existing source IDs wherever possible, including existing profile evidence.
  const present=links.map(l=>l.event_id).filter(id=>store.statement('SELECT 1 FROM messages WHERE id=?').get(id));
  const canonical=old?.message_id||present[0]||`discord:${channel}:${remote}`;
  for(const link of links){
    store.statement('INSERT INTO discord_matrix_links(event_id,message_id) VALUES(?,?) ON CONFLICT(event_id) DO UPDATE SET message_id=excluded.message_id').run(link.event_id,canonical);
    if(link.event_id!==canonical)store.statement('DELETE FROM messages WHERE id=?').run(link.event_id);
  }
  const version=Date.parse(raw.edited_timestamp||raw.timestamp)||Number((BigInt(remote)>>22n)+1420070400000n);
  if(old&&(version<old.version||(version===old.version&&fetchedAt<old.fetched_at)))return;
  if(store.statement('SELECT 1 FROM tombstones WHERE id=?').get(canonical))return;
  const sender=raw.author?.id===ownDiscord?'@owner:localhost':raw.author?.id?`@discord_${raw.author.id}:localhost`:'@discordbot:localhost';
  store.statement(`INSERT INTO identities(id,platform,remote_id,name) VALUES(?,'discord',?,?) ON CONFLICT(id) DO UPDATE SET name=CASE WHEN excluded.name<>'' AND identities.is_me=0 THEN excluded.name ELSE identities.name END`).run(sender,raw.author?.id||'',raw.author?.global_name||raw.author?.username||'Discord');
  const body=discordBody(raw),ts=Date.parse(raw.timestamp)||Number((BigInt(remote)>>22n)+1420070400000n);
  const reply=raw.message_reference?.message_id;
  const replyId=reply?(store.statement('SELECT message_id FROM discord_remote WHERE channel_id=? AND remote_id=?').get(channel,reply)?.message_id||`discord:${channel}:${reply}`):'';
  const previous=store.statement('SELECT body FROM messages WHERE id=?').get(canonical);
  store.statement(`INSERT INTO messages(id,room_id,sender,ts,body,original_body,type,is_me,edited,stream,source_received,reply_to,media_url)
    VALUES(?,?,?,?,?,?,'discord.message',?,?,0,?,?,?) ON CONFLICT(id) DO UPDATE SET sender=excluded.sender,ts=excluded.ts,body=excluded.body,original_body=excluded.original_body,is_me=excluded.is_me,edited=excluded.edited,reply_to=excluded.reply_to,media_url=excluded.media_url`)
    .run(canonical,roomId,sender,ts,body,body,+store.selfIds.has(sender),+!!raw.edited_timestamp,fetchedAt,replyId,raw.attachments?.[0]?.url||'');
  store.statement(`INSERT INTO discord_remote VALUES(?,?,?,?,?,?,?) ON CONFLICT(channel_id,remote_id) DO UPDATE SET raw_json=excluded.raw_json,version=excluded.version,fetched_at=excluded.fetched_at`).run(channel,remote,roomId,canonical,JSON.stringify(raw),version,fetchedAt);
  store.statement('DELETE FROM edits WHERE target=?').run(canonical);
  if(!previous||previous.body!==body||links.length)store.touched.add(roomId);
}
export function deleteDiscord(store,roomId,remote){
  const room=store.room(roomId);if(!room||room.platform!=='discord')return;
  if(room.server_id&&(!room.connected||!room.tracked||!['S','SP','G','GP'].includes(room.discordPolicy?.treatment)))return;
  const old=store.statement('SELECT message_id FROM discord_remote WHERE channel_id=? AND remote_id=?').get(room.remote_id,remote);
  store.statement('INSERT OR IGNORE INTO discord_deleted VALUES(?,?)').run(room.remote_id,remote);
  if(old){store.redact(old.message_id,{direct:true});store.statement('DELETE FROM discord_remote WHERE channel_id=? AND remote_id=?').run(room.remote_id,remote);}
}
export function ensureHistoryJobs(store){
  store.statement(`INSERT INTO discord_history_jobs(room_id,channel_id) SELECT id,remote_id FROM conversations WHERE platform='discord' AND server_id='' AND kind IN ('dm','group') AND connected=1 AND tracked=1 AND source_joined=1 ON CONFLICT(room_id) DO NOTHING`).run();
}
export function historyPlans(store){return store.statement(`SELECT j.room_id room,j.channel_id channel,j.before_id before_id FROM discord_history_jobs j JOIN conversations c ON c.id=j.room_id WHERE j.complete=0 AND c.connected=1 AND c.tracked=1 AND c.source_joined=1 ORDER BY j.channel_id='100000000000000037' DESC,j.updated_at,j.channel_id`).all();}
export function applyHistoryPage(store,page){
  const room=store.room(page.room);if(!room?.connected||!room.tracked)return false;
  if(page.channel!==room.remote_id)throw new Error('History page channel mismatch');
  const checkpoint=store.statement('SELECT before_id FROM discord_history_jobs WHERE room_id=?').get(page.room);
  if(page.from_before!==undefined&&checkpoint?.before_id!==page.from_before){
    if(checkpoint?.before_id===page.before_id)return true;
    throw new Error('Stale history page checkpoint');
  }
  if(!page.error&&page.messages.some(raw=>raw.channel_id!==room.remote_id||!/^\d{16,22}$/.test(raw.id)))throw new Error('Invalid Discord history page');
  store.begin();
  try{
    if(page.error){store.statement('UPDATE discord_history_jobs SET error=?,updated_at=? WHERE room_id=?').run(page.error,Date.now(),page.room);}
    else{
      const byId=new Map();for(const l of page.links||[]){if(!byId.has(l.remote_id))byId.set(l.remote_id,[]);byId.get(l.remote_id).push(l);}
      for(const raw of page.messages)ingestDiscord(store,page.room,raw,byId.get(raw.id)||[],page.fetched_at);
      if(page.complete)for(const [id,links] of byId){
        if(page.messages.some(raw=>raw.id===id))continue;
        const row=store.statement('SELECT raw_json,fetched_at FROM discord_remote WHERE channel_id=? AND remote_id=?').get(page.channel,id);
        if(row)ingestDiscord(store,page.room,JSON.parse(row.raw_json),links,row.fetched_at);
      }
      store.statement('UPDATE discord_history_jobs SET before_id=?,fetched=fetched+?,complete=?,error=?,updated_at=? WHERE room_id=?').run(page.before_id,page.messages.length,+page.complete,'',Date.now(),page.room);
    }
    store.set('discord_history_revision',Date.now());store.commit();return true;
  }catch(e){store.rollback();throw e;}
}
export function historyStatus(store){return store.statement(`SELECT count(*) chats,coalesce(sum(complete),0) complete,coalesce(sum(fetched),0) fetched,coalesce(sum(error<>''),0) errors FROM discord_history_jobs`).get();}
