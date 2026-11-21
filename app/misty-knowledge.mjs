import {createHash} from 'node:crypto';
import {taskCard,disabledCard} from './misty-components.mjs';

const signature=rows=>{const h=createHash('sha256');for(const r of rows)h.update(JSON.stringify([r.ordinal,r.role,r.turn_id,r.at,r.text])+'\n');return h.digest('hex');};
export const knowledgeSignature=signature;
const definition=(name,description,properties)=>({type:'function',name,description,strict:true,parameters:{type:'object',properties,required:Object.keys(properties),additionalProperties:false}});

// Separate from private-message storage: only the paired laptop can publish.
// A complete verified snapshot replaces a document atomically; interrupted uploads
// never hide the last readable version. No SQL or filesystem paths are executable.
export class MistyKnowledge{
 constructor(relay){
  this.relay=relay;this.db=relay.db;
  this.db.exec(`CREATE TABLE IF NOT EXISTS misty_documents(id TEXT PRIMARY KEY,kind TEXT NOT NULL,title TEXT NOT NULL,path TEXT NOT NULL,thread_id TEXT NOT NULL,revision TEXT NOT NULL,parts INTEGER NOT NULL,characters INTEGER NOT NULL,updated INTEGER NOT NULL,synced INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS misty_document_chunks(document_id TEXT NOT NULL,ordinal INTEGER NOT NULL,role TEXT NOT NULL,turn_id TEXT NOT NULL,at TEXT NOT NULL,text TEXT NOT NULL,PRIMARY KEY(document_id,ordinal));
  CREATE VIRTUAL TABLE IF NOT EXISTS misty_knowledge_fts USING fts5(document_id UNINDEXED,ordinal UNINDEXED,text,tokenize='unicode61');
  CREATE TABLE IF NOT EXISTS misty_document_uploads(id TEXT PRIMARY KEY,meta TEXT NOT NULL,created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS misty_document_stage(document_id TEXT NOT NULL,ordinal INTEGER NOT NULL,role TEXT NOT NULL,turn_id TEXT NOT NULL,at TEXT NOT NULL,text TEXT NOT NULL,PRIMARY KEY(document_id,ordinal));`);
 }
 publish(p){
  if(p.worker!==this.relay.catalog().worker||!p.worker)throw Error('Laptop pairing mismatch.');
  if(p.action==='inventory')return {documents:this.db.prepare('SELECT id,revision,parts,characters,synced FROM misty_documents').all()};
  if(typeof p.id!=='string'||p.id.length>550||!p.id)throw Error('Invalid document ID.');
  if(p.action==='begin'){
   const m=p.meta;
   if(!m||!['code','codex'].includes(m.kind)||typeof m.title!=='string'||m.title.length>500||typeof m.path!=='string'||m.path.length>550||typeof m.thread_id!=='string'||!/^([\da-f-]{36})?$/.test(m.thread_id)||typeof m.revision!=='string'||!/^[a-f0-9]{64}$/.test(m.revision)||!Number.isInteger(m.parts)||m.parts<0||m.parts>100000||!Number.isSafeInteger(m.characters)||m.characters<0||m.characters>300000000||!Number.isSafeInteger(m.updated))throw Error('Invalid document manifest.');
   if(m.kind==='codex'&&(!this.relay.catalog().chats.some(t=>t.id===m.thread_id)||p.id!=='codex:'+m.thread_id))throw Error('Unknown Codex chat.');
   if(m.kind==='code'&&(!p.id.startsWith('code:')||m.thread_id))throw Error('Invalid code document.');
   return this.relay.transaction(()=>{
    this.db.prepare('DELETE FROM misty_document_stage WHERE document_id=?').run(p.id);
    this.db.prepare('INSERT INTO misty_document_uploads VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET meta=excluded.meta,created=excluded.created').run(p.id,JSON.stringify(m),Date.now());return {ok:true};
   });
  }
  const upload=this.db.prepare('SELECT meta FROM misty_document_uploads WHERE id=?').get(p.id);if(!upload)throw Error('Missing upload.');const m=JSON.parse(upload.meta);
  if(p.action==='chunks'){
   if(!Array.isArray(p.rows)||p.rows.length>80||Buffer.byteLength(JSON.stringify(p.rows))>1000000)throw Error('Invalid page.');
   return this.relay.transaction(()=>{for(const r of p.rows){
    if(!Number.isInteger(r.ordinal)||r.ordinal<0||r.ordinal>=m.parts||!['user','assistant','code'].includes(r.role)||typeof r.text!=='string'||r.text.length>16000||typeof r.turn_id!=='string'||r.turn_id.length>150||typeof r.at!=='string'||r.at.length>80)throw Error('Invalid chunk.');
    this.db.prepare('INSERT INTO misty_document_stage VALUES(?,?,?,?,?,?) ON CONFLICT(document_id,ordinal) DO UPDATE SET role=excluded.role,turn_id=excluded.turn_id,at=excluded.at,text=excluded.text').run(p.id,r.ordinal,r.role,r.turn_id,r.at,r.text);
   }return {ok:true};});
  }
  if(p.action!=='commit')throw Error('Unknown document action.');
  return this.relay.transaction(()=>{
   const totals=this.db.prepare('SELECT count(*) n,coalesce(sum(length(text)),0) characters,min(ordinal) first,max(ordinal) last FROM misty_document_stage WHERE document_id=?').get(p.id);
   // JS counts UTF-16 code units; hash verification below is the authoritative
   // byte/content check, including surrogate pairs and every page in order.
   const rows=this.db.prepare('SELECT ordinal,role,turn_id,at,text FROM misty_document_stage WHERE document_id=? ORDER BY ordinal');
   let characters=0;for(const r of rows.iterate(p.id))characters+=r.text.length;
   if(totals.n!==m.parts||characters!==m.characters||(m.parts&&(totals.first!==0||totals.last!==m.parts-1))||signature(rows.iterate(p.id))!==m.revision)throw Error('Incomplete or changed document.');
   this.db.prepare('DELETE FROM misty_knowledge_fts WHERE rowid IN (SELECT rowid FROM misty_document_chunks WHERE document_id=?)').run(p.id);
   this.db.prepare('DELETE FROM misty_document_chunks WHERE document_id=?').run(p.id);
   this.db.prepare('INSERT INTO misty_document_chunks SELECT * FROM misty_document_stage WHERE document_id=?').run(p.id);
   this.db.prepare('INSERT INTO misty_knowledge_fts(rowid,document_id,ordinal,text) SELECT rowid,document_id,ordinal,text FROM misty_document_chunks WHERE document_id=?').run(p.id);
   this.db.prepare('INSERT INTO misty_documents VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,title=excluded.title,path=excluded.path,thread_id=excluded.thread_id,revision=excluded.revision,parts=excluded.parts,characters=excluded.characters,updated=excluded.updated,synced=excluded.synced').run(p.id,m.kind,m.title,m.path,m.thread_id,m.revision,m.parts,m.characters,m.updated,Date.now());
   this.db.prepare('DELETE FROM misty_document_stage WHERE document_id=?').run(p.id);this.db.prepare('DELETE FROM misty_document_uploads WHERE id=?').run(p.id);return {ok:true,parts:m.parts,characters};
  });
 }
 status(){return this.db.prepare('SELECT kind,count(*) documents,sum(parts) parts,sum(characters) characters,max(synced) lastSynced FROM misty_documents GROUP BY kind').all();}
 definitions(){const s={type:'string'},i={type:'integer'};return [
  definition('knowledge_find','Search synced Misty code or full visible Codex message transcripts. kind is code, codex, or empty. Empty query lists documents. Results include document IDs; read all relevant pages before claiming full coverage.',{query:s,kind:s}),
  definition('knowledge_read','Read consecutive full-text chunks by document ID and zero-based offset. Follow nextOffset until null for the complete transcript/file. No hidden reasoning, tool logs or attachment bytes.',{document:s,offset:i}),
  definition('misty_control','Handle an explicitly requested housekeeping action for the owner. action: pause_notifications/resume_notifications/stop_work/cancel_draft. id is the work/draft ID, otherwise empty. Never starts, approves or expands a Codex task.',{action:s,id:s}),
  definition('misty_details','Retrieve saved details. kind: result/card/work/status/exact/answer/answer_exact. result reads Codex result pages silently; exact publishes the complete verbatim Codex reply ONLY on explicit request. answer reads Misty detailed original before style editing; answer_exact publishes that original verbatim ONLY when requested. For answer kinds id is source or empty for latest. For other kinds id is job/draft code or empty for latest. card publishes an exact review card ONLY on request.',{kind:s,id:s,offset:i})];}
 execute(name,p){
  if(name==='misty_control'){
   if(p.action==='pause_notifications'||p.action==='resume_notifications'){if(this.relay.store.get('conversation_monitor')==='apollo')return {ok:false,managedBy:'Apollo',message:'Conversation notifications are managed in the Apollo DM.'};this.relay.store.set('misty_notifications_paused',p.action==='pause_notifications');return {ok:true,paused:p.action==='pause_notifications'};}
   if(p.action==='stop_work')return {ok:true,result:this.relay.work.stop(p.id)};
   if(p.action==='cancel_draft'){const d=this.relay.findDraft(p.id);this.relay.db.prepare("UPDATE relay_drafts SET state='cancelled' WHERE id=?").run(d.id);this.relay.retire(d,'Cancelled');return {ok:true};}
   throw Error('Unsupported control.');
  }
  if(name==='knowledge_read'){
   const m=this.db.prepare('SELECT * FROM misty_documents WHERE id=?').get(p.document);if(!m)return {available:false};
   const offset=Math.max(0,Math.floor(p.offset||0)),rows=[];let bytes=0;
   for(const r of this.db.prepare('SELECT ordinal,role,turn_id,at,text FROM misty_document_chunks WHERE document_id=? AND ordinal>=? ORDER BY ordinal LIMIT 250').iterate(p.document,offset)){if(rows.length&&bytes+Buffer.byteLength(r.text)>65000)break;rows.push(r);bytes+=Buffer.byteLength(r.text);}
   const next=rows.length?rows.at(-1).ordinal+1:offset;return {document:m,rows,nextOffset:next<m.parts?next:null,coverage:'All visible user/assistant text in the saved rollout snapshot, paginated; no hidden reasoning or attachment binaries. Code snapshots exclude secrets and generated/vendor/data files.'};
  }
  if(name==='knowledge_find'){
   const kind=['code','codex'].includes(p.kind)?p.kind:'',query=String(p.query||'').slice(0,500),terms=query.match(/[\p{L}\p{N}_]+/gu)?.slice(0,12)||[];
   const documents=this.db.prepare("SELECT * FROM misty_documents WHERE (?='' OR kind=?) AND (title LIKE ? OR path LIKE ? OR id=?) ORDER BY updated DESC LIMIT 30").all(kind,kind,'%'+query+'%','%'+query+'%',query);
   const hits=terms.length?this.db.prepare("SELECT f.document_id,f.ordinal,snippet(misty_knowledge_fts,2,'[',']',' … ',50) excerpt,d.title,d.kind FROM misty_knowledge_fts f JOIN misty_documents d ON d.id=f.document_id WHERE misty_knowledge_fts MATCH ? AND (?='' OR d.kind=?) ORDER BY bm25(misty_knowledge_fts) LIMIT 20").all(terms.map(t=>'"'+t.replaceAll('"','""')+'"*').join(' AND '),kind,kind):[];
   return {status:this.status(),documents,hits,limits:'30 document matches, 20 text hits; refine query or read pages. Sync requires laptop online; synced timestamp is snapshot freshness.'};
  }
  if(name!=='misty_details')throw Error('Unknown knowledge tool.');
  if(p.kind==='answer'||p.kind==='answer_exact'){
   const answer=this.relay.rephraser.read(p.id||'',p.offset);
   if(answer.available&&p.kind==='answer_exact'){this.relay.notice('requested-answer:'+answer.source+':'+Date.now(),answer.text);return {...answer,originalReplyQueued:true};}
   return answer;
  }
  if(p.kind==='status')return {online:this.relay.online(),knowledge:this.status(),jobs:this.db.prepare('SELECT code,status,thread_id,turn_id,updated FROM relay_jobs ORDER BY created DESC LIMIT 15').all()};
  if(p.kind==='work')return {grants:this.db.prepare("SELECT id,goal,workspace,thread_id,state,remaining,created,expires FROM misty_work_grants WHERE (?='' OR id=?) ORDER BY created DESC LIMIT 15").all(p.id||'',p.id||'')};
  if(p.kind==='card'){
   const d=p.id?this.db.prepare('SELECT * FROM relay_drafts WHERE code=? OR id=?').get(p.id,p.id):this.db.prepare("SELECT * FROM relay_drafts WHERE state='pending' AND expires>? ORDER BY created DESC LIMIT 1").get(Date.now());
   if(d?.state==='pending'&&d.expires>Date.now()){const fresh=this.relay.refresh(d,{},{formal:true});return {available:true,code:fresh.code,prompt:fresh.prompt,target:JSON.parse(fresh.target),cardQueued:true};}
   const j=this.db.prepare("SELECT * FROM relay_jobs WHERE (?='' OR code=? OR id=?) ORDER BY created DESC LIMIT 1").get(p.id||'',p.id||'',p.id||'');if(!j)return {available:false};
   const source='requested-card:'+j.id+':'+Date.now(),parts=[];for(let at=0;at<j.prompt.length;){let end=Math.min(at+3000,j.prompt.length);if(/[\uD800-\uDBFF]/.test(j.prompt[end-1]))end--;parts.push(j.prompt.slice(at,end));at=end;}
   const saved={...j,candidates:'[]',reason:'Exact submitted task; read-only history.'};
   parts.forEach((part,i)=>{const payload=disabledCard(taskCard(saved,part,i,parts.length));payload.embeds.forEach(e=>{e.footer={text:'Submitted task '+j.code+' · '+j.status+' · '+new Date(j.created).toISOString()};});this.db.prepare('INSERT INTO relay_notices(source,body,payload) VALUES(?,?,?)').run(source+':'+i,'',JSON.stringify(payload));});
   return {available:true,code:j.code,cardQueued:true,readOnly:true,status:j.status};
  }
  if(!['result','exact'].includes(p.kind))throw Error('Unknown details kind.');
  const j=this.db.prepare("SELECT * FROM relay_jobs WHERE (?='' OR code=? OR id=?) ORDER BY created DESC LIMIT 1").get(p.id||'',p.id||'',p.id||'');if(!j)return {available:false};
  if(p.kind==='exact'){this.relay.notice('requested-exact:'+j.id+':'+Date.now(),j.result||'No final text is saved for this job.');return {available:true,code:j.code,status:j.status,exactReplyQueued:true,totalCharacters:j.result.length};}
  const offset=Math.max(0,Math.floor(p.offset||0)),text=j.result.slice(offset,offset+60000);return {available:true,code:j.code,status:j.status,prompt:j.prompt,target:JSON.parse(j.target),thread:j.thread_id,turn:j.turn_id,text,nextOffset:offset+text.length<j.result.length?offset+text.length:null,totalCharacters:j.result.length,exact:true};
 }
}
