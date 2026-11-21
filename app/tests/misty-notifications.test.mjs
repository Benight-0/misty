import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {BotStore} from '../discord-bot.mjs';
import {MistyRelay} from '../misty-relay.mjs';
import {MistyNotifications} from '../misty-notifications.mjs';
import {ArchiveStore} from '../store.mjs';
import {discordServerPolicySchema} from '../discord-server-policies.mjs';

const event=(seq,patch={})=>({seq,message_id:'m'+seq,room_id:'room',ts:Date.now(),name:'Chat',platform:'discord',kind:'dm',server_id:'',is_me:0,...patch});
const result=patch=>({message:{content:JSON.stringify({notify:false,priority:'normal',category:'interest',topic:'topic',message:'',reason:'Nothing new.',sources:[],chunkMemory:'',...patch})}});
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t){
 const store=new BotStore(':memory:');t.after(()=>store.close());
 const relay=new MistyRelay(store,{generate:async()=>result()});
 const archive={read:async(op,args)=>op==='events'?{rows:[]}:op==='profile'?{rows:[{title:'Computing',summary:'Algorithms',confidence:.9}]}:args.hashes?{eligible:true,valid:true,sources:args.ids.map(id=>({id,url:'https://example.org/'+id}))}:{eligible:true,chat:{name:'Chat'},newMessages:args.ids.map(id=>({id,body:'A meaningful message',is_me:0})),hashes:Object.fromEntries(args.ids.map(id=>[id,'hash'])),recent:{rows:[]},summary:{available:true},coverage:{included:args.ids.length}}};
 const watch=new MistyNotifications(relay,archive);return {store,relay,archive,watch};
}

test('direct and group messages enqueue separately; own, ignored, email and Misty DM cannot trigger',t=>{
 const {store,relay,watch}=fixture(t);store.set('bot',{channel:'bot-dm'});
 watch.ingest([event(1),event(2,{platform:'whatsapp'}),event(3,{kind:'group'}),event(4,{kind:'group',platform:'whatsapp',treatment:'G',server_id:'community'}),event(5,{is_me:1}),event(6,{kind:'group',platform:'whatsapp',treatment:'I'}),event(7,{platform:'gmail'}),event(8,{remote_id:'bot-dm'})]);
 assert.deepEqual(relay.db.prepare('SELECT kind FROM misty_watch_jobs ORDER BY created,rowid').all().map(r=>r.kind),['dm','dm','group','group']);assert.equal(store.get('misty_watch_cursor'),8);
});

test('server buffers are independent, exact 50, survive restart and replay does not duplicate jobs',async t=>{
 const {relay,watch}=fixture(t);const rows=Array.from({length:99},(_,i)=>event(i+1,{kind:'group',platform:'whatsapp',treatment:'S',room_id:i%2?'a':'b'}));
 watch.ingest(rows);await watch.close();const next=new MistyNotifications(relay,{});next.ingest(rows);
 assert.equal(relay.db.prepare('SELECT count(*) n FROM misty_watch_jobs').get().n,1);assert.equal(JSON.parse(relay.db.prepare('SELECT events FROM misty_watch_jobs').get().events).length,50);assert.equal(JSON.parse(relay.db.prepare("SELECT events FROM misty_watch_buffers WHERE room_id='a'").get().events).length,49);
 next.ingest([event(100,{kind:'group',platform:'whatsapp',treatment:'S',room_id:'a'})]);assert.equal(relay.db.prepare('SELECT count(*) n FROM misty_watch_jobs').get().n,2);
});

test('SP keeps 50-message batches, lowers relevance threshold and permits distinct mild updates within an hour',async t=>{
 const {relay,archive,watch}=fixture(t);const read=archive.read;let requests=[];
 archive.read=async(op,args)=>{const data=await read(op,args);return op==='watch_context'&&!args.hashes?{...data,chat:{name:'Priority server',treatment:'SP'}}:data;};
 relay.client.generate=async input=>{requests.push(input);const c=JSON.parse(input.messages[1].content);return result({notify:true,topic:'ongoing-discussion',message:'mildly relevant update '+c.newMessages[0].id,sources:[c.newMessages[0].id]});};
 watch.ingest(Array.from({length:100},(_,i)=>event(i+1,{kind:'channel',treatment:'SP'})));await watch.tick();
 assert.equal(requests.length,2);for(const request of requests){assert.match(request.messages[0].content,/lower interruption threshold/);assert.equal(request.outputBudget,4500);const c=JSON.parse(request.messages[1].content);assert.equal(c.notificationPriority,'priority');assert.equal(c.newMessages.length,50);}
 assert.equal(relay.db.prepare('SELECT count(*) n FROM relay_notices').get().n,2);
});

