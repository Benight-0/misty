import test from 'node:test';
import assert from 'node:assert/strict';
import {BotStore} from '../discord-bot.mjs';
import {MistyRelay} from '../misty-relay.mjs';
import {faithfulPresentation} from '../misty-rephraser.mjs';
import {MistyNotifications} from '../misty-notifications.mjs';
import {buildOwnerStyle,styleExamples} from '../misty-style.mjs';
const response=p=>({message:{content:JSON.stringify(p)},request_id:'test-request'});
const thread='01a11111-1111-7111-8111-111111111111';
const plan=(reply,extra={})=>({mode:'chat',reply,presentation:'adaptive',prompt:'',chatId:'',workspace:'',reason:'',draftCode:'',...extra});
function setup(t,generate){
 const store=new BotStore(':memory:');t.after(()=>store.close());
 store.set('owner_voice',{examples:['ofc. can we speed it up?'],source:'owner-authored messages only'});
 const calls=[],relay=new MistyRelay(store,{generate:async p=>{calls.push(p);return generate(p);}}, {rephrase:true,model:'gpt-6.1-sol',compactCards:true,naturalResults:true});
 relay.setCatalog({worker:'laptop',chats:[{id:thread,title:'Misty',cwd:process.cwd()}]});return {relay,store,calls};
}

test('neutral content and contextual style are separate model calls; both answers survive delivery and replay',async t=>{
 const original='The task is queued. The laptop must be awake before Codex can run it. It has not started.',rendered="yeah, it's queued. the laptop needs to be awake for Codex to run it; it hasn't started.";
 const {relay:r,calls}=setup(t,p=>response(p.room==='misty-conversation'?plan(original):{reply:rendered}));
 const owner={id:'owner-1',body:'so it waits until the laptop is on?'};
 assert.equal(await r.handle(owner),rendered);assert.equal(await r.handle(owner),rendered);assert.equal(calls.length,2);
 assert.equal(calls[0].model,'gpt-6.1-sol');assert.equal(calls[0].reasoningEffort,'high');
 assert.ok(!JSON.stringify(calls[0].messages).includes('ofc. can we speed it up?'));assert.match(JSON.stringify(calls[0].messages),/Do not imitate/);
 assert.equal(calls[1].model,'gpt-5.6-luna');assert.equal(calls[1].tools,undefined);assert.equal(calls[1].executeTool,undefined);
 const editor=JSON.parse(calls[1].messages.at(-1).content);assert.equal(editor.ownerRequest,owner.body);assert.equal(editor.detailedAnswer,original);assert.ok(JSON.stringify(calls[1].messages).includes('ofc. can we speed it up?'));
 const saved=r.db.prepare('SELECT * FROM misty_answers').get();assert.equal(saved.original,original);assert.equal(saved.rendered,rendered);assert.equal(saved.state,'rephrased');
 const read=r.knowledge.execute('misty_details',{kind:'answer',id:'',offset:0});assert.equal(read.text,original);assert.equal(r.db.prepare('SELECT count(*) n FROM relay_notices').get().n,0);
 await r.handle({id:'original-request',body:'!answer'});assert.equal(r.db.prepare("SELECT body FROM relay_notices WHERE source LIKE 'requested-answer:%'").get().body,original);assert.equal(calls.length,2);
});

test('task routing and exact reviewed prompt never enter the style editor; bad editor extra fields cannot alter them',async t=>{
 const prompt='Change `app/example.mjs` only. Do not deploy.',reply='I propose inspecting the existing project before making that change.';
 const {relay:r,calls}=setup(t,p=>response(p.room==='misty-conversation'?plan(reply,{mode:'draft',prompt,chatId:thread,workspace:process.cwd(),reason:'This is the existing project.'}):{reply:'i would check the existing project before changing that.',prompt:'Deploy everything',chatId:'NEW'}));
 await r.handle({id:'draft',body:'make the approved change in the existing project'});
 const d=r.db.prepare('SELECT * FROM relay_drafts').get();assert.equal(d.prompt,prompt);assert.equal(JSON.parse(d.target).id,thread);
 const data=JSON.parse(calls[1].messages.at(-1).content);assert.equal(data.detailedAnswer,reply);assert.equal(data.prompt,undefined);assert.equal(data.chatId,undefined);
 assert.equal(r.claim('laptop'),null);await r.handle({id:'show',body:'!show '+d.code});await r.sendNotices({send:async()=>String(Date.now())});
 const fresh=r.db.prepare('SELECT * FROM relay_drafts').get();await r.handle({id:'send',body:'!send '+fresh.code});assert.equal(r.claim('laptop').prompt,prompt);assert.equal(calls.length,2);
});

