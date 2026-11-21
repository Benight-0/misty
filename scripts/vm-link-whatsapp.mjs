import {DatabaseSync} from 'node:sqlite';
import {ArchiveStore} from '../app/store.mjs';
import {nativeSchema,nativePlans} from '../app/native-ingest.mjs';
const store=new ArchiveStore('/var/lib/archival/data/archive.sqlite');nativeSchema(store);nativePlans(store);
const legacy=new DatabaseSync('/var/lib/archival/whatsapp.sqlite',{readOnly:true});
store.begin();let count=0;
try{
 for(const row of legacy.prepare('SELECT id,mxid,room_id FROM message').iterate()){
  const message=store.statement("SELECT m.id,c.id room_id,c.remote_id FROM messages m JOIN conversations c ON c.id=m.room_id WHERE m.id=? AND c.platform='whatsapp' AND c.kind='dm'").get(row.mxid);
  if(!message)continue;
  // mautrix remote IDs contain the chat/sender JIDs followed by the native ID.
  const remote=row.id.includes(':')?row.id.slice(row.id.lastIndexOf(':')+1):row.id;
  if(!remote)continue;
  store.statement("INSERT OR IGNORE INTO native_message_links VALUES('whatsapp',?,?,?)").run(message.remote_id,remote,message.id);
  store.statement("INSERT OR IGNORE INTO native_chat_aliases VALUES('whatsapp',?,?)").run(message.remote_id,message.room_id);count++;
 }
 store.commit();
}catch(error){store.rollback();throw error;}
console.log('Legacy WhatsApp message IDs linked:',count);
console.log('WhatsApp identifier format sample:',legacy.prepare('SELECT id,room_id FROM message LIMIT 1').get());
legacy.close();store.close();
