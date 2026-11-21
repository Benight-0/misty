import fs from 'node:fs';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {knowledgeSignature} from './misty-knowledge.mjs';

import {redactSecrets} from './misty-redact.mjs';
export {redactSecrets};
export function textChunks(text,role,turn_id='',at='',start=0){const rows=[];text=redactSecrets(text);for(let pos=0;pos<text.length;){let end=Math.min(pos+12000,text.length);if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;rows.push({ordinal:start+rows.length,role,turn_id,at,text:text.slice(pos,end)});pos=end;}return rows;}
export function knowledgePage(rows,offset){let end=offset,bytes=0;while(end<rows.length&&end-offset<80&&bytes+Buffer.byteLength(JSON.stringify(rows[end]))<650000){bytes+=Buffer.byteLength(JSON.stringify(rows[end++]));}return rows.slice(offset,end);}
export async function rolloutChunks(filename,size){
 const rows=[];let turn='';
 if(!size)return rows;
 const lines=createInterface({input:fs.createReadStream(filename,{start:0,end:size-1}),crlfDelay:Infinity});
 for await(const line of lines){let e;try{e=JSON.parse(line);}catch{continue;}
  if(e.type==='turn_context'){turn=String(e.payload?.turn_id||e.payload?.turnId||'');continue;}
  const p=e.payload;
  if(e.type!=='response_item'||p?.type!=='message'||!['user','assistant'].includes(p.role)||['analysis','summary'].includes(p.channel)||['analysis','summary'].includes(p.phase))continue;
  const text=(p.content||[]).filter(c=>['input_text','output_text','text'].includes(c.type)).map(c=>c.text||'').join('\n');
  rows.push(...textChunks(text,p.role,turn,String(e.timestamp||''),rows.length));
 }
 return rows;
}
export async function codexTranscriptChunks(rpc,threadId){
 const rows=[],turns=new Set(),cursors=new Set();let cursor;
 do{
  // The installed backend transparently reads its compressed .jsonl.zst
  // archives. This read does not resume a thread or acquire an editor writer.
  const page=await rpc.request('thread/turns/list',{threadId,limit:30,itemsView:'full',sortDirection:'asc',...(cursor?{cursor}:{})},60000);
  for(const t of page.data||[]){if(turns.has(t.id))continue;turns.add(t.id);
   const n=Number(t.startedAt),at=t.startedAt!=null&&Number.isFinite(n)?new Date(n<100000000000?n*1000:n).toISOString():'';
   for(const item of t.items||[]){
    let role,text;
    if(item.type==='userMessage'){role='user';text=(item.content||[]).filter(c=>c.type==='text').map(c=>c.text||'').join('\n');}
    else if(item.type==='agentMessage'&&!['analysis','summary'].includes(item.phase)){role='assistant';text=item.text||'';}
    else continue;
    rows.push(...textChunks(text,role,String(t.id),at,rows.length));
   }
  }
  cursor=page.nextCursor;if(cursor&&cursors.has(cursor))throw Error('Repeated history cursor.');if(cursor)cursors.add(cursor);
 }while(cursor);
 return rows;
}
export function codeFiles(root){
 const files=[];const roots=['app','collector','scripts','docs','public'];
 function walk(dir){if(!fs.existsSync(dir))return;for(const e of fs.readdirSync(dir,{withFileTypes:true})){
  if(e.isSymbolicLink()||/^(node_modules|vendor|data|deployment|__pycache__|\.git|tests)$/.test(e.name))continue;
  const f=path.join(dir,e.name);if(e.isDirectory())walk(f);else if(/\.(mjs|js|py|go|mod|html|css|md|json|ps1|sh|service|timer)$/.test(e.name)&&!/(token|credential|secret|key|config\.json)/i.test(e.name)&&fs.statSync(f).size<=1500000)files.push(f);
 }}
 roots.forEach(d=>walk(path.join(root,d)));for(const f of ['WORK.md','README.md','package.json'])if(fs.existsSync(path.join(root,f)))files.push(path.join(root,f));return files;
}
export class MistyKnowledgeSync{
 constructor({root,rpc,vm,worker,db}){Object.assign(this,{root,rpc,vm,worker,db});this.cache=new Map();this.queue=[];this.current=null;this.nextScan=0;this.stopped=false;db.exec('CREATE TABLE IF NOT EXISTS knowledge_sync_errors(id TEXT PRIMARY KEY,at INTEGER NOT NULL,reason TEXT NOT NULL)');}
 async scan(chats){
  const remote=await this.vm.request('knowledge',{worker:this.worker,action:'inventory'});this.cache=new Map(remote.documents.map(d=>[d.id,d.revision]));
  this.queue=codeFiles(this.root).map(f=>({id:'code:'+path.relative(this.root,f).replaceAll('\\','/'),kind:'code',filename:f,title:path.relative(this.root,f),path:path.relative(this.root,f),thread_id:'',priority:0}));
  // Read only persisted rollouts. No thread resume, turn creation, or editor locks.
  for(const c of chats)this.queue.push({id:'codex:'+c.id,kind:'codex',filename:c.rolloutPath,title:c.title,path:c.cwd,thread_id:c.id,updated:c.updatedAt,priority:1});
  this.nextScan=Date.now()+180000;
 }
 prioritize(chats){
  if(Date.now()<(this.nextPriority||0))return;this.nextPriority=Date.now()+15000;
  const changed=[];
  for(const c of chats){
   if(this.current?.d.id==='codex:'+c.id||!c.rolloutPath||!fs.existsSync(c.rolloutPath))continue;
   const st=fs.statSync(c.rolloutPath),fingerprint=c.rolloutPath+':'+st.size+':'+st.mtimeMs;
   if(st.mtimeMs<Date.now()-86400000||this.fingerprints?.get('codex:'+c.id)===fingerprint)continue;
   changed.push({id:'codex:'+c.id,kind:'codex',filename:c.rolloutPath,title:c.title,path:c.cwd,thread_id:c.id,updated:st.mtimeMs});
  }
  changed.sort((a,b)=>b.updated-a.updated);const ids=new Set(changed.map(c=>c.id));
  this.queue=[...changed,...this.queue.filter(c=>!ids.has(c.id))];
 }
 tick(chats){if(!this.active)this.active=this.step(chats).finally(()=>{this.active=null;});return this.active;}
 async step(chats){
  if(this.stopped)return;
  if(!this.current&&!this.queue.length){if(Date.now()>=this.nextScan)await this.scan(chats);else this.prioritize(chats);}
  this.prioritize(chats);
  if(!this.current){
   const d=this.queue.shift();if(!d)return;
   try{
    if(d.kind==='codex'&&!d.filename){const r=await this.rpc.request('thread/read',{threadId:d.thread_id,includeTurns:false});d.filename=r.thread?.path;}
    if(d.kind==='codex'&&d.filename&&!fs.existsSync(d.filename)&&fs.existsSync(d.filename+'.zst'))d.filename+='.zst';
    if(!d.filename||!fs.existsSync(d.filename))throw Error('Saved transcript unavailable.');
    // Codex controls the rollout path; never accept arbitrary paths from Discord.
    if(d.kind==='codex'&&(!/[/\\]\.codex[/\\](sessions|archived_sessions)[/\\]/i.test(d.filename)||!d.filename.endsWith('.jsonl')&&!d.filename.endsWith('.jsonl.zst')))throw Error('Unsupported transcript location.');
    const st=fs.statSync(d.filename),fingerprint=d.filename+':'+st.size+':'+st.mtimeMs;
    if(this.fingerprints?.get(d.id)===fingerprint)return;
    const rows=d.kind==='code'?textChunks(fs.readFileSync(d.filename,'utf8'),'code'):d.filename.endsWith('.zst')?await codexTranscriptChunks(this.rpc,d.thread_id):await rolloutChunks(d.filename,st.size);
    const revision=knowledgeSignature(rows);this.fingerprints??=new Map();
    if(this.cache.get(d.id)===revision){this.fingerprints.set(d.id,fingerprint);this.db.prepare('DELETE FROM knowledge_sync_errors WHERE id=?').run(d.id);return;}
    this.current={d,rows,revision,fingerprint,offset:0,stage:'begin',updated:Math.floor(st.mtimeMs)};
   }catch{this.db.prepare('INSERT INTO knowledge_sync_errors VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET at=excluded.at,reason=excluded.reason').run(d.id,Date.now(),'Snapshot unavailable; last synced version retained.');return;}
  }
  const c=this.current,base={worker:this.worker,id:c.d.id};
  if(c.stage==='begin'){await this.vm.request('knowledge',{...base,action:'begin',meta:{kind:c.d.kind,title:c.d.title,path:c.d.path,thread_id:c.d.thread_id,revision:c.revision,parts:c.rows.length,characters:c.rows.reduce((n,r)=>n+r.text.length,0),updated:c.updated}});c.stage='chunks';}
  else if(c.offset<c.rows.length){const page=knowledgePage(c.rows,c.offset);await this.vm.request('knowledge',{...base,action:'chunks',rows:page});c.offset+=page.length;}
  else{await this.vm.request('knowledge',{...base,action:'commit'});this.cache.set(c.d.id,c.revision);this.fingerprints.set(c.d.id,c.fingerprint);this.db.prepare('DELETE FROM knowledge_sync_errors WHERE id=?').run(c.d.id);this.current=null;}
 }
}
