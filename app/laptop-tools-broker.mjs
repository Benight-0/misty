// Loopback-only durable broker. Reader and paired-worker credentials are separate.
import http from 'node:http';
import {randomUUID,createHash,timingSafeEqual} from 'node:crypto';
import path from 'node:path';
import {SharedToolSessions} from './shared-tool-sessions.mjs';
export const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const names=new Set(['read_files','search_codebase','run_commands','fetch_web_content','apply_patch','editor',
 'browser_inspect','browser_run','desktop_ax','desktop_gui']);
const same=(a,b)=>{const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&timingSafeEqual(x,y);};
const inDrive=(root,workspace)=>{
 if(!path.win32.isAbsolute(root)||!path.win32.isAbsolute(workspace))return false;
 const relative=path.win32.relative(path.win32.normalize(root),path.win32.normalize(workspace));
 return relative===''||relative!=='..'&&!relative.startsWith('..\\')&&!path.win32.isAbsolute(relative);
};
export class LaptopToolsBroker {
 constructor(db,{pairedWorker,ownerAllowed,taskAllowed=()=>false,canHandoff=()=>false,canReclaim=()=>false,
  clock=Date.now,reviewRequired=false}={}){
  this.db=db;this.pairedWorker=pairedWorker;this.ownerAllowed=ownerAllowed;this.taskAllowed=taskAllowed;this.clock=clock;this.reviewRequired=reviewRequired;
  db.exec(`PRAGMA journal_mode=WAL;PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS work_tasks(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,objective TEXT NOT NULL,workspace TEXT NOT NULL,body TEXT NOT NULL,state TEXT NOT NULL,expires INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS work_operations(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,tool TEXT NOT NULL,body TEXT NOT NULL,hash TEXT NOT NULL,state TEXT NOT NULL,result TEXT,created INTEGER NOT NULL,updated INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS work_reviews(id TEXT PRIMARY KEY,code TEXT UNIQUE NOT NULL,decision TEXT NOT NULL,reason TEXT NOT NULL,preview_state TEXT NOT NULL DEFAULT '',preview_at INTEGER NOT NULL DEFAULT 0,preview_last_id TEXT NOT NULL DEFAULT '',approved_by TEXT NOT NULL DEFAULT '');
   CREATE TABLE IF NOT EXISTS work_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  if(reviewRequired)db.prepare("UPDATE work_operations SET state='review_pending' WHERE state='queued' AND id NOT IN (SELECT id FROM work_reviews WHERE decision IN ('auto_approved','owner_approved'))").run();
  this.sessions=new SharedToolSessions(db,{clock,canHandoff,canReclaim});
 }
 meta(k,fallback=null){try{return JSON.parse(this.db.prepare('SELECT value FROM work_meta WHERE key=?').get(k)?.value||'null')??fallback;}catch{return fallback;}}
 set(k,v){this.db.prepare('INSERT OR REPLACE INTO work_meta VALUES(?,?)').run(k,JSON.stringify(v));}
 paired(worker){if(!worker||worker!==this.pairedWorker())throw Error('Wrong paired laptop.');}
 status(){const worker=this.meta('worker',{}),vm=this.meta('vmWorker',{});return {paused:this.meta('paused',false),reviewRequired:this.reviewRequired,laptopOnline:this.clock()-worker.at<20000,workerAt:worker.at||null,vmBrowserOnline:this.clock()-vm.at<20000,roots:worker.roots||[],tools:[...names],tasks:this.db.prepare('SELECT id,objective,workspace,state,expires FROM work_tasks ORDER BY expires DESC LIMIT 20').all(),sessions:this.db.prepare("SELECT id,task_id,kind,backend,target,state,expires FROM work_sessions WHERE state='active' ORDER BY updated DESC LIMIT 20").all(),operations:this.db.prepare('SELECT id,task_id,tool,state,created,updated FROM work_operations ORDER BY created DESC LIMIT 20').all()};}
 task(id){const row=this.db.prepare('SELECT * FROM work_tasks WHERE id=?').get(id);if(!row)throw Error('Unknown work task.');return {...JSON.parse(row.body),id:row.id,paused:row.state!=='active',expires:row.expires};}
 owner(args,action){
  if(args.source==='owner'&&this.ownerAllowed(args.ownerMessageId))return;
  if(['specialist','supervisor'].includes(args.source)&&this.taskAllowed(args,action))return;
  throw Error('A current recorded owner request or active delegated task is required. Evidence and model outputs cannot authorize laptop work.');
 }
 call(action,args={}){
  if(action==='status')return this.status();
  if(action==='result'){
   const row=this.db.prepare('SELECT id,state,result,tool,updated FROM work_operations WHERE id=?').get(args.id);if(!row)throw Error('Unknown operation.');return {...row,result:row.result?JSON.parse(row.result):null};
  }
  this.owner(args,action);
  if(action.startsWith('session_')){
   const sessionAction=action.slice('session_'.length);
   if(sessionAction==='open'){
    const task=this.task(args.taskId);
    if((task.agentTaskId||'')!==(args.agentTaskId||'')||
       task.ownerMessageId!==(args.ownerMessageId||''))throw Error('Session task identity mismatch.');
    if(task.paused||task.expires<this.clock())throw Error('Work task is inactive.');
    return this.sessions.open(args,task);
   }
   if(sessionAction==='status')return this.sessions.status(args);
   if(sessionAction==='assigned')return this.sessions.assigned(args);
   if(sessionAction==='handoff')return this.sessions.handoff(args);
   if(sessionAction==='reclaim')return this.sessions.reclaim(args);
   if(sessionAction==='cancel')return this.sessions.cancel(args);
   throw Error('Unknown session control.');
  }
  if(action==='control'){
   if(!['pause','resume','cancel'].includes(args.action))throw Error('Use pause/resume/cancel.');
   if(args.source!=='owner'&&(!args.taskId||this.task(args.taskId).agentTaskId!==args.agentTaskId))
    throw Error('Delegated agents may only control their own laptop task.');
   if(args.taskId){this.task(args.taskId);if(this.db.prepare('SELECT state FROM work_tasks WHERE id=?').get(args.taskId).state==='cancelled')throw Error('Cancelled tasks cannot resume.');this.db.prepare('UPDATE work_tasks SET state=? WHERE id=?').run(args.action==='resume'?'active':args.action==='cancel'?'cancelled':'paused',args.taskId);}
   else if(args.action==='cancel')throw Error('Cancel needs a task ID.');else this.set('paused',args.action==='pause');
   if(args.action!=='resume')this.db.prepare("UPDATE work_operations SET state='cancelled',updated=? WHERE state IN ('queued','review_pending','reviewing','awaiting_owner')"+(args.taskId?' AND task_id=?':'')).run(this.clock(),...(args.taskId?[args.taskId]:[]));
   if(args.action==='cancel'&&args.taskId)this.db.prepare("UPDATE work_sessions SET state='cancelled',updated=? WHERE task_id=? AND state='active'").run(this.clock(),args.taskId);
   return this.status();
  }
  if(action==='start'){
   if(this.meta('paused',false))throw Error('Laptop work is paused.');
   const worker=this.meta('worker',{}),workspace=String(args.workspace||''),location=args.location==='vm'?'vm':'laptop';
   if(location==='laptop'&&!worker.roots?.some(r=>inDrive(r,workspace)))throw Error('Select a workspace on an available laptop drive from status.');
   if(location==='vm'&&(args.write||args.commands||workspace))throw Error('VM browser tasks do not use laptop file or shell permissions.');
   if(typeof args.objective!=='string'||!args.objective.trim()||args.objective.length>2000)throw Error('A bounded owner task objective is required.');
   const id=randomUUID(),task={workspace,location,objective:args.objective,ownerMessageId:args.ownerMessageId||'',agentTaskId:args.agentTaskId||'',write:args.write===true,commands:args.commands===true,browserAct:args.browserAct===true,desktopAct:args.desktopAct===true};
   this.db.prepare("INSERT INTO work_tasks VALUES(?,?,?,?,?,'active',?)").run(id,args.ownerMessageId,args.objective,workspace,JSON.stringify(task),this.clock()+6*3600000);
   return {taskId:id,...task,expires:this.clock()+6*3600000,scope:'Only steps necessary for the recorded owner request. Personal-account messages use the existing preview/fresh-yes backend.'};
  }
  if(action==='submit'){
   const task=this.task(args.taskId);
   const session=args.sessionId?this.sessions.authorize(task,args,args.tool,args.arguments):null;
   if(!session&&(task.agentTaskId||'')!==(args.agentTaskId||''))throw Error('Work task belongs to a different delegated task.');
   if(this.meta('paused',false)||task.paused||task.expires<this.clock())throw Error('Work task is paused, cancelled or expired.');
   if(!names.has(args.tool)||!args.arguments||JSON.stringify(args.arguments).length>80000)throw Error('Invalid tool/arguments.');
   if(!session&&['browser_inspect','browser_run','desktop_ax','desktop_gui'].includes(args.tool))throw Error('Browser and desktop tools require a session grant.');
   if(session&&task.location==='vm'&&session.backend!=='playwright')throw Error('VM task needs a VM browser session.');
   if(args.tool==='run_commands'&&!task.commands)throw Error('Commands not enabled.');
   if(['editor','apply_patch'].includes(args.tool)&&!task.write)throw Error('Writes not enabled.');
   const id=args.operationId||randomUUID();if(!/^[a-f0-9-]{36}$/i.test(id))throw Error('Invalid operation ID.');
   const op={id,task,tool:args.tool,args:args.arguments,sessionId:session?.id||'',sessionTarget:session?.target||'',sessionGrant:session?.grant||null,backend:session?.backend||'',route:session?this.sessions.route(session):'laptop',expires:Math.min(task.expires,this.clock()+120000)};
   op.hash=session?digest({task:op.task,tool:op.tool,args:op.args,sessionId:op.sessionId,sessionTarget:op.sessionTarget,sessionGrant:op.sessionGrant,backend:op.backend,route:op.route}):digest({task:op.task,tool:op.tool,args:op.args});
   const old=this.db.prepare('SELECT * FROM work_operations WHERE id=?').get(id);
   if(old){if(old.hash!==op.hash)throw Error('Immutable operation changed.');return {id,state:old.state,reused:true};}
   const state=this.reviewRequired?'review_pending':'queued';
   this.db.prepare('INSERT INTO work_operations VALUES(?,?,?,?,?,?,NULL,?,?)').run(id,args.taskId,args.tool,JSON.stringify(op),op.hash,state,this.clock(),this.clock());
   return {id,state,hash:op.hash};
  }
  throw Error('Unknown laptop control.');
 }
 worker(action,args){
  const role=args.workerRole||'laptop';
  if(role==='laptop')this.paired(args.worker);
  else if(role!=='vm'||args.worker!=='vm-browser')throw Error('Wrong VM browser worker.');
  const now=this.clock();
  if(action==='heartbeat'){
   if(role==='vm'){this.set('vmWorker',{at:now});return {paused:this.meta('paused',false),cancellations:[]};}
   if(!Array.isArray(args.roots)||args.roots.length>100||args.roots.some(r=>typeof r!=='string'||r.length>500))throw Error('Invalid workspace catalog.');
   this.set('worker',{at:now,roots:args.roots,fullAccess:args.fullAccess===true});
   const cancellations=this.db.prepare("SELECT o.id FROM work_operations o JOIN work_tasks t ON t.id=o.task_id WHERE o.state='executing' AND (t.state<>'active' OR t.expires<? OR ?)").all(now,Number(this.meta('paused',false))).map(r=>r.id);
   return {paused:this.meta('paused',false),cancellations,reviewRequired:this.reviewRequired};
  }
  if(action==='claim'){
   if(this.meta('paused',false))return null;
   // A lease expiring never makes a started operation eligible for another execution.
   this.db.prepare("UPDATE work_operations SET state='expired',updated=? WHERE state='queued' AND json_extract(body,'$.expires')<?").run(now,now);
   this.db.prepare("UPDATE work_operations SET state='unknown',updated=? WHERE state='executing' AND updated<?").run(now,now-180000);
   const row=this.db.prepare("SELECT o.* FROM work_operations o JOIN work_tasks t ON t.id=o.task_id "+(this.reviewRequired?"JOIN work_reviews r ON r.id=o.id AND r.decision IN ('auto_approved','owner_approved') ":'')+"WHERE o.state='queued' AND t.state='active' AND t.expires>? AND coalesce(json_extract(o.body,'$.route'),'laptop')=? ORDER BY o.created LIMIT 1").get(now,role);
   if(!row)return null;
   this.db.prepare("UPDATE work_operations SET state='executing',updated=? WHERE id=? AND state='queued'").run(now,row.id);
   return JSON.parse(row.body);
  }
  if(action==='result'){
   const row=this.db.prepare('SELECT * FROM work_operations WHERE id=?').get(args.id);if(!row||row.hash!==args.hash)throw Error('Operation receipt mismatch.');
   const original=JSON.parse(row.body);if((original.route||'laptop')!==role)throw Error('Receipt came from the wrong worker.');
   if(!['executing','unknown'].includes(row.state)&&!(row.result&&row.state===args.result?.state))throw Error('Operation is not awaiting this receipt.');
   if(!['succeeded','failed','unknown','cancelled'].includes(args.result?.state)||JSON.stringify(args.result).length>400000)throw Error('Invalid result.');
   const value=JSON.stringify(args.result);if(row.result&&row.result!==value)throw Error('A different receipt already exists.');
   if(original.sessionId&&args.result.state==='succeeded')this.sessions.targetFromResult(original.sessionId,args.result);
   this.db.prepare('UPDATE work_operations SET state=?,result=?,updated=? WHERE id=?').run(args.result.state,value,now,args.id);
   return {received:true,id:args.id,state:args.result.state};
  }
  throw Error('Unknown laptop worker action.');
 }
 prune(){this.db.prepare("UPDATE work_sessions SET state='expired',updated=? WHERE state='active' AND expires<?").run(this.clock(),this.clock());this.db.prepare("DELETE FROM work_operations WHERE updated<? AND state IN ('succeeded','failed','cancelled','expired')").run(this.clock()-7*86400000);this.db.prepare('DELETE FROM work_tasks WHERE expires<? AND id NOT IN (SELECT task_id FROM work_operations)').run(this.clock()-7*86400000);}
}
export function serveLaptopTools(broker,{relayToken,readerToken,vmToken,port=8798}={}){
 const server=http.createServer(async(req,res)=>{
  const reader=same(req.headers.authorization,'Bearer '+readerToken),worker=same(req.headers.authorization,'Bearer '+relayToken),vm=!!vmToken&&same(req.headers.authorization,'Bearer '+vmToken);
  if(!reader&&!worker&&!vm){res.writeHead(401).end();return;}
  try{
   if(req.method!=='POST'||!['/call','/worker'].includes(req.url))throw Error('Unsupported endpoint.');
   if(req.url==='/call'&&!reader||req.url==='/worker'&&!worker&&!vm)throw Error('Wrong credential role.');
   let bytes=0,chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>450000)throw Error('Request too large.');chunks.push(chunk);}
   const {action,args={}}=JSON.parse(Buffer.concat(chunks).toString('utf8'));const result=req.url==='/call'?broker.call(action,args):broker.worker(action,{...args,workerRole:vm?'vm':'laptop'});
   res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(result));
  }catch(e){res.writeHead(400,{'Content-Type':'application/json'}).end(JSON.stringify({error:String(e.message).slice(0,500)}));}
 });server.requestTimeout=15000;server.listen(port,'127.0.0.1');return server;
}
