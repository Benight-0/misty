export const groupJID=id=>typeof id==='string'&&/^\d+(?:-\d+)?@g\.us$/.test(id);

export function whatsappGroupSchema(db){db.exec(`CREATE TABLE IF NOT EXISTS whatsapp_group_policies(
 chat_id TEXT PRIMARY KEY,name TEXT NOT NULL,treatment TEXT NOT NULL CHECK(treatment IN ('G','S','I')),
 room_id TEXT REFERENCES conversations(id),cutoff INTEGER NOT NULL,continuous INTEGER NOT NULL DEFAULT 0 CHECK(continuous=0),
 import_state TEXT NOT NULL DEFAULT 'inactive',phase TEXT NOT NULL DEFAULT 'recent',before_id TEXT NOT NULL DEFAULT '',
 before_ts INTEGER NOT NULL DEFAULT 0,before_me INTEGER NOT NULL DEFAULT 0,pages INTEGER NOT NULL DEFAULT 0,
 known_id TEXT NOT NULL DEFAULT '',known_ts INTEGER NOT NULL DEFAULT 0,known_me INTEGER NOT NULL DEFAULT 0,
 recent_gap INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '',updated_at INTEGER NOT NULL DEFAULT 0
);`);}

export function configureWhatsAppGroups(store,manifest){
 if(!manifest||manifest.continuousTracking!==false||!Number.isSafeInteger(manifest.cutoff)||!Array.isArray(manifest.choices))throw new Error('Invalid historical group choices.');
 const seen=new Set(),inventory=new Map((store.get('whatsapp_group_inventory',{}).groups||[]).map(g=>[g.id,g]));
 for(const choice of manifest.choices){
  if(!choice||!groupJID(choice.id)||seen.has(choice.id)||typeof choice.name!=='string'||!['','G','S','I'].includes(choice.treatment))throw new Error('Invalid or duplicate group choice.');
  seen.add(choice.id);
  if(choice.treatment&&(!inventory.has(choice.id)||inventory.get(choice.id).community))throw new Error('Classify a current group chat, not its community container.');
 }
 store.begin();
 try{
  const counts={G:0,S:0,I:0,unassigned:0};
  for(const choice of manifest.choices){
   if(!choice.treatment){counts.unassigned++;continue;}counts[choice.treatment]++;
   const previous=store.statement('SELECT * FROM whatsapp_group_policies WHERE chat_id=?').get(choice.id);
   if(previous&&previous.treatment===choice.treatment&&previous.cutoff===manifest.cutoff)continue;
   const matches=store.statement("SELECT * FROM conversations WHERE platform='whatsapp' AND kind='group' AND remote_id=?").all(choice.id);
   if(matches.length>1)throw new Error('Group has duplicate archived conversations; resolve before import.');
   let room=matches[0];
   if(choice.treatment==='G'&&!room){
    const id='whatsapp:group:'+choice.id;
    store.statement("INSERT INTO conversations(id,name,platform,kind,remote_id,connected,tracked,include_profile,updated_at) VALUES(?,?,'whatsapp','group',?,1,0,1,?)").run(id,choice.name,choice.id,Date.now());
    room=store.statement('SELECT * FROM conversations WHERE id=?').get(id);
   }
   if(room)store.statement('UPDATE conversations SET connected=?,tracked=0,include_profile=?,name=? WHERE id=?').run(+(choice.treatment==='G'),+(choice.treatment==='G'),choice.name,room.id);
   store.statement(`INSERT INTO whatsapp_group_policies(chat_id,name,treatment,room_id,cutoff,import_state,before_ts,updated_at)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET name=excluded.name,treatment=excluded.treatment,room_id=excluded.room_id,
    cutoff=excluded.cutoff,import_state=excluded.import_state,phase='recent',before_id='',before_ts=excluded.before_ts,pages=0,error='',updated_at=excluded.updated_at`)
    .run(choice.id,choice.name,choice.treatment,room?.id||null,manifest.cutoff,choice.treatment==='G'?'queued':'inactive',manifest.cutoff,Date.now());
   if(room&&choice.treatment==='G'){
    if(room.message_count>0)store.statement(`INSERT INTO briefing_jobs(room_id,force) VALUES(?,3)
     ON CONFLICT(room_id) DO UPDATE SET enabled=1,force=3,revision=revision+1,status='queued',not_before=0,error=''`).run(room.id);
    else store.statement("UPDATE briefing_jobs SET enabled=1,status='queued' WHERE room_id=?").run(room.id);
   }else if(room)store.statement("UPDATE briefing_jobs SET enabled=0,status='paused' WHERE room_id=?").run(room.id);
  }
  store.set('whatsapp_group_classification',{source:manifest.source,cutoff:manifest.cutoff,continuousTracking:false,counts,serverPolicy:{rawRetentionHours:24,previousContext:false,active:false}});
  store.commit();return counts;
 }catch(error){store.rollback();throw error;}
}

export function whatsappGroupPlans(store){return store.statement(`SELECT chat_id id,cutoff,phase,before_id before,before_ts at,before_me from_me,pages,known_id,known_ts,known_me,recent_gap
 FROM whatsapp_group_policies WHERE treatment='G' AND import_state IN ('queued','requesting','downloading','retrying') ORDER BY chat_id`).all().map(g=>({...g,from_me:!!g.from_me,known_me:!!g.known_me,recent_gap:!!g.recent_gap}));}

export function historyGroupRoom(store,event){
 if(!groupJID(event.chat)||!Number.isSafeInteger(event.at)||event.at<=0)return null;
 const policy=store.statement("SELECT * FROM whatsapp_group_policies WHERE chat_id=? AND treatment='G'").get(event.chat);
 if(!policy||event.at>policy.cutoff)return null;
 return store.room(policy.room_id);
}

export function groupImportStatus(store,event){
 const states=['requesting','downloading','retrying','available_exhausted','phone_unavailable','request_failed'];
 const policy=store.statement("SELECT * FROM whatsapp_group_policies WHERE chat_id=? AND treatment='G'").get(event.chat);
 if(!policy||!states.includes(event.state)||!['recent','older'].includes(event.phase)||typeof event.before!=='string'||event.before.length>200||!Number.isSafeInteger(event.at)||event.at>policy.cutoff||!Number.isSafeInteger(event.pages)||event.pages<0)throw new Error('Invalid group import progress.');
 const overlap=policy.phase==='recent'&&event.phase==='older'&&!event.recent_gap&&policy.known_ts>0&&event.at<=policy.known_ts&&event.pages>policy.pages;
 store.statement(`UPDATE whatsapp_group_policies SET import_state=?,phase=?,before_id=?,before_ts=?,before_me=?,pages=?,recent_gap=CASE WHEN ? THEN 0 ELSE max(recent_gap,?) END,error=?,updated_at=? WHERE chat_id=?`)
  .run(event.state,event.phase,event.before,event.at,+!!event.from_me,event.pages,+overlap,+!!event.recent_gap,event.state==='phone_unavailable'?'Phone did not return the requested history.':event.state==='request_failed'?'WhatsApp history request failed.':'',Date.now(),event.chat);
}
