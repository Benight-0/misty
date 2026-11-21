// Read-only timings. Output contains counts/timings only, never chat content.
import {DatabaseSync} from 'node:sqlite';
import {ArchiveStore} from '/opt/archival/app/store.mjs';
import {conversationFit} from '/opt/archival/app/analysis.mjs';
import {roomMembers} from '/opt/archival/app/person-profile.mjs';
const db=new DatabaseSync('/var/lib/archival/data/archive.sqlite',{readOnly:true});
const s=Object.create(ArchiveStore.prototype);s.db=db;s.cache=new Map();
function timed(name,fn){const start=performance.now();const result=fn();console.log(JSON.stringify({operation:name,ms:Math.round(performance.now()-start),rows:Array.isArray(result)?result.length:undefined}));return result;}
for(const platform of ['discord','whatsapp']){
 const id=s.statement("SELECT id FROM conversations WHERE platform=? AND connected=1 AND kind='dm' ORDER BY last_ts DESC LIMIT 1").get(platform).id;
 console.log(JSON.stringify({platform}));timed('room metadata',()=>s.room(id));timed('latest 80 messages',()=>s.messages({room:id}));timed('member list',()=>roomMembers(s,id));
 timed('new bundled chat response with serialization',()=>JSON.stringify({room:s.room(id),fit:null,messages:s.messages({room:id})}));
 if(!process.argv.includes('--fast-only'))timed('old room fit calculation',()=>conversationFit(s,id));
}
db.close();
