import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {BotStore} from '../discord-bot.mjs';
import {MistyRelay} from '../misty-relay.mjs';
import {ProminenceBridge,serveProminenceBridge} from '../misty-prominence-bridge.mjs';
import {CodexEventSync} from '../codex-events.mjs';
import {ApolloMessenger} from '../apollo.mjs';
import {pumpCodexNotices} from '../codex-reader.mjs';
const id='11111111-1111-1111-1111-111111111111',owner='100000000000000052';
function fixture(t){
 const s=new BotStore(':memory:');t.after(()=>s.close());let calls=0;
 const r=new MistyRelay(s,{generate:async()=>{calls++;throw Error('Dispatch review should not run');}});
 r.setCatalog({worker:'laptop',chats:[{id,title:'Project',cwd:'C:\\project',preview:''}]});
 s.db.prepare('INSERT INTO bot_turns(id,channel,body,ts,status) VALUES(?,?,?,?,?)').run(owner,'owner-dm','Implement the fix in the Project Codex chat; complete and verify it.',Date.now(),'external');
 return {r,s,b:new ProminenceBridge(r),calls:()=>calls};
}
const request={ownerMessageId:owner,chatId:id,prompt:'Implement and verify the requested fix.'};
test('clear owner task queues directly, once, without cards and with exact destination',async t=>{
 const {b,r,calls}=fixture(t);const [a,c]=await Promise.all([b.execute('send',request),b.execute('send',request)]);
 assert.equal(a.queued,true);assert.equal(c.code,a.code);assert.equal(calls(),0);
 assert.equal(r.db.prepare('SELECT count(*) n FROM relay_jobs').get().n,1);
 assert.equal(r.db.prepare('SELECT count(*) n FROM relay_drafts').get().n,0);
 assert.equal(r.claim('laptop').target.id,id);
 assert.equal((await b.execute('send',request)).reused,true);
 await assert.rejects(b.execute('send',{...request,prompt:'unrelated task'}),/different task/);
});
test('invented owner, chat and workspace fail before direct admission',async t=>{
 const {b,r}=fixture(t);
 await assert.rejects(b.execute('send',{...request,ownerMessageId:'100000000000000053'}),/recorded owner/);
 await assert.rejects(b.execute('send',{...request,chatId:'bad'}),/actual catalog/);
 await assert.rejects(b.execute('send',{...request,chatId:'NEW',workspace:'bad'}),/known workspace/);
 assert.equal(r.db.prepare('SELECT count(*) n FROM relay_jobs').get().n,0);
});
test('overlay queues an exact selected-chat prompt once and rejects a reused ID with different work',async t=>{
 const {b,r}=fixture(t),clientId='22222222-2222-4222-8222-222222222222';
 const args={clientId,chatId:id,prompt:'  Check the build and report results.  '};
 const first=await b.execute('overlay_codex_send',args);
 assert.equal(first.queued,true);assert.equal(first.target.id,id);
 assert.equal((await b.execute('overlay_codex_send',args)).reused,true);
 assert.equal(r.db.prepare('SELECT count(*) n FROM relay_jobs').get().n,1);
 assert.equal(r.claim('laptop').prompt,'Check the build and report results.');
 assert.throws(()=>r.direct.sendFromOverlay({...args,prompt:'Different task'}),/different prompt/);
 assert.throws(()=>r.direct.sendFromOverlay({...args,chatId:'missing'}),/existing Codex chat/);
 assert.throws(()=>r.direct.sendFromOverlay({...args,clientId:'bad'}),/stable overlay/);
});
test('direct follow-through is scoped to the existing chat and uses the existing revocable grant',async t=>{
 const {b,r}=fixture(t),v=await b.execute('send',{...request,followThrough:true});
 const grant=r.db.prepare('SELECT * FROM misty_work_grants').get();
 assert.equal(v.followThrough,true);assert.equal(grant.thread_id,id);assert.equal(grant.remaining,6);
 r.work.stop(v.code);assert.equal(r.db.prepare('SELECT state FROM misty_work_grants').get().state,'stopped');
});
test('a newer owner instruction stops direct admission',async t=>{
 const {b,r,s}=fixture(t);
 s.db.prepare('INSERT INTO bot_turns(id,channel,body,ts,status) VALUES(?,?,?,?,?)').run('100000000000000053','dm','Wait, stop.',Date.now()+1,'external');
 assert.equal((await b.execute('send',request)).queued,false);assert.equal(r.db.prepare('SELECT count(*) n FROM relay_jobs').get().n,0);
});
test('Apollo token can read Codex data but cannot send, approve, or read code documents',async t=>{
 const {r}=fixture(t),dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-reader-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const token='a'.repeat(48),file=path.join(dir,'token');fs.writeFileSync(file,token);
 const server=serveProminenceBridge(r,{tokenFile:file,port:0,readOnly:true});await once(server,'listening');t.after(()=>new Promise(res=>server.close(res)));
 const call=async(op,args={})=>fetch('http://127.0.0.1:'+server.address().port+'/call',{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify({op,args})});
 assert.equal((await call('chats')).status,200);assert.equal((await call('knowledge_find',{query:'x',kind:'codex'})).status,200);
 for(const op of ['send','overlay_codex_send','draft','approve','control','record','archive'])assert.equal((await call(op,request)).status,400);
 assert.equal((await call('knowledge_find',{query:'x',kind:'code'})).status,400);assert.equal((await call('knowledge_read',{document:'code:secret'})).status,400);
});
function watcher(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-events-')),folder=path.join(dir,'.codex','sessions');fs.mkdirSync(folder,{recursive:true});t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const filename=path.join(folder,'active.jsonl'),db=new DatabaseSync(':memory:');t.after(()=>db.close());let now=100000,fail=false;const uploaded=[];
 const vm={request:async(method,args)=>{assert.equal(method,'codex_events');if(fail)throw Error('offline');uploaded.push(...args.events);}};
 const sync=new CodexEventSync({db,vm,worker:'laptop',clock:()=>now});
 const event=(type,payload,at=100000)=>JSON.stringify({type,payload,timestamp:new Date(at).toISOString()})+'\n';
 return {filename,db,vm,sync,event,chat:{id,rolloutPath:filename},uploaded,time:n=>now=n,fail:v=>fail=v};
}
test('tail excludes old history and hidden reasoning; partial writes, duplicate polls and restart are safe',async t=>{
 const w=watcher(t),turn='turn';
 const text=(phase,text)=>w.event('response_item',{type:'message',role:'assistant',phase,content:[{type:'output_text',text}]});
 fs.writeFileSync(w.filename,w.event('event_msg',{type:'task_complete',turn_id:'old',last_agent_message:'OLD'},90000)+w.event('event_msg',{type:'task_started',turn_id:turn})+text('analysis','HIDDEN')+text('commentary','Working on it')+text('final_answer','Finished'));
 await w.sync.tick([w.chat]);assert.deepEqual(w.uploaded.map(e=>e.text),['Working on it']);
 const done=w.event('event_msg',{type:'task_complete',turn_id:turn,last_agent_message:'Finished'},104000);fs.appendFileSync(w.filename,done.trimEnd());w.time(104000);await w.sync.tick([w.chat]);assert.equal(w.uploaded.length,1);
 fs.appendFileSync(w.filename,'\n');w.time(108000);await w.sync.tick([w.chat]);assert.deepEqual(w.uploaded.map(e=>e.kind),['message','completed']);
 w.time(112000);const next=new CodexEventSync({db:w.db,vm:w.vm,worker:'laptop',clock:()=>112000});await next.tick([w.chat]);assert.equal(w.uploaded.length,2);
});
test('event outbox survives a lost connection and VM deduplicates replayed receipts',async t=>{
 const w=watcher(t);fs.writeFileSync(w.filename,w.event('event_msg',{type:'task_complete',turn_id:'turn',last_agent_message:'Finished'}));w.fail(true);
 await assert.rejects(w.sync.tick([w.chat]),/offline/);assert.equal(w.db.prepare('SELECT count(*) n FROM codex_event_outbox').get().n,1);
 w.fail(false);w.time(104000);await w.sync.tick([w.chat]);assert.equal(w.uploaded.length,1);
 const {r}=fixture(t);r.codexEvents.publish({worker:'laptop',events:w.uploaded});r.codexEvents.publish({worker:'laptop',events:w.uploaded});assert.equal(r.codexEvents.read(0).events.length,1);
 assert.throws(()=>r.codexEvents.publish({worker:'stranger',events:w.uploaded}),/pairing/);
});
test('Apollo stores and queues new visible Codex updates once, with the real chat link',async t=>{
 const store=new BotStore(':memory:');t.after(()=>store.close());const apollo=new ApolloMessenger(store,{},{}),events=[{seq:1,id:'a',kind:'completed',at:store.get('apollo_codex_live_since'),text:'Done',thread_id:id,title:'Project'}];
 const reader={call:async(op,args)=>({events:events.filter(e=>e.seq>args.after)})};
 await pumpCodexNotices(apollo,reader);await pumpCodexNotices(apollo,reader);
 assert.equal(store.get('codex_event_cursor'),1);const row=store.db.prepare("SELECT * FROM apollo_findings WHERE kind='codex'").get();assert.match(row.summary,/Codex finished/);assert.match(row.summary,/vscode:\/\//);assert.equal(store.db.prepare('SELECT count(*) n FROM apollo_findings').get().n,1);assert.equal(store.db.prepare('SELECT count(*) n FROM relay_notices').get().n,1);
});
