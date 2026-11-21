import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {BotStore,BOT_OWNER} from '../discord-bot.mjs';
import {ApolloMessenger,discordParts,APOLLO_PROMPT} from '../apollo.mjs';
import {MistyNotifications} from '../misty-notifications.mjs';
import {MistyRelay} from '../misty-relay.mjs';
import {ProminenceBridge} from '../misty-prominence-bridge.mjs';

const response=(body='Here is the answer',sources=[])=>({message:{content:JSON.stringify({body,sources})}});
function fixture(t,filename=':memory:'){
 const store=new BotStore(filename);t.after(()=>store.close());
 const archive={definitions:()=>[{type:'function',name:'archive_source',parameters:{}}],execute:async()=>({available:true}),read:async()=>({available:true,url:'https://discord.com/channels/@me/100000000000000005/100000000000000052'})};
 const client={generate:async()=>response()};const apollo=new ApolloMessenger(store,client,archive);return {store,archive,client,apollo};
}
const add=(store,id='100000000000000052',body='Send the original source',ts=Date.now())=>{store.db.prepare('INSERT INTO bot_turns(id,channel,body,ts) VALUES(?,?,?,?)').run(id,'apollo-dm',body,ts);return store.db.prepare('SELECT * FROM bot_turns WHERE id=?').get(id);};

test('Apollo only admits the owner DM and exposes archive/conversation tools, no execution',async t=>{
 const {store,apollo}=fixture(t);const base={id:'100000000000000052',channel_id:'apollo-dm',timestamp:new Date().toISOString(),content:'hello',author:{id:BOT_OWNER}};
 assert.equal(store.accept({...base,author:{id:'other'}},'apollo-dm'),false);
 assert.equal(store.accept({...base,channel_id:'misty-dm'},'apollo-dm'),false);
 assert.equal(store.accept(base,'apollo-dm'),true);
 assert.deepEqual(apollo.definitions().map(t=>t.name),['archive_source','apollo_inbox','apollo_inbox_item','apollo_notifications','apollo_history','apollo_progress']);
 await assert.rejects(apollo.execute('codex_send',{}),/unavailable/);await assert.rejects(apollo.execute('shell',{}),/unavailable/);
 assert.match(APOLLO_PROMPT,/Misty is his separate general agent/);
});

