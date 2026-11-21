export function chatSchema(db){db.exec(`
  CREATE TABLE IF NOT EXISTS chat_outgoing(
    id TEXT PRIMARY KEY,room_id TEXT NOT NULL REFERENCES conversations(id),platform TEXT NOT NULL,body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'sending',event_id TEXT NOT NULL DEFAULT '',error TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS chat_outgoing_event ON chat_outgoing(event_id);
  CREATE TABLE IF NOT EXISTS chat_delivery(
    room_id TEXT NOT NULL,event_id TEXT NOT NULL,status TEXT NOT NULL,error TEXT NOT NULL,stream INTEGER NOT NULL,
    PRIMARY KEY(room_id,event_id));
`);
 // Additive journal fields: old private-chat receipts remain valid. Rollback must
 // retain this journal, never restore an old database over current submissions.
 const columns=new Set(db.prepare('PRAGMA table_info(chat_outgoing)').all().map(c=>c.name));
 for(const name of ['target_json','guild_id','channel_id','reply_id','post_url'])if(!columns.has(name))db.exec(`ALTER TABLE chat_outgoing ADD COLUMN ${name} TEXT NOT NULL DEFAULT ''`);
}

export function reconcileChatStatus(store,id) {
  const row=store.statement('SELECT * FROM chat_outgoing WHERE id=?').get(id);
  if(!row?.event_id)return;
  const delivery=store.statement('SELECT * FROM chat_delivery WHERE room_id=? AND event_id=?').get(row.room_id,row.event_id);
  if(!delivery)return;
  const status=delivery.status==='SUCCESS'?'sent':delivery.status==='FAIL_PERMANENT'?'failed':'pending';
  store.statement('UPDATE chat_outgoing SET status=?,error=?,updated_at=? WHERE id=?').run(status,delivery.error,Date.now(),id);
}

export function ingestChatStatus(store,event,stream=0) {
  if(event.type!=='com.beeper.message_send_status')return false;
  const room=store.room(event.room_id);if(!room || !['discord','whatsapp'].includes(room.platform))return true;
  const bot='@'+room.platform+'bot:localhost';
  const ghost=room.platform==='discord'?/^@discord_\d+:localhost$/:/^@whatsapp_[\w-]+:localhost$/;
  if(event.sender!==bot&&!ghost.test(event.sender||''))return true;
  const content=event.content||{},target=content['m.relates_to']?.event_id;
  if(typeof target!=='string'||!target.startsWith('$')||!['SUCCESS','PENDING','FAIL_RETRIABLE','FAIL_PERMANENT'].includes(content.status))return true;
  // Never expose bridge internal_error/raw error strings, which can contain private implementation details.
  const message=content.status==='SUCCESS'?'':String(content.message||{
    'm.no_permission':'The remote service denied permission to send here.',
    'm.bridge_unavailable':'The bridge connection is unavailable.',
    'm.foreign_network_error':'The bridge reported a network problem.',
    'com.beeper.unsupported_event':'The bridge does not support this message.'
  }[content.reason]||'The bridge has not confirmed this message. Check the native app before sending another copy.').slice(0,600);
  const old=store.statement('SELECT * FROM chat_delivery WHERE room_id=? AND event_id=?').get(event.room_id,target);
  if(old&&(old.stream>stream||old.status==='SUCCESS'&&content.status!=='SUCCESS'))return true;
  store.statement(`INSERT INTO chat_delivery(room_id,event_id,status,error,stream) VALUES(?,?,?,?,?)
    ON CONFLICT(room_id,event_id) DO UPDATE SET status=excluded.status,error=excluded.error,stream=excluded.stream`)
    .run(event.room_id,target,content.status,message,stream);
  for(const row of store.statement('SELECT id FROM chat_outgoing WHERE room_id=? AND event_id=?').all(event.room_id,target))reconcileChatStatus(store,row.id);
  return true;
}
