import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {BotStore} from '../discord-bot.mjs';
import {MistyRelay,digestJob,chunks} from '../misty-relay.mjs';
import {CodexJobs,listCodexChats} from '../codex-relay-client.mjs';

const cwd=process.cwd(),a='01a11111-1111-7111-8111-111111111111',b='01a22222-2222-7222-8222-222222222222';
function setup(t){const store=new BotStore(':memory:');t.after(()=>store.close());let calls=0;const client={generate:async()=>{calls++;return {message:{content:JSON.stringify({mode:'draft',reply:'I suggest using the Misty project chat.',draftCode:'',prompt:'Improve the Misty chat loading speed. Preserve all archived messages.',chatId:a,workspace:cwd,reason:'This chat contains the Misty project history.'})}};}};const relay=new MistyRelay(store,client,{defaultCwd:cwd});relay.setCatalog({worker:'laptop',chats:[{id:a,title:'Misty archive',cwd},{id:b,title:'Other project',cwd}]});return {store,relay,calls:()=>calls};}
const row=(id,body)=>({id,body});
const current=r=>r.db.prepare('SELECT * FROM relay_drafts ORDER BY created DESC LIMIT 1').get();
const sent=async r=>r.sendNotices({send:async()=>String(Date.now())});

test('rough prompt only creates preview, owner must approve complete delivered preview',async t=>{
 const {relay:r,calls}=setup(t);await r.handle(row('rough','make misty faster'));const d=current(r);
 assert.equal(r.claim('laptop'),null);assert.equal(calls(),1);
 assert.match(await r.handle(row('early','!send '+d.code)),/entire preview/);assert.equal(r.claim('laptop'),null);
 await sent(r);assert.match(await r.handle(row('approved','!send '+d.code)),/Approved/);
 const j=r.claim('laptop');assert.equal(j.prompt,d.prompt);assert.equal(j.target.id,a);assert.equal(j.hash,digestJob(d.prompt,j.target));
 await r.handle(row('duplicate','!send '+d.code));assert.equal(r.db.prepare('SELECT count(*) n FROM relay_jobs').get().n,1);
});

test('editing exact prompt and changing target invalidate previous confirmation codes',async t=>{
 const {relay:r}=setup(t);await r.handle(row('rough','improve'));let d=current(r),first=d.code;
 await r.handle(row('edit','!edit '+d.code+' Exact replacement\nwith two lines.'));d=current(r);assert.notEqual(d.code,first);assert.equal(d.prompt,'Exact replacement\nwith two lines.');
 assert.match(await r.handle(row('old','!send '+first)),/latest preview code/);
 const second=d.code;await r.handle(row('chat','!chat '+d.code+' '+b));d=current(r);assert.notEqual(d.code,second);assert.equal(JSON.parse(d.target).id,b);
 await sent(r);await r.handle(row('approve','!send '+d.code));const job=r.claim('laptop');assert.equal(job.target.id,b);assert.equal(job.prompt,d.prompt);
});

test('restart/replayed incoming message does not regenerate plans; cancelled and expired drafts cannot run',async t=>{
 const {relay:r,calls}=setup(t);const request=row('rough','improve');const reply=await r.handle(request);assert.equal(await r.handle(request),reply);assert.equal(calls(),1);
 let d=current(r);await r.handle(row('cancel','!cancel '+d.code));await sent(r);assert.match(await r.handle(row('approve','!send '+d.code)),/latest preview code/);assert.equal(r.claim('laptop'),null);
 await r.handle(row('rough2','again'));d=current(r);r.db.prepare('UPDATE relay_drafts SET expires=0 WHERE id=?').run(d.id);assert.match(await r.handle(row('expired','!send '+d.code)),/expired/);
});

test('offline approvals wait durably; worker and destination mismatch rejected; completion delivered once',async t=>{
 const {relay:r,store}=setup(t);store.set('relay_heartbeat',0);await r.handle(row('rough','improve'));const d=current(r);await sent(r);assert.match(await r.handle(row('approve','!send '+d.code)),/reconnects/);
 assert.throws(()=>r.claim('stranger'));const job=r.claim('laptop');assert.equal(r.claim('laptop').id,job.id);
 assert.throws(()=>r.progress({id:job.id,worker:'laptop',hash:job.hash,status:'running',threadId:b,turnId:'turn'}));
 r.progress({id:job.id,worker:'laptop',hash:job.hash,status:'submitting',threadId:a});r.progress({id:job.id,worker:'laptop',hash:job.hash,status:'running',threadId:a,turnId:'turn'});
 const result={id:job.id,worker:'laptop',hash:job.hash,status:'completed',threadId:a,turnId:'turn',answer:'done'};
 assert.throws(()=>r.result({...result,threadId:b}));r.result(result);const n=r.db.prepare('SELECT count(*) n FROM relay_notices').get().n;r.result(result);assert.equal(r.db.prepare('SELECT count(*) n FROM relay_notices').get().n,n);assert.equal(r.claim('laptop'),null);
});