test('G/GP channels get per-message jobs, and historical imports cannot notify',t=>{
 const {relay,watch}=fixture(t);watch.ingest([event(1,{kind:'channel',server_id:'guild',treatment:'G'}),event(2,{kind:'channel',server_id:'guild',treatment:'GP'}),event(3,{kind:'channel',server_id:'guild',treatment:'GP',from_ts:Date.now()+10000})]);
 assert.deepEqual(relay.db.prepare('SELECT kind FROM misty_watch_jobs').all().map(r=>r.kind),['group','group']);assert.equal(relay.db.prepare('SELECT count(*) n FROM misty_watch_buffers').get().n,0);
});

test('in-flight server inference does not block ingestion or the reserved direct-message slot',async t=>{
 const {relay,archive,watch}=fixture(t);let release,calls=[];
 relay.client.generate=async input=>{const c=JSON.parse(input.messages[1].content);calls.push(c);if(c.kind==='server')await new Promise(resolve=>release=resolve);return result();};
 watch.ingest(Array.from({length:100},(_,i)=>event(i+1,{kind:'channel',room_id:i<50?'server-a':'server-b'})));
 await watch.pump();for(let i=0;i<6;i++)await settle();assert.equal(calls.length,1);assert.equal(calls[0].newMessages.length,50);
 const read=archive.read;archive.read=(op,args)=>op==='events'?{rows:[event(101,{room_id:'dm'})]}:read(op,args);
 await watch.pump();for(let i=0;i<6;i++)await settle();
 assert.equal(relay.store.get('misty_watch_cursor'),101);assert.equal(calls.filter(c=>c.kind==='dm').length,1);assert.equal(calls.filter(c=>c.kind==='server').length,1);
 relay.client.generate=async()=>result();release();await watch.tick();await watch.close();
});

test('same-room messages are decided in order, and pause preserves queued work',async t=>{
 const {store,relay,watch}=fixture(t);store.set('misty_notifications_paused',true);watch.ingest([event(1),event(2)]);await watch.pump();assert.equal(watch.running.size,0);
 store.set('misty_notifications_paused',false);let active=0,peak=0,seen=[];
 relay.client.generate=async input=>{active++;peak=Math.max(peak,active);seen.push(JSON.parse(input.messages[1].content).newMessages[0].id);await settle();active--;return result();};
 await watch.tick();assert.equal(peak,1);assert.deepEqual(seen,['m1','m2']);
});

test('one decision call creates a grounded notice; changed selection/evidence suppresses it',async t=>{
 const {relay,archive,watch}=fixture(t);let calls=0;relay.client.generate=async()=>{calls++;return result({notify:true,topic:'useful',message:'this looks useful',sources:['m1']});};
 relay.rephraser.present=()=>{throw Error('Should not use the old owner-style editor');};watch.ingest([event(1)]);await watch.tick();
 assert.match(relay.db.prepare("SELECT body FROM relay_notices WHERE source LIKE 'watch:%'").get().body,/https:\/\/example.org\/m1/);assert.equal(calls,1);
 const read=archive.read;archive.read=(op,args)=>args.hashes?{eligible:false}:read(op,args);
 relay.client.generate=async()=>result({notify:true,topic:'changed',message:'should be suppressed',sources:['m2']});watch.ingest([event(2)]);await watch.tick();
 assert.equal(relay.db.prepare('SELECT count(*) n FROM relay_notices').get().n,1);assert.match(relay.db.prepare('SELECT decision FROM misty_watch_jobs ORDER BY rowid DESC LIMIT 1').get().decision,/selection changed/);
});

