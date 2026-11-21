// Sources are durable request IDs, never model-selected destination channels.
export function ownerChannel(db,source,seen=new Set()){
 if(!source||seen.has(source)||seen.size>12)return '';seen.add(source);
 const get=(sql,...args)=>{try{return db.prepare(sql).get(...args);}catch{return null;}};
 for(const match of String(source).matchAll(/(?:^|:)(\d{16,22})(?=:|$)/g)){
  const row=get('SELECT channel FROM bot_turns WHERE id=?',match[1]);if(row)return row.channel;
 }
 let match=/^personal:([a-f0-9]{10}):/.exec(source);
 if(match){const d=get('SELECT owner_id FROM misty_message_drafts WHERE code=?',match[1]);return d?get('SELECT channel FROM bot_turns WHERE id=?',d.owner_id)?.channel||'':'';}
 match=/^draft:([a-f0-9]{10}):/.exec(source);
 if(match)return ownerChannel(db,get('SELECT source FROM relay_drafts WHERE code=?',match[1])?.source,seen);
 match=/^interaction:(\d{16,22})/.exec(source);
 if(match){const d=get('SELECT d.source FROM relay_interactions i JOIN relay_drafts d ON d.code=i.code WHERE i.id=?',match[1]);return ownerChannel(db,d?.source,seen);}
 match=/^(?:natural-result|result|work):([a-f0-9-]{36})(?=:|$)/.exec(source);
 if(match){
  const id=match[1],d=get('SELECT source FROM relay_drafts WHERE id=?',id);
  if(d)return ownerChannel(db,d.source,seen);
  const direct=get('SELECT owner_id FROM misty_direct_dispatch WHERE job_id=?',id);
  if(direct)return get('SELECT channel FROM bot_turns WHERE id=?',direct.owner_id)?.channel||'';
  const step=get('SELECT g.root_job FROM misty_work_steps s JOIN misty_work_grants g ON g.id=s.grant_id WHERE s.next_job=?',id);
  if(step)return ownerChannel(db,'work:'+step.root_job,seen);
 }
 match=/^work-pause:([a-f0-9]{10})/.exec(source);
 if(match){const g=get('SELECT root_job FROM misty_work_grants WHERE id=?',match[1]);return ownerChannel(db,g?'work:'+g.root_job:'',seen);}
 return ''; // Old notices and independent scheduled updates keep the primary owner DM.
}