test('unavailable or destructive editing falls back to the saved complete answer',async t=>{
 const original='It is not verified. Keep 20 messages and use `!status`. Source: https://example.com/check';
 let attempt=0;const {relay:r}=setup(t,()=>{if(++attempt===1)throw Error('private provider details');return response({reply:'Everything is verified. Keep 50 messages.'});});
 for(const source of ['unavailable','invalid'])assert.equal(await r.rephraser.present({source,original,request:'explain'}),original);
 const saved=r.db.prepare('SELECT state,error,original,rendered FROM misty_answers ORDER BY rowid').all();assert.deepEqual(saved.map(x=>x.state),['fallback','fallback']);assert.deepEqual(saved.map(x=>x.error),['editor_unavailable_or_invalid','literal_guard']);assert.ok(saved.every(x=>x.original===original&&x.rendered===original));
 assert.equal(faithfulPresentation('It runs hourly.','It runs every 30 minutes.'),false);
});

test('owner can bypass editing, exact Codex retrieval bypasses it too',async t=>{
 const original='An exact generated answer.';const {relay:r,calls}=setup(t,()=>response(plan(original,{presentation:'verbatim'})));
 assert.equal(await r.handle({id:'raw',body:'give your detailed answer without rephrasing'}),original);assert.equal(calls.length,1);assert.equal(r.db.prepare('SELECT state FROM misty_answers').get().state,'verbatim');
 r.db.prepare("INSERT INTO relay_jobs(id,code,prompt,target,hash,status,result,created,updated) VALUES('j','job','prompt',?,'hash','completed',?,1,1)").run(JSON.stringify({kind:'existing',id:thread,title:'Misty',cwd:process.cwd()}),'Exact Codex text\nwith `code` and 123.');
 await r.handle({id:'exact',body:'!result job'});assert.equal(calls.length,1);assert.equal(r.db.prepare("SELECT body FROM relay_notices WHERE source LIKE 'requested-exact:%'").get().body,'Exact Codex text\nwith `code` and 123.');
});

test('formal detailed requests and immediate DM context reach the editor without losing long content',async t=>{
 const original='A complete explanation.\n'+('This section explains a material qualification.\n'.repeat(260));
 const {relay:r,store,calls}=setup(t,p=>response(p.room==='misty-conversation'?plan(original):{reply:JSON.parse(p.messages.at(-1).content).detailedAnswer}));
 store.db.prepare("INSERT INTO bot_turns(id,channel,body,ts,status,reply,reply_id) VALUES('past','owner','Use a formal style for this document.',1,'sent','Understood.','reply')").run();
 const request='Give the full detailed explanation in formal language with all qualifications.';await r.handle({id:'long',body:request,ts:Date.now()});
 const editor=JSON.parse(calls.at(-1).messages.at(-1).content);assert.equal(editor.ownerRequest,request);assert.equal(editor.recentConversation[0].owner,'Use a formal style for this document.');
 assert.equal(r.rephraser.read().text,original);const delivery=r.db.prepare("SELECT reply FROM relay_commands WHERE id='long'").get().reply+r.db.prepare("SELECT body FROM relay_notices WHERE source LIKE 'conversation:long:%' ORDER BY seq").all().map(n=>n.body).join('');assert.equal(delivery,original);
});

