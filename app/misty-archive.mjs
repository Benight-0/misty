import http from 'node:http';
import fs from 'node:fs';
import {timingSafeEqual} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export function journalSchema(db,now=Date.now()){
 db.exec(`CREATE TABLE IF NOT EXISTS misty_message_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,message_id TEXT UNIQUE NOT NULL,room_id TEXT NOT NULL,at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS misty_activation(id INTEGER PRIMARY KEY CHECK(id=1),at INTEGER NOT NULL);`);
 db.prepare('INSERT OR IGNORE INTO misty_activation VALUES(1,?)').run(now);
 db.exec(`DROP TRIGGER IF EXISTS misty_message_arrived;
 CREATE TRIGGER misty_message_arrived AFTER INSERT ON messages
 WHEN (new.ts>=(SELECT at FROM misty_activation WHERE id=1) AND new.ts>=CAST(strftime('%s','now') AS INTEGER)*1000-300000 AND new.ts<=CAST(strftime('%s','now') AS INTEGER)*1000+60000)
 OR EXISTS(SELECT 1 FROM conversations c WHERE c.id=new.room_id AND c.platform='gmail' AND c.connected=1)
 BEGIN INSERT OR IGNORE INTO misty_message_events(message_id,room_id,at) VALUES(new.id,new.room_id,CAST(strftime('%s','now') AS INTEGER)*1000); END;`);
}
export function archiveRead(filename,op,args={}){return new Promise((resolve,reject)=>{
 const child=spawn(process.env.PYTHON||'python3',[fileURLToPath(new URL('../scripts/misty-archive-query.py',import.meta.url)),filename],{stdio:['pipe','pipe','pipe'],windowsHide:true});
 let body='',size=0,settled=false;const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
 const timer=setTimeout(()=>{child.kill();finish(new Error('Archive read timed out.'));},6000);
 child.stdout.on('data',part=>{size+=part.length;if(size>180000){child.kill();finish(new Error('Archive result exceeded budget.'));}else body+=part;});
 child.stderr.on('data',()=>{});child.once('error',()=>finish(new Error('Archive reader unavailable.')));child.stdin.on('error',()=>{});
 child.once('close',code=>{try{const data=JSON.parse(body);if(code||data.error)throw Error();finish(null,data);}catch{finish(new Error('Archive query rejected or exceeded its budget.'));}});
 child.stdin.end(JSON.stringify({op,args}));
});}
export function serveArchiveTools(store,{tokenFile,port=8791}={}){
 const token=fs.readFileSync(tokenFile,'utf8').trim();if(token.length<32)throw new Error('Invalid archive tool credential.');
 journalSchema(store.db);let active=0;
 const server=http.createServer(async(req,res)=>{
  const expected='Bearer '+token,auth=String(req.headers.authorization||'');
  if(Buffer.byteLength(auth)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(auth),Buffer.from(expected))){res.writeHead(401).end();return;}
  if(req.method!=='POST'||req.url!=='/read'){res.writeHead(404).end();return;}
  if(active>=1){res.writeHead(429).end();return;}active++;
  try{let body='';for await(const part of req){body+=part;if(Buffer.byteLength(body)>32768)throw Error();}
   const {op,args}=JSON.parse(body),result=await archiveRead(store.filename,op,args);
   res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(result));
  }catch{res.writeHead(400,{'Content-Type':'application/json'}).end(JSON.stringify({error:'Archive tool unavailable or request rejected.'}));}finally{active--;}
 });server.requestTimeout=10000;server.listen(port,'127.0.0.1');return server;
}
export class ArchiveTools{
 constructor({tokenFile,port=8791,fetchImpl=fetch}={}){this.tokenFile=tokenFile;this.port=port;this.fetch=fetchImpl;}
 async read(op,args={}){
  const token=fs.readFileSync(this.tokenFile,'utf8').trim();
  for(let attempt=0;attempt<6;attempt++){
   const response=await this.fetch(`http://127.0.0.1:${this.port}/read`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({op,args}),signal:AbortSignal.timeout(8000)});
   if(response.status===429&&attempt<5){await new Promise(resolve=>setTimeout(resolve,Math.min(1000,150*2**attempt)));continue;}
   if(!response.ok)throw new Error('Archive read unavailable; retry later.');return response.json();
  }
 }
 definitions(){
  const s={type:'string'},integer={type:'integer'};
  return [
   ['archive_chats','Find connected chat and Gmail thread IDs and names.',{query:s}],
   ['archive_search','Search original chat messages and stored Gmail text with FTS5; AND prefix terms, source IDs and timestamps. Empty room searches all connected conversations.',{query:s,room:s}],
   ['archive_source','Retrieve one current original message by exact source ID, with a verified source hyperlink. offset=0 starts; follow nextOffset for long text, checking bodyHash across pages. Use for evidence and source follow-ups; unavailable means missing, deleted or disconnected, never invent a replacement link.',{id:s,offset:integer}],
   ['archive_summary','Get stored, evidence-checked chat summary, people observations, events and coverage. Empty person returns group; person ID focuses one profile. Not proof of complete lifetime history.',{room:s,person:s}],
   ['archive_context','Read up to 200 recent chat or Gmail messages in a conversation within a time window; timestamps are Unix milliseconds; use 0 for default.',{room:s,since:integer,before:integer}],
   ['archive_servers','List selected collected Discord servers and server-style WhatsApp groups with their channel/community summary availability.',{query:s}],
   ['archive_server_summary','Read the rolling server/community and channel summaries. Supply room for one channel, server for a community; an empty value means no filter. Fresh collection only; old history is excluded.',{server:s,room:s}],
   ['archive_server_history','Read saved summary history for one server-style channel. before is a summary timestamp in milliseconds, or 0 for latest. Follow nextBefore for older batches; raw text may have expired.',{room:s,before:integer}],
   ['archive_profile','Read stored owner interests with confidence and review status.',{}],
   ['archive_schema','Inspect read-only query views and limits.',{}],
   ['archive_sql','Execute bounded read-only SELECT over documented views. Read schema first. No access to secrets or raw platform data.',{sql:s,params:{type:'array',items:{type:['string','number','null']}}}]
  ].map(([name,description,properties])=>({type:'function',name,description,strict:true,parameters:{type:'object',properties,required:Object.keys(properties),additionalProperties:false}}));
 }
 execute(name,args){const op=name.replace(/^archive_/,'');if(!this.definitions().some(t=>t.name===name))throw new Error('Tool not allowed.');return this.read(op,args);}
}
