import test from 'node:test';
import assert from 'node:assert/strict';
import {ArchiveStore} from '../store.mjs';
import {Briefings} from '../briefings.mjs';
import {prepareBriefing,validateBriefing} from '../briefing-store.mjs';
import {loadHistoryPlan,nextHistoryStep,saveHistoryNode,historyChapters} from '../briefing-history.mjs';

const now=Date.now()+60000,id='!history:localhost';
function setup(t){const s=new ArchiveStore(':memory:');s.ingest({kind:'room',id,state:{'m.room.name':{name:'History test'},'m.bridge':{protocol:{id:'discordgo'},channel:{id:'123'},'com.beeper.room_type':'dm'}}});t.after(()=>s.close());return s;}
function add(s,n,body='I like coding.',sender='@owner:localhost'){s.ingestEvent({event_id:'$'+n,room_id:id,sender,type:'m.room.message',origin_server_ts:now-500000+n,content:{msgtype:'m.text',body}});}
function response(input){
  const m=input.messages?.[0],note=input.notes?.[0].overview?.[0];
  const sources=m?[m.ref]:note.sources;
  return {overview:[{text:m?'Discussed: '+m.text.slice(0,100):'Combined lifetime discussion.',sources}],recent:[],followups:[],people:m?[{person:m.person,observations:[{text:'Discussed coding.',sources}],preferences:[{text:'Likes coding.',sources}]}]:[],events:[]};
}
const mockFetch=counts=>async(url,options)=>{const request=JSON.parse(options.body),input=JSON.parse(request.messages[1].content);counts.push(input);return new Response(JSON.stringify({done_reason:'stop',message:{content:JSON.stringify(response(input))}}));};

test('full-history batches cover every eligible character, including brief messages and long Unicode text',t=>{
  const s=setup(t);for(let i=0;i<700;i++)add(s,i,i%2?'ok':'I like coding '+i);
  const long='Long message 😀 भारत '.repeat(1100);add(s,1000,long);add(s,1001,'https://example.test');add(s,1002,'Forwarded I love tennis');add(s,1003,'Copied I like biology');add(s,1004,'file');add(s,1005,'k');s.set('profile_excluded_messages',['$1003']);
  const full=prepareBriefing(s,id,now,{full:true}),plan=loadHistoryPlan(s,id,'test',now);
  assert.equal(full.baseline.coverage.texts,706);assert.ok(plan.leaves.length>4);
  const pieces=plan.leaves.flatMap(n=>n.messages);assert.equal(new Set(pieces.map(m=>m.id)).size,706);
  assert.ok(pieces.filter(m=>m.id==='$1000').map(m=>m.body).join('')===long.trim(),'All normalized long-message characters are preserved');
  assert.equal(pieces.filter(m=>m.id==='$1').map(m=>m.body).join(''),'ok');
  assert.ok(pieces.filter(m=>['$1002','$1003'].includes(m.id)).every(m=>m.profileEligible===false));
  for(const node of plan.leaves)assert.ok(node.messages.length<=180);
});

test('copied and forwarded text is analyzed as context but cannot become the sender’s profile',t=>{
  const s=setup(t);add(s,1,'Forwarded I love tennis');const plan=loadHistoryPlan(s,id,'test',now),step=nextHistoryStep(s,plan);
  const p=validateBriefing(response(step.snapshot.input),step.snapshot);assert.equal(p.overview.length,1);assert.equal(p.people[0].observations.length,0);assert.equal(p.people[0].preferences.length,0);
});

test('multiple stages must finish before the chat is ready; all batch findings remain available',async t=>{
  const s=setup(t);for(let i=0;i<730;i++)add(s,i,'I like coding '+i);
  const counts=[],b=new Briefings(s,{poll:false,clock:()=>now,fetchImpl:mockFetch(counts)});b.seedHistoryProgress();
  const total=b.room(id).history.total_batches;assert.ok(total>=5);await b.runOne();assert.equal(b.status().ready,0);assert.equal(b.room(id).history.completed_batches,1);assert.equal(b.room(id).job.completed_revision,0);
  for(let i=0;i<30&&b.status().ready===0;i++)await b.runOne();
  assert.equal(b.status().ready,1);assert.equal(b.status().upToDate,1);
  const p=b.room(id).payload;assert.equal(p.coverage.mode,'full-history');assert.equal(p.coverage.analyzed,730);assert.equal(p.coverage.complete,true);
  assert.ok(counts.some(input=>input.stage==='final'));assert.ok(p.people[0].observations.length>0,'Quiet profiles survive reducer omission');
  const chapters=historyChapters(s,id,b.model,now,{offset:0,limit:10});assert.equal(chapters.total,total);assert.equal(chapters.chapters.length,total);assert.ok(chapters.chapters.every(c=>c.payload.overview.length));
  await b.close();
});

