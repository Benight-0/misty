import {safePublicSourceLink} from './owner-config.mjs';
import {createHash} from 'node:crypto';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json=(value,fallback)=>{try{return JSON.parse(value);}catch{return fallback;}};
const clip=(value,size=1600)=>String(value||'').slice(0,size);
const table=(db,name)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const safeLink=value=>safePublicSourceLink(value)?value:'';

export function inboxRange(range='recent',since=0,before=0,now=Date.now()){
 if(!['recent','today','yesterday','since_yesterday','custom'].includes(range))throw Error('Unknown time range.');
 if(![since,before,now].every(Number.isSafeInteger)||since<0||before<0)throw Error('Invalid time range.');
 const day=86400000,offset=19800000,today=Math.floor((now+offset)/day)*day-offset;
 return {since:since||(['today'].includes(range)?today:['yesterday','since_yesterday'].includes(range)?today-day:range==='custom'?0:now-7*day),
         before:before||(range==='yesterday'?today:now+1),timezone:'Asia/Kolkata'};
}

export class ApolloInbox{
 constructor(store,archive,{clock=Date.now}={}){
  this.store=store;this.db=store.db;this.archive=archive;this.clock=clock;
  this.db.exec(`CREATE TABLE IF NOT EXISTS apollo_findings(
   seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,fingerprint TEXT UNIQUE NOT NULL,
   kind TEXT NOT NULL,room_id TEXT NOT NULL,topic TEXT NOT NULL,event_from INTEGER NOT NULL,event_to INTEGER NOT NULL,
   saved_at INTEGER NOT NULL,summary TEXT NOT NULL,reason TEXT NOT NULL,metadata TEXT NOT NULL,sources TEXT NOT NULL,provenance TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS apollo_findings_time ON apollo_findings(event_to,seq);
   CREATE TABLE IF NOT EXISTS apollo_inbox_reads(turn_id TEXT PRIMARY KEY,at INTEGER NOT NULL,ids TEXT NOT NULL,shown_at INTEGER);`);
  this.store.set('apollo_delivery_mode','store_only');
 }
 insert(item){
  const result=this.db.prepare('INSERT OR IGNORE INTO apollo_findings(id,fingerprint,kind,room_id,topic,event_from,event_to,saved_at,summary,reason,metadata,sources,provenance) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
   item.id,item.fingerprint,item.kind,item.room||'',clip(item.topic,160),item.from,item.to,this.clock(),clip(item.summary,6500),clip(item.reason,1200),JSON.stringify(item.metadata||{}),JSON.stringify(item.sources||[]),JSON.stringify(item.provenance||{}));
  return !!result.changes;
 }
 saveWatch(job,decision,links=[]){
  const events=json(job.events,[]);if(!events.length||events.some(e=>e.treatment==='I'))return false;
  const last=events.at(-1),ids=[...new Set(decision.sources||[])],proof=decision.provenance||{};
  const sources=ids.map(id=>({id,savedUrl:safeLink(links.find(s=>s.id===id)?.url),bodyHash:proof.sourceHashes?.[id]||'',verifiedAt:proof.checkedAt||null}));
  return this.insert({id:'watch:'+job.id,fingerprint:digest([job.room_id,ids.slice().sort(),sources.map(s=>s.bodyHash)]),kind:'discussion',room:job.room_id,
   topic:decision.topic,from:Math.min(...events.map(e=>e.ts)),to:Math.max(...events.map(e=>e.ts)),summary:decision.message,reason:decision.reason,
   sources,metadata:{platform:last.platform,roomName:proof.chat?.name||last.name||'',server:proof.chat?.server_name||last.server_name||'',serverId:proof.chat?.server_id||last.server_id||'',watchKind:job.kind,treatment:proof.chat?.treatment||last.treatment||'',priority:decision.notificationPriority||'normal',category:decision.category||'update',coverage:proof.coverage||null},
   provenance:{jobId:job.id,eventSeqs:events.map(e=>e.seq),selectedAt:job.created,checkedAt:proof.checkedAt||null,deliveryReceipts:proof.deliveryReceipts||[],deliveryMode:'store_only',originals:'May expire under existing chat retention; summary is not a permanent raw archive.'}});
 }
 saveCodex(event,body,deliveryMode='store_only'){
  return this.insert({id:'codex:'+event.id,fingerprint:digest(['codex',event.id]),kind:'codex',room:'',topic:'codex:'+event.thread_id,
   from:Number(event.at||event.ts)||this.clock(),to:Number(event.at||event.ts)||this.clock(),summary:body,reason:deliveryMode==='live_codex'?'Visible Codex update authorized for live owner delivery.':'Saved visible Codex activity; no unsolicited delivery.',
   sources:[],metadata:{threadId:event.thread_id,title:clip(event.title,180),eventKind:event.kind},provenance:{eventId:event.id,eventSeq:event.seq,turnId:event.turn_id||'',deliveryMode,originals:'Read current synced transcript on request; not proof of successful implementation.'}});
 }
 saveNotice(source,body,status='queued',messageId=''){
  const base=source.replace(/:\d{1,4}$/,'');
  return this.insert({id:'notice:'+source,fingerprint:digest(['notice',source]),kind:source.startsWith('codex:')?'codex':source.startsWith('watch:')?'discussion':'notice',room:'',topic:base,
   from:this.clock(),to:this.clock(),summary:body,reason:'Preserved existing notice without retrying delivery.',sources:[],
   metadata:{legacy:true,eventTimeUnknown:true},provenance:{noticeSource:source,originalDeliveryStatus:status,originalMessageId:messageId,deliveryMode:'store_only',originals:'Legacy notice may lack retained original evidence.'}});
 }
 migrate(){
  if(!this.store.get('apollo_inbox_migrated',false)){
   if(table(this.db,'misty_watch_jobs'))for(const job of this.db.prepare("SELECT * FROM misty_watch_jobs WHERE state='done' AND json_valid(decision) AND json_extract(decision,'$.notify')=1").all()){
    const receipts=this.db.prepare('SELECT status,message_id,body FROM relay_notices WHERE source GLOB ? ORDER BY seq').all('watch:'+job.id+':*');
    const decision=json(job.decision,{}),urls=[...receipts.map(r=>r.body).join('').matchAll(/\]\((https:\/\/[^\s)]+)\)/g)].map(m=>safeLink(m[1])).filter(Boolean);
    decision.provenance={...decision.provenance,deliveryReceipts:receipts.map(({status,message_id})=>({status,message_id}))};
    this.saveWatch(job,decision,(decision.sources||[]).slice(0,urls.length).map((id,i)=>({id,url:urls[i]})));
   }
   // Historical sent/unknown receipts stay untouched. Keep a provenance copy.
   for(const row of this.db.prepare("SELECT * FROM relay_notices WHERE source NOT LIKE 'answer:%' AND source NOT LIKE 'progress:%'").all()){
    if(row.source.startsWith('watch:')&&this.db.prepare('SELECT 1 FROM apollo_findings WHERE id=?').get(row.source.replace(/:\d{1,4}$/, '')))continue;
    this.saveNotice(row.source,row.body,row.status,row.message_id);
   }
   this.store.set('apollo_inbox_migrated',true);
  }
 }
 prepareRead(turn,ids){this.db.prepare('INSERT OR REPLACE INTO apollo_inbox_reads(turn_id,at,ids) VALUES(?,?,?)').run(turn,this.clock(),JSON.stringify([...new Set(ids)].slice(0,60)));}
 shown(turn){this.db.prepare('UPDATE apollo_inbox_reads SET shown_at=coalesce(shown_at,?) WHERE turn_id=?').run(this.clock(),turn);}
 lastContext(){const row=this.db.prepare('SELECT turn_id,shown_at,ids FROM apollo_inbox_reads WHERE shown_at IS NOT NULL AND json_array_length(ids)>0 ORDER BY shown_at DESC LIMIT 1').get();return row?{...row,ids:json(row.ids,[])}:null;}
 decode(row){if(!row)return null;return {...row,metadata:json(row.metadata,{}),sources:json(row.sources,[]),provenance:json(row.provenance,{})};}
 async eligible(item,policies=new Map()){
  if(item.kind!=='discussion')return true;
  if(!item.room_id)return false; // Legacy provenance cannot establish current selection.
  const key=item.room_id+':'+item.metadata.watchKind;if(policies.has(key))return policies.get(key);
  const ids=item.sources.map(s=>s.id).slice(0,50);if(!ids.length)return false;
  const policy=await this.archive.read('watch_context',{room:item.room_id,kind:item.metadata.watchKind,ids});
  const eligible=policy.eligible===true;policies.set(key,eligible);return eligible;
 }
 publicItem(item){
  const shown=this.db.prepare("SELECT max(shown_at) at FROM apollo_inbox_reads WHERE shown_at IS NOT NULL AND EXISTS(SELECT 1 FROM json_each(ids) WHERE value=?)").get(item.id)?.at||null;
  return {id:item.id,kind:item.kind,room:item.room_id,topic:item.topic,eventFrom:item.event_from,eventTo:item.event_to,savedAt:item.saved_at,summary:item.summary,reason:item.reason,
   ...item.metadata,sources:item.sources.map(s=>({id:s.id,sourceStatus:'not_rechecked_may_have_expired'})),provenance:item.provenance,shownAt:shown,
   newToOwner:!shown&&!item.provenance.deliveryReceipts?.some(r=>r.status==='sent')&&item.provenance.originalDeliveryStatus!=='sent'&&!(item.kind==='codex'&&this.db.prepare("SELECT 1 FROM relay_notices WHERE source GLOB ? AND status='sent' LIMIT 1").get(item.id+':*'))};
 }
 async list(args={}){
  const {range='recent',since=0,before=0,query='',room='',kind='discussion',onlyUnseen=false,cursor=''}=args;
  if(!['discussion','codex','all'].includes(kind)||typeof query!=='string'||typeof room!=='string'||typeof onlyUnseen!=='boolean')throw Error('Invalid inbox query.');
  const times=inboxRange(range,since,before,this.clock());let edge={time:Number.MAX_SAFE_INTEGER,seq:Number.MAX_SAFE_INTEGER};
  if(cursor){edge=json(cursor,null);if(!edge||!Number.isSafeInteger(edge.time)||!Number.isSafeInteger(edge.seq))throw Error('Invalid inbox cursor.');}
  const rows=this.db.prepare(`SELECT * FROM apollo_findings WHERE event_to>=? AND event_to<? AND (?='all' OR kind=?) AND (?='' OR room_id=?)
    AND (summary LIKE ? ESCAPE '\\' OR topic LIKE ? ESCAPE '\\') AND (event_to<? OR event_to=? AND seq<?)
    ORDER BY event_to DESC,seq DESC LIMIT 81`).all(times.since,times.before,kind,kind,room,room,...Array(2).fill('%'+query.slice(0,150).replace(/[\\%_]/g,'\\$&')+'%'),edge.time,edge.time,edge.seq);
  const selected=[],policies=new Map();let scanned=0,last=null;
  for(const row of rows.slice(0,80)){
   scanned++;last=row;const item=this.decode(row);if(onlyUnseen&&!this.publicItem(item).newToOwner)continue;
   if(!await this.eligible(item,policies))continue;
   selected.push(this.publicItem(item));if(selected.length===8)break;
  }
  return {rows:selected,...times,nextCursor:last&&(scanned<rows.length||rows.length===81)?JSON.stringify({time:last.event_to,seq:last.seq}):'',
   coverage:'Saved relevant findings only, not a fresh evaluation of the archive. Current ignored/untracked chats are omitted. newToOwner tracks delivered recap context/historical notices, not a read receipt. Source availability is checked when requested; originals may expire.'};
 }
 async item(id){
  const item=this.decode(this.db.prepare('SELECT * FROM apollo_findings WHERE id=?').get(String(id)));
  if(!item||!await this.eligible(item))return {available:false,reason:'Finding missing or current chat selection does not allow it.'};
  const sources=[];
  for(const saved of item.sources.slice(0,6)){
   const original=await this.archive.read('source',{id:saved.id,offset:0});
   sources.push(original.available===false?{id:saved.id,available:false,status:'original_unavailable_or_expired',savedUrl:saved.savedUrl||'',linkVerifiedAtCaptureOnly:true}:{...original,body:clip(original.body,6000),status:saved.bodyHash&&original.bodyHash&&saved.bodyHash!==original.bodyHash?'retained_original_changed_since_capture':'retained_original'});
  }
  return {available:true,...this.publicItem(item),sources};
 }
 async source(id,offset=0){
  const related=this.db.prepare("SELECT f.* FROM apollo_findings f WHERE f.kind='discussion' AND EXISTS(SELECT 1 FROM json_each(f.sources) WHERE json_extract(value,'$.id')=?) LIMIT 20").all(String(id));
  if(related.length){let allowed=false;const policies=new Map();for(const row of related)if(await this.eligible(this.decode(row),policies)){allowed=true;break;}
   if(!allowed)return {available:false,reason:'Current chat selection does not permit this saved source.'};
  }
  return this.archive.read('source',{id,offset});
 }
 status(){return {deliveryMode:'store_only',findings:this.db.prepare('SELECT kind,count(*) count FROM apollo_findings GROUP BY kind').all(),lastShown:this.lastContext(),originalRetention:'Unchanged; saved summaries can outlive original message text.'};}
}
