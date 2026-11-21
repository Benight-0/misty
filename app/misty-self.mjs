import {randomUUID} from 'node:crypto';

const snowflake=id=>typeof id==='string'&&/^\d{16,22}$/.test(id);
const definition=(name,description,properties)=>({type:'function',name,description,strict:true,parameters:{type:'object',properties,required:Object.keys(properties),additionalProperties:false}});
export function normalizePresence(value){
 if(!value||!['online','idle','dnd','invisible'].includes(value.status)||!['custom','playing','listening','watching','competing','none'].includes(value.activity)||typeof value.text!=='string'||[...value.text].length>128||/[\u0000-\u001f\u007f]/.test(value.text))throw Error('Invalid Discord presence.');
 if(value.activity!=='none'&&!value.text.trim())throw Error('Activity needs text.');
 return {status:value.status,activity:value.activity,text:value.activity==='none'?'':value.text.trim()};
}

// Parent/child IPC acknowledges a successful Gateway write, not a visual readback.
export class MistyPresence{
 constructor(store,{write,isConnected=()=>true,now=()=>Date.now(),timeoutMs=7000}={}){this.store=store;this.write=write;this.isConnected=isConnected;this.now=now;this.timeoutMs=timeoutMs;this.pending=new Map();this.last=-Infinity;}
 current(){return this.store.get('misty_presence',{status:'online',activity:'custom',text:'around, if you need me'});}
 async set(value){
  const presence=normalizePresence(value);
  if(!this.isConnected())throw Error('Discord is reconnecting; status was not changed.');
  if(this.pending.size||this.now()-this.last<20000)throw Error('Status changes are limited to once every 20 seconds.');
  this.last=this.now();const id=randomUUID();
  const receipt=await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('Status update was not confirmed.'));},this.timeoutMs);
   this.pending.set(id,{resolve,reject,timer});
   try{this.write({kind:'presence',id,...presence});}catch{clearTimeout(timer);this.pending.delete(id);reject(Error('Status update was not confirmed.'));}
  });
  this.store.set('misty_presence',presence);this.store.set('misty_presence_receipt',{state:receipt.state,at:this.now(),value:presence});return {...presence,state:receipt.state};
 }
 receive(event){
  if(event.kind!=='presence')return false;
  const p=this.pending.get(event.id);if(!p)return true;
  clearTimeout(p.timer);this.pending.delete(event.id);
  if(event.ok)p.resolve({state:'gateway_sent'});else p.reject(Error('Discord did not accept the status write.'));
  return true;
 }
 close(){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('Status connection closed.'));}this.pending.clear();}
}

