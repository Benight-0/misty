import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {ArchiveStore} from '../store.mjs';
import {BotStore} from '../discord-bot.mjs';
import {MistyRelay} from '../misty-relay.mjs';
import {MistyNotifications} from '../misty-notifications.mjs';
import {journalSchema,ArchiveTools} from '../misty-archive.mjs';
import {OpenAIAnalysis} from '../openai-analysis.mjs';
import {applyNativeEvent} from '../native-ingest.mjs';
import {configureWhatsAppGroups} from '../whatsapp-groups.mjs';

const response=value=>({message:{content:JSON.stringify(value)}});
function harness(t){const store=new BotStore(':memory:');t.after(()=>store.close());const relay=new MistyRelay(store,{generate:async()=>{throw Error('Unconfigured test model');}});return {store,relay};}
const event=(seq,patch={})=>({seq,message_id:'m'+seq,room_id:'group',ts:Date.now(),at:Date.now(),name:'Group',platform:'discord',kind:'group',server_id:'',is_me:0,...patch});

test('archive reads retry a busy reader without treating it as missing data',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'misty-tool-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const tokenFile=path.join(dir,'token');fs.writeFileSync(tokenFile,'test-credential');let calls=0;
 const archive=new ArchiveTools({tokenFile,fetchImpl:async()=>++calls===1?new Response('',{status:429}):Response.json({rows:[{id:'found'}]})});
 assert.equal((await archive.read('chats',{})).rows[0].id,'found');assert.equal(calls,2);
});

test('journal begins with future arrivals and ignores old history, duplicates and edits',t=>{
 const store=new ArchiveStore(':memory:');t.after(()=>store.close());const now=Date.now();
 store.db.prepare("INSERT INTO conversations(id,name,platform,kind) VALUES('g','G','discord','group')").run();
 const add=(id,ts)=>store.db.prepare("INSERT OR IGNORE INTO messages(id,room_id,sender,ts,body,original_body) VALUES(?,'g','@owner:localhost',?,'text','text')").run(id,ts);
 add('before',now);journalSchema(store.db,now);add('old',now-86400000);add('new',now+1);add('new',now+1);
 store.db.prepare("UPDATE messages SET body='edited' WHERE id='new'").run();
 assert.deepEqual(store.db.prepare('SELECT message_id FROM misty_message_events').all().map(r=>r.message_id),['new']);
});

test('supervisor journal includes late connected Gmail arrivals without replaying chat history',t=>{
 const store=new ArchiveStore(':memory:');t.after(()=>store.close());const now=Date.now();
 store.db.prepare("INSERT INTO conversations(id,name,platform,kind) VALUES('mail','Mail','gmail','mailbox')").run();
 journalSchema(store.db,now);
 store.db.prepare("INSERT INTO messages(id,room_id,sender,ts,body,original_body) VALUES('late-mail','mail','@owner:localhost',?,'subject','subject')").run(now-86400000);
 assert.equal(store.db.prepare('SELECT message_id FROM misty_message_events').get().message_id,'late-mail');
});

test('notification ingestion is durable, per incoming group message and exact 50-message server chunks',t=>{
 const {relay}=harness(t),watch=new MistyNotifications(relay,{});
 const rows=[event(1),event(2,{is_me:1}),...Array.from({length:101},(_,i)=>event(i+3,{kind:'channel',room_id:'server',server_id:'guild'}))];
 watch.ingest(rows);watch.ingest(rows);
 const jobs=relay.db.prepare('SELECT kind,events FROM misty_watch_jobs').all();
 assert.equal(jobs.filter(j=>j.kind==='group').length,1);assert.deepEqual(jobs.filter(j=>j.kind==='server').map(j=>JSON.parse(j.events).length),[50,50]);
 const ids=jobs.flatMap(j=>JSON.parse(j.events).map(e=>e.seq));assert.equal(new Set(ids).size,101);
 assert.equal(JSON.parse(relay.db.prepare("SELECT events FROM misty_watch_buffers WHERE room_id='server'").get().events).length,1);
 assert.equal(relay.store.get('misty_watch_cursor'),103);
});

