import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { SELF_IDENTITIES, platformOf, cleanBody, classifyRoom } from './identity.mjs';
import {historySchema,historyStatus,ingestDiscord,deleteDiscord,resolveDiscordId} from './discord-history-store.mjs';
import {gmailSchema} from './gmail-store.mjs';
import {chatSchema,ingestChatStatus} from './chat-store.mjs';
import {briefingSchema} from './briefing-store.mjs';

export class ArchiveStore {
  constructor(filename) {
    this.filename=filename;
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations(
        id TEXT PRIMARY KEY,name TEXT NOT NULL,alias TEXT NOT NULL DEFAULT '',platform TEXT NOT NULL,kind TEXT NOT NULL,
        remote_id TEXT NOT NULL DEFAULT '',server_id TEXT NOT NULL DEFAULT '',server_name TEXT NOT NULL DEFAULT '',
        connected INTEGER NOT NULL DEFAULT 1,source_joined INTEGER NOT NULL DEFAULT 1,tracked INTEGER NOT NULL DEFAULT 1,
        followed INTEGER NOT NULL DEFAULT 0,include_profile INTEGER NOT NULL DEFAULT 1,encrypted INTEGER NOT NULL DEFAULT 0,
        message_count INTEGER NOT NULL DEFAULT 0,own_count INTEGER NOT NULL DEFAULT 0,
        first_ts INTEGER,last_ts INTEGER,last_preview TEXT NOT NULL DEFAULT '',updated_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS identities(id TEXT PRIMARY KEY,platform TEXT NOT NULL,remote_id TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL DEFAULT '',alias TEXT NOT NULL DEFAULT '',is_me INTEGER NOT NULL DEFAULT 0,verified INTEGER NOT NULL DEFAULT 0,source TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,room_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        sender TEXT NOT NULL REFERENCES identities(id),ts INTEGER NOT NULL,body TEXT NOT NULL,original_body TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'm.text',is_me INTEGER NOT NULL DEFAULT 0,edited INTEGER NOT NULL DEFAULT 0,stream INTEGER NOT NULL DEFAULT 0,
        source_received INTEGER,reply_to TEXT NOT NULL DEFAULT '',media_url TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS messages_room_ts ON messages(room_id,ts);
      CREATE INDEX IF NOT EXISTS messages_self ON messages(is_me,ts);
      CREATE INDEX IF NOT EXISTS messages_sender ON messages(sender);
      CREATE TABLE IF NOT EXISTS edits(id TEXT PRIMARY KEY,target TEXT NOT NULL,sender TEXT NOT NULL,body TEXT NOT NULL,ts INTEGER NOT NULL,stream INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS edits_target ON edits(target,ts);
      CREATE TABLE IF NOT EXISTS tombstones(id TEXT PRIMARY KEY);
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(body,content='messages',content_rowid='rowid',tokenize='unicode61');
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(rowid,body) VALUES(new.rowid,new.body); END;
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN INSERT INTO messages_fts(messages_fts,rowid,body) VALUES('delete',old.rowid,old.body); END;
      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF body ON messages BEGIN
        INSERT INTO messages_fts(messages_fts,rowid,body) VALUES('delete',old.rowid,old.body);
        INSERT INTO messages_fts(rowid,body) VALUES(new.rowid,new.body); END;
      CREATE TABLE IF NOT EXISTS profile_findings(id TEXT PRIMARY KEY,title TEXT NOT NULL,category TEXT NOT NULL,summary TEXT NOT NULL,
        confidence TEXT NOT NULL DEFAULT 'tentative',status TEXT NOT NULL DEFAULT 'suggested',source TEXT NOT NULL DEFAULT 'local',
        tags TEXT NOT NULL DEFAULT '[]',evidence_ids TEXT NOT NULL DEFAULT '[]',updated_at INTEGER NOT NULL);
    `);
    historySchema(this.db);
    gmailSchema(this.db);
    chatSchema(this.db);
    briefingSchema(this.db);
    this.cache = new Map();
    this.touched = new Set();
    for (const identity of SELF_IDENTITIES) {
      this.statement(`INSERT INTO identities(id,platform,remote_id,name,is_me,verified,source) VALUES(?,?,?,?,1,1,?) ON CONFLICT(id) DO NOTHING`)
        .run(identity.id,identity.platform,identity.remote,identity.name,identity.source);
    }
    this.refreshSelfIds();
  }

  statement(sql) { if (!this.cache.has(sql)) this.cache.set(sql,this.db.prepare(sql)); return this.cache.get(sql); }
  get(key, fallback = null) { const r=this.statement('SELECT value FROM settings WHERE key=?').get(key); return r ? JSON.parse(r.value) : fallback; }
  set(key,value) { this.statement('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value)); }
  refreshSelfIds() { this.selfIds = new Set(this.statement('SELECT id FROM identities WHERE is_me=1').all().map(r=>r.id)); }
  begin({dedupe=false}={}) {
    // Reserve the writer before any reads. A deferred WAL transaction cannot upgrade
    // its snapshot if the analysis worker commits between ingestion's read and write.
    this.db.exec('BEGIN IMMEDIATE'); this.touched.clear();
    this.existingIds=dedupe?new Set(this.statement('SELECT id FROM messages UNION ALL SELECT id FROM edits UNION ALL SELECT id FROM tombstones').all().map(r=>r.id)):null;
  }
  rollback() { this.db.exec('ROLLBACK'); this.touched.clear();this.existingIds=null; }
  commit() { this.refreshCounts(); this.db.exec('COMMIT');this.existingIds=null; }

  ingest(record) {
    if (record.kind==='room') {
      const state=record.state || {};
      const room=classifyRoom({ name:state['m.room.name']?.name,bridge:state['m.bridge'],create:state['m.room.create'],encrypted:state['m.room.encryption'] });
      if (room.management) {
        const match=(state['m.room.name']?.name || '').match(/^(Discord|WhatsApp|Instagram|Telegram) bridge$/i);
        if (match) this.set('bridge_room_'+match[1].toLowerCase(),record.id);
        return;
      }
      this.statement(`INSERT INTO conversations(id,name,platform,kind,remote_id,server_id,server_name,encrypted,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,platform=excluded.platform,kind=excluded.kind,
        remote_id=excluded.remote_id,server_id=excluded.server_id,server_name=excluded.server_name,encrypted=excluded.encrypted,source_joined=1,updated_at=excluded.updated_at`)
        .run(record.id,room.name,room.platform,room.kind,room.remoteId,room.serverId,room.serverName,+room.encrypted,Date.now());
    } else if (record.kind==='identity') {
      this.statement(`INSERT INTO identities(id,platform,name) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name WHERE excluded.name<>'' AND excluded.name<>identities.name`)
        .run(record.id,platformOf(record.id),record.name || '');
    } else if (record.kind==='redacted') this.redact(record.id);
    else if (record.kind==='event') {
      if(['m.room.message','m.sticker'].includes(record.event?.type) && this.existingIds?.has(record.event.event_id))return;
      this.ingestEvent(record.event,record.stream,record.received);
    }
    else if (record.kind==='watermark') { this.set('stream_cursor',record.cursor); this.set('source_message_events',record.messages); }
  }

  ingestEvent(event,stream=0,received=null) {
    if(ingestChatStatus(this,event,stream))return;
    const room=this.statement('SELECT connected,tracked FROM conversations WHERE id=?').get(event.room_id);
    if (!room || !room.connected || !room.tracked) return;
    if (event.type==='m.room.redaction') { this.redact(event.redacts || event.content?.redacts); return; }
    if (event.type==='m.room.encrypted') { this.statement('UPDATE conversations SET encrypted=1 WHERE id=?').run(event.room_id); return; }
    const trusted=event.sender==='@owner:localhost'||/^@discord_(?:\d+):localhost$/.test(event.sender)||event.sender==='@discordbot:localhost';
    if(event.type==='fi.mau.discord.history'&&trusted){
      const content=event.content||{};
      if(content.op==='upsert'&&content.message)ingestDiscord(this,event.room_id,content.message,[],received||Date.now());
      if(content.op==='delete')for(const id of content.ids||[])deleteDiscord(this,event.room_id,id);
      return;
    }
    if(event.content?.['fi.mau.discord.raw']&&trusted){ingestDiscord(this,event.room_id,event.content['fi.mau.discord.raw'],[{event_id:event.event_id}],received||Date.now());return;}
    if(this.statement('SELECT 1 FROM discord_matrix_links WHERE event_id=?').get(event.event_id))return;
    if (!['m.room.message','m.sticker'].includes(event.type) || this.statement('SELECT 1 FROM tombstones WHERE id=?').get(event.event_id)) return;
    const c=event.content || {};
    const replacement=c['m.relates_to']?.rel_type==='m.replace' ? c['m.relates_to'].event_id : null;
    if(replacement&&resolveDiscordId(this,replacement)!==replacement)return;
    if(replacement&&this.statement('SELECT 1 FROM discord_remote WHERE message_id=?').get(replacement))return;
    const body=cleanBody(replacement ? c['m.new_content']?.body || c.body : c.body) || (event.type==='m.sticker'?'[Sticker]':'[Message without text]');
    this.statement('INSERT INTO identities(id,platform,name) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING')
      .run(event.sender,platformOf(event.sender),event.sender);
    if (replacement) {
      this.statement('INSERT INTO edits(id,target,sender,body,ts,stream) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING')
        .run(event.event_id,replacement,event.sender,body,event.origin_server_ts || 0,stream);
      this.applyEdit(replacement);
      return;
    }
    this.statement(`INSERT INTO messages(id,room_id,sender,ts,body,original_body,type,is_me,stream,source_received,reply_to,media_url)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
      .run(event.event_id,event.room_id,event.sender,event.origin_server_ts || 0,body,body,event.type==='m.sticker'?'m.sticker':c.msgtype || 'm.text',+this.selfIds.has(event.sender),stream,received,
        c['m.relates_to']?.['m.in_reply_to']?.event_id || '',c.url || '');
    this.applyEdit(event.event_id);
    this.touched.add(event.room_id);
  }

  applyEdit(id) {
    const original=this.statement('SELECT sender,room_id,original_body,body,edited FROM messages WHERE id=?').get(id);
    if (!original) return;
    const edit=this.statement('SELECT body FROM edits WHERE target=? AND sender=? ORDER BY ts DESC,stream DESC LIMIT 1').get(id,original.sender);
    const body=edit?.body || original.original_body;
    if(body!==original.body || +!!edit!==original.edited) {
      this.statement('UPDATE messages SET body=?,edited=? WHERE id=?').run(body,+!!edit,id);
      this.touched.add(original.room_id);
    }
  }

  redact(id,{direct=false}={}) {
    if (!id) return;
    // Discord deltas carry whole-message deletes; native attachment redactions must not erase the whole archive entry.
    if(!direct&&this.statement('SELECT 1 FROM discord_matrix_links WHERE event_id=?').get(id))return;
    this.statement('INSERT INTO tombstones(id) VALUES(?) ON CONFLICT(id) DO NOTHING').run(id);
    const message=this.statement('SELECT room_id FROM messages WHERE id=?').get(id);
    if (message) this.touched.add(message.room_id);
    const edit=this.statement('SELECT target FROM edits WHERE id=?').get(id);
    this.statement('DELETE FROM messages WHERE id=?').run(id);
    this.statement('DELETE FROM edits WHERE id=?').run(id);
    if (edit) this.applyEdit(edit.target);
  }

  refreshCounts() {
    const statement=this.statement(`UPDATE conversations SET
      message_count=(SELECT count(*) FROM messages WHERE room_id=?),own_count=(SELECT count(*) FROM messages WHERE room_id=? AND is_me=1),
      first_ts=(SELECT min(ts) FROM messages WHERE room_id=?),last_ts=(SELECT max(ts) FROM messages WHERE room_id=?),
      last_preview=coalesce((SELECT substr(body,1,180) FROM messages WHERE room_id=? ORDER BY ts DESC LIMIT 1),'') WHERE id=?`);
    for (const id of this.touched) statement.run(id,id,id,id,id,id);
    this.touched.clear();
  }

  stats() {
    const messages=this.statement('SELECT count(*) total,sum(is_me) own,min(ts) first,max(ts) last FROM messages').get();
    const rooms=this.statement("SELECT count(*) total,sum(connected) connected,sum(tracked) tracked,sum(followed) followed,sum(own_count>0) participated FROM conversations WHERE kind<>'space'").get();
    return { messages,rooms,platforms:this.statement("SELECT platform,count(*) rooms,sum(message_count) messages,sum(own_count) own FROM conversations WHERE kind<>'space' GROUP BY platform").all(),
      sync:this.get('sync_status',{}),lastFullSync:this.get('last_full_sync',null),cursor:this.get('stream_cursor',0),sourceMessageEvents:this.get('source_message_events',0),history:historyStatus(this),historyRevision:this.get('discord_history_revision',0),gmailRevision:this.get('gmail_revision',0) };
  }

  listRooms({q='',platform='',kind='',view='',offset=0,limit=60}={}) {
    const conditions=["c.kind<>'space'"],args=[];
    if (q) { conditions.push('(c.name LIKE ? OR c.alias LIKE ? OR c.server_name LIKE ?)'); args.push(...Array(3).fill('%'+q+'%')); }
    if (platform) { conditions.push('c.platform=?'); args.push(platform); }
    if (kind==='groups') conditions.push("c.kind IN ('group','channel')");
    else if (kind) { conditions.push('c.kind=?'); args.push(kind); }
    if (view==='followed') conditions.push('c.followed=1');
    if (view==='participated') conditions.push('c.own_count>0');
    if (view==='disconnected') conditions.push('c.connected=0');
    const where=conditions.join(' AND ');
    const total=this.statement('SELECT count(*) count FROM conversations c WHERE '+where).get(...args).count;
    const rows=this.statement('SELECT c.* FROM conversations c WHERE '+where+' ORDER BY c.last_ts DESC,c.id LIMIT ? OFFSET ?').all(...args,limit,offset);
    return { rows,total,offset,limit };
  }

  room(id) { const r=this.statement('SELECT * FROM conversations WHERE id=?').get(id);if(r){r.history=this.statement('SELECT fetched,complete,error,updated_at FROM discord_history_jobs WHERE room_id=?').get(id)||null;if(r.platform==='discord'&&r.server_id)r.discordPolicy=this.statement('SELECT * FROM discord_server_policies WHERE server_id=?').get(r.server_id)||null;if(r.platform==='whatsapp'&&r.kind==='group')r.groupPolicy=this.statement('SELECT treatment,cutoff,continuous,import_state,phase,pages,recent_gap,error,updated_at FROM whatsapp_group_policies WHERE room_id=?').get(id)||null;}return r; }
  updateRoom(id,patch) {
    if (!this.room(id)) throw new Error('Conversation not found');
    const fields=[],args=[];
    for (const key of ['alias','connected','tracked','followed','include_profile']) if (key in patch) {
      fields.push(key+'=?'); args.push(key==='alias' ? String(patch[key]).slice(0,160) : +!!patch[key]);
    }
    if (fields.length) this.statement('UPDATE conversations SET '+fields.join(',')+' WHERE id=?').run(...args,id);
    return this.room(id);
  }

  updateIdentity(id,patch) {
    const identity=this.statement('SELECT * FROM identities WHERE id=?').get(id);
    if (!identity) throw new Error('Identity not found');
    const alias='alias' in patch ? String(patch.alias).slice(0,160) : identity.alias;
    const isMe='is_me' in patch ? +!!patch.is_me : identity.is_me;
    this.statement('UPDATE identities SET alias=?,is_me=? WHERE id=?').run(alias,isMe,id);
    this.statement('UPDATE messages SET is_me=? WHERE sender=?').run(isMe,id);
    for (const row of this.statement('SELECT DISTINCT room_id FROM messages WHERE sender=?').all(id)) this.touched.add(row.room_id);
    this.refreshSelfIds(); this.refreshCounts();
    return this.statement('SELECT * FROM identities WHERE id=?').get(id);
  }

  people(q='',offset=0,limit=60) {
    return this.statement(`SELECT i.*,count(m.id) message_count FROM identities i LEFT JOIN messages m ON m.sender=i.id
      WHERE i.is_me=1 OR ((i.name LIKE ? OR i.alias LIKE ? OR i.id LIKE ?) AND EXISTS(SELECT 1 FROM messages WHERE sender=i.id))
      GROUP BY i.id ORDER BY i.is_me DESC,message_count DESC LIMIT ? OFFSET ?`).all('%'+q+'%','%'+q+'%','%'+q+'%',limit,offset);
  }

  messages({room='',q='',own=false,before=null,before_id='',limit=80,offset=0}={}) {
    const conditions=[],args=[];
    if (room) {conditions.push('m.room_id=?');args.push(room);}
    if (own) conditions.push('m.is_me=1');
    if(before!==null&&before!==''){
      if(before_id){conditions.push('(m.ts,m.id)<(?,?)');args.push(Number(before),String(before_id));}
      else {conditions.push('m.ts<?');args.push(Number(before));}
    }
    const tokens=String(q).match(/[\p{L}\p{N}_]+/gu)?.slice(0,12) || [];
    if (tokens.length) {conditions.push('m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)');args.push(tokens.map(t=>'"'+t+'"*').join(' AND '));}
    const where=conditions.length ? ' WHERE '+conditions.join(' AND ') : '';
    const rows=this.statement(`SELECT m.id,m.room_id,m.sender,m.ts,m.body,m.type,m.is_me,m.edited,m.reply_to,m.media_url,coalesce(nullif(i.alias,''),nullif(i.name,''),m.sender) author,
      coalesce(nullif(c.alias,''),c.name) conversation,c.platform,c.server_name,
      coalesce(g.attachments_json,'[]') attachments_json,
      (SELECT json_group_array(part_key) FROM gmail_attachment_blobs WHERE message_id=m.id) stored_attachment_keys FROM messages m
      JOIN identities i ON i.id=m.sender JOIN conversations c ON c.id=m.room_id
      LEFT JOIN gmail_messages g ON g.message_id=m.id`+where+' ORDER BY m.ts DESC,m.id DESC LIMIT ? OFFSET ?').all(...args,limit,offset);
    return rows;
  }

  ownCorpus() {
    const excluded=new Set(this.get('profile_excluded_messages',[]).map(id=>resolveDiscordId(this,id)));
    return this.statement(`SELECT m.id,m.room_id,m.ts,CASE WHEN g.message_id IS NOT NULL THEN g.authored_text WHEN d.raw_json IS NOT NULL THEN coalesce(json_extract(d.raw_json,'$.content'),'') ELSE m.body END body,c.platform,c.kind,c.name conversation,c.server_name
      FROM messages m JOIN conversations c ON c.id=m.room_id LEFT JOIN discord_remote d ON d.message_id=m.id LEFT JOIN gmail_messages g ON g.message_id=m.id WHERE m.is_me=1 AND c.include_profile=1 ORDER BY m.ts`).all().filter(m=>!excluded.has(m.id));
  }

  evidence(id) {
    id=resolveDiscordId(this,id);
    const event=this.statement(`SELECT m.*,coalesce(nullif(i.alias,''),i.name) author,c.name conversation,c.platform,c.server_name
      FROM messages m JOIN identities i ON i.id=m.sender JOIN conversations c ON c.id=m.room_id WHERE m.id=?`).get(id);
    if (!event) return null;
    const context=this.statement(`SELECT m.id,m.room_id,m.sender,m.body,m.ts,m.is_me,coalesce(nullif(i.alias,''),i.name) author FROM messages m
      JOIN identities i ON i.id=m.sender WHERE m.room_id=? AND m.ts BETWEEN ? AND ? ORDER BY abs(m.ts-?) LIMIT 7`)
      .all(event.room_id,event.ts-20*60000,event.ts+20*60000,event.ts).sort((a,b)=>a.ts-b.ts);
    return {event,context};
  }

  saveFinding(finding) {
    const existing=this.statement('SELECT source FROM profile_findings WHERE id=?').get(finding.id);
    if(existing?.source==='user' && finding.source!=='user')return;
    this.statement(`INSERT INTO profile_findings(id,title,category,summary,confidence,status,source,tags,evidence_ids,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,category=excluded.category,summary=excluded.summary,
      confidence=excluded.confidence,tags=excluded.tags,evidence_ids=excluded.evidence_ids,updated_at=excluded.updated_at`)
      .run(finding.id,finding.title,finding.category,finding.summary,finding.confidence || 'tentative',finding.status || 'suggested',finding.source || 'local',
        JSON.stringify(finding.tags || []),JSON.stringify(finding.evidence_ids || []),Date.now());
  }

  updateFinding(id,patch) {
    const old=this.statement('SELECT * FROM profile_findings WHERE id=?').get(id);
    if(!old)throw new Error('Finding not found');
    const status=['suggested','confirmed','dismissed'].includes(patch.status)?patch.status:old.status;
    const summary=typeof patch.summary==='string'?patch.summary.slice(0,6000):old.summary;
    this.statement('UPDATE profile_findings SET status=?,summary=?,source=?,updated_at=? WHERE id=?')
      .run(status,summary,typeof patch.summary==='string'?'user':old.source,Date.now(),id);
    return {ok:true};
  }

  findings() {
    const allowed=new Set(this.ownCorpus().map(m=>m.id));
    return this.statement("SELECT * FROM profile_findings WHERE status<>'dismissed' ORDER BY category,title").all().map(f=>{
      const evidence=JSON.parse(f.evidence_ids).filter(id=>allowed.has(resolveDiscordId(this,id)));
      return {...f,tags:JSON.parse(f.tags),evidence_ids:evidence,evidence_count:evidence.length};
    }).filter(f=>f.evidence_count>0 || f.source==='user');
  }

  close() { this.db.close(); }
}
