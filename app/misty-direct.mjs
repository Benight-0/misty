import {randomUUID,randomBytes,createHash} from 'node:crypto';
const digestJob=(prompt,target)=>createHash('sha256').update(JSON.stringify({prompt,target})).digest('hex');

export class MistyDirect {
 constructor(relay){this.r=relay;this.db=relay.db;this.pending=new Map();this.db.exec('CREATE TABLE IF NOT EXISTS misty_direct_dispatch(owner_id TEXT PRIMARY KEY,job_id TEXT UNIQUE NOT NULL,decision TEXT NOT NULL,created INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS overlay_codex_dispatch(client TEXT PRIMARY KEY,job_id TEXT UNIQUE NOT NULL,hash TEXT NOT NULL,created INTEGER NOT NULL)');}
 sendFromOverlay({clientId,chatId,prompt}){
  if(typeof clientId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId))throw Error('A stable overlay request ID is required.');
  if(typeof prompt!=='string'||!prompt.trim()||prompt.length>10000)throw Error('Provide a prompt of at most 10,000 characters.');
  const chat=this.r.catalog().chats.find(c=>c.id===chatId);
  if(!chat)throw Error('Choose an existing Codex chat from the current catalog.');
  const target={kind:'existing',id:chat.id,title:chat.title,cwd:chat.cwd},text=prompt.trim(),hash=digestJob(text,target);
  return this.r.transaction(()=>{
   const old=this.db.prepare('SELECT d.hash,j.code,j.status FROM overlay_codex_dispatch d JOIN relay_jobs j ON j.id=d.job_id WHERE d.client=?').get(clientId);
   if(old){if(old.hash!==hash)throw Error('This overlay request ID already belongs to a different prompt or chat.');return {queued:true,reused:true,code:old.code,status:old.status,target};}
   const now=Date.now(),id=randomUUID(),code=randomBytes(5).toString('hex');
   this.db.prepare("INSERT INTO relay_jobs(id,code,prompt,target,hash,status,created,updated) VALUES(?,?,?,?,?,'queued',?,?)").run(id,code,text,JSON.stringify(target),hash,now,now);
   this.db.prepare('INSERT INTO overlay_codex_dispatch VALUES(?,?,?,?)').run(clientId,id,hash,now);
   return {queued:true,reused:false,code,status:'queued',target,laptopOnline:this.r.online()};
  });
 }
 async send(args){
  const ownerId=String(args.ownerMessageId||'');
  if(this.pending.has(ownerId))return this.pending.get(ownerId);
  const promise=this.prepare({...args,ownerMessageId:ownerId}).finally(()=>this.pending.delete(ownerId));this.pending.set(ownerId,promise);return promise;
 }
 async prepare(args){
  const r=this.r,owner=this.db.prepare('SELECT * FROM bot_turns WHERE id=?').get(args.ownerMessageId);
  if(!owner||!/^\d{16,22}$/.test(owner.id)||!['external','external_sent'].includes(owner.status)||Date.now()-owner.ts>1800000)throw Error('A current recorded owner request is required.');
  if(typeof args.prompt!=='string'||!args.prompt.trim()||args.prompt.length>10000)throw Error('Provide an exact prompt up to 10000 characters.');
  const chat=r.catalog().chats.find(c=>c.id===args.chatId),known=[r.defaultCwd,...r.catalog().chats.map(c=>c.cwd)];
  if(!chat&&args.chatId!=='NEW')throw Error('Choose an actual catalog chat ID.');
  if(!chat&&!known.includes(args.workspace))throw Error('Choose a known workspace.');
  const target=chat?{kind:'existing',id:chat.id,title:chat.title,cwd:chat.cwd}:{kind:'new',title:String(args.title||'Misty work').slice(0,150),cwd:args.workspace};
  const hash=digestJob(args.prompt,target);
  const receipt=()=>{const saved=this.db.prepare('SELECT j.* FROM misty_direct_dispatch d JOIN relay_jobs j ON j.id=d.job_id WHERE d.owner_id=?').get(owner.id);if(!saved)return null;if(saved.hash!==hash)throw Error('This owner request already submitted a different task. Inspect its receipt or ask for a new task.');return {queued:true,reused:true,code:saved.code,status:saved.status,target:JSON.parse(saved.target)};};
  const existing=receipt();if(existing)return existing;
  return r.transaction(()=>{
   const previous=receipt();if(previous)return previous;
   if(this.db.prepare('SELECT 1 FROM bot_turns WHERE ts>? LIMIT 1').get(owner.ts))return {queued:false,requiresOwnerApproval:true,reason:'A newer owner message arrived; resolve it before sending.'};
   const now=Date.now(),id=randomUUID(),code=randomBytes(5).toString('hex');
   this.db.prepare("INSERT INTO relay_jobs(id,code,prompt,target,hash,status,created,updated) VALUES(?,?,?,?,?,'queued',?,?)").run(id,code,args.prompt,JSON.stringify(target),hash,now,now);
   const followThrough=args.followThrough===true;
   if(followThrough)this.db.prepare('INSERT INTO misty_work_grants(id,root_job,goal,workspace,thread_id,created,expires) VALUES(?,?,?,?,?,?,?)').run(code,id,'Original owner request:\n'+owner.body+'\n\nDispatched task:\n'+args.prompt,target.cwd,target.id||'',now,now+86400000);
   this.db.prepare('INSERT INTO misty_direct_dispatch VALUES(?,?,?,?)').run(owner.id,id,JSON.stringify({source:'verified_owner_request',followThrough}),now);
   return {queued:true,code,status:'queued',target,laptopOnline:r.online(),followThrough,receipt:'Saved exact prompt, destination and owner authorization. Not yet a completion.'};
  });
 }
}