test('restart reuses saved batches, and appended messages preserve completed older batches',async t=>{
  const s=setup(t);for(let i=0;i<400;i++)add(s,i,'I like coding '+i);
  let calls=[];const first=new Briefings(s,{poll:false,clock:()=>now,fetchImpl:mockFetch(calls)});await first.runOne();assert.equal(calls.length,1);await first.close();
  calls=[];const resumed=new Briefings(s,{poll:false,clock:()=>now,fetchImpl:mockFetch(calls)});await resumed.runOne();assert.equal(calls[0].messages[0].text,'I like coding 180');
  const old=loadHistoryPlan(s,id,resumed.model,now);add(s,999,'An appended reply');const updated=loadHistoryPlan(s,id,resumed.model,now);
  assert.equal(updated.leaves[0].hash,old.leaves[0].hash);assert.equal(updated.leaves[1].hash,old.leaves[1].hash);assert.notEqual(updated.leaves.at(-1).hash,old.leaves.at(-1).hash);
  assert.equal(nextHistoryStep(s,updated).progress.completed_batches,2);await resumed.close();
});

test('edits/deletions invalidate affected batches and hide stale chapter findings immediately',t=>{
  const s=setup(t);for(let i=0;i<360;i++)add(s,i,'I like coding '+i);
  const plan=loadHistoryPlan(s,id,'test',now),step=nextHistoryStep(s,plan),payload=validateBriefing(response(step.snapshot.input),step.snapshot);
  saveHistoryNode(s,id,step.node,payload,now);assert.equal(historyChapters(s,id,'test',now).chapters[0].status,'complete');
  s.statement('UPDATE messages SET body=? WHERE id=?').run('I now dislike coding','$0');
  const edited=historyChapters(s,id,'test',now);assert.equal(edited.chapters[0].status,'queued');assert.equal(edited.chapters[0].payload,null);
  s.redact('$0');assert.equal(historyChapters(s,id,'test',now).progress.completed_texts,0);
});

test('partially analyzed long messages do not count as fully read',t=>{
  const s=setup(t);add(s,1,'😀'.repeat(20000));const plan=loadHistoryPlan(s,id,'test',now),step=nextHistoryStep(s,plan);
  saveHistoryNode(s,id,step.node,validateBriefing(response(step.snapshot.input),step.snapshot),now);
  const current=nextHistoryStep(s,loadHistoryPlan(s,id,'test',now));assert.ok(current.progress.completed_parts>0);assert.equal(current.progress.completed_texts,0);assert.ok(current.node);
});

test('truncated outputs are never marked complete or cached',async t=>{
  const s=setup(t);add(s,1);const b=new Briefings(s,{poll:false,clock:()=>now,fetchImpl:async(url,options)=>{
    const input=JSON.parse(JSON.parse(options.body).messages[1].content);return new Response(JSON.stringify({done_reason:'length',message:{content:JSON.stringify(response(input))}}));}});
  await b.runOne();assert.equal(b.room(id).job.status,'error');assert.match(b.room(id).job.error,/truncated/);assert.equal(b.status().ready,0);assert.equal(s.statement('SELECT count(*) n FROM briefing_history_nodes').get().n,0);await b.close();
});

test('multi-level synthesis consumes every chronological batch and preserves its separate records',async t=>{
  const s=setup(t);for(let i=0;i<2400;i++)add(s,i,'I like coding '+i);
  const inputs=[],b=new Briefings(s,{poll:false,clock:()=>now,fetchImpl:mockFetch(inputs)});
  for(let i=0;i<50&&b.status().ready===0;i++)await b.runOne();
  assert.equal(b.status().upToDate,1);assert.ok(inputs.some(i=>i.stage==='reduce'));assert.ok(inputs.some(i=>i.stage==='final'));
  const mapped=inputs.filter(i=>i.stage==='map');assert.equal(mapped.flatMap(i=>i.messages).length,2400);
  const noteCount=inputs.filter(i=>i.notes).reduce((sum,i)=>sum+i.notes.length,0);assert.ok(noteCount>=mapped.length);
  assert.equal(b.room(id).payload.coverage.analyzed,2400);assert.equal(s.statement("SELECT count(*) n FROM briefing_history_nodes WHERE stage='map'").get().n,mapped.length);await b.close();
});