test('notification decisions require current incoming source evidence and deduplicate topics',async t=>{
 const {relay}=harness(t);let seq=1,calls=0;
 const archive={read:async(op,args)=>{
  if(op==='events')return {rows:[event(seq)]};
  if(op==='watch_context')return args.hashes?{eligible:true,valid:true,sources:[{id:'m'+seq,url:'https://example.org/source'}]}:{eligible:true,newMessages:[{id:'m'+seq,room_id:'group',body:'Opportunity',is_me:0}],hashes:{['m'+seq]:'hash'}};
  return {};
 }};
 relay.client.generate=async()=>{calls++;return response({notify:true,priority:'normal',topic:'research-opening',message:'A research opening looks relevant.',reason:'Concrete opportunity',sources:['m'+seq]});};
 const watch=new MistyNotifications(relay,archive);await watch.tick();seq++;await watch.tick();
 assert.equal(calls,2);assert.equal(relay.db.prepare("SELECT count(*) n FROM relay_notices WHERE source LIKE 'watch:%'").get().n,1);
 seq++;relay.client.generate=async()=>response({notify:true,topic:'other',message:'Invalid',sources:['invented']});await watch.tick();
 assert.equal(relay.db.prepare("SELECT count(*) n FROM misty_watch_jobs WHERE state='queued'").get().n,1);
});

test('owner work pins one dedicated chat, continues once and supports revocation',async t=>{
 const {relay}=harness(t),now=Date.now(),thread='01a11111-1111-7111-8111-111111111111';
 relay.db.prepare("INSERT INTO relay_drafts VALUES('root','owner','abc1234567','task','Fix the search bug and verify it.',?,?,'task','pending',?,?)").run(JSON.stringify({kind:'new',title:'Misty work',cwd:process.cwd()}),'[]',now,now+86400000);
 const d=relay.findDraft('abc1234567');relay.preview(d);await relay.sendNotices({send:async()=> '123'});
 relay.transaction(()=>relay.work.approve(d));
 relay.db.prepare("UPDATE relay_jobs SET status='completed',thread_id=?,turn_id='turn',result='Fix implemented, verification remains.' WHERE id='root'").run(thread);
 let calls=0;relay.client.generate=async()=>{calls++;return response({action:'continue',reply:'Checking the fix.',prompt:'Run the focused search verification.',reason:'Part of task'});};
 await relay.work.tick();await relay.work.tick();assert.equal(calls,1);
 const next=relay.db.prepare("SELECT * FROM relay_jobs WHERE id<>'root'").get();assert.equal(JSON.parse(next.target).id,thread);assert.equal(JSON.parse(next.target).cwd,process.cwd());
 assert.equal(relay.work.list()[0].remaining,5);relay.work.stop(d.code);
 assert.equal(relay.db.prepare('SELECT status FROM relay_jobs WHERE id=?').get(next.id).status,'failed');
 await relay.work.tick();assert.equal(calls,1);
});

test('work mode cannot reuse an existing chat and an ask pauses continuation',async t=>{
 const {relay}=harness(t);assert.throws(()=>relay.work.approve({target:JSON.stringify({kind:'existing'})}),/dedicated/);
 const now=Date.now();relay.db.prepare("INSERT INTO misty_work_grants(id,root_job,goal,workspace,created,expires) VALUES('grant','root','Fix search',?, ?,?)").run(process.cwd(),now,now+86400000);
 relay.db.prepare("INSERT INTO relay_jobs(id,code,prompt,target,hash,status,thread_id,turn_id,result,created,updated) VALUES('root','grant','Fix search','{}','hash','completed','thread','turn','Done',?,?)").run(now,now);
 relay.client.generate=async()=>response({action:'ask',reply:'Do you want me to deploy this?',prompt:'',reason:'Deployment was not requested'});
 await relay.work.tick();assert.equal(relay.db.prepare('SELECT count(*) n FROM relay_jobs').get().n,1);assert.equal(relay.work.list()[0].state,'needs_owner');
});

test('expired grants cannot admit queued or claimed follow-ups after a restart',t=>{
 const {relay}=harness(t);relay.setCatalog({worker:'laptop',chats:[]});const now=Date.now();
 relay.db.prepare("INSERT INTO misty_work_grants(id,root_job,goal,workspace,created,expires) VALUES('g','root','Fix search','workspace',?,?)").run(now-5000,now-1);
 relay.db.prepare("INSERT INTO relay_jobs(id,code,prompt,target,hash,status,worker,created,updated) VALUES('next','g','verify','{}','hash','claimed','laptop',?,?)").run(now-1000,now-1000);
 relay.db.prepare("INSERT INTO misty_work_steps(previous_job,grant_id,next_job,state) VALUES('root','g','next','done')").run();
 assert.equal(relay.claim('laptop'),null);assert.equal(relay.work.list()[0].state,'expired');
 assert.equal(relay.db.prepare("SELECT status FROM relay_jobs WHERE id='next'").get().status,'failed');
 assert.throws(()=>relay.progress({id:'next',worker:'laptop',hash:'hash',status:'submitting',threadId:'thread'}),/settled/);
});

