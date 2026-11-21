import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {BotStore,BotReplies,BOT_OWNER} from '../discord-bot.mjs';
import {MistyRelay} from '../misty-relay.mjs';
import {MistyConversation} from '../misty-conversation.mjs';
import {OpenAIAnalysis} from '../openai-analysis.mjs';

const chat='01a11111-1111-7111-8111-111111111111',cwd=process.cwd();
const response=fields=>({message:{content:JSON.stringify({mode:'chat',reply:'Hello. I can help you discuss a task or choose the right command.',prompt:'',chatId:'',workspace:'',reason:'',draftCode:'',...fields})},request_id:'request-test',reasoning_tokens:240});
function setup(t,generate){const store=new BotStore(':memory:');t.after(()=>store.close());const relay=new MistyRelay(store,{generate},{defaultCwd:cwd});relay.setCatalog({worker:'laptop',chats:[{id:chat,title:'Misty project',cwd,preview:'Existing project history'}]});return {store,relay};}
const flake=(ts,i=0)=>(((BigInt(ts)-1420070400000n)<<22n)+BigInt(i)).toString();
function seed(store,n=30,size=200){const start=Date.now()-3600000;for(let i=0;i<n;i++){const ts=start+i*1000;store.db.prepare("INSERT INTO bot_turns(id,channel,body,ts,status,reply,reply_id) VALUES(?,?,?,?,'sent',?,?)").run(flake(ts),'owner-channel',i===0?'My reference word is cobalt; preserve it. '+'.'.repeat(size):'Older owner message '+i+' '+'.'.repeat(size),ts,'Earlier answer '+i,flake(ts+500));}}

test('normal conversation uses high reasoning, full earlier DM context, capabilities and real catalog without making a draft',async t=>{
 let input;const {store,relay}=setup(t,async p=>{input=p;return response({reply:'Your reference word is cobalt. !chats Misty helps find the project chat.'});});seed(store,35);
 relay.notice('historic-preview','A prior exact prompt and its chat selection.');await relay.sendNotices({send:async()=>flake(Date.now()-1000)});
 const body=await relay.handle({id:'current',body:'What was my reference word, and how do I find the Misty chat?',ts:Date.now()});
 assert.match(body,/cobalt/);assert.equal(input.reasoningEffort,'high');assert.equal(input.model,'gpt-5.6-luna');assert.ok(input.outputBudget>=12000);
 const serialized=JSON.stringify(input.messages);assert.match(serialized,/My reference word is cobalt/);assert.match(serialized,/Older owner message 34/);assert.match(serialized,/prior exact prompt/);assert.match(serialized,/Misty project/);assert.match(serialized,/!send CODE/);assert.match(serialized,/separate official bot/);
 const audit=store.db.prepare('SELECT * FROM relay_context_runs').get();assert.equal(audit.visible_events,71);assert.equal(audit.verbatim_events,71);assert.equal(audit.memory_events,0);assert.equal(audit.effort,'high');assert.equal(audit.reasoning_tokens,240);
 assert.equal(store.db.prepare('SELECT count(*) n FROM relay_drafts').get().n,0);assert.equal(relay.claim('laptop'),null);
});

test('discussion works without a laptop catalog and a natural yes never queues a job',async t=>{
 const store=new BotStore(':memory:');t.after(()=>store.close());const relay=new MistyRelay(store,{generate:async()=>response({reply:'I can talk while your laptop is offline. Use !send CODE to approve a reviewed draft.'})});
 assert.match(await relay.handle({id:'hello',body:'Can we talk?'}),/offline/);
 await relay.handle({id:'yes',body:'Yes send it'});assert.equal(store.db.prepare('SELECT count(*) n FROM relay_jobs').get().n,0);
});

