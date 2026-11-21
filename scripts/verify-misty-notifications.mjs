// Isolated live-model probe: synthetic evidence only; no Discord sends or DBs.
import assert from 'node:assert/strict';
import {OpenAIAnalysis} from '../app/openai-analysis.mjs';
import {NOTIFICATION_PROMPT} from '../app/misty-notifications.mjs';
const client=new OpenAIAnalysis({keyFile:process.env.MISTY_PROBE_KEY_FILE});
const cases=[
 {name:'direct-action',kind:'dm',messages:[{id:'fixture-dm',body:'Can you confirm by 18:00 today whether you are joining our algorithms practice tomorrow? I need your answer to reserve a spot.',is_me:0}],notify:true},
 {name:'group-filler',kind:'group',messages:[{id:'fixture-group',body:'ok lol',is_me:0}],notify:false},
 {name:'server-50',kind:'server',messages:Array.from({length:50},(_,i)=>({id:'fixture-'+i,body:i===49?'Registration for the algorithms training camp closes today at 20:00. There are two places left; sign up today if you want to attend.':'Routine greetings and unrelated small talk.',is_me:0})),notify:true}
];
for(const sample of cases){
 const now=new Date();const began=Date.now();
 const response=await client.generate({model:'gpt-5.6-luna',reasoningEffort:'low',outputBudget:2500,signal:AbortSignal.timeout(60000),schema:{type:'object',properties:{notify:{type:'boolean'},priority:{type:'string'},category:{type:'string'},topic:{type:'string'},message:{type:'string'},reason:{type:'string'},sources:{type:'array',items:{type:'string'}},chunkMemory:{type:'string'}}},messages:[{role:'system',content:NOTIFICATION_PROMPT},{role:'user',content:JSON.stringify({now:now.toISOString(),timezone:'Asia/Kolkata',kind:sample.kind,newMessages:sample.messages.map(m=>({...m,ts:now.getTime()})),profile:{findings:[{title:'Algorithms',summary:'The owner actively practices competitive programming and seeks training opportunities.',confidence:.95,status:'confirmed'}]},recent:{rows:[]},alreadyNotified:[],priorDay:{chunks:[]}})}]});
 const decision=JSON.parse(response.message.content);assert.equal(decision.notify,sample.notify,sample.name);
 if(decision.notify){assert.ok(decision.message.trim());assert.ok(decision.sources.length);assert.ok(decision.sources.every(id=>sample.messages.some(m=>m.id===id)));}
 if(sample.kind==='server')assert.ok(decision.chunkMemory.trim());
 console.log(JSON.stringify({case:sample.name,notify:decision.notify,category:decision.category,elapsedMs:Date.now()-began,inputTokens:response.prompt_eval_count,outputTokens:response.eval_count}));
}