test('archive SQL permits views but rejects secrets, writes, CTE impersonation and extension loading',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'misty-archive-test-')),filename=path.join(dir,'archive.sqlite'),store=new ArchiveStore(filename);t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 store.db.prepare("INSERT INTO conversations(id,name,platform,kind) VALUES('g','Public test','discord','group')").run();
 store.db.prepare("INSERT INTO messages(id,room_id,sender,ts,body,original_body) VALUES('source','g','@owner:localhost',?,'quasar test','quasar test')").run(Date.now());journalSchema(store.db);
 const invoke=(op,args)=>{const p=spawnSync(process.platform==='win32'?'python':'python3',['scripts/misty-archive-query.py',filename],{input:JSON.stringify({op,args}),encoding:'utf8'});assert.ok(p.stdout,p.stderr);return {code:p.status,data:JSON.parse(p.stdout)};};
 assert.equal(invoke('sql',{sql:'SELECT name,message_count FROM chats',params:[]}).data.rows[0].name,'Public test');
 for(const sql of ['SELECT value FROM settings',"SELECT load_extension('evil')",'DELETE FROM chats','WITH chats AS (SELECT value FROM settings) SELECT * FROM chats',"SELECT (WITH chats AS (SELECT value FROM settings) SELECT * FROM chats)",'SELECT raw_json FROM discord_remote'])assert.equal(invoke('sql',{sql,params:[]}).code,1,sql);
 assert.equal(invoke('search',{query:'quasar',room:''}).data.rows[0].id,'source');
 store.db.prepare("INSERT INTO conversations(id,name,platform,kind) VALUES('gmail:a:thread','Mail thread','gmail','email')").run();
 store.db.prepare("INSERT INTO identities(id,platform,remote_id,name) VALUES('gmail:sender','gmail','sender@example.com','Sender')").run();
 store.db.prepare("INSERT INTO messages(id,room_id,sender,ts,body,original_body,type) VALUES('gmail:a:mail','gmail:a:thread','gmail:sender',?,'nebula email','nebula email','email')").run(Date.now());
 assert.equal(invoke('search',{query:'nebula',room:''}).data.rows[0].id,'gmail:a:mail');
 assert.equal(invoke('source',{id:'gmail:a:mail',offset:0}).data.platform,'gmail');
 assert.ok(invoke('chats',{query:'Mail thread'}).data.rows.some(row=>row.id==='gmail:a:thread'));
});

test('Responses tool loop executes bounded named reads and returns structured answer without replaying the call',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'misty-api-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const keyFile=path.join(dir,'key');fs.writeFileSync(keyFile,'sk-test');let calls=0,toolCalls=0;
 const client=new OpenAIAnalysis({keyFile,fetchImpl:async(url,options)=>{const body=JSON.parse(options.body);calls++;
  if(calls===1)return Response.json({status:'completed',output:[{type:'function_call',name:'archive_profile',arguments:'{}',call_id:'call-one'}],usage:{}});
  assert.equal(body.input.at(-1).type,'function_call_output');assert.equal(body.input.at(-1).call_id,'call-one');assert.equal(body.store,false);
  return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{"reply":"found it"}'}]}],usage:{}});
 }});
 const result=await client.generate({model:'test',messages:[{role:'user',content:'my interests?'}],schema:{type:'object',properties:{reply:{type:'string'}}},outputBudget:500,tools:[{type:'function',name:'archive_profile',parameters:{type:'object',properties:{}}}],executeTool:async()=>{toolCalls++;return {interest:'research'};}});
 assert.equal(JSON.parse(result.message.content).reply,'found it');assert.equal(toolCalls,1);assert.equal(calls,2);
});

test('selected WhatsApp G groups accept live messages only after explicit activation; I and S stay excluded',t=>{
 const store=new ArchiveStore(':memory:');t.after(()=>store.close());const cutoff=Date.now(),choices=[{id:'100@g.us',name:'G',treatment:'G'},{id:'200@g.us',name:'I',treatment:'I'}];store.set('whatsapp_group_inventory',{groups:choices.map(c=>({...c,community:false}))});configureWhatsAppGroups(store,{continuousTracking:false,cutoff,choices});
 const msg={kind:'whatsapp_message',chat:'100@g.us',sender:'123@lid',id:'LIVE',name:'Person',at:cutoff+1,body:'Live context',type:'m.text',raw:{}};
 applyNativeEvent(store,msg);assert.equal(store.db.prepare('SELECT count(*) n FROM messages').get().n,0);
 store.set('misty_live_groups',true);store.db.prepare("UPDATE conversations SET tracked=1 WHERE remote_id='100@g.us'").run();applyNativeEvent(store,msg);applyNativeEvent(store,{...msg,chat:'200@g.us'});
 assert.equal(store.db.prepare('SELECT count(*) n FROM messages').get().n,1);assert.equal(store.db.prepare('SELECT count(*) n FROM native_message_links').get().n,1);
});