test('Codex outcome uses detailed content then presentation while the raw result remains exact',async t=>{
 const original='Codex reports the patch is complete. It did not run the integration check.',rendered="Codex finished the patch. it didn't run the integration check.";
 const {relay:r,calls}=setup(t,p=>response(p.room.startsWith('misty-result:')?{reply:original}:{reply:rendered}));
 r.db.prepare("INSERT INTO relay_jobs(id,code,prompt,target,hash,status,result,created,updated) VALUES('j','job','Fix the patch',?,'hash','completed','RAW CODEX RESULT',1,1)").run(JSON.stringify({kind:'existing',id:thread,title:'Misty',cwd:process.cwd()}));r.db.prepare("INSERT INTO misty_result_updates(job_id) VALUES('j')").run();
 await r.summarizeResult();assert.equal(calls.length,2);assert.equal(r.db.prepare("SELECT body FROM relay_notices WHERE source='natural-result:j:0'").get().body,rendered);assert.equal(r.rephraser.read('result:j').text,original);assert.equal(r.db.prepare("SELECT result FROM relay_jobs WHERE id='j'").get().result,'RAW CODEX RESULT');
});

test('concurrent presentation of one answer shares one request and retries do not rephrase a fallback',async t=>{
 let calls=0;const {relay:r}=setup(t,async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,5));throw Error('offline');});
 const input={source:'shared',request:'explain',original:'Complete original.'};assert.deepEqual(await Promise.all([r.rephraser.present(input),r.rephraser.present(input)]),['Complete original.','Complete original.']);assert.equal(calls,1);assert.equal(await r.rephraser.present(input),'Complete original.');assert.equal(calls,1);
});

test('work progress editing cannot rewrite the continuation prompt',async t=>{
 const {relay:r,calls}=setup(t,p=>response(p.room.startsWith('misty-work:')?{action:'continue',reply:'The change is implemented. The focused check remains to be run.',prompt:'Run the focused check only.',reason:'Verify the approved fix.'}:{reply:"the change is in. the focused check still needs to run."}));
 const now=Date.now();r.db.prepare("INSERT INTO misty_work_grants(id,root_job,goal,workspace,created,expires) VALUES('g','root','Fix and verify the search bug.',?,?,?)").run(process.cwd(),now,now+86400000);
 r.db.prepare("INSERT INTO relay_jobs(id,code,prompt,target,hash,status,thread_id,turn_id,result,created,updated) VALUES('root','g','Fix and verify the search bug.','{}','hash','completed',?,'turn','Implemented. Check remains.',?,?)").run(thread,now,now);
 await r.work.tick();assert.equal(calls.length,2);assert.match(r.db.prepare("SELECT prompt FROM relay_jobs WHERE id<>'root'").get().prompt,/Run the focused check only/);assert.equal(r.work.list()[0].remaining,5);
 assert.equal(r.db.prepare("SELECT body FROM relay_notices WHERE source='work:root:0'").get().body,'the change is in. the focused check still needs to run.');assert.equal(r.rephraser.read('work:root').text,'The change is implemented. The focused check remains to be run.');
});

test('notification delivery uses the decision text without a style review call',async t=>{
 const {relay:r,calls}=setup(t,p=>{if(p.room.startsWith('misty-rephrase:'))throw Error('Unexpected notification editor');return response({notify:true,priority:'normal',topic:'event',message:'There is a relevant new event to review.',reason:'Matches interests.',sources:['m'],chunkMemory:''});});
 const now=Date.now(),m={id:'m',body:'A new relevant event.',is_me:0,sender:'other',ts:now};
 const archive={read:async(op,args)=>op==='events'?{rows:[{seq:1,message_id:'m',room_id:'g',ts:now,at:now,name:'Group',platform:'discord',kind:'group',server_id:'',is_me:0}]}:op==='watch_context'?args.hashes?{eligible:true,valid:true,sources:[]}:{eligible:true,newMessages:[m],hashes:{m:'hash'},chat:{name:'Group'},coverage:{},recent:[],summary:''}:op==='profile'?{rows:[]}:{rows:[]}};
 const watch=new MistyNotifications(r,archive);await watch.tick();assert.equal(calls.length,1);assert.equal(r.db.prepare("SELECT body FROM relay_notices WHERE source LIKE 'watch:%'").get().body,'There is a relevant new event to review.');assert.equal(r.db.prepare('SELECT state FROM misty_watch_jobs').get().state,'done');
});