test('follow-up context includes delivered alerts and retrieves verified original links',async t=>{
 const {store,apollo,client}=fixture(t);apollo.notice('watch:original','a relevant discussion');
 // Seed a genuine historical receipt; new background notices must stay stored.
 store.db.prepare("UPDATE relay_notices SET status='sent',message_id='100000000000000051' WHERE source LIKE 'watch:original:%'").run();const row=add(store);let used;
 client.generate=async request=>{used=request;assert.match(request.messages[1].content,/a relevant discussion/);return response('Here is what they said',['message-id']);};
 const body=await apollo.prepare(row);assert.match(body,/\[source\]\(https:\/\/discord.com\/channels/);assert.equal(used.reasoningEffort,'none');assert.equal(used.model,'gpt-6-luna');
});

test('unavailable sources are reported and model-provided links cannot masquerade as sources',async t=>{
 const {store,apollo,client,archive}=fixture(t);client.generate=async()=>response('See https://invented.example/source',['missing']);archive.read=async()=>({available:false});
 const body=await apollo.prepare(add(store));assert.doesNotMatch(body,/invented.example/);assert.match(body,/source 1 is currently unavailable/);
});

test('owner notification pause is durable and invalid controls cannot execute anything else',async t=>{
 const {store,apollo}=fixture(t);apollo.notifications={details:()=>({paused:store.get('misty_notifications_paused',false)})};
 assert.equal((await apollo.execute('apollo_notifications',{action:'pause'})).paused,true);
 assert.equal((await apollo.execute('apollo_notifications',{action:'resume'})).paused,false);
 await assert.rejects(apollo.execute('apollo_notifications',{action:'send_message'}),/Unknown/);
});

test('long replies have durable receipts, no resend after uncertain delivery or restart',async t=>{
 const {store,apollo,client}=fixture(t);client.generate=async()=>response('a'.repeat(4100));add(store);await apollo.pumpReplies();
 let calls=0;await apollo.sendNotices({send:async()=>{calls++;if(calls===2)throw Error('timeout');return '100000000000000010'+calls;}});
 assert.equal(calls,3);assert.equal(store.db.prepare('SELECT status FROM bot_turns').get().status,'unknown');
 const next=new ApolloMessenger(store,client,apollo.archive);await next.sendNotices({send:async()=>{throw Error('Must not resend');}});
 assert.equal(store.db.prepare("SELECT count(*) n FROM relay_notices WHERE status='unknown'").get().n,1);
 const text='x'.repeat(1899)+'\u{1f642}'+'end';assert.equal(discordParts(text).join(''),text);assert.equal(discordParts(text)[0].length,1899);
});

test('history can page beyond the latest 100 alerts',async t=>{
 const {apollo}=fixture(t);for(let i=0;i<160;i++)apollo.notice('watch:'+i,'update '+i);
 let i=0;for(const row of apollo.db.prepare('SELECT seq FROM relay_notices').all())apollo.db.prepare("UPDATE relay_notices SET status='sent',message_id=? WHERE seq=?").run(String(1000000000000000100n+(BigInt(++i*1000)<<22n)),row.seq);
 let before=Number.MAX_SAFE_INTEGER,total=0;for(let page=0;page<8;page++){const history=apollo.history(before);total+=history.rows.length;if(!history.nextBefore)break;before=history.nextBefore;}
 assert.equal(total,160);
});

test('both owner-bot DMs are excluded at ingestion and for previously queued jobs',async t=>{
 const {store,apollo,client}=fixture(t);store.set('bot',{channel:'apollo-dm'});let calls=0;client.generate=async()=>{calls++;throw Error('No call expected');};
 const watch=new MistyNotifications(apollo,{}, {name:'Apollo'});const event=(seq,remote_id)=>({seq,remote_id,platform:'discord',kind:'dm',room_id:'room',message_id:'m'+seq,ts:Date.now(),is_me:0});
 watch.ingest([event(1,'misty-dm')]);store.set('watch_excluded_channels',['misty-dm','apollo-dm']);watch.ingest([event(2,'misty-dm'),event(3,'apollo-dm')]);
 await watch.run(apollo.db.prepare('SELECT * FROM misty_watch_jobs').get());assert.equal(calls,0);assert.equal(store.get('misty_watch_cursor'),3);assert.equal(watch.status()[0].state,'done');await watch.close();
});

test('handoff preserves buffers, queued work and receipts without copying Misty conversation/tasks',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'apollo-handoff-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const source=path.join(dir,'old.sqlite'),dest=path.join(dir,'apollo.sqlite');
 const old=new BotStore(source),r=new MistyRelay(old,{generate:()=>{}}),watch=new MistyNotifications(r,{});old.set('bot',{id:'misty-bot',channel:'misty-dm'});old.set('misty_watch_cursor',52);old.set('misty_notifications_paused',true);
 r.notice('watch:sent','already delivered');r.db.prepare("UPDATE relay_notices SET status='sent',message_id='100000000000000052'").run();r.notice('watch:queued','pending');r.notice('result:codex','private work');add(old);
 watch.ingest([{seq:53,platform:'discord',kind:'channel',room_id:'server',message_id:'m53',ts:Date.now()}]);old.close();
 const target=new BotStore(dest),a=new ApolloMessenger(target,{},{});new MistyNotifications(a,{}, {name:'Apollo'});target.close();
 const run=()=>spawnSync(process.platform==='win32'?'python':'python3',['scripts/handoff-apollo.py',source,dest,JSON.stringify({id:'apollo-bot',channel:'apollo-dm'}),String(Date.now())],{encoding:'utf8'});
 const output=run();assert.equal(output.status,0,output.stderr);assert.equal(JSON.parse(output.stdout).queued_transferred,1);assert.notEqual(run().status,0);
 const saved=new BotStore(dest);assert.equal(saved.get('misty_watch_cursor'),53);assert.equal(saved.get('misty_notifications_paused'),true);assert.equal(saved.db.prepare('SELECT count(*) n FROM bot_turns').get().n,0);assert.equal(saved.db.prepare('SELECT count(*) n FROM relay_notices').get().n,2);assert.equal(saved.db.prepare('SELECT count(*) n FROM misty_watch_buffers').get().n,1);saved.close();
 const previous=new BotStore(source);assert.equal(previous.get('conversation_monitor'),'apollo');assert.equal(previous.db.prepare("SELECT status FROM relay_notices WHERE source LIKE 'watch:queued:%'").get().status,'handed_off');assert.equal(previous.db.prepare("SELECT status FROM relay_notices WHERE source LIKE 'result:%'").get().status,'queued');previous.close();
});

test('Misty keeps work results but excludes chat alerts from main-agent context after handoff',async t=>{
 const store=new BotStore(':memory:');t.after(()=>store.close());const r=new MistyRelay(store,{});r.notice('watch:old','conversation alert');r.notice('result:task','work result');r.db.prepare("UPDATE relay_notices SET status='sent',message_id='100000000000000052'").run();
 const bridge=new ProminenceBridge(r);assert.equal((await bridge.execute('outbound')).rows.length,2);store.set('conversation_monitor','apollo');const result=await bridge.execute('outbound');assert.equal(result.rows.length,1);assert.equal(result.rows[0].body,'work result');
 assert.equal(r.knowledge.execute('misty_control',{action:'pause_notifications'}).managedBy,'Apollo');
});
