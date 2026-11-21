// One real API quality check using invented conversations, never the private archive.
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.argv[2]||'/opt/archival/app';
const {ArchiveStore}=await import(pathToFileURL(path.join(root,'store.mjs')));
const {loadHistoryPlan,nextHistoryStep,saveHistoryNode}=await import(pathToFileURL(path.join(root,'briefing-history.mjs')));
const {validateBriefing}=await import(pathToFileURL(path.join(root,'briefing-store.mjs')));
const {briefingFormat,BRIEFING_PROMPT,COMPACT_OUTPUT_PROMPT}=await import(pathToFileURL(path.join(root,'briefings.mjs')));
const {OpenAIAnalysis}=await import(pathToFileURL(path.join(root,'openai-analysis.mjs')));
// FULL_REDUCE_PROMPT is exported by briefing-history rather than Briefings.
const {FULL_REDUCE_PROMPT:reducePrompt}=await import(pathToFileURL(path.join(root,'briefing-history.mjs')));
const store=new ArchiveStore(':memory:'),room='!synthetic:localhost',now=Date.now();
store.ingest({kind:'room',id:room,state:{'m.room.name':{name:'Synthetic quality test'},'m.bridge':{protocol:{id:'discordgo'},channel:{id:'123'},'com.beeper.room_type':'dm'}}});
const samples=[
 ['@owner:localhost','I enjoy Python programming.','Used to enjoy Python programming.'],
 ['@other:localhost','I prefer quiet places for studying.','Prefers quiet places for studying.'],
 ['@owner:localhost','I no longer enjoy Python for scripts. I prefer Rust now.','Changed scripting preference from Python to Rust.'],
 ['@other:localhost','Let us meet on 2026-11-15.','Proposed meeting on 2026-11-15.'],
 ['@other:localhost','The 2026-11-15 meeting is cancelled.','Cancelled the 2026-11-15 meeting.'],
 ['@owner:localhost','I enjoy astronomy. I will send telescope notes on 2026-11-20.','Enjoys astronomy and promised telescope notes for 2026-11-20.']
];
for(let b=0;b<samples.length;b++)for(let i=0;i<180;i++)store.ingestEvent({event_id:'$'+b+'-'+i,room_id:room,sender:samples[b][0],type:'m.room.message',origin_server_ts:now-100000+(b*180+i)*50,content:{msgtype:'m.text',body:i===0?samples[b][1]:'ok'}});
const plan=loadHistoryPlan(store,room,'gpt-5.6-luna',now,{reductionPolicy:'wide'});assert.equal(plan.leaves.length,6);
for(let b=0;b<6;b++){
 const step=nextHistoryStep(store,plan),input=step.snapshot.input,ref=input.messages[0].ref,person=input.messages[0].person,sources=[ref];
 const payload=validateBriefing({overview:[{text:samples[b][2],sources}],recent:[],followups:[],people:[{person,observations:[{text:samples[b][2],sources}],preferences:[0,1,2,5].includes(b)?[{text:samples[b][2],sources}]:[]}],events:b===3||b===4?[{title:'Meeting',description:samples[b][2],date:'2026-11-15',people:[person],sources}]:b===5?[{title:'Send telescope notes',description:samples[b][2],date:'2026-11-20',people:[person],sources}]:[]},step.snapshot);
 saveHistoryNode(store,room,step.node,payload,now);plan.cached.set(step.node.hash,JSON.stringify(payload));plan.payloads.set(step.node.hash,payload);
}
const step=nextHistoryStep(store,plan);assert.equal(step.snapshot.input.notes.length,6);
const client=new OpenAIAnalysis({keyFile:'/etc/archival/openai-key',onUsage:u=>console.log(JSON.stringify({inputTokens:u.inputTokens,outputTokens:u.outputTokens,status:u.status}))});
const result=await client.generate({model:'gpt-5.6-luna',messages:[{role:'system',content:BRIEFING_PROMPT+'\n'+reducePrompt+'\n'+COMPACT_OUTPUT_PROMPT},{role:'user',content:JSON.stringify(step.snapshot.input)}],schema:briefingFormat(step.snapshot),outputBudget:5000,room:'_synthetic_synthesis_check_',signal:AbortSignal.timeout(120000)});
const payload=validateBriefing(JSON.parse(result.message.content),step.snapshot),text=JSON.stringify(payload.overview)+' '+JSON.stringify(payload.people)+' '+JSON.stringify(payload.suggestedEvents);
assert.match(text,/Rust/i);assert.match(text,/quiet/i);assert.match(text,/astronom|telescope/i);assert.match(text,/cancel/i);
const owner=payload.people.find(p=>p.is_me),other=payload.people.find(p=>!p.is_me);
assert.ok(owner.preferences.some(c=>/Rust/i.test(c.text)));assert.ok(other.preferences.some(c=>/quiet/i.test(c.text)));
for(const p of payload.people)for(const c of [...p.observations,...p.preferences])for(const id of c.evidence)assert.equal(plan.byId.get(id).person,p.id);
for(const e of payload.suggestedEvents)if(e.date==='2026-11-15')assert.match(e.description+' '+e.title,/cancel/i);
console.log(JSON.stringify({qualityCheck:'passed',notes:6,people:payload.people.length,overview:payload.overview,profiles:payload.people.map(p=>({name:p.name,observations:p.observations,preferences:p.preferences})),events:payload.suggestedEvents,durationMs:Math.round(result.total_duration/1e6)}));
store.close();
