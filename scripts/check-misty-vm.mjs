// Read-only production profile checks; never print chat text or account IDs.
import {DatabaseSync} from 'node:sqlite';
import {ArchiveStore} from '/opt/archival/app/store.mjs';
import {Briefings} from '/opt/archival/app/briefings.mjs';
import {personProfile,roomMembers} from '/opt/archival/app/person-profile.mjs';
import fs from 'node:fs';
const db=new DatabaseSync('/var/lib/archival/data/archive.sqlite',{readOnly:true});
const store=Object.create(ArchiveStore.prototype);store.db=db;store.cache=new Map();
const briefings=Object.create(Briefings.prototype);briefings.store=store;briefings.model='gpt-5.6-luna';briefings.seed=()=>{};
for(const platform of ['discord','whatsapp']){
 const room=store.statement("SELECT id FROM conversations WHERE platform=? AND connected=1 AND kind='dm' ORDER BY last_ts DESC LIMIT 1").get(platform);
 const start=performance.now(),members=roomMembers(store,room.id),person=members.rows.find(p=>!p.is_me)||members.rows[0],profile=personProfile(store,briefings,person.id,{room:room.id});
 if(!profile.chats.length||profile.chats[0].room.id!==room.id)throw Error('Profile did not include the selected shared chat.');
 console.log(JSON.stringify({platform,members:members.total,sharedChats:profile.total,loadedChats:profile.chats.length,savedProfiles:profile.chats.filter(c=>c.person).length,milliseconds:Math.round(performance.now()-start)}));
}
for(const asset of ['index.html','app.js','misty.js','misty.css','briefings.js']){
 const content=fs.readFileSync('/opt/archival/app/public/'+asset,'utf8');
 if(asset==='index.html'&&!content.includes('<title>Misty'))throw Error('Old branding still served');
 console.log('Deployed asset:',asset,Buffer.byteLength(content),'bytes');
}
db.close();
