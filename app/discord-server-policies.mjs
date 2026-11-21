// The editable checklist is an explicit allowlist. Blank entries are undecided.
export function parseDiscordServerChoices(text,inventory){
 if(!Array.isArray(inventory?.servers)||inventory.complete!==true)throw Error('A complete current-membership inventory is required.');
 const known=new Map(inventory.servers.map(s=>[s.id,s])),seen=new Set(),choices=[];
 for(const [index,line] of text.split(/\r?\n/).entries()){
  if(!/^\s*\d+\.\s+\[/.test(line))continue;
  const match=line.match(/^\s*\d+\.\s+\[([^\]]*)\].*`(\d{16,22})`\s*$/);
  if(!match)throw Error(`Invalid checklist entry at line ${index+1}; retain its server ID.`);
  const treatment=match[1].trim().toUpperCase(),id=match[2];
  if(!['','G','GP','S','SP','I'].includes(treatment))throw Error(`Unknown label at line ${index+1}; use G, GP, S, SP or I.`);
  if(seen.has(id)||!known.has(id))throw Error(`Duplicate or unknown server ID at line ${index+1}.`);
  seen.add(id);choices.push({id,name:known.get(id).name,treatment});
 }
 if(!choices.length)throw Error('No server checklist entries found.');
 const counts={G:0,GP:0,S:0,SP:0,I:0,unassigned:inventory.servers.length-seen.size};
 for(const c of choices)counts[c.treatment||'unassigned']++;
 return {choices,counts};
}

import {serverSummarySchema} from './misty-server-summaries.mjs';

export function discordServerPolicySchema(db){db.exec(`CREATE TABLE IF NOT EXISTS discord_server_policies(
 server_id TEXT PRIMARY KEY,name TEXT NOT NULL,treatment TEXT NOT NULL CHECK(treatment IN ('G','GP','S','SP','I')),
 from_ts INTEGER NOT NULL,updated_at INTEGER NOT NULL
);`);}

export const discordSnowflakeAt=ts=>((BigInt(Math.max(1420070400000,ts))-1420070400000n)<<22n).toString();
export function addDiscordServerChannel(store,channel,now=Date.now()){
 if(!channel||!/^\d{16,22}$/.test(channel.id)||!/^\d{16,22}$/.test(channel.guild_id)||![0,5,10,11,12].includes(channel.type))return null;
 const policy=store.statement('SELECT * FROM discord_server_policies WHERE server_id=?').get(channel.guild_id);
 if(!policy||!['S','SP','G','GP'].includes(policy.treatment))return null;
 const group=['G','GP'].includes(policy.treatment),old=store.statement("SELECT * FROM conversations WHERE platform='discord' AND remote_id=? AND server_id=? AND kind<>'space'").get(channel.id,channel.guild_id);
 const id=old?.id||'discord:channel:'+channel.id,name=String(channel.name||old?.name||'Discord channel').slice(0,1024);
 store.statement(`INSERT INTO conversations(id,name,platform,kind,remote_id,server_id,server_name,connected,tracked,include_profile,updated_at)
 VALUES(?,?,'discord','channel',?,?,?,1,1,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,server_name=excluded.server_name,connected=1,tracked=1,source_joined=1,include_profile=excluded.include_profile,updated_at=excluded.updated_at`).run(id,name,channel.id,policy.server_id,policy.name,+group,now);
 if(group){
  store.statement('INSERT OR IGNORE INTO discord_history_jobs(room_id,channel_id) VALUES(?,?)').run(id,channel.id);
  store.statement(`INSERT OR IGNORE INTO native_discord_cursors(channel_id,after_id) VALUES(?,coalesce((SELECT max(remote_id) FROM discord_remote WHERE channel_id=?),''))`).run(channel.id,channel.id);
  store.statement("UPDATE misty_server_channels SET enabled=0 WHERE room_id=?").run(id);
  store.statement("INSERT INTO briefing_jobs(room_id) VALUES(?) ON CONFLICT(room_id) DO UPDATE SET enabled=1,status=CASE WHEN completed_revision=revision THEN status ELSE 'queued' END").run(id);
 }else{
  store.statement(`INSERT INTO misty_server_channels VALUES(?,?,?,?,?,1) ON CONFLICT(room_id) DO UPDATE SET server_name=excluded.server_name,channel_name=excluded.channel_name,from_ts=excluded.from_ts,enabled=1`).run(id,policy.server_id,policy.name,name,policy.from_ts);
  store.statement('INSERT OR IGNORE INTO native_discord_cursors(channel_id,after_id) VALUES(?,?)').run(channel.id,discordSnowflakeAt(policy.from_ts));
  // History checkpoints belong only to G/GP. Switching back later restarts available history.
  store.statement('DELETE FROM discord_history_jobs WHERE room_id=?').run(id);
  store.statement("UPDATE briefing_jobs SET enabled=0,status='paused' WHERE room_id=?").run(id);
 }
 return store.room(id);
}

