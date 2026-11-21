import {createHash} from 'node:crypto';

const definition=(name,description,properties)=>({type:'function',name,description,strict:true,parameters:{type:'object',properties,required:Object.keys(properties),additionalProperties:false}});

// Visible updates share the durable, nonce-bound owner-DM outbox. They can flush
// while the main model is waiting on tools; the final reply remains a later turn.
export class MistyDialogue{
 constructor(relay){
  this.relay=relay;this.db=relay.db;
  this.db.exec("CREATE TABLE IF NOT EXISTS misty_job_announcements(job_id TEXT PRIMARY KEY,state TEXT NOT NULL DEFAULT 'queued');");
 }
 definitions(){return [
  definition('misty_say','Send a brief progress message to the owner NOW, then continue the tools/work and finish the answer. Use before a multi-step archive/code search or other noticeable work, and for a meaningful change of step. Write the concrete intended step, not a final answer, fake completion or filler. Conversation wording is composed in the owner style. Usually one update, at most three per owner request. This does not approve/execute code or send to anyone else.',{message:{type:'string'}}),
  ...(this.relay.archive?[definition('misty_quote','Retrieve a real original archive message and queue its exact unedited text for the owner. Choose this when they ask to see the actual wording, word for word, not merely a link or summary. Natural language decides when; no command phrase is required. Returns verified metadata for your conversational framing/link. Does not invent/complete truncated text.',{sourceId:{type:'string'}})]:[])
 ];}
 async say(row,message){
  if(typeof message!=='string'||!message.trim()||message.length>800)throw Error('Progress update must be brief.');
  if(!this.relay.messageApi)return {available:false,state:'unavailable',message:'Live owner-DM delivery is not connected.'};
  const hash=createHash('sha256').update(message).digest('hex').slice(0,20),source='progress:'+row.id+':'+hash;
  let notice=this.db.prepare('SELECT * FROM relay_notices WHERE source=?').get(source+':0');
  if(!notice){
   const count=this.db.prepare('SELECT count(*) n FROM relay_notices WHERE source LIKE ?').get('progress:'+row.id+':%').n;
   if(count>=3)return {state:'limit',message:'Continue the work and give the final answer; enough progress messages were sent.'};
   const original='The next step I am about to perform is: '+message;
   const reply=await this.relay.rephraser.present({source,kind:'progress',request:row.body,original,context:this.relay.rephraser.recent(row),maxLength:800,essentialFacts:[message]});
   this.relay.notice(source,reply);
  }
  // An existing flush can finish between our INSERT and its finalizer. After
  // joining it, flush again only if our update is still positively queued.
  for(let attempt=0;attempt<2;attempt++){
   await this.relay.sendNotices(this.relay.messageApi);
   notice=this.db.prepare('SELECT status,message_id FROM relay_notices WHERE source=?').get(source+':0');
   if(notice?.status!=='queued')break;
  }
  return {state:notice?.status==='sent'?'sent':'not_confirmed',messageId:notice?.message_id||'',meaning:'This was an update about the next step, not proof that work completed. Continue with the actual tools, then answer.'};
 }
 async quote(row,id){
  if(typeof id!=='string'||!id||id.length>600||!this.relay.archive)throw Error('Invalid source.');
  const source=await this.relay.archive.execute('archive_source',{id});
  if(!source.available)return source;
  if(typeof source.body!=='string'||!source.body.trim())return {...source,quoteQueued:false};
  let text=source.body,next=source.nextOffset,previous=0;
  for(let page=0;next!=null;page++){
   if(page>=30||!Number.isInteger(next)||next<=previous||text.length>160000)throw Error('Source exceeds quotation bounds.');
   const part=await this.relay.archive.execute('archive_source',{id,offset:next});
   if(!part.available||part.id!==source.id||part.bodyHash!==source.bodyHash||part.offset!==next)throw Error('Source changed while reading.');
   text+=part.body;previous=next;next=part.nextOffset;
  }
  const hash=createHash('sha256').update(source.id+'\n'+text).digest('hex').slice(0,24);
  this.relay.notice('quoted-source:'+row.id+':'+hash,text);
  return {...source,quoteQueued:true,exact:true,truncated:false,quotedCharacters:text.length,coverage:'Complete source text read with matching revision hashes, queued unedited.'};
 }
 started(jobId){this.db.prepare('INSERT OR IGNORE INTO misty_job_announcements(job_id) VALUES(?)').run(jobId);}
 async tick(){
  const job=this.db.prepare("SELECT j.* FROM misty_job_announcements a JOIN relay_jobs j ON j.id=a.job_id WHERE a.state='queued' ORDER BY j.updated LIMIT 1").get();
  if(!job)return;
  if(job.status!=='running'){this.db.prepare("UPDATE misty_job_announcements SET state='skipped' WHERE job_id=?").run(job.id);return;}
  try{
   const reply=await this.relay.rephraser.present({source:'job-started:'+job.id,kind:'codex_started',request:job.prompt,original:'The owner-approved Codex task is now confirmed running in its selected chat. Its result is not available yet; I will follow up here when it finishes.',context:this.relay.rephraser.recent(),maxLength:800});
   this.relay.transaction(()=>{
    if(this.db.prepare('SELECT status FROM relay_jobs WHERE id=?').get(job.id)?.status==='running'){
     this.relay.notice('job-started:'+job.id,reply);this.db.prepare("UPDATE misty_job_announcements SET state='queued_notice' WHERE job_id=?").run(job.id);
    }else this.db.prepare("UPDATE misty_job_announcements SET state='skipped' WHERE job_id=?").run(job.id);
   });
   if(this.relay.messageApi)await this.relay.sendNotices(this.relay.messageApi);
  }catch{/* Keep the event queued; original work continues independently. */}
 }
 execute(name,args,row){
  if(name==='misty_say')return this.say(row,args.message);
  if(name==='misty_quote')return this.quote(row,args.sourceId);
  throw Error('Unknown conversation tool.');
 }
}
