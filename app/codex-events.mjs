import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {redactSecrets} from './misty-redact.mjs';

// Installed thread/list omits rollout paths. Read only the local metadata catalog;
// never resume threads or open writer connections to discover their log files.
export function resolveRolloutPaths(chats,home=process.env.CODEX_HOME||path.join(os.homedir(),'.codex')){
 const candidates=fs.readdirSync(home).filter(n=>/^state_\d+\.sqlite$/.test(n)).sort((a,b)=>Number(b.match(/\d+/)[0])-Number(a.match(/\d+/)[0]));
 for(const name of candidates){let db;try{
  db=new DatabaseSync(path.join(home,name),{readOnly:true});
  const columns=db.prepare('PRAGMA table_info(threads)').all().map(r=>r.name);
  if(!['id','rollout_path'].every(c=>columns.includes(c)))continue;
  const paths=new Map(db.prepare('SELECT id,rollout_path FROM threads').all().map(r=>[r.id,r.rollout_path]));
  return chats.map(c=>({...c,rolloutPath:c.rolloutPath||paths.get(c.id)||''}));
 }catch{}finally{db?.close();}}
 return chats;
}

// Durable VM event journal. It can receive evidence only, never start a turn.
export class CodexEvents {
 constructor(relay){this.r=relay;this.db=relay.db;this.db.exec('CREATE TABLE IF NOT EXISTS codex_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,thread_id TEXT NOT NULL,turn_id TEXT NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,at INTEGER NOT NULL)');}
 publish({worker,events}){
  if(!worker||worker!==this.r.catalog().worker)throw Error('Laptop pairing mismatch.');
  if(!Array.isArray(events)||events.length>100)throw Error('Invalid event batch.');
  return this.r.transaction(()=>{
   for(const e of events){
    if(!/^[a-f0-9]{64}$/.test(e.id||'')||!this.r.catalog().chats.some(c=>c.id===e.threadId)||typeof e.turnId!=='string'||e.turnId.length>150||!['message','completed','failed','interrupted'].includes(e.kind)||typeof e.text!=='string'||e.text.length>12000||!Number.isSafeInteger(e.at))throw Error('Invalid Codex event.');
    this.db.prepare('INSERT OR IGNORE INTO codex_events(id,thread_id,turn_id,kind,text,at) VALUES(?,?,?,?,?,?)').run(e.id,e.threadId,e.turnId,e.kind,redactSecrets(e.text),e.at);
   }
   return {ok:true};
  });
 }
 read(after=0){return {events:this.db.prepare('SELECT * FROM codex_events WHERE seq>? ORDER BY seq LIMIT 100').all(Math.max(0,Number(after)||0)),
  highWater:this.db.prepare('SELECT coalesce(max(seq),0) high FROM codex_events').get().high};}
}

// Tail only visible assistant text and lifecycle records. No reasoning/tool logs.
export class CodexEventSync {
 constructor({db,vm,worker,clock=()=>Date.now()}){
  Object.assign(this,{db,vm,worker,clock});this.nextPoll=0;this.busy=false;
  db.exec('CREATE TABLE IF NOT EXISTS codex_event_offsets(thread TEXT PRIMARY KEY,path TEXT NOT NULL,offset INTEGER NOT NULL,turn TEXT NOT NULL,final TEXT NOT NULL);CREATE TABLE IF NOT EXISTS codex_event_outbox(id TEXT PRIMARY KEY,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS codex_event_settings(key TEXT PRIMARY KEY,value INTEGER NOT NULL)');
  db.prepare("INSERT OR IGNORE INTO codex_event_settings VALUES('started',?)").run(clock());
  this.started=db.prepare("SELECT value FROM codex_event_settings WHERE key='started'").get().value;
 }
 tail(chat){
  const filename=chat.rolloutPath;
  if(!filename||!filename.endsWith('.jsonl')||!/[\\/]\.codex[\\/](sessions|archived_sessions)[\\/]/i.test(filename)||!fs.existsSync(filename))return;
  const size=fs.statSync(filename).size;
  let state=this.db.prepare('SELECT * FROM codex_event_offsets WHERE thread=?').get(chat.id);
  if(!state||state.path!==filename||size<state.offset)state={offset:Math.max(0,size-2000000),turn:'',final:''};
  if(size===state.offset)return;
  const fd=fs.openSync(filename,'r');let bytes;
  try{bytes=Buffer.alloc(Math.min(size-state.offset,4000000));fs.readSync(fd,bytes,0,bytes.length,state.offset);}finally{fs.closeSync(fd);}
  const end=bytes.lastIndexOf(10);if(end<0)return;
  const lines=bytes.subarray(0,end+1).toString('utf8').split('\n');
  const pending=[];
  for(const line of lines){
   let e;try{e=JSON.parse(line);}catch{continue;}
   const p=e.payload||{},at=Date.parse(e.timestamp||'');
   if(e.type==='turn_context')state.turn=String(p.turn_id||p.turnId||state.turn);
   if(e.type==='event_msg'&&p.type==='task_started'){state.turn=String(p.turn_id||'');state.final='';}
   let kind='',text='';
   if(e.type==='response_item'&&p.type==='message'&&p.role==='assistant'&&!['analysis','summary'].includes(p.channel||p.phase)){
    text=(p.content||[]).filter(c=>['output_text','text'].includes(c.type)).map(c=>c.text||'').join('\n');
    if(['final','final_answer'].includes(p.phase)){state.final=text;continue;}
    if(p.phase==='commentary'||p.channel==='commentary')kind='message';
   }
   if(e.type==='event_msg'&&['task_complete','turn_aborted','task_cancelled'].includes(p.type)){
    kind=p.type==='task_complete'?'completed':'interrupted';state.turn=String(p.turn_id||state.turn);text=String(p.last_agent_message||state.final||'');
   }
   if(!kind||!Number.isFinite(at)||at<this.started)continue;
   const id=createHash('sha256').update(JSON.stringify([chat.id,state.turn,kind,e.timestamp,p.id||'',text])).digest('hex');
   pending.push({id,threadId:chat.id,turnId:state.turn,kind,text:redactSecrets(text).slice(0,12000),at});
  }
  this.db.exec('BEGIN IMMEDIATE');try{
   for(const e of pending)this.db.prepare('INSERT OR IGNORE INTO codex_event_outbox VALUES(?,?)').run(e.id,JSON.stringify(e));
   this.db.prepare('INSERT INTO codex_event_offsets VALUES(?,?,?,?,?) ON CONFLICT(thread) DO UPDATE SET path=excluded.path,offset=excluded.offset,turn=excluded.turn,final=excluded.final').run(chat.id,filename,state.offset+end+1,state.turn,state.final.slice(0,24000));
   this.db.exec('COMMIT');
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 async tick(chats){
  if(this.busy||this.clock()<this.nextPoll)return;this.busy=true;
  try{
   for(const c of chats)this.tail(c);
   const batch=this.db.prepare('SELECT id,payload FROM codex_event_outbox ORDER BY rowid LIMIT 50').all();
   if(batch.length){await this.vm.request('codex_events',{worker:this.worker,events:batch.map(e=>JSON.parse(e.payload))});for(const e of batch)this.db.prepare('DELETE FROM codex_event_outbox WHERE id=?').run(e.id);}
   this.nextPoll=this.clock()+3000;
  }finally{this.busy=false;}
 }
}