export function configureDiscordServers(store,manifest,inventory,now=Date.now()){
 discordServerPolicySchema(store.db);serverSummarySchema(store.db);
 if(!inventory?.complete||!Array.isArray(manifest?.choices)||!Array.isArray(inventory?.servers))throw Error('Complete classification and channel metadata required.');
 const metadata=new Map(inventory.servers.map(g=>[g.id,g]));
 // Prepare and validate everything before changing the active allowlist.
 const seen=new Set();
 for(const p of manifest.choices){if(!/^\d{16,22}$/.test(p.id)||seen.has(p.id)||!['','G','GP','S','SP','I'].includes(p.treatment))throw Error('Invalid server classification.');seen.add(p.id);if(['G','GP','S','SP'].includes(p.treatment)&&!metadata.has(p.id))throw Error('Selected server is missing metadata.');}
 store.begin();try{
  store.statement("UPDATE conversations SET connected=0,tracked=0,include_profile=0 WHERE platform='discord' AND server_id<>''").run();
  store.statement("UPDATE misty_server_channels SET enabled=0 WHERE room_id IN (SELECT id FROM conversations WHERE platform='discord' AND server_id<>'')").run();
  store.statement("UPDATE briefing_jobs SET enabled=0,status='paused' WHERE room_id IN (SELECT id FROM conversations WHERE platform='discord' AND server_id<>'')").run();
  for(const p of manifest.choices){
   const previous=store.statement('SELECT * FROM discord_server_policies WHERE server_id=?').get(p.id),treatment=p.treatment||'I';
   const sameScope=previous&&(['S','SP'].includes(previous.treatment)&&['S','SP'].includes(treatment)||['G','GP'].includes(previous.treatment)&&['G','GP'].includes(treatment));
   const from=sameScope?previous.from_ts:now;
   store.statement('INSERT INTO discord_server_policies VALUES(?,?,?,?,?) ON CONFLICT(server_id) DO UPDATE SET name=excluded.name,treatment=excluded.treatment,from_ts=excluded.from_ts,updated_at=excluded.updated_at').run(p.id,p.name,treatment,from,now);
   if(!['S','SP','G','GP'].includes(treatment))continue;
   for(const channel of metadata.get(p.id).channels){
    if(channel.guild_id!==p.id)throw Error('Channel guild mismatch.');
    const room=addDiscordServerChannel(store,channel,now);
    if(room&&!sameScope&&['S','SP'].includes(treatment))store.statement('UPDATE native_discord_cursors SET after_id=?,updated_at=? WHERE channel_id=?').run(discordSnowflakeAt(from),now,channel.id);
   }
  }
  store.set('discord_server_classification',{at:now,counts:manifest.counts,source:manifest.source,metadataAt:inventory.at});
  store.commit();return manifest.counts;
 }catch(e){store.rollback();throw e;}
}

export function nativeDiscordServers(store){return store.statement("SELECT server_id id,treatment,from_ts FROM discord_server_policies WHERE treatment IN ('G','GP','S','SP')").all();}
export function nativeDiscordServerPlans(store){return store.statement(`SELECT c.remote_id id,c.server_id guild_id,p.treatment,p.from_ts,
 coalesce(k.after_id,'') after,CASE WHEN p.treatment IN ('G','GP') THEN coalesce(j.before_id,'') ELSE '' END before,
 CASE WHEN p.treatment IN ('G','GP') THEN coalesce(j.complete,0) ELSE 1 END complete
 FROM conversations c JOIN discord_server_policies p ON p.server_id=c.server_id
 LEFT JOIN native_discord_cursors k ON k.channel_id=c.remote_id LEFT JOIN discord_history_jobs j ON j.room_id=c.id
 WHERE c.platform='discord' AND c.kind='channel' AND c.connected=1 AND c.tracked=1 AND p.treatment IN ('S','SP','G','GP')`).all().map(p=>({...p,complete:!!p.complete}));}
