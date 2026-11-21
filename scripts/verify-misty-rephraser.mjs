// Real model calls against an isolated in-memory bot. Production is opened only
// read-only for owner style; no synthetic owner messages or jobs enter it.
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const root=process.env.MISTY_PROBE_ROOT||'/opt/misty-bot';
const {BotStore}=await import(pathToFileURL(root+'/app/discord-bot.mjs'));
const {MistyRelay}=await import(pathToFileURL(root+'/app/misty-relay.mjs'));
const {OpenAIAnalysis}=await import(pathToFileURL(root+'/app/openai-analysis.mjs'));
const production=new DatabaseSync('/var/lib/misty-bot/chat.sqlite',{readOnly:true});
const style=production.prepare("SELECT value FROM bot_settings WHERE key='owner_voice'").get();production.close();
const store=new BotStore(':memory:');if(style)store.set('owner_voice',JSON.parse(style.value));
const calls=[];
const api=new OpenAIAnalysis({keyFile:'/etc/archival/openai-key',onUsage:u=>calls.push(u)});
const client={generate:async p=>{const start=Date.now(),result=await api.generate(p);result.elapsed=Date.now()-start;return result;}};
const relay=new MistyRelay(store,client,{model:'gpt-6.1-sol',rephrase:true,compactCards:true,naturalResults:true});
const started=Date.now();
try{
 const request='Explain in a detailed formal reply how approved Codex requests work while my laptop is off. Include these facts: tasks wait on the VM; the laptop must be awake, signed in and online to run Codex; Work on this allows up to 6 follow-ups within 24 hours in the pinned dedicated chat; new unrelated work requires fresh approval. Preserve the qualifications. This is explanation only, not a request to start work.';
 const reply=await relay.handle({id:'isolated-rephraser-verification',body:request});
 const saved=store.db.prepare('SELECT * FROM misty_answers').get();assert.ok(saved,'No detailed answer stored');assert.equal(saved.state,'rephrased',saved.error);assert.ok(saved.original.length>300);assert.ok(reply.length>300);assert.match(saved.rendered,/(?:6|six) follow-ups/i);assert.match(saved.rendered,/24/);assert.equal(store.db.prepare('SELECT count(*) n FROM relay_jobs').get().n,0);
 const secondStart=Date.now();
 const casual=await relay.rephraser.present({source:'isolated-casual',kind:'chat',request:'okay so does it wait until the laptop is back on? keep it brief.',original:'Yes. Approved tasks remain queued on the VM while the laptop is offline. They run only when the laptop is awake, signed in and online. No task has started merely because it is queued.'});
 assert.equal(relay.rephraser.read('isolated-casual').presentationState,'rephrased');
 console.log(JSON.stringify({isolated:true,formal:{original:saved.original,presented:saved.rendered},casual,modelCalls:calls.map(u=>({model:u.model,inputTokens:u.inputTokens,outputTokens:u.outputTokens})),totalMs:Date.now()-started,casualMs:Date.now()-secondStart,productionMessagesWritten:0,productionJobsCreated:0}));
}finally{store.close();}
