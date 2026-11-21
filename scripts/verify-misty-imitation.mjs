// Fictional in-memory conversation with the real model and real owner style.
// No production owner turn, source, approval or Codex job is inserted.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const root=process.env.MISTY_PROBE_ROOT||'/opt/misty-bot';
const {BotStore}=await import(pathToFileURL(root+'/app/discord-bot.mjs'));
const {MistyRelay}=await import(pathToFileURL(root+'/app/misty-relay.mjs'));
const {OpenAIAnalysis}=await import(pathToFileURL(root+'/app/openai-analysis.mjs'));
const {ArchiveTools}=await import(pathToFileURL(root+'/app/misty-archive.mjs'));
const style=JSON.parse(fs.readFileSync('/tmp/archival-migration/misty-rephraser/owner-voice.json','utf8'));
const store=new BotStore(':memory:');store.set('owner_voice',style);
const usage=[],client=new OpenAIAnalysis({keyFile:'/etc/archival/openai-key',onUsage:u=>usage.push({model:u.model,inputTokens:u.inputTokens,outputTokens:u.outputTokens})});
const fixture={available:true,id:'discord:100000000000000005:100000000000000011',room_id:'fixture',body:'I think my birthday is on 17 May, but I need to confirm that date.',author:'ExampleFriend',conversation:'ExampleFriend',platform:'discord',ts:Date.now(),url:'https://discord.com/channels/@me/100000000000000005/100000000000000011'};
const definitions=Object.create(ArchiveTools.prototype).definitions().filter(t=>['archive_chats','archive_search','archive_context','archive_source','archive_summary'].includes(t.name));
const calls=[],archive={definitions:()=>definitions,execute:async(name,args)=>{
 calls.push(name);
 if(name==='archive_source')return args.id===fixture.id?fixture:{available:false};
 if(name==='archive_chats')return {rows:[{id:'fixture',name:'ExampleFriend',platform:'discord',kind:'dm'}]};
 if(name==='archive_search'||name==='archive_context')return {rows:[fixture]};
 return {available:false};
}};
const relay=new MistyRelay(store,client,{model:'gpt-6.1-sol',archive,rephrase:true,compactCards:true,naturalResults:true});
const started=Date.now();
try{
 const first=await relay.handle({id:'isolated-birthday',body:"When is ExampleFriend's birthday?"});
 const initial=relay.rephraser.read('conversation:isolated-birthday');assert.equal(initial.presentationState,'rephrased');assert.ok(initial.sources.length);assert.match(first,/17/);assert.match(first,/\b(?:think|confirm|sure|might|seems|apparently|probably|uncertain|possibly)\b|may be/i);
 const source=await relay.handle({id:'isolated-source',body:'Can you send me the source'});
 assert.match(source,/\[.+\]\(https:\/\/discord\.com\/channels\/@me\/100000000000000005\/100000000000000011\)/);assert.ok(source.length<160);assert.ok(!source.includes('17 May'));
 const details=await relay.handle({id:'isolated-details',body:'Explain in detail what the evidence does and does not establish, including its limits. Keep the uncertainty clear.'});
 const detailAnswer=relay.rephraser.read('conversation:isolated-details');assert.equal(detailAnswer.presentationState,'rephrased');assert.ok(detailAnswer.totalCharacters>initial.totalCharacters||details.length>first.length);assert.equal(store.db.prepare('SELECT count(*) n FROM relay_jobs').get().n,0);
 console.log(JSON.stringify({isolatedFictionalFixture:true,first,source,details,originalCharacters:initial.totalCharacters,style:{version:style.version,count:style.count,examples:style.examples.length},tools:calls,usage,ms:Date.now()-started,productionTurnsWritten:0,productionJobsCreated:0}));
}finally{store.close();}