test('unknown Discord delivery blocks confirmation until a new preview is sent; Unicode survives chunks',async t=>{
 const {relay:r}=setup(t);await r.handle(row('rough','improve'));const first=current(r);await r.sendNotices({send:async()=>{throw Error('disconnected');}});
 assert.match(await r.handle(row('approve','!send '+first.code)),/entire preview/);await r.handle(row('show','!show '+first.code));const d=current(r);await sent(r);await r.handle(row('send','!send '+d.code));assert.ok(r.claim('laptop'));
 const text='a'.repeat(1749)+'😀'+'b'.repeat(2000);assert.equal(chunks(text).join(''),text);assert.ok(chunks(text).every(x=>x.length<=1750));
});

class FakeRPC extends EventEmitter {
 constructor(){super();this.calls=[];this.closed=false;}
 async request(method,p){this.calls.push({method,p});if(method==='thread/read'||method==='thread/resume')return {thread:{id:a,cwd,status:{type:'idle'}}};
  if(method==='turn/start'){queueMicrotask(()=>{this.emit('notification','item/completed',{threadId:a,turnId:'turn',item:{id:'answer',type:'agentMessage',phase:'final_answer',text:'Exact final answer'}});this.emit('notification','turn/completed',{threadId:a,turn:{id:'turn',status:'completed',items:[]}});});return {turn:{id:'turn'}};}
  if(method==='thread/turns/list')return {data:[]};throw Error(method);
 }
}
function job(){const target={kind:'existing',id:a,title:'Misty',cwd};return {id:'job',target,prompt:'Exact approved text',hash:digestJob('Exact approved text',target)};}

test('Codex receives exact approved text/chat; settled journal replay never repeats turn',async t=>{
 const store=new BotStore(':memory:');t.after(()=>store.close());const rpc=new FakeRPC(),jobs=new CodexJobs(rpc,store.db,{busyCheck:async()=>false}),j=job();
 const answer=await jobs.run(j);assert.equal(answer.answer,'Exact final answer');assert.equal(answer.threadId,a);const submit=rpc.calls.find(c=>c.method==='turn/start');assert.deepEqual(submit.p.input,[{type:'text',text:j.prompt}]);assert.equal(submit.p.threadId,a);
 assert.deepEqual(await jobs.run(j),answer);assert.equal(rpc.calls.filter(c=>c.method==='turn/start').length,1);
 await assert.rejects(jobs.run({...j,prompt:'Changed after approval'}),/hash mismatch/);
});

test('busy or unavailable selected chat is never silently rerouted; ambiguous submission never repeated',async t=>{
 const store=new BotStore(':memory:');t.after(()=>store.close());const rpc=new FakeRPC(),busy=new CodexJobs(rpc,store.db,{busyCheck:async()=>true});assert.deepEqual(await busy.run(job()),{blocked:true});assert.ok(!rpc.calls.some(c=>c.method==='turn/start'));busy.close();
 const jobs=new CodexJobs(rpc,store.db,{busyCheck:async()=>false});store.db.prepare("UPDATE codex_jobs SET stage='submitting',thread_id=? WHERE id='job'").run(a);
 const result=await jobs.run(job());assert.equal(result.status,'unknown');assert.ok(!rpc.calls.some(c=>c.method==='turn/start'));assert.equal((await jobs.run(job())).status,'unknown');
});

test('catalog pagination deduplicates overlapping pages without losing other chats',async()=>{
 let i=0;const rpc={request:async()=>i++===0?{data:[{id:a,cwd,name:'A'}],nextCursor:'next'}:{data:[{id:a,cwd,name:'A'},{id:b,cwd,name:'B'}]}};
 assert.deepEqual((await listCodexChats(rpc)).map(t=>t.id),[a,b]);
});
