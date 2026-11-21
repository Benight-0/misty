import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {BotStore} from '../discord-bot.mjs';
import {ApolloMessenger,apolloRuntime} from '../apollo.mjs';
import {ApolloInbox,inboxRange} from '../apollo-inbox.mjs';
import {MistyNotifications} from '../misty-notifications.mjs';
import {MistyRelay} from '../misty-relay.mjs';
import {OpenAIAnalysis} from '../openai-analysis.mjs';
import {ApolloAnalysis,apolloFinalOutput} from '../apollo-client.mjs';
import {pumpCodexNotices} from '../codex-reader.mjs';

const reply=(body,sources=[])=>({message:{content:JSON.stringify({body,sources})}});
const decision=(id,extra={})=>({message:{content:JSON.stringify({notify:true,priority:'normal',category:'interest',topic:'essay',message:'a useful discussion about revising an essay.',reason:'Matches owner interests.',sources:[id],chunkMemory:'',...extra})}});
const owner=(store,id='100000000000000052',body='what did I miss?')=>{store.db.prepare('INSERT INTO bot_turns(id,channel,body,ts) VALUES(?,?,?,?)').run(id,'owner-dm',body,Date.now());return store.db.prepare('SELECT * FROM bot_turns WHERE id=?').get(id);};
function fixture(t,{filename=':memory:',now=Date.now()}={}){
 const store=new BotStore(filename);t.after(()=>{try{store.close();}catch{}});const state={ignored:false,expired:false,requests:[],reads:[],now};
 const archive={definitions:()=>[],execute:async()=>{throw Error('No execution');},read:async(op,args={})=>{
  state.reads.push({op,args});
  if(op==='events')return {rows:[]};if(op==='profile')return {rows:[],truncated:false};
  if(op==='source')return state.expired?{available:false}:{available:true,id:args.id,room_id:'room',body:'retained fixture source',url:'https://discord.com/channels/@me/100000000000000005/100000000000000052'};
  if(op==='watch_context')return {eligible:!state.ignored,valid:!state.ignored,chat:{name:'Essay friends',platform:'discord',kind:'dm',treatment:''},
   newMessages:args.ids.map(id=>({id,body:'A distinct essay idea.',is_me:0})),hashes:Object.fromEntries(args.ids.map(id=>[id,'hash-'+id])),sources:args.ids.map(id=>({id,url:'https://discord.com/channels/@me/100000000000000005/100000000000000052'})),recent:{rows:[]},coverage:{included:args.ids.length},summary:null};
  throw Error('Unexpected archive request '+op);
 }};
 const client={generate:async request=>{state.requests.push(request);return request.room==='apollo-owner'?reply('saved discussion',['m1']):decision(JSON.parse(request.messages[1].content).newMessages[0].id);}};
 const apollo=new ApolloMessenger(store,client,archive);apollo.inbox.clock=()=>state.now;
 const watch=new MistyNotifications(apollo,archive,{name:'Apollo',clock:()=>state.now,serverMaxWaitMs:900000});apollo.notifications=watch;
 const event=(seq,extra={})=>({seq,message_id:'m'+seq,room_id:'room',name:'Essay friends',ts:state.now,is_me:0,platform:'discord',kind:'dm',...extra});
 return {store,state,archive,client,apollo,watch,event};
}
function temporary(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'apollo-inbox-'));t.after(()=>{assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true});});return dir;}