test('silent server decisions retain memory; transient errors retry without losing the job',async t=>{
 const {relay,watch}=fixture(t);let now=Date.now();watch.clock=()=>now;relay.client.generate=async()=>{throw Error('network');};watch.ingest(Array.from({length:50},(_,i)=>event(i+1,{kind:'channel'})));await watch.tick();
 assert.equal(watch.status()[0].state,'queued');assert.equal(relay.db.prepare('SELECT attempts FROM misty_watch_jobs').get().attempts,1);
 now+=300001;relay.client.generate=async()=>result({chunkMemory:'A plan was discussed; no alert warranted.'});await watch.tick();assert.equal(watch.status()[0].state,'done');assert.equal(relay.db.prepare('SELECT count(*) n FROM misty_server_memory').get().n,1);assert.equal(relay.db.prepare('SELECT count(*) n FROM relay_notices').get().n,0);
});

test('invented sources cannot create alerts; stale jobs do not call the model',async t=>{
 const {relay,watch}=fixture(t);let calls=0;relay.client.generate=async()=>{calls++;return result({notify:true,message:'invented',sources:['not-a-source']});};watch.ingest([event(1),event(2,{room_id:'stale',ts:Date.now()-2*86400000})]);await watch.tick();
 assert.equal(calls,1);assert.equal(relay.db.prepare('SELECT count(*) n FROM relay_notices').get().n,0);assert.equal(relay.db.prepare("SELECT count(*) n FROM misty_watch_jobs WHERE state='done'").get().n,1);
});

test('archive snapshots check policy, include later owner replies and verify full original hashes',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'misty-watch-')),file=path.join(dir,'archive.sqlite'),store=new ArchiveStore(file);t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const now=Date.now();store.db.prepare("INSERT INTO conversations(id,name,platform,kind,connected,tracked) VALUES('dm','Person','discord','dm',1,1)").run();store.db.prepare("INSERT INTO identities(id,name,platform) VALUES('person','Person','discord')").run();
 const add=(id,ts,me,body)=>store.db.prepare("INSERT INTO messages(id,room_id,sender,ts,body,original_body,is_me) VALUES(?,'dm','person',?,?,?,?)").run(id,ts,body,body,me);add('trigger',now-1000,0,'a'.repeat(7000));add('reply',now,1,'already handled');
 const query=args=>{const p=spawnSync(process.platform==='win32'?'python':'python3',['scripts/misty-archive-query.py',file],{input:JSON.stringify({op:'watch_context',args}),encoding:'utf8'});assert.equal(p.status,0,p.stdout);return JSON.parse(p.stdout);};
 const snapshot=query({room:'dm',kind:'dm',ids:['trigger']});assert.equal(snapshot.eligible,true);assert.equal(snapshot.newMessages[0].body.length,6000);assert.equal(snapshot.recent.rows.at(-1).id,'reply');assert.equal(snapshot.summary.available,false);assert.equal(query({room:'dm',kind:'dm',ids:['trigger'],hashes:snapshot.hashes}).valid,true);
 store.db.prepare("UPDATE messages SET body='changed' WHERE id='trigger'").run();assert.equal(query({room:'dm',kind:'dm',ids:['trigger'],hashes:snapshot.hashes}).valid,false);
 store.db.prepare("UPDATE conversations SET tracked=0 WHERE id='dm'").run();assert.equal(query({room:'dm',kind:'dm',ids:['trigger']}).eligible,false);
 store.db.prepare("UPDATE conversations SET tracked=1,kind='group' WHERE id='dm'").run();assert.equal(query({room:'dm',kind:'dm',ids:['trigger']}).eligible,false);
 discordServerPolicySchema(store.db);store.db.prepare("UPDATE conversations SET kind='channel',server_id='100000000000000005' WHERE id='dm'").run();store.db.prepare("INSERT INTO discord_server_policies VALUES('100000000000000005','Priority','SP',?,?)").run(now,now);
 assert.equal(query({room:'dm',kind:'server',ids:['trigger']}).chat.treatment,'SP');
 store.db.prepare("UPDATE discord_server_policies SET treatment='I'").run();assert.equal(query({room:'dm',kind:'server',ids:['trigger']}).eligible,false);
});

