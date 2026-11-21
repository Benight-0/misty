import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import {digestJob} from './misty-relay.mjs';

// Use the installed extension's supported protocol. Credentials never leave this process.
export class RPCProcess extends EventEmitter {
 constructor(command,args=[],options={}){
  super();this.sequence=0;this.pending=new Map();this.closed=false;
  this.child=spawn(command,args,{...options,windowsHide:true,stdio:['pipe','pipe','pipe']});
  this.child.stderr.on('data',()=>{});this.child.stdin.on('error',()=>{});
  this.lines=createInterface({input:this.child.stdout});
  this.lines.on('line',line=>{try{this.receive(JSON.parse(line));}catch{this.emit('protocolError');}});
  this.child.on('error',()=>this.finish());this.child.on('close',()=>this.finish());
 }
 finish(){if(this.closed)return;this.closed=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Relay process disconnected.'));}this.pending.clear();this.emit('closed');}
 receive(message){
  if(message.method){
   if(message.id!==undefined){this.write({id:message.id,error:{code:-32601,message:'Interactive requests are unavailable in the Discord relay. Use VS Code for this action.'}});this.emit('interactive',message.method);}
   else this.emit('notification',message.method,message.params);
  }else{const p=this.pending.get(message.id);if(!p)return;this.pending.delete(message.id);clearTimeout(p.timer);if(message.error){const e=new Error(String(message.error.message||'RPC error').slice(0,300));e.rpcCode=message.error.code;p.reject(e);}else p.resolve(message.result);}
 }
 write(value){if(this.closed)throw new Error('Relay process disconnected.');this.child.stdin.write(JSON.stringify(value)+'\n');}
 request(method,params={},timeout=60000){return new Promise((resolve,reject)=>{const id=++this.sequence;const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Relay request timed out.'));},timeout);this.pending.set(id,{resolve,reject,timer});try{this.write({id,method,params});}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}});}
 notify(method,params={}){this.write({method,params});}
 close(){this.child.stdin.end();this.child.kill();this.finish();}
}

export async function initializeCodex(rpc){
 await rpc.request('initialize',{clientInfo:{name:'misty_discord_relay',title:'Misty Discord relay',version:'1.0.0'},capabilities:{experimentalApi:true}});
 rpc.notify('initialized');
 return rpc.request('account/read',{refreshToken:false});
}

export async function listCodexChats(rpc){
 const chats=[],seen=new Set(),cursors=new Set();let cursor;
 do{
  const page=await rpc.request('thread/list',{limit:100,sortKey:'updated_at',archived:false,...(cursor?{cursor}:{})});
  for(const t of page.data||[])if(t.id&&t.cwd&&!seen.has(t.id)){seen.add(t.id);chats.push({id:t.id,title:String(t.name||t.preview||'Untitled chat').replace(/\s+/g,' ').slice(0,150),cwd:t.cwd,preview:String(t.preview||'').slice(0,600),updatedAt:t.updatedAt,status:t.status?.type||'unknown',source:t.source,rolloutPath:t.path});}
  cursor=page.nextCursor;if(cursor&&cursors.has(cursor))break;if(cursor)cursors.add(cursor);
 }while(cursor&&chats.length<1000);
 return chats;
}

// Other VS Code windows have their own server. Check persisted lifecycle events too.
export async function hasActiveTurn(filename){
 if(!filename)return false;let active=false;
 const lines=createInterface({input:fs.createReadStream(filename),crlfDelay:Infinity});
 for await(const line of lines){try{const event=JSON.parse(line);if(event.type!=='event_msg')continue;const t=event.payload?.type;if(t==='task_started')active=true;else if(['task_complete','turn_aborted','task_cancelled'].includes(t))active=false;}catch{}}
 return active;
}

export class CodexJobs {
 constructor(rpc,db,{busyCheck=hasActiveTurn,liveSessions=null,pollMs=2000}={}){
  this.rpc=rpc;this.db=db;this.busyCheck=busyCheck;this.liveSessions=liveSessions;this.pollMs=pollMs;this.events=new Map();
  db.exec(`CREATE TABLE IF NOT EXISTS codex_jobs(id TEXT PRIMARY KEY,hash TEXT NOT NULL,stage TEXT NOT NULL,thread_id TEXT NOT NULL DEFAULT '',turn_id TEXT NOT NULL DEFAULT '',answer TEXT NOT NULL DEFAULT '',outcome TEXT NOT NULL DEFAULT '');`);
  if(!db.prepare('PRAGMA table_info(codex_jobs)').all().some(c=>c.name==='route'))db.exec("ALTER TABLE codex_jobs ADD COLUMN route TEXT NOT NULL DEFAULT 'appserver'");
  this.listener=(method,p)=>{
   if(!p)return;const turnId=p.turnId||p.turn?.id;if(!turnId)return;
   let e=this.events.get(turnId);if(!e){e={messages:new Map(),turn:null};this.events.set(turnId,e);if(this.events.size>30)this.events.delete(this.events.keys().next().value);}
   if(method==='item/completed'&&p.item?.type==='agentMessage'&&p.item.phase!=='commentary')e.messages.set(p.item.id,p.item.text);
   if(method==='turn/completed')e.turn=p.turn;
  };rpc.on('notification',this.listener);
 }
 row(id){return this.db.prepare('SELECT * FROM codex_jobs WHERE id=?').get(id);}
 save(id,changes){const keys=Object.keys(changes);if(keys.some(k=>!['stage','thread_id','turn_id','answer','outcome','route'].includes(k)))throw new Error('Invalid journal update.');this.db.prepare('UPDATE codex_jobs SET '+keys.map(k=>k+'=?').join(',')+' WHERE id=?').run(...keys.map(k=>changes[k]),id);}
 async readTurn(threadId,turnId,clientId,maxPages=Infinity){
  let cursor,pages=0;const seen=new Set();
  do{
   const page=await this.rpc.request('thread/turns/list',{threadId,limit:30,itemsView:'full',sortDirection:'desc',...(cursor?{cursor}:{})});
   const found=(page.data||[]).find(t=>turnId?t.id===turnId:t.items?.some(i=>i.type==='userMessage'&&i.clientId===clientId));
   if(found)return found;
   cursor=page.nextCursor;if(cursor&&seen.has(cursor))throw new Error('Repeated Codex history cursor.');if(cursor)seen.add(cursor);
   pages++;
  }while(cursor&&pages<maxPages);
 }
 async run(job,progress=async()=>{}){
  if(job.hash!==digestJob(job.prompt,job.target))throw new Error('Approved prompt or destination hash mismatch.');
  let row=this.row(job.id);if(row&&row.hash!==job.hash)throw new Error('Journal hash mismatch.');
  if(!row){this.db.prepare("INSERT INTO codex_jobs(id,hash,stage) VALUES(?,?,'claimed')").run(job.id,job.hash);row=this.row(job.id);}
  if(row.stage==='settled')return {status:row.outcome,threadId:row.thread_id,turnId:row.turn_id,answer:row.answer};
  if(row.route==='live')return this.runLive(job,progress);
  if(row.stage==='submitting'&&!row.turn_id){
   // clientUserMessageId correlates crash recovery. Never blindly submit again.
   const found=await this.readTurn(row.thread_id,'',job.id);
   if(found){this.save(job.id,{turn_id:found.id,stage:'running'});row=this.row(job.id);}
   else return this.settle(job.id,'unknown','Submission was interrupted before its receipt was saved. I will not send it again automatically. Check this chat in VS Code.');
  }
  if(!row.thread_id){
   const target=job.target;if(!fs.existsSync(target.cwd)||!fs.statSync(target.cwd).isDirectory())return this.settle(job.id,'failed','The approved workspace is unavailable on this laptop. Nothing was submitted.');
   let thread;
   if(target.kind==='existing'){
    try{thread=(await this.rpc.request('thread/read',{threadId:target.id,includeTurns:false})).thread;}
    catch(e){if(e.rpcCode!==undefined)return this.settle(job.id,'failed','Codex could not open the approved chat. Nothing was submitted, and no different chat was used.');throw e;}
    if(thread.id!==target.id||path.resolve(thread.cwd).toLowerCase()!==path.resolve(target.cwd).toLowerCase())return this.settle(job.id,'failed','The approved chat or workspace no longer matches. Nothing was submitted.');
    if(this.liveSessions){
     const session=await this.liveSessions.open(target.id,target.cwd);
     if(session){this.save(job.id,{thread_id:target.id,stage:'prepared',route:'live'});return this.runLive(job,progress,session);}
    }
    if(thread.status?.type==='active'||await this.busyCheck(thread.path))return {blocked:true};
    thread=(await this.rpc.request('thread/resume',{threadId:target.id,excludeTurns:true,approvalPolicy:'never',sandbox:'danger-full-access'},15000)).thread;
   }else if(target.kind==='new'){
    thread=(await this.rpc.request('thread/start',{cwd:target.cwd,approvalPolicy:'never',sandbox:'danger-full-access',ephemeral:false})).thread;
    await this.rpc.request('thread/name/set',{threadId:thread.id,name:'Misty — '+job.prompt.replace(/\s+/g,' ').slice(0,65)});
   }else throw new Error('Unknown approved destination.');
   this.save(job.id,{thread_id:thread.id,stage:'prepared'});row=this.row(job.id);
  }
  if(row.stage==='prepared'){
   if(this.liveSessions&&job.target.kind==='existing'){
    const session=await this.liveSessions.open(row.thread_id,job.target.cwd);
    if(session){this.save(job.id,{route:'live'});return this.runLive(job,progress,session);}
   }
   const check=(await this.rpc.request('thread/read',{threadId:row.thread_id,includeTurns:false})).thread;
   if(check.id!==row.thread_id||path.resolve(check.cwd).toLowerCase()!==path.resolve(job.target.cwd).toLowerCase())return this.settle(job.id,'failed','The approved chat or workspace no longer matches. Nothing was submitted.');
   if(check.status?.type==='active'||await this.busyCheck(check.path))return {blocked:true};
   if(check.status?.type==='notLoaded')await this.rpc.request('thread/resume',{threadId:row.thread_id,excludeTurns:true,approvalPolicy:'never',sandbox:'danger-full-access'},15000);
   await progress({status:'submitting',threadId:row.thread_id,turnId:''});
   this.save(job.id,{stage:'submitting'});
   let started;
   try{started=await this.rpc.request('turn/start',{threadId:row.thread_id,clientUserMessageId:job.id,input:[{type:'text',text:job.prompt}],approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'}},90000);}
   catch{return this.settle(job.id,'unknown','Codex did not confirm prompt submission. It will not be retried automatically. Check the exact chat in VS Code.');}
   if(!started.turn?.id)throw new Error('Missing turn receipt.');
   this.save(job.id,{stage:'running',turn_id:started.turn.id});row=this.row(job.id);
  }
  await progress({status:'running',threadId:row.thread_id,turnId:row.turn_id});
  // A restarted worker reads the receipt instead of executing the prompt again.
  const end=Date.now()+6*3600000;let nextRead=0;
  while(Date.now()<end){
   if(this.rpc.closed)throw new Error('Codex disconnected; resume from the journal.');
   let event=this.events.get(row.turn_id),turn=event?.turn;
   if(!turn&&Date.now()>nextRead){turn=await this.readTurn(row.thread_id,row.turn_id);nextRead=Date.now()+30000;}
   if(turn&&turn.status!=='inProgress'){
    if(turn.status!=='completed')return this.settle(job.id,'failed','Codex '+turn.status+'. Check the selected chat in VS Code. The prompt was not repeated.');
    let messages=(turn.items||[]).filter(i=>i.type==='agentMessage'&&i.phase!=='commentary').map(i=>i.text);
    if(!messages.length&&event)messages=[...event.messages.values()];
    if(!messages.length){const stored=await this.readTurn(row.thread_id,row.turn_id);messages=(stored?.items||[]).filter(i=>i.type==='agentMessage'&&i.phase!=='commentary').map(i=>i.text);}
    return this.settle(job.id,'completed',messages.join('\n\n')||'Codex completed without a final text answer. Open the chat to inspect the result.');
   }
   await new Promise(resolve=>setTimeout(resolve,1000));
  }
  return this.settle(job.id,'unknown','Codex has not completed within six hours. Check its chat before issuing another request.');
 }
 async runLive(job,progress,session){
  if(!this.liveSessions)throw new Error('Live session adapter is required to recover this job.');
  let row=this.row(job.id),reconcileAll=!session&&row.stage!=='prepared';
  if(row.stage==='prepared'){
   session??=await this.liveSessions.open(row.thread_id,job.target.cwd);
   if(!session){
    // No live submission was attempted. Re-enter the ordinary backend path safely.
    this.save(job.id,{route:'appserver'});return this.run(job,progress);
   }
   if(this.liveSessions.busy(session))return {blocked:true,reason:'chat_busy',route:'live'};
   await progress({status:'submitting',threadId:row.thread_id,turnId:''});
   // Intent must survive a lost IPC response or worker crash. Never replay it.
   this.save(job.id,{stage:'submitting'});
   try{
    const receipt=await this.liveSessions.enqueue(session,job);
    if(receipt.blocked){this.save(job.id,{stage:'prepared'});return {blocked:true,reason:'editor_queue_busy',route:'live'};}
    this.save(job.id,{stage:'queued'});
   }catch(error){
    if(error.code==='no-client-found'){
     this.save(job.id,{stage:'prepared'});return {blocked:true,reason:'owner_changed',route:'live'};
    }
    // All other errors may have occurred after delivery. Reconcile, do not resend.
   }
   row=this.row(job.id);
  }
  const end=Date.now()+6*3600000,missingSince=Date.now();let nextSnapshot=0,reportedTurn='';
  while(Date.now()<end){
   if(this.rpc.closed)throw new Error('Codex reader disconnected; recover from the journal.');
   const stored=await this.readTurn(row.thread_id,row.turn_id,job.id,reconcileAll?Infinity:1);reconcileAll=false;
   if(Date.now()>=nextSnapshot){
    session=await this.liveSessions.open(row.thread_id,job.target.cwd);
    nextSnapshot=Date.now()+10000;
   }else session=await this.liveSessions.refresh(session);
   let liveTurn=this.liveSessions.findTurn(session,job.id,row.turn_id);
   let turn=liveTurn?.turnId?{...liveTurn,id:liveTurn.turnId}:stored;
   if(turn?.id){
    if(row.turn_id&&row.turn_id!==turn.id)throw new Error('Live turn receipt mismatch.');
    this.save(job.id,{stage:'running',turn_id:turn.id});row=this.row(job.id);
    if(reportedTurn!==turn.id){await progress({status:'running',threadId:row.thread_id,turnId:turn.id});reportedTurn=turn.id;}
    if(turn.status==='completed'){
     // Streaming text can live outside ordinary state patches. Fetch the final
     // owner snapshot once, then return its completed answer verbatim.
     if(liveTurn&&session){await session.snapshot();liveTurn=this.liveSessions.findTurn(session,job.id,row.turn_id);if(liveTurn?.status==='completed')turn={...liveTurn,id:liveTurn.turnId};}
     const messages=(turn.items||[]).filter(i=>i.type==='agentMessage'&&i.phase!=='commentary').map(i=>i.text);
     return this.settle(job.id,'completed',messages.join('\n\n')||'Codex completed without a final text answer. Open the chat to inspect the result.');
    }
    // A reader which does not own the runtime labels an unfinished persisted
    // rollout "interrupted". Only the live owner or a persisted terminal receipt
    // can establish failure; absence of a terminal event is not a failure.
    if(turn.status!=='inProgress'&&(liveTurn||turn.completedAt!=null))return this.settle(job.id,'failed','Codex '+turn.status+'. Check the selected chat in VS Code. The prompt was not repeated.');
   }else if(!row.turn_id){
    const queued=this.liveSessions.readQueue(row.thread_id).find(m=>m.id===job.id);
    if(queued){
     if(queued.text!==job.prompt||path.resolve(queued.cwd).toLowerCase()!==path.resolve(job.target.cwd).toLowerCase())return this.settle(job.id,'unknown','The queued prompt changed in VS Code. Inspect the selected chat; it will not be resent.');
     this.save(job.id,{stage:'queued'});row=this.row(job.id);
     if(queued.pausedReason)return {blocked:true,reason:'editor_queue_paused',route:'live'};
     if(!session)return {blocked:true,reason:'waiting_for_editor',route:'live'};
    }else if(Date.now()-missingSince>15000){
     return this.settle(job.id,'unknown','The editor did not confirm this submission. Inspect the selected chat and its queue before sending another request. It will not be repeated automatically.');
    }
   }
   await new Promise(resolve=>setTimeout(resolve,this.pollMs));
  }
  return this.settle(job.id,'unknown','Codex has not completed within six hours. Check its chat and queued messages before issuing another request.');
 }
 settle(id,status,answer){this.save(id,{stage:'settled',answer,outcome:status});const r=this.row(id);return {status,answer,threadId:r.thread_id,turnId:r.turn_id};}
 close(){this.rpc.off('notification',this.listener);}
}