test('concurrent lanes claim distinct batches, honor the capacity, and complete out of order safely',async t=>{
  const s=setup(t);for(let i=0;i<400;i++)add(s,i,'I like coding '+i);
  const pending=[],inputs=[],b=new Briefings(s,{poll:false,clock:()=>now,concurrency:2,fetchImpl:async(url,options)=>{
    const input=JSON.parse(JSON.parse(options.body).messages[1].content);inputs.push(input);return new Promise(resolve=>pending.push(()=>resolve(new Response(JSON.stringify({message:{content:JSON.stringify(response(input))}})))));
  }});
  const first=b.runOne(),second=b.runOne();assert.equal(inputs.length,2);assert.notEqual(inputs[0].messages[0].text,inputs[1].messages[0].text);assert.equal(b.active,2);assert.equal(await b.runOne(),false);
  pending[1]();await second;assert.equal(b.room(id).history.completed_batches,1);assert.equal(b.room(id).job.status,'running');assert.equal(b.status().ready,0);
  const third=b.runOne();assert.equal(inputs[2].messages[0].text,'I like coding 360');pending[2]();await third;
  pending[0]();await first;assert.equal(b.room(id).history.completed_batches,3);assert.equal(b.active,0);assert.equal(b.status().ready,0);
  const root=b.runOne();assert.equal(inputs[3].stage,'final');assert.equal(await b.runOne(),false);pending[3]();await root;assert.equal(b.status().upToDate,1);assert.equal(b.room(id).payload.coverage.analyzed,400);await b.close();
});

test('a concurrent failure preserves successful checkpoints and never publishes an incomplete chat',async t=>{
  const s=setup(t);for(let i=0;i<400;i++)add(s,i,'I like coding '+i);
  const pending=[],b=new Briefings(s,{poll:false,clock:()=>now,concurrency:2,fetchImpl:async(url,options)=>{
    const input=JSON.parse(JSON.parse(options.body).messages[1].content);return new Promise(resolve=>pending.push(valid=>resolve(new Response(valid?JSON.stringify({message:{content:JSON.stringify(response(input))}}):'broken'))));
  }});
  const first=b.runOne(),second=b.runOne();pending[0](false);await first;pending[1](true);await second;
  assert.equal(b.room(id).history.completed_batches,1);assert.equal(b.room(id).job.status,'error');assert.equal(b.status().ready,0);assert.equal(b.active,0);assert.equal(b.claims.size,0);
  assert.equal(s.statement("SELECT count(*) n FROM briefing_history_nodes WHERE stage='map'").get().n,1);await b.close();
});

test('a new revision waits for old in-flight requests; pause and shutdown preserve prior checkpoints',async t=>{
  const s=setup(t);for(let i=0;i<400;i++)add(s,i,'I like coding '+i);
  const pending=[],b=new Briefings(s,{poll:false,clock:()=>now,concurrency:2,fetchImpl:async(url,options)=>{
    const input=JSON.parse(JSON.parse(options.body).messages[1].content);return new Promise((resolve,reject)=>{pending.push(()=>resolve(new Response(JSON.stringify({message:{content:JSON.stringify(response(input))}}))));options.signal.addEventListener('abort',()=>reject(new Error('Aborted')));});
  }});
  const first=b.runOne(),second=b.runOne();add(s,999,'New reply');b.configure(id,{refresh:true});assert.equal(await b.runOne(),false);
  pending[0]();await first;assert.equal(await b.runOne(),false,'New revision cannot duplicate a still-active old revision');pending[1]();await second;
  assert.equal(b.room(id).stale,false);assert.equal(b.status().ready,0);assert.equal(b.room(id).history.completed_batches,2);
  const third=b.runOne();b.configure(id,{enabled:false});pending[2]();await third;assert.equal(b.room(id).job.status,'paused');assert.equal(b.room(id).history.completed_batches,2);
  b.configure(id,{enabled:true,refresh:true});const fourth=b.runOne();await b.close();await fourth;assert.equal(b.active,0);assert.equal(b.room(id).job.status,'queued');assert.equal(b.room(id).history.completed_batches,2);
});

test('parallel analysis rejects external endpoints and invalid lane counts',t=>{
  const s=setup(t);assert.throws(()=>new Briefings(s,{poll:false,endpoint:'https://example.test/api/chat'}),/local/);assert.throws(()=>new Briefings(s,{poll:false,concurrency:8}),/one to four/);
});

for(const capacity of [2,3])test('polling dispatches '+capacity+' concurrent requests automatically and keeps going through synthesis',async t=>{
  const s=setup(t);for(let i=0;i<400;i++)add(s,i,'I like coding '+i);
  let active=0,peak=0,calls=0;
  const b=new Briefings(s,{poll:true,clock:()=>now,concurrency:capacity,fetchImpl:async(url,options)=>{
    active++;peak=Math.max(peak,active);calls++;await new Promise(r=>setTimeout(r,100));active--;
    return new Response(JSON.stringify({message:{content:JSON.stringify(response(JSON.parse(JSON.parse(options.body).messages[1].content)))}}));
  }});
  const idleTimer=b.timer;b.wake(0);assert.notEqual(b.timer,idleTimer,'An earlier work dispatch must preempt an idle poll timer');
  const deadline=Date.now()+2000;while(Date.now()<deadline&&b.status().ready===0)await new Promise(r=>setTimeout(r,10));
  assert.equal(b.status().ready,1);assert.equal(peak,capacity);assert.equal(calls,4);assert.equal(s.get('briefing_worker_error',''),'');await b.close();
});