export class MistySelf{
 constructor(relay,api,presence){
  this.relay=relay;this.store=relay.store;this.db=relay.db;this.api=api;this.presence=presence;
  this.db.exec(`CREATE TABLE IF NOT EXISTS misty_deleted_messages(id TEXT PRIMARY KEY,channel TEXT NOT NULL,request TEXT NOT NULL,state TEXT NOT NULL,updated INTEGER NOT NULL);`);
 }
 definitions(){return [
  definition('misty_self_messages','List Misty-authored messages in this owner DM, newest first. Page past owner messages using nextBefore. Does not read or delete other chats.',{before:{type:'string'},limit:{type:'integer',minimum:1,maximum:100}}),
  definition('misty_self_delete','Delete selected Misty-authored messages in this DM. Use on owner request or to correct your own duplicate/mistaken replies. First list real IDs. Never delete owner messages; does not erase saved memory or cancel approved work.',{ids:{type:'array',items:{type:'string'},minItems:1,maxItems:50}}),
  definition('misty_self_clear','On an explicit owner request to clear your messages, delete all Misty-authored messages before this owner request. Preserves owner messages, saved history and approved jobs.',{}),
  definition('misty_self_presence','Set your Discord availability and activity/status text. This is visible to shared-server members: never publish private chat/project details. Roleplay can be playful but never claim human identity or actual consciousness. Rate limited; successful result confirms Gateway write only.',{status:{type:'string',enum:['online','idle','dnd','invisible']},activity:{type:'string',enum:['custom','playing','listening','watching','competing','none']},text:{type:'string'}})
 ];}
 mark(id,request,state){
  this.relay.transaction(()=>{
   this.db.prepare('INSERT INTO misty_deleted_messages VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,updated=excluded.updated').run(id,this.api.channel,request,state,Date.now());
   if(!['deleted','already_missing'].includes(state))return;
   for(const notice of this.db.prepare('SELECT seq,source FROM relay_notices WHERE message_id=?').all(id)){
    this.db.prepare("UPDATE relay_notices SET status='deleted' WHERE seq=?").run(notice.seq);
    this.db.prepare("UPDATE relay_card_updates SET status='deleted' WHERE notice_seq=?").run(notice.seq);
    const code=/^draft:([a-f0-9]{10}):/.exec(notice.source)?.[1];
    if(code){
     this.db.prepare("UPDATE relay_drafts SET state='cancelled' WHERE code=? AND state='pending'").run(code);
     this.db.prepare("UPDATE relay_notices SET status='superseded' WHERE source LIKE ? AND status='queued'").run('draft:'+code+':%');
     this.db.prepare("UPDATE relay_forms SET state='cancelled' WHERE code=? AND state='pending'").run(code);
    }
   }
  });
 }
 async remove(ids,request){
  if(!snowflake(request)||!Array.isArray(ids)||!ids.length||ids.length>50||ids.some(id=>!snowflake(id)||BigInt(id)>=BigInt(request)))throw Error('Select up to 50 real older Misty messages.');
  const results=[];
  for(const id of new Set(ids)){
   this.mark(id,request,'attempting');
   try{const result=await this.api.deleteOwnMessage(id);this.mark(id,request,result.state);results.push(result);}
   catch(e){this.mark(id,request,'unconfirmed');results.push({id,state:'unconfirmed'});}
  }
  return {results,deleted:results.filter(r=>r.state==='deleted').length,missing:results.filter(r=>r.state==='already_missing').length,unconfirmed:results.filter(r=>r.state==='unconfirmed').length};
 }
 async clear(request){
  if(!snowflake(request))throw Error('Invalid cleanup boundary.');
  const ids=[];let before=request;
  // Snapshot all pages before mutation. If unexpectedly huge, do not partially clear.
  for(let pages=0;;pages++){
   if(pages>=100)throw Error('Cleanup exceeds 10,000 scanned messages; use selected-message deletion.');
   const page=await this.api.ownMessages({before,limit:100});ids.push(...page.messages.map(m=>m.id));
   if(!page.nextBefore)break;before=page.nextBefore;
  }
  const total={selected:ids.length,deleted:0,missing:0,unconfirmed:0};
  for(let i=0;i<ids.length;i+=50){const result=await this.remove(ids.slice(i,i+50),request);for(const key of ['deleted','missing','unconfirmed'])total[key]+=result[key];}
  return total;
 }
 async execute(name,args,row){
  if(this.api.forChannel&&row?.channel&&row.channel!==this.api.channel){const scoped=Object.create(this);scoped.api=this.api.forChannel(row.channel);return scoped.execute(name,args,row);}
  if(name==='misty_self_messages')return this.api.ownMessages(args);
  if(name==='misty_self_delete')return this.remove(args.ids,row.id);
  if(name==='misty_self_clear'){
   if(!/\b(delete|clear|remove|clean|wipe)\b/i.test(row.body)||!(/\b(all|everything|history|messages|chat)\b/i.test(row.body)))throw Error('Clearing all replies needs an explicit owner cleanup request.');
   return this.clear(row.id);
  }
  if(name==='misty_self_presence')return this.presence.set(args);
  throw Error('Unknown self-management tool.');
 }
 status(){return {presence:this.presence.current(),deletedMessages:this.db.prepare("SELECT count(*) n FROM misty_deleted_messages WHERE state IN ('deleted','already_missing')").get().n,scope:'Misty-authored messages in owner DM only; saved originals remain stored'};}
}
