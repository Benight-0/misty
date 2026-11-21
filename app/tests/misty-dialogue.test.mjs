import test from 'node:test';
import assert from 'node:assert/strict';
import {BotStore} from '../discord-bot.mjs';
import {MistyRelay} from '../misty-relay.mjs';

const response=p=>({message:{content:JSON.stringify(p)}}),plan=reply=>({mode:'chat',reply,presentation:'adaptive',replyKind:'answer',essentialFacts:[],sourceIds:[],prompt:'',chatId:'',workspace:'',reason:'',draftCode:''});
function setup(t,generate,options={}){const store=new BotStore(':memory:');t.after(()=>store.close());const relay=new MistyRelay(store,{generate},{rephrase:true,naturalResults:true,...options});return {relay,store};}

test('progress is delivered before a waiting search and final parts preserve the chosen message boundaries',async t=>{
 const order=[],sent=[];let archiveReleased=false;
 const {relay:r}=setup(t,async p=>{
  if(p.room==='misty-conversation'){
   const result=await p.executeTool('misty_say',{message:'Check the original birthday message.'});assert.equal(result.state,'sent');order.push('search-start');
   assert.deepEqual(sent,['Lemme check the original message.']);await p.executeTool('archive_search',{query:'birthday',room:''});assert.equal(archiveReleased,true);
   return response(plan('The original says 17 May. The date is unconfirmed.'));
  }
  const data=JSON.parse(p.messages.at(-1).content);
  if(data.kind==='progress')return response({messages:['Lemme check the original message.']});
  assert.ok(data.recentConversation.some(c=>c.phase==='already_sent_progress'));
  return response({messages:['I think it’s 17 May.','They weren’t sure though.']});
 },{archive:{definitions:()=>[],execute:async()=>{assert.equal(sent.length,1);archiveReleased=true;return {rows:[]};}}});
 r.messageApi={send:async body=>{sent.push(body);order.push('sent');return String(100000000000000064n+BigInt(sent.length));}};
 const reply=await r.handle({id:'owner',body:'When is the birthday?'});assert.equal(reply,'I think it’s 17 May.');sent.push(reply);await r.sendNotices(r.messageApi);
 assert.deepEqual(order.slice(0,2),['sent','search-start']);assert.deepEqual(sent,['Lemme check the original message.','I think it’s 17 May.','They weren’t sure though.']);
 const saved=r.rephraser.read('conversation:owner');assert.equal(saved.text,'The original says 17 May. The date is unconfirmed.');assert.equal(r.db.prepare('SELECT count(*) n FROM relay_jobs').get().n,0);
});

test('progress retries reuse receipts, unknown delivery is not resent and per-request chatter is bounded',async t=>{
 let calls=0;const {relay:r}=setup(t,async()=>response({messages:['Checking the source.']}));
 r.messageApi={send:async()=>{calls++;throw Error('ambiguous');}};const row={id:'owner',body:'find the source'};
 assert.equal((await r.dialogue.say(row,'Check source')).state,'not_confirmed');
 assert.equal((await r.dialogue.say(row,'Check source')).state,'not_confirmed');assert.equal(calls,1);
 await r.dialogue.say(row,'Check nearby context');await r.dialogue.say(row,'Check alternate name');assert.equal((await r.dialogue.say(row,'Another check')).state,'limit');assert.equal(calls,3);
});

test('progress joins a finishing outbox flush then sends its still-queued update before returning',async t=>{
 const {relay:r}=setup(t,async()=>response({messages:['Checking it.']}));let sent=0,flushes=0;
 r.messageApi={send:async()=>{sent++;return '100000000000000064';}};
 const flush=r.sendNotices.bind(r);r.sendNotices=async api=>{if(++flushes===1)return;return flush(api);};
 assert.equal((await r.dialogue.say({id:'owner',body:'look it up'},'Look up the source')).state,'sent');assert.equal(sent,1);assert.equal(flushes,2);
});

test('exact source wording is paged with revision checks and bypasses composition',async t=>{
 const body='first line\n'+('Exact source wording. '.repeat(420)),requests=[];
 const archive={definitions:()=>[],execute:async(_name,{offset=0})=>{requests.push(offset);return {available:true,id:'m',body:body.slice(offset,offset+6000),bodyHash:'revision',offset,nextOffset:offset+6000<body.length?offset+6000:null,url:'https://example.com/source'};}};
 const {relay:r}=setup(t,()=>assert.fail('Quoting must not call a model'),{archive});
 const result=await r.dialogue.quote({id:'owner'},'m');assert.equal(result.quoteQueued,true);assert.deepEqual(requests,[0,6000]);
 const notices=r.db.prepare('SELECT body FROM relay_notices ORDER BY seq').all();assert.equal(notices.map(n=>n.body).join(''),body);
 await r.dialogue.quote({id:'owner'},'m');assert.equal(r.db.prepare('SELECT count(*) n FROM relay_notices').get().n,notices.length);
 archive.execute=async(_name,{offset=0})=>({available:true,id:'changed',body:'x'.repeat(6000),bodyHash:offset?'new':'old',offset,nextOffset:offset?null:6000});
 await assert.rejects(r.dialogue.quote({id:'other'},'changed'),/changed/);assert.equal(r.db.prepare('SELECT count(*) n FROM relay_notices').get().n,notices.length);
});

test('confirmed running events announce once; a job finishing during composition cannot get a stale running notice',async t=>{
 let settle=false;const {relay:r}=setup(t,async()=>{if(settle)r.db.prepare("UPDATE relay_jobs SET status='completed' WHERE id='j'").run();return response({messages:['Codex has started on it.']});});
 r.db.prepare("INSERT INTO relay_jobs(id,code,prompt,target,hash,status,created,updated) VALUES('j','code','approved task','{}','hash','running',1,1)").run();
 r.dialogue.started('j');r.dialogue.started('j');settle=true;await r.dialogue.tick();assert.equal(r.db.prepare('SELECT count(*) n FROM relay_notices').get().n,0);assert.equal(r.db.prepare('SELECT state FROM misty_job_announcements').get().state,'skipped');
 r.db.prepare("DELETE FROM misty_job_announcements").run();r.db.prepare("UPDATE relay_jobs SET status='running' WHERE id='j'").run();settle=false;r.dialogue.started('j');await r.dialogue.tick();await r.dialogue.tick();assert.equal(r.db.prepare('SELECT count(*) n FROM relay_notices').get().n,1);
});

test('source follow-up wording is model-composed and long source briefs can be answered naturally',async t=>{
 let calls=0;const {relay:r}=setup(t,async p=>{calls++;assert.ok(p.schema.properties.messages);return response({messages:['This is the one: https://example.com/source']});});
 const reply=await r.rephraser.present({source:'source',original:'Stored reference 123456789. https://example.com/source',request:'send source',intent:'source',sources:[{id:'m',url:'https://example.com/source'}]});
 assert.equal(reply,'This is the one: https://example.com/source');assert.equal(calls,1);assert.equal(r.rephraser.read().presentationState,'rephrased');
});