test('compact profile keeps all interest categories despite large evidence lists and still excludes unsupported findings',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'apollo-profile-')),file=path.join(dir,'archive.sqlite'),store=new ArchiveStore(file);t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const evidence=JSON.stringify(Array.from({length:40},(_,i)=>'missing-source-'+String(i).padStart(50,'0'))),insert=store.db.prepare('INSERT INTO profile_findings(id,title,category,summary,source,evidence_ids,updated_at,status) VALUES(?,?,?,?,?,?,?,?)');
 for(let i=0;i<70;i++)insert.run('p'+i,'Interest '+i,i<20?'Core interests':'Conversation preferences','A compact, grounded owner-provided interest.','user',evidence,i,'confirmed');
 insert.run('unsupported','Unsupported inference','Core interests','No surviving original evidence.','local','[]',1000,'suggested');insert.run('dismissed','Dismissed interest','Core interests','Owner dismissed this.','user','[]',1001,'dismissed');
 const query=compact=>{const p=spawnSync(process.platform==='win32'?'python':'python3',['scripts/misty-archive-query.py',file],{input:JSON.stringify({op:'profile',args:{compact}}),encoding:'utf8'});assert.equal(p.status,0,p.stdout);return JSON.parse(p.stdout);};
 const legacy=query(false),compact=query(true);assert.equal(legacy.truncated,true);assert.ok(legacy.rows.length<70);assert.equal(compact.truncated,false);assert.equal(compact.rows.length,70);assert.equal(compact.eligibleFindings,70);assert.equal(new Set(compact.rows.map(f=>f.category)).size,2);assert.ok(compact.rows.every(f=>!['unsupported','dismissed'].includes(f.id)));assert.ok(compact.rows.every(f=>f.current_evidence_ids.length===0));
});

test('server decisions use participation calibration and complete compact profile without changing DM prompt or batches',async t=>{
 const {relay,archive,watch}=fixture(t),read=archive.read,requests=[];
 archive.read=async(op,args)=>{if(op!=='profile')return read(op,args);assert.deepEqual(args,{compact:true});return {truncated:false,rows:Array.from({length:70},(_,i)=>({id:'p'+i,title:'Interest '+i,category:i<60?'Topics you discuss':'Core interests',summary:'Owner-provided topic',source:'user',status:'confirmed'}))};};
 relay.client.generate=async input=>{requests.push(input);return result();};watch.ingest(Array.from({length:50},(_,i)=>event(i+1,{kind:'channel'})));await watch.tick();
 watch.ingest([event(51,{room_id:'dm'})]);await watch.tick();assert.equal(requests.length,2);assert.match(requests[0].messages[0].content,/enjoy joining or learning from/);assert.doesNotMatch(requests[1].messages[0].content,/Server mode calibration/);
 const context=JSON.parse(requests[0].messages[1].content);assert.equal(context.profile.findings.length,70);assert.equal(context.profile.findings[69].category,'Core interests');assert.equal(context.profile.decisionContextLimited,false);assert.equal(context.newMessages.length,50);
});

test('quiet server batch flushes at 15 minutes without another message and never replays',async t=>{
 const {relay,watch}=fixture(t);let now=Date.now();watch.clock=()=>now;watch.serverMaxWaitMs=900000;
 watch.ingest([event(1,{kind:'channel',treatment:'SP'})]);now+=899999;await watch.tick();assert.equal(watch.status().length,0);
 now++;await watch.tick();const job=relay.db.prepare('SELECT events,state FROM misty_watch_jobs').get();assert.equal(JSON.parse(job.events).length,1);assert.equal(job.state,'done');
 const details=watch.details();assert.equal(details.serverMaxWaitMs,900000);assert.equal(details.buffers.length,0);
 now+=900000;await watch.tick();watch.ingest([event(1,{kind:'channel',treatment:'SP'})]);assert.equal(relay.db.prepare('SELECT count(*) n FROM misty_watch_jobs').get().n,1);
});

