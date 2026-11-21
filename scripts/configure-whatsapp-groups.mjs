import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {ArchiveStore} from '../app/store.mjs';
import {nativeSchema} from '../app/native-ingest.mjs';
import {configureWhatsAppGroups} from '../app/whatsapp-groups.mjs';

const [manifestPath,archivePath='/var/lib/archival/data/archive.sqlite',sessionPath='/var/lib/archival/whatsapp.sqlite']=process.argv.slice(2);
if(!manifestPath)throw new Error('Supply the reviewed G/S/I manifest.');
const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
const store=new ArchiveStore(archivePath);nativeSchema(store);
try{
 const counts=configureWhatsAppGroups(store,manifest);
 const bridge=new DatabaseSync(sessionPath,{readOnly:true});
 try{
  store.begin();
  try{
   for(const group of store.statement("SELECT * FROM whatsapp_group_policies WHERE treatment='G'").all()){
    const links=bridge.prepare("SELECT id,mxid FROM message WHERE room_id=? ORDER BY timestamp,part_id").all(group.chat_id);
    for(const link of links){
     const remote=link.id.split(':').at(-1);
     if(!remote||!store.statement('SELECT 1 FROM messages WHERE id=? AND room_id=?').get(link.mxid,group.room_id))continue;
     store.statement("INSERT OR IGNORE INTO native_message_links(platform,chat_id,remote_id,message_id) VALUES('whatsapp',?,?,?)").run(group.chat_id,remote,link.mxid);
    }
    const oldest=store.statement(`SELECT m.ts,m.is_me,l.remote_id FROM messages m JOIN native_message_links l ON l.message_id=m.id
     WHERE l.platform='whatsapp' AND l.chat_id=? AND m.room_id=? ORDER BY m.ts,l.remote_id LIMIT 1`).get(group.chat_id,group.room_id);
    if(oldest)store.statement('UPDATE whatsapp_group_policies SET known_id=?,known_ts=?,known_me=? WHERE chat_id=?').run(oldest.remote_id,oldest.ts,oldest.is_me,group.chat_id);
   }
   store.commit();
  }catch(error){store.rollback();throw error;}
 }finally{bridge.close();}
 console.log(JSON.stringify({counts,continuousTracking:false,groups:store.statement("SELECT p.name,c.message_count,p.import_state FROM whatsapp_group_policies p JOIN conversations c ON c.id=p.room_id WHERE p.treatment='G'").all()}));
}finally{store.close();}
