// Exact source mappings from the owner's original bridge, never fuzzy text matches.
import fs from 'node:fs';
import {ArchiveStore} from '../app/store.mjs';
import {ingestDiscord} from '../app/discord-history-store.mjs';
const [filename,linksFile]=process.argv.slice(2),links=JSON.parse(fs.readFileSync(linksFile,'utf8'));
const store=new ArchiveStore(filename);let accepted=0,reconciled=0;
try{
 store.begin();try{
  const pairs=new Map();
  for(const l of links){
   if(!/^\d{16,22}$/.test(l.channel)||!/^\d{16,22}$/.test(l.remote)||typeof l.event!=='string'||!l.event.startsWith('$')||l.event.length>600)throw Error('Invalid source link.');
   const room=store.statement("SELECT c.id FROM conversations c JOIN discord_server_policies p ON p.server_id=c.server_id WHERE c.platform='discord' AND c.remote_id=? AND c.connected=1 AND c.tracked=1 AND p.treatment IN ('G','GP')").get(l.channel);if(!room)continue;
   store.statement('INSERT OR IGNORE INTO discord_source_links VALUES(?,?,?)').run(l.channel,l.remote,l.event);accepted++;
   pairs.set(l.channel+':'+l.remote,{...l,room:room.id});
  }
  for(const l of pairs.values()){
   const existing=store.statement('SELECT raw_json,fetched_at FROM discord_remote WHERE channel_id=? AND remote_id=?').get(l.channel,l.remote);
   if(existing){ingestDiscord(store,l.room,JSON.parse(existing.raw_json),[],existing.fetched_at);reconciled++;}
  }
  store.commit();console.log(JSON.stringify({accepted,reconciled}));
 }catch(e){store.rollback();throw e;}
}finally{store.close();}