test('50 messages flush early and the next message starts a new independent timer',async t=>{
 const {relay,watch}=fixture(t);let now=Date.now();watch.clock=()=>now;watch.serverMaxWaitMs=900000;
 watch.ingest(Array.from({length:50},(_,i)=>event(i+1,{kind:'channel'})));assert.equal(relay.db.prepare('SELECT count(*) n FROM misty_watch_jobs').get().n,1);
 now+=120000;watch.ingest([event(51,{kind:'channel'})]);assert.equal(watch.details().buffers[0].dueAt,now+900000);
 now+=899999;await watch.tick();assert.equal(relay.db.prepare('SELECT count(*) n FROM misty_watch_jobs').get().n,1);
 now++;await watch.tick();assert.deepEqual(relay.db.prepare('SELECT json_array_length(events) n FROM misty_watch_jobs ORDER BY created').all().map(r=>r.n),[50,1]);
});

test('channels have separate fixed deadlines and paused decisions preserve timed jobs',async t=>{
 const {store,relay,watch}=fixture(t);let now=Date.now(),start=now;watch.clock=()=>now;watch.serverMaxWaitMs=900000;
 store.set('misty_notifications_paused',true);watch.ingest([event(1,{kind:'channel',room_id:'a'})]);now+=600000;watch.ingest([event(2,{kind:'channel',room_id:'b'}),event(3,{kind:'channel',room_id:'a'})]);
 assert.equal(watch.details().buffers.find(r=>r.room_id==='a').dueAt,start+900000);now=start+900000;await watch.tick();assert.equal(watch.status()[0].state,'queued');assert.deepEqual(watch.details().buffers.map(r=>r.room_id),['b']);
 store.set('misty_notifications_paused',false);await watch.tick();now=start+1500000;await watch.tick();assert.deepEqual(relay.db.prepare('SELECT room_id,state FROM misty_watch_jobs ORDER BY created').all().map(r=>[r.room_id,r.state]),[['a','done'],['b','done']]);
});

test('old two-column buffers migrate with elapsed wait and restart keeps the deadline',async t=>{
 const store=new BotStore(':memory:');t.after(()=>store.close());const relay=new MistyRelay(store,{generate:async()=>result()});
 relay.db.exec('CREATE TABLE misty_watch_buffers(room_id TEXT PRIMARY KEY,events TEXT NOT NULL)');let now=Date.now(),start=now;
 const first=event(1,{kind:'channel',ts:start});relay.db.prepare('INSERT INTO misty_watch_buffers VALUES(?,?)').run('room',JSON.stringify([first]));store.set('misty_watch_cursor',1);
 const archive={read:async(op,args)=>op==='events'?{rows:[]}:op==='profile'?{rows:[]}:({eligible:true,chat:{},newMessages:[{id:'m1',is_me:0}],hashes:{m1:'hash'},recent:{rows:[]},summary:{}})};
 now+=600000;const watch=new MistyNotifications(relay,archive,{serverMaxWaitMs:900000,clock:()=>now});assert.equal(watch.details().buffers[0].dueAt,start+900000);await watch.close();
 const next=new MistyNotifications(relay,archive,{serverMaxWaitMs:900000,clock:()=>now});await next.tick();assert.equal(next.status().length,0);now=start+900000;await next.tick();assert.equal(next.status()[0].state,'done');next.ingest([first]);assert.equal(relay.db.prepare('SELECT count(*) n FROM misty_watch_jobs').get().n,1);await next.close();
});

test('a message arriving at the timeout starts the next batch without losing or reusing any event',async t=>{
 const {relay,watch}=fixture(t);let now=Date.now();watch.clock=()=>now;watch.serverMaxWaitMs=900000;
 watch.ingest(Array.from({length:49},(_,i)=>event(i+1,{kind:'channel'})));now+=900000;watch.ingest([event(50,{kind:'channel'})]);
 const completed=JSON.parse(relay.db.prepare('SELECT events FROM misty_watch_jobs').get().events),pending=JSON.parse(relay.db.prepare('SELECT events FROM misty_watch_buffers').get().events);
 assert.equal(completed.length,49);assert.equal(pending.length,1);assert.equal(new Set([...completed,...pending].map(e=>e.seq)).size,50);assert.equal(watch.details().buffers[0].dueAt,now+900000);
 await watch.close();
});