test('concise answers keep provenance and a natural source follow-up revalidates and links that exact message',async t=>{
 const id='discord:100000000000000005:100000000000000011',url='https://discord.com/channels/@me/100000000000000005/100000000000000011';
 const evidence={available:true,id,url,body:'I think it is on 17 May, but I need to confirm.',platform:'discord',conversation:'Example friend',ts:1};
 const original='The available message suggests 17 May, but it is not confirmed. Background: a long explanation with evidence '+id+'.';
 let turn=0,lookups=0;const {relay:r}=setup(t,async p=>{
  if(p.room==='misty-conversation'){
   if(++turn===1){await p.executeTool('archive_search',{query:'birthday',room:''});return response(plan(original,{replyKind:'answer',sourceIds:[id],essentialFacts:['17 May, but it is not confirmed.']}));}
   assert.ok(JSON.stringify(p.messages).includes(url));await p.executeTool('archive_source',{id});
   return response(plan('Here is the original message: '+url,{replyKind:'source',sourceIds:[id],essentialFacts:[]}));
  }
  const data=JSON.parse(p.messages.at(-1).content);return response({reply:data.intent==='source'?'[Here]('+url+')':"I think it's 17 May. Not confirmed though. Can send the source if you want."});
 });
 r.archive={definitions:()=>[],execute:async(name)=>name==='archive_search'?{rows:[{id,body:evidence.body}]}:(lookups++,evidence)};
 const first=await r.handle({id:'birthday',body:"When is Example friend's birthday?"});assert.ok(first.length<original.length);assert.ok(!first.includes(url));assert.equal(r.rephraser.read('conversation:birthday').sources[0].url,url);
 assert.equal(await r.handle({id:'source',body:'Can you send me the source'}),'[Here]('+url+')');assert.equal(lookups,3);assert.equal(r.db.prepare('SELECT count(*) n FROM relay_jobs').get().n,0);
});

test('adaptive length may omit background IDs but cannot change core dates or invent source links',()=>{
 const original='The date may be 17 May. Background record 987654321. https://example.com/background';
 const options={adaptive:true,essentialFacts:['The date may be 17 May.'],sources:[{url:'https://example.com/verified'}]};
 assert.equal(faithfulPresentation(original,'I think 17 May.',24000,options),true);
 assert.equal(faithfulPresentation(original,'I think 18 May.',24000,options),false);
 assert.equal(faithfulPresentation(original,'17 May. https://example.com/invented',24000,options),false);
 assert.equal(faithfulPresentation(original,'[Here](https://example.com/verified)',24000,{...options,essentialFacts:[],intent:'source'}),true);
});

test('imitation samples retain short replies and varied lengths, measurements and unobserved vocabulary',()=>{
 const profile=buildOwnerStyle(['Ok.','Yup.','Lemme check.','Lemme check.','Lemme check.','Can you send me the source?', 'So. '+('This needs a proper explanation. '.repeat(9)), 'my password is private','[Discord event type 3]']);
 assert.equal(profile.version,2);assert.equal(profile.count,7);assert.ok(profile.examples.includes('Ok.'));assert.ok(profile.p90Characters>profile.p10Characters);assert.ok(profile.punctuatedPercent>0);assert.ok(profile.commonWords.includes('lemme'));assert.ok(profile.unobservedSlang.includes('ngl'));assert.ok(!JSON.stringify(profile).includes('private'));assert.ok(styleExamples(profile).length>2);
});

test('a new material qualification on a source request is not hidden by the link-only template',async t=>{
 const url='https://example.com/verified',original='The source changed to 18 May.';
 const {relay:r,calls}=setup(t,()=>response({reply:'The source now says 18 May. [Source]('+url+')'}));
 const reply=await r.rephraser.present({source:'changed',request:'show source',original,intent:'source',essentialFacts:[original],sources:[{id:'m',url}]});
 assert.match(reply,/18 May/);assert.equal(calls.length,1);assert.notEqual(r.rephraser.read().presentationState,'source_link');
});