test('a natural request can revise an actual pending draft, invalidating its old approval code',async t=>{
 let draftCode='';const {store,relay}=setup(t,async()=>response({mode:draftCode?'revise':'draft',reply:'I have prepared the change for review.',prompt:draftCode?'Plan the change. Do not edit yet.':'Improve loading.',chatId:chat,workspace:cwd,reason:'The existing Misty chat contains this project.',draftCode}));
 await relay.handle({id:'first',body:'Improve chat loading'});const original=store.db.prepare('SELECT * FROM relay_drafts').get();draftCode=original.code;
 await relay.handle({id:'revision',body:'Change that to planning only; do not edit yet.'});const revised=store.db.prepare('SELECT * FROM relay_drafts').get();assert.notEqual(revised.code,original.code);assert.equal(revised.id,original.id);assert.equal(revised.prompt,'Plan the change. Do not edit yet.');
 assert.match(await relay.handle({id:'stale',body:'!send '+original.code}),/latest preview code/);assert.equal(relay.claim('laptop'),null);
});

test('older memory compaction covers every event, preserves raw history, and resumes its checkpoint',async t=>{
 const store=new BotStore(':memory:');t.after(()=>store.close());seed(store,100,1200);let calls=0;
 // Schema setup is normally owned by MistyRelay.
 new MistyRelay(store,{});const memory=new MistyConversation(store,{generate:async p=>{calls++;assert.equal(p.reasoningEffort,'high');return {message:{content:JSON.stringify({memory:'Reference word cobalt. All supplied owner turns and responses incorporated; original sources remain stored.'})}};}},{historyBudget:40000});
 const before=store.db.prepare('SELECT count(*) n FROM bot_turns').get().n;
 const first=await memory.build({id:'new',ts:Date.now()});assert.equal(first.stats.visible,200);assert.ok(first.stats.memory>0);assert.equal(first.stats.verbatim+first.stats.memory,200);assert.match(first.messages[0].content,/cobalt/);
 const used=calls;const resumed=await memory.build({id:'new',ts:Date.now()});assert.equal(calls,used);assert.equal(resumed.stats.memory,first.stats.memory);assert.equal(store.db.prepare('SELECT count(*) n FROM bot_turns').get().n,before);
 store.db.prepare('UPDATE bot_turns SET body=? WHERE id=(SELECT id FROM bot_turns ORDER BY ts LIMIT 1)').run('Corrected first message');await memory.build({id:'new',ts:Date.now()});assert.ok(calls>used,'Changed prefixes invalidate old checkpoints');
});

test('long conversational answers are completely delivered in order before the next owner reply',async t=>{
 const {store,relay}=setup(t,async()=>response({reply:'First paragraph. '+('detail '.repeat(600))+' End of answer.'}));store.set('started_at',Date.now()-1000);const channel='100000000000000051',id=flake(Date.now());store.accept({id,channel_id:channel,author:{id:BOT_OWNER},content:'Explain in detail',timestamp:new Date().toISOString()},channel);
 const sent=[];const replies=new BotReplies(store,{send:async body=>{sent.push(body);return flake(Date.now(),sent.length);}},{},{workflow:relay});await replies.drain();
 assert.equal(sent.join(''),'First paragraph. '+('detail '.repeat(600))+' End of answer.');assert.ok(sent.every(s=>s.length<=2000));assert.ok(sent.length>1);
});

test('API client sends high effort only when requested; archive default remains none',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'misty-reasoning-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const keyFile=path.join(dir,'key');fs.writeFileSync(keyFile,'sk-test-not-a-real-key');const requests=[];
 const client=new OpenAIAnalysis({keyFile,fetchImpl:async(_url,options)=>{requests.push(JSON.parse(options.body));return Response.json({id:'resp-test',status:'completed',usage:{output_tokens:400,output_tokens_details:{reasoning_tokens:300}},output:[{type:'message',content:[{type:'output_text',text:'{"body":"ok"}'}]}]});}});
 const args={model:'gpt-5.6-luna',messages:[{role:'user',content:'hello'}],schema:{type:'object',properties:{body:{type:'string'}}},outputBudget:16000};
 const result=await client.generate({...args,reasoningEffort:'high'});await client.generate(args);
 assert.equal(requests[0].reasoning.effort,'high');assert.equal(requests[1].reasoning.effort,'none');assert.equal(requests[0].store,false);assert.equal(result.reasoning_tokens,300);assert.equal(result.request_id,'resp-test');
});