test('Apollo defaults/runtime overrides pin exact Luna none; Misty main/helper routing stays separate',t=>{
 const {store,apollo}=fixture(t);assert.deepEqual(apolloRuntime(),{chatModel:'gpt-6-luna',decisionModel:'gpt-6-luna',chatEffort:'none',decisionEffort:'none',deliveryMode:'store_only'});
 assert.equal(apolloRuntime({APOLLO_CHAT_REASONING:'low'}).chatEffort,'low');
 for(const env of [{APOLLO_CHAT_MODEL:'gpt-6.1-sol'},{APOLLO_DECISION_MODEL:'gpt-5.6-luna'},{APOLLO_CHAT_REASONING:'high'},{APOLLO_DELIVERY_MODE:'notify'}])assert.throws(()=>apolloRuntime(env));
 assert.throws(()=>new ApolloMessenger(store,{}, {},{model:'gpt-6.1-sol'}));
 const misty=new MistyRelay(store,{}, {model:'gpt-6.1-sol',reasoningEffort:'high'}),helper=new MistyNotifications(misty,{});
 assert.equal(misty.model,'gpt-6.1-sol');assert.equal(misty.reasoningEffort,'high');assert.equal(helper.model,'gpt-5.6-luna');assert.equal(helper.reasoningEffort,'low');assert.equal(apollo.model,'gpt-6-luna');
});
test('background and owner call paths both explicitly pass Luna none',async t=>{
 const f=fixture(t);f.watch.ingest([f.event(1)]);await f.watch.tick();await f.apollo.prepare(owner(f.store));
 assert.equal(f.state.requests.length,2);assert.ok(f.state.requests.every(r=>r.model==='gpt-6-luna'&&r.reasoningEffort==='none'));
 assert.match(f.state.requests[0].messages[0].content,/STORE ONLY/);assert.ok(f.watch.details().deliveryMode==='store_only');
});
test('real Responses client preserves model/effort through function-tool continuation without shared defaults mutation',async t=>{
 const dir=temporary(t),file=path.join(dir,'key');fs.writeFileSync(file,'sk-fixture-not-a-real-key');const seen=[];let tools=0;
 const client=new OpenAIAnalysis({keyFile:file,fetchImpl:async(url,args)=>{const request=JSON.parse(args.body);seen.push(request);return {ok:true,json:async()=>({status:'completed',id:'fixture-'+seen.length,usage:{},output:seen.length===1?[{type:'function_call',name:'read_fixture',arguments:'{}',call_id:'one'}]:[{type:'message',content:[{type:'output_text',text:'{"body":"ok"}'}]}]})};}});
 await client.generate({model:'gpt-6-luna',reasoningEffort:'none',messages:[],schema:{type:'object',properties:{body:{type:'string'}}},outputBudget:200,tools:[{name:'read_fixture'}],executeTool:async()=>{tools++;return {fixture:true};}});
 assert.equal(tools,1);assert.equal(seen.length,2);assert.ok(seen.every(r=>r.model==='gpt-6-luna'&&r.reasoning.effort==='none'));
});
test('relevant findings save concise provenance with zero outgoing delivery',async t=>{
 const f=fixture(t);f.watch.ingest([f.event(1)]);await f.watch.tick();let sends=0;await f.apollo.sendNotices({send:async()=>{sends++;}});
 assert.equal(sends,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM relay_notices').get().n,0);
 const list=await f.apollo.inbox.list();assert.equal(list.rows.length,1);assert.equal(list.rows[0].sources[0].id,'m1');assert.equal(list.rows[0].room,'room');assert.equal(list.rows[0].roomName,'Essay friends');assert.equal(list.rows[0].eventTo,f.state.now);assert.equal(list.rows[0].newToOwner,true);
 const item=await f.apollo.inbox.item(list.rows[0].id);assert.equal(item.sources[0].available,true);assert.equal(item.sources[0].body,'retained fixture source');
});
test('Apollo uses final_answer JSON instead of commentary; tool rounds retain every phase',async t=>{
 const commentary={type:'message',phase:'commentary',content:[{type:'output_text',text:'preface that is not final JSON'}]},final={type:'message',phase:'final_answer',content:[{type:'output_text',text:'{"body":"final"}'}]};
 assert.deepEqual(apolloFinalOutput({output:[commentary,final]}).output,[final]);assert.equal(apolloFinalOutput({output:[commentary]}).output.length,0);
 const round={output:[commentary,{type:'function_call',name:'fixture',call_id:'one',arguments:'{}'}]};assert.equal(apolloFinalOutput(round),round);
 const dir=temporary(t),file=path.join(dir,'key');fs.writeFileSync(file,'sk-fixture-not-real');const client=new ApolloAnalysis({keyFile:file,fetchImpl:async()=>({ok:true,status:200,headers:{},json:async()=>({status:'completed',output:[commentary,final],usage:{}})})});
 const answer=await client.generate({model:'gpt-6-luna',reasoningEffort:'none',messages:[],schema:{type:'object',properties:{body:{type:'string'}}},outputBudget:200});assert.deepEqual(JSON.parse(answer.message.content),{body:'final'});
});
test('same evidence/restarts deduplicate; later distinct same-topic development is retained within an hour',async t=>{
 const f=fixture(t);f.watch.ingest([f.event(1)]);await f.watch.tick();const job=f.store.db.prepare('SELECT * FROM misty_watch_jobs').get(),parsed=JSON.parse(job.decision);
 f.watch.finish(job,parsed);new ApolloInbox(f.store,f.archive);f.watch.ingest([f.event(1)]);await f.watch.tick();assert.equal(f.store.db.prepare('SELECT count(*) n FROM apollo_findings').get().n,1);
 f.state.now+=1000;f.watch.ingest([f.event(2)]);await f.watch.tick();assert.equal(f.store.db.prepare('SELECT count(*) n FROM apollo_findings').get().n,2);
});
test('partial batches retain 50-or-15-minute behavior and priority selection',async t=>{
 const f=fixture(t);const read=f.archive.read;f.archive.read=async(op,args)=>{const value=await read(op,args);if(op==='watch_context')value.chat.treatment='SP';return value;};
 f.watch.ingest([f.event(1,{kind:'channel',treatment:'SP'})]);await f.watch.tick();assert.equal(f.state.requests.length,0);
 f.state.now+=900000;await f.watch.tick();assert.equal(f.state.requests.length,1);assert.equal(f.state.requests[0].model,'gpt-6-luna');assert.equal(JSON.parse(f.state.requests[0].messages[1].content).notificationPriority,'priority');
 f.watch.ingest(Array.from({length:50},(_,i)=>f.event(i+2,{kind:'channel',treatment:'SP'})));await f.watch.tick();assert.equal(f.state.requests.length,2);
});
test('queued old background notices are saved, sent/unknown receipts stay intact and never catch up as DMs',async t=>{
 const dir=temporary(t),store=new BotStore(path.join(dir,'db'));t.after(()=>{try{store.close();}catch{}});
 const relay=new MistyRelay(store,{});new MistyNotifications(relay,{});
 for(const suffix of ['queued','sent','unknown','sending']){relay.notice('codex:'+suffix,'old '+suffix);store.db.prepare('UPDATE relay_notices SET status=?,message_id=? WHERE source LIKE ?').run(suffix,suffix==='sent'?'100000000000000052':'','codex:'+suffix+':%');}
 const a=new ApolloMessenger(store,{},{});let sends=0;await a.sendNotices({send:async()=>{sends++;}});assert.equal(sends,0);
 const statuses=Object.fromEntries(store.db.prepare('SELECT source,status FROM relay_notices').all().map(r=>[r.source,r.status]));assert.equal(statuses['codex:queued:0'],'stored');assert.equal(statuses['codex:sent:0'],'sent');assert.equal(statuses['codex:unknown:0'],'unknown');assert.equal(statuses['codex:sending:0'],'unknown');
 const before=store.db.prepare('SELECT count(*) n FROM apollo_findings').get().n;new ApolloMessenger(store,{},{});assert.equal(store.db.prepare('SELECT count(*) n FROM apollo_findings').get().n,before);store.close();
});
test('outgoing guard also catches a legacy background row inserted after startup',async t=>{
 const {store,apollo}=fixture(t);store.db.prepare("INSERT INTO relay_notices(source,body) VALUES('watch:legacy:0000','do not deliver')").run();let sends=0;await apollo.sendNotices({send:async()=>{sends++;}});assert.equal(sends,0);assert.equal(store.db.prepare('SELECT status FROM relay_notices').get().status,'stored');
 apollo.notice('answer:invented-owner','do not deliver either');await apollo.sendNotices({send:async()=>{sends++;}});assert.equal(sends,0);
});
test('historical watch findings retain source links and delivered receipts without replay',async t=>{
 const f=fixture(t),store=new BotStore(':memory:');t.after(()=>store.close());const old=new MistyRelay(store,{}),watch=new MistyNotifications(old,{});
 watch.ingest([f.event(99)]);const job=store.db.prepare('SELECT * FROM misty_watch_jobs').get();watch.finish(job,JSON.parse(decision('m99').message.content),[{id:'m99',url:'https://discord.com/channels/@me/100000000000000005/100000000000000052'}]);
 store.db.prepare("UPDATE relay_notices SET status='sent',message_id='100000000000000052'").run();const a=new ApolloMessenger(store,{},f.archive),items=await a.inbox.list();assert.equal(items.rows.length,1);assert.equal(items.rows[0].newToOwner,false);
 const item=store.db.prepare('SELECT sources,provenance FROM apollo_findings').get();assert.match(item.sources,/discord.com/);assert.match(item.provenance,/sent/);assert.equal(store.db.prepare('SELECT status FROM relay_notices').get().status,'sent');
});
test('old Codex activity stays quiet with cursor progress and no duplicate notices',async t=>{
 const {apollo,store}=fixture(t),events=[{id:'e',seq:1,kind:'completed',at:store.get('apollo_codex_live_since')-1,thread_id:'real-thread',title:'project',text:'Done'}];
 const reader={call:async(op,args)=>({events:events.filter(e=>e.seq>args.after)})};await pumpCodexNotices(apollo,reader);await pumpCodexNotices(apollo,reader);
 assert.equal(store.get('codex_event_cursor'),1);assert.equal(store.db.prepare('SELECT count(*) n FROM apollo_findings').get().n,1);assert.equal(store.db.prepare('SELECT count(*) n FROM relay_notices').get().n,0);
});
test('new Codex commentary and turn endings deliver once; discussion notices remain stored',async t=>{
 const f=fixture(t),at=f.store.get('apollo_codex_live_since'),events=['message','completed','failed','interrupted'].map((kind,i)=>({id:'live-'+i,seq:i+1,kind,at,thread_id:'real-thread',text:kind}));
 const reader={call:async(op,args)=>({events:events.filter(e=>e.seq>args.after)})};await pumpCodexNotices(f.apollo,reader);await pumpCodexNotices(f.apollo,reader);
 f.apollo.notice('watch:quiet','discussion must stay quiet');let sent=[];await f.apollo.sendNotices({send:async(body,nonce)=>{sent.push({body,nonce});return '100000000000000052';}});
 assert.equal(sent.length,4);assert.ok(sent.every(s=>s.nonce.startsWith('apollo:codex:live-')));assert.equal(f.store.get('codex_event_cursor'),4);
 assert.equal(f.store.db.prepare("SELECT status FROM relay_notices WHERE source LIKE 'watch:%'").get().status,'stored');
 assert.equal((await f.apollo.inbox.list({kind:'codex',before:at+1})).rows.every(r=>!r.newToOwner),true);
 const again=new ApolloMessenger(f.store,{},f.archive);assert.equal(again.deliveryStatus().codexLiveSince,at);await pumpCodexNotices(again,reader);await again.sendNotices({send:async()=>{throw Error('duplicate');}});
 assert.equal(f.store.db.prepare("SELECT count(*) n FROM relay_notices WHERE status='sent'").get().n,4);
});
test('live Codex queue survives restart; unknown delivery is never retried or forged',async t=>{
 const f=fixture(t),at=f.store.get('apollo_codex_live_since');f.apollo.transaction(()=>f.apollo.saveCodex({id:'restart',seq:1,kind:'message',at,thread_id:'t'},'new visible update'));
 const again=new ApolloMessenger(f.store,{},f.archive);let calls=0;await again.sendNotices({send:async()=>{calls++;throw Error('uncertain');}});
 assert.equal(calls,1);assert.equal(f.store.db.prepare("SELECT status FROM relay_notices WHERE source='codex:restart:0000'").get().status,'unknown');
 const third=new ApolloMessenger(f.store,{},f.archive);await third.sendNotices({send:async()=>{calls++;}});assert.equal(calls,1);
 f.store.db.prepare("INSERT INTO relay_notices(source,body,payload) VALUES(?,?,?)").run('codex:forged:0000','not real',JSON.stringify({delivery:'live_codex',eventId:'forged'}));
 await third.sendNotices({send:async()=>{calls++;}});assert.equal(calls,1);assert.equal(f.store.db.prepare("SELECT status FROM relay_notices WHERE source='codex:forged:0000'").get().status,'stored');
});
test('monitoring resume does not change delivery mode; owner replies/progress still work',async t=>{
 const f=fixture(t);await f.apollo.execute('apollo_notifications',{action:'pause'});const result=await f.apollo.execute('apollo_notifications',{action:'resume'});assert.equal(result.deliveryMode,'store_only');assert.equal(result.paused,false);
 const row=owner(f.store);await f.apollo.execute('apollo_progress',{text:'checking the saved discussions'},{row,progress:{sent:false}});await f.apollo.pumpReplies();let sends=0;await f.apollo.sendNotices({send:async()=>String(1000000000000000101n+BigInt(sends++))});assert.equal(sends,2);assert.equal(f.store.db.prepare('SELECT status FROM bot_turns').get().status,'sent');
});
test('owner recap/source follow-up uses persisted inbox context across restart, not another archive analysis',async t=>{
 const dir=temporary(t),f=fixture(t,{filename:path.join(dir,'db')});f.watch.ingest([f.event(1)]);await f.watch.tick();f.state.requests=[];
 f.client.generate=async request=>{const items=await request.executeTool('apollo_inbox',{range:'recent'});assert.equal(items.rows.length,1);return reply('an essay revision discussion',['m1']);};
 const row=owner(f.store);await f.apollo.pumpReplies();await f.apollo.sendNotices({send:async()=>'100000000000000064'});assert.equal(f.apollo.inbox.lastContext().ids.length,1);
 f.store.close();const nextStore=new BotStore(path.join(dir,'db')),next=new ApolloMessenger(nextStore,f.client,f.archive);assert.equal(next.inbox.lastContext().turn_id,row.id);next.inbox.prepareRead('empty',[]);next.inbox.shown('empty');assert.equal(next.inbox.lastContext().turn_id,row.id);
 f.client.generate=async request=>{const historical=JSON.parse(request.messages[1].content.split('\n').slice(1).join('\n'));const item=await request.executeTool('apollo_inbox_item',{id:historical.lastInboxContext.ids[0]});assert.equal(item.sources[0].body,'retained fixture source');return reply('the retained original',['m1']);};
 const body=await next.prepare(owner(nextStore,'100000000000000053','send the source'));assert.match(body,/\[source\]/);assert.equal(f.state.requests.length,0);assert.equal(nextStore.db.prepare("SELECT count(*) n FROM misty_watch_jobs").get().n,1);nextStore.close();
});
test('time filters respect IST today/yesterday/custom bounds and stable equal-time pagination',async t=>{
 const now=Date.UTC(2026,9,24,1),f=fixture(t,{now});
 assert.equal(inboxRange('today',0,0,now).since,Date.UTC(2026,9,23,18,30));assert.equal(inboxRange('yesterday',0,0,now).before,Date.UTC(2026,9,23,18,30));
 for(let i=0;i<12;i++){const ts=i===0?Date.UTC(2026,9,23,17):now-1000;f.apollo.saveFinding({id:'job'+i,room_id:'room',kind:'dm',created:now,events:JSON.stringify([f.event(i,{ts})])},{sources:['m'+i],topic:'essay',message:'summary '+i,reason:'interest'});}
 const today=await f.apollo.inbox.list({range:'today'}),second=await f.apollo.inbox.list({range:'today',cursor:today.nextCursor});assert.equal(today.rows.length,8);assert.equal(second.rows.length,3);assert.equal(new Set([...today.rows,...second.rows].map(r=>r.id)).size,11);
 assert.equal((await f.apollo.inbox.list({range:'yesterday'})).rows.length,1);assert.equal((await f.apollo.inbox.list({range:'custom',since:now-100,before:now})).rows.length,0);
});
test('ignored/untracked chats are omitted on retrieval and their source follow-ups fail closed',async t=>{
 const f=fixture(t);f.watch.ingest([f.event(1)]);await f.watch.tick();const id=f.store.db.prepare('SELECT id FROM apollo_findings').get().id;f.state.ignored=true;
 assert.equal((await f.apollo.inbox.list()).rows.length,0);assert.equal((await f.apollo.inbox.item(id)).available,false);
 const answer=await f.apollo.prepare(owner(f.store));assert.doesNotMatch(answer,/\[source\]/);assert.match(answer,/unavailable/);
 f.watch.ingest([f.event(2)]);await f.watch.tick();assert.equal(f.store.db.prepare('SELECT count(*) n FROM apollo_findings').get().n,1);
 f.watch.ingest([f.event(3,{treatment:'I'})]);assert.equal(f.store.db.prepare('SELECT count(*) n FROM misty_watch_jobs').get().n,2);
});
test('expired sources preserve the useful summary but explicitly lack original text',async t=>{
 const f=fixture(t);f.watch.ingest([f.event(1)]);await f.watch.tick();f.state.expired=true;
 const list=await f.apollo.inbox.list(),item=await f.apollo.inbox.item(list.rows[0].id);assert.equal(item.available,true);assert.match(item.summary,/essay/);assert.equal(item.sources[0].available,false);assert.equal(item.sources[0].status,'original_unavailable_or_expired');assert.equal(item.sources[0].body,undefined);
});
test('empty or unavailable inbox is honest and model failures retry without costly fallback',async t=>{
 const f=fixture(t);assert.equal((await f.apollo.inbox.list()).rows.length,0);let calls=0;f.client.generate=async request=>{calls++;assert.equal(request.model,'gpt-6-luna');throw Error('Unavailable');};
 f.watch.ingest([f.event(1)]);await f.watch.tick();assert.equal(calls,1);assert.equal(f.store.db.prepare('SELECT state FROM misty_watch_jobs').get().state,'queued');assert.equal(f.store.db.prepare('SELECT count(*) n FROM apollo_findings').get().n,0);
});
test('owner status remains bounded with large priority decisions and does not invoke a model',async t=>{
 const f=fixture(t),details=f.watch.details();f.apollo.notifications={details:()=>({...details,recent:Array.from({length:10},()=>({decision:{message:'x'.repeat(6000)}}))})};
 const text=await f.apollo.prepare(owner(f.store,'100000000000000052','!status'));assert.ok(text.length<3000);assert.equal(JSON.parse(text).deliveryMode,'store_only');assert.equal(f.state.requests.length,0);
});
