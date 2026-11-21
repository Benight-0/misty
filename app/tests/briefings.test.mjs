import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ArchiveStore} from '../store.mjs';
import {Briefings,BRIEFING_PROMPT,briefingFormat} from '../briefings.mjs';
import {prepareBriefing,validateBriefing,dateCues,saveChatEvent,savePersonNote,validDay} from '../briefing-store.mjs';
import {createApplication} from '../server.mjs';

const now=Date.parse('2026-10-10T07:00:00Z');
function room(s,id='!private:localhost',platform='discord',kind='dm'){
  s.ingest({kind:'room',id,state:{'m.room.name':{name:'Private test'},'m.bridge':{protocol:{id:platform==='discord'?'discordgo':platform},channel:{id:platform==='whatsapp'&&kind==='dm'?'123@s.whatsapp.net':'123'},network:{id:kind==='channel'?'123':''},'com.beeper.room_type':kind==='dm'?'dm':kind==='group'?'group_dm':''}}});
}
function message(s,id='$a',body='I like coding in Python.',sender='@discord_123:localhost',ts=now-3600000,room_id='!private:localhost'){
  s.ingestEvent({event_id:id,room_id,sender,type:'m.room.message',origin_server_ts:ts,content:{msgtype:'m.text',body}});
}
function store(t){const s=new ArchiveStore(':memory:');room(s);t.after(()=>s.close());return s;}
function output(snapshot){const [ref,m]=snapshot.refs.entries().next().value;const person=[...snapshot.personRefs].find(([,p])=>p.id===m.person)[0];return {overview:[{text:'This chat discusses coding.',sources:[ref]}],recent:[],followups:[],people:[{person,observations:[{text:'Discusses concrete software work.',sources:[ref]}],preferences:[{text:'Says they like coding.',sources:[ref]}]}],events:[]};}
function modelResponse(value){return new Response(JSON.stringify({message:{content:JSON.stringify(value)}}));}
test('only connected Discord private chats and direct WhatsApp chats enter the queue',t=>{
  const s=store(t);room(s,'!group:localhost','discord','group');room(s,'!wa:localhost','whatsapp','dm');room(s,'!wagroup:localhost','whatsapp','group');room(s,'!server:localhost','discord','channel');room(s,'!mail:localhost','gmail','dm');s.updateRoom('!group:localhost',{connected:false});
  const b=new Briefings(s,{poll:false});assert.deepEqual(b.list().map(x=>x.id).sort(),['!private:localhost','!wa:localhost']);assert.equal(b.room('!wagroup:localhost').eligible,false);
  room(s,'!oddserver:localhost','discord','group');s.statement("UPDATE conversations SET server_id='123' WHERE id='!oddserver:localhost'").run();assert.equal(b.room('!oddserver:localhost').eligible,false);
  assert.throws(()=>prepareBriefing(s,'!server:localhost',now),/limited/);assert.throws(()=>saveChatEvent(s,{room_id:'!wagroup:localhost',title:'Excluded'}),/private/);
});
test('sampling retains authors, raw authored text, own-account grouping and explicit coverage',t=>{
  const s=store(t);message(s,'$a');message(s,'$b','My team is building a website.','@owner:localhost');message(s,'$c','More Python software work.','@discord_123:localhost');message(s,'$exclude','A pasted research article');s.set('profile_excluded_messages',['$exclude']);
  const snapshot=prepareBriefing(s,'!private:localhost',now);assert.equal(snapshot.baseline.coverage.messages,4);assert.equal(snapshot.baseline.coverage.texts,3);assert.equal(snapshot.baseline.people.length,2);assert.equal(snapshot.baseline.people.find(p=>p.is_me).id,'self');assert.ok([...snapshot.refs.values()].every(m=>m.id!=='$exclude'));
  assert.ok(snapshot.baseline.people.find(p=>!p.is_me).topics.some(t=>t.id==='programming'));assert.ok(snapshot.baseline.sourceVersions.$a);
});
test('automated Discord authors are identified and excluded from human topic/profile interpretation',t=>{
  const s=store(t);message(s);message(s,'$bot','Wordle AI research game every day','@discord_999:localhost');
  s.statement('INSERT INTO discord_remote VALUES(?,?,?,?,?,?,?)').run('123','999','!private:localhost','$bot',JSON.stringify({content:'Wordle AI research game every day',author:{bot:true}}),1,now);
  const snap=prepareBriefing(s,'!private:localhost',now);assert.equal(snap.baseline.coverage.messages,2);assert.equal(snap.baseline.coverage.texts,1);assert.equal(snap.baseline.people.find(p=>p.id==='@discord_999:localhost').is_bot,true);assert.ok([...snap.refs.values()].every(m=>m.id!=='$bot'));
  const format=briefingFormat(snap);assert.deepEqual(format.properties.overview.items.properties.sources.items.enum,['m0']);assert.ok(format.properties.people.items.properties.person.enum.includes('p0'));
  for(const key of ['overview','recent','followups'])assert.equal(format.properties[key].items.properties.sources.maxItems,4);
  for(const key of ['observations','preferences'])assert.equal(format.properties.people.items.properties[key].items.properties.sources.maxItems,4);
  assert.equal(format.properties.events.items.properties.sources.maxItems,4);
});
test('trend comparisons use equal current windows and ignore inactive historical chats',t=>{
  const s=store(t);for(let i=0;i<4;i++)message(s,'$r'+i,'Research experiment benchmark',undefined,now-(i+1)*86400000);
  for(let i=0;i<5;i++)message(s,'$p'+i,'Let us discuss the weekend',undefined,now-(40+i)*86400000);
  const p=prepareBriefing(s,'!private:localhost',now).baseline;assert.ok(p.trends.some(t=>t.id==='research'&&t.recent===4&&t.previous===0));
  const old=prepareBriefing(s,'!private:localhost',now+100*86400000).baseline;assert.equal(old.trends.length,0);assert.equal(old.coverage.recentTotal,0);
});
test('dates are relative to the source in India time, and ambiguous years or kal stay unresolved',()=>{
  const ts=Date.parse('2026-10-09T20:00:00Z');assert.deepEqual(dateCues('Meeting tomorrow',ts),['2026-10-11']);assert.deepEqual(dateCues('today tonight',ts),['2026-10-10']);
  assert.deepEqual(dateCues('Deadline 12 October 2026',ts),['2026-10-12']);assert.deepEqual(dateCues('on 12 October',ts),[]);assert.deepEqual(dateCues('kal milte hain',ts),[]);assert.deepEqual(dateCues('Exam 12/10/2026',ts),['2026-10-12']);assert.equal(validDay('2026-02-30'),false);
});
test('model claims need valid in-chat references; person observations cannot cite another author',t=>{
  const s=store(t);message(s);message(s,'$b','I enjoy teaching.','@owner:localhost');const snapshot=prepareBriefing(s,'!private:localhost',now),value=output(snapshot);
  value.people[0].observations.push({text:'Wrong author attribution',sources:['m1']});value.overview.push({text:'Ungrounded',sources:['not-a-message']});value.events.push({title:'Invented date',description:'A plan',date:'2030-12-30',people:['unknown'],sources:['m0']});
  const p=validateBriefing(value,snapshot);assert.equal(p.overview.length,1);assert.equal(p.people.find(x=>!x.is_me).observations.length,1);assert.equal(p.suggestedEvents[0].date,'');assert.deepEqual(p.suggestedEvents[0].people,[]);
  assert.match(BRIEFING_PROMPT,/untrusted quoted conversation/);assert.match(BRIEFING_PROMPT,/No tools/);
});
test('historical follow-ups cannot become upcoming; explicit future dates are allowed and stable',t=>{
  const s=store(t);message(s,'$old','Submit the exam paper tomorrow',undefined,now-365*86400000);const snapshot=prepareBriefing(s,'!private:localhost',now),value=output(snapshot);value.followups=[{text:'Submit it now',sources:['m0']}];assert.equal(validateBriefing(value,snapshot).followups.length,0);
  message(s,'$future','Project review on 2027-01-05',undefined,now-80*86400000);const future=prepareBriefing(s,'!private:localhost',now),v=output(future);v.events=[{title:'Review',description:'Review project',date:'2027-01-05',people:[],sources:['m1']}];v.followups=[{text:'Suggested follow-up: prepare the review.',sources:['m1']}];const result=validateBriefing(v,future);assert.equal(result.suggestedEvents[0].date,'2027-01-05');assert.equal(result.followups.length,1);
});
test('message edits, deletions and own identity corrections dirty only that chat, with atomic rollback',t=>{
  const s=store(t);room(s,'!second:localhost');message(s);const before=s.statement('SELECT * FROM briefing_jobs WHERE room_id=?').get('!private:localhost');
  s.begin();message(s,'$rolled','Another message');s.rollback();assert.equal(s.statement('SELECT revision FROM briefing_jobs WHERE room_id=?').get('!private:localhost').revision,before.revision);
  s.statement('UPDATE messages SET body=? WHERE id=?').run('Updated coding preference','$a');assert.equal(s.statement('SELECT revision FROM briefing_jobs WHERE room_id=?').get('!private:localhost').revision,before.revision+1);
  assert.equal(s.statement('SELECT * FROM briefing_jobs WHERE room_id=?').get('!second:localhost'),undefined);s.redact('$a');assert.equal(s.statement('SELECT revision FROM briefing_jobs WHERE room_id=?').get('!private:localhost').revision,before.revision+2);
});
test('cached interpretations and list excerpts are hidden when their evidence is edited or deleted',async t=>{
  const s=store(t);message(s);const b=new Briefings(s,{poll:false,clock:()=>now,fetchImpl:async()=>modelResponse(output(prepareBriefing(s,'!private:localhost',now)))});await b.runOne();assert.equal(b.room('!private:localhost').payload.overview.length,1);
  s.statement('UPDATE messages SET body=? WHERE id=?').run('Completely different message','$a');assert.equal(b.room('!private:localhost').payload.overview.length,0);assert.equal(b.list()[0].summary,'');assert.equal(b.room('!private:localhost').stale,true);
  s.redact('$a');assert.equal(b.room('!private:localhost').payload.people[0].observations.length,0);await b.close();
});
test('inference is local, does not hold a write transaction, and a newer revision stays queued',async t=>{
  const s=store(t);message(s);let resolve,called=false;const b=new Briefings(s,{poll:false,clock:()=>now,fetchImpl:async(url,options)=>{
    assert.equal(url,'http://127.0.0.1:11434/api/chat');assert.equal(s.db.isTransaction,false);called=true;const request=JSON.parse(options.body);assert.equal(request.think,false);assert.equal(request.stream,false);assert.ok(request.format.properties.people);return new Promise(r=>resolve=r);
  }});const snapshot=prepareBriefing(s,'!private:localhost',now),pending=b.runOne();assert.equal(called,true);
  message(s,'$new','A new project reply',undefined,now-100);resolve(modelResponse(output(snapshot)));await pending;
  const data=b.room('!private:localhost');assert.equal(data.stale,true);assert.equal(data.job.status,'queued');assert.ok(data.job.completed_revision<data.job.revision);await b.close();
});
test('pausing analysis during inference prevents publishing; generated model errors preserve previous previews',async t=>{
  const s=store(t);message(s);let resolve;const b=new Briefings(s,{poll:false,clock:()=>now,fetchImpl:()=>new Promise(r=>resolve=r)});b.seedPreviews();const pending=b.runOne();b.configure('!private:localhost',{enabled:false});resolve(modelResponse(output(prepareBriefing(s,'!private:localhost',now))));await pending;
  assert.equal(b.room('!private:localhost').model,'extractive-preview');assert.equal(b.room('!private:localhost').job.status,'paused');b.configure('!private:localhost',{enabled:true,refresh:true});b.fetch=async()=>new Response('{broken-json');await b.runOne();assert.equal(b.room('!private:localhost').job.status,'error');assert.equal(b.room('!private:localhost').model,'extractive-preview');await b.close();
});
test('user events and chat-specific profile notes persist through regeneration without crossing chats',async t=>{
  const s=store(t);message(s,'$a','Project meeting tomorrow');const b=new Briefings(s,{poll:false,clock:()=>now,fetchImpl:async()=>{const snap=prepareBriefing(s,'!private:localhost',now),v=output(snap);v.events=[{title:'Project meeting',description:'Discuss the project',date:'2026-10-11',people:['p0'],sources:['m0']}];return modelResponse(v);}});await b.runOne();const candidate=b.room('!private:localhost').events[0];assert.equal(candidate.status,'proposed');
  const saved=saveChatEvent(s,{...candidate,title:'My reviewed title',date:'2026-10-12',status:'confirmed'},now);savePersonNote(s,{room_id:'!private:localhost',person_id:'@discord_123:localhost',label:'A colleague',note:'Discuss project updates here.'});
  b.configure('!private:localhost',{refresh:true});await b.runOne();const result=b.room('!private:localhost');assert.equal(result.events.length,1);assert.equal(result.events[0].title,saved.title);assert.equal(result.events[0].status,'confirmed');assert.equal(result.payload.people[0].name,'A colleague');assert.match(result.payload.people[0].customNote,/project/);
  assert.equal(b.events().length,1);assert.equal(b.events()[0].title,saved.title);
  room(s,'!other:localhost');message(s,'$other','Other chat',undefined,now,'!other:localhost');assert.throws(()=>saveChatEvent(s,{...candidate,room_id:'!other:localhost'}),/different chat/);assert.throws(()=>saveChatEvent(s,{room_id:'!other:localhost',title:'Bad source',evidence:['$a']}),/this chat/);assert.throws(()=>savePersonNote(s,{room_id:'!other:localhost',person_id:'unknown',note:'Bad'}),/author/);await b.close();
});
test('briefing and event APIs require mutation tokens and reject excluded room types',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'archival-briefing-test-')),s=new ArchiveStore(':memory:');room(s);message(s);room(s,'!server:localhost','discord','channel');
  const app=createApplication({store:s,poll:false,port:18790,gmailOptions:{directory},source:{close(){},read(){throw new Error('No upstream calls');}}});await new Promise(r=>app.server.listen(18790,'127.0.0.1',r));
  try{const base='http://127.0.0.1:18790/api/',b=await(await fetch(base+'bootstrap')).json();assert.equal((await(await fetch(base+'briefings')).json()).status.total,1);
    const post=(path,body,token='')=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Archival-Token':token},body:JSON.stringify(body)});
    assert.equal((await post('briefings/event',{room_id:'!private:localhost',title:'Local plan'})).status,403);
    assert.equal((await post('briefings/event',{room_id:'!private:localhost',title:'Local plan',date:'2026-10-12',status:'confirmed'},b.token)).status,200);
    assert.equal((await post('briefings/event',{room_id:'!server:localhost',title:'Excluded'},b.token)).status,400);
    assert.equal((await(await fetch(base+'briefings/events')).json()).length,1);
  }finally{await app.close();assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('archival-briefing-test-'));await fs.rm(directory,{recursive:true,force:true});}
});
test('manual profile notes and event updates remain usable after their last source message is redacted',async t=>{
  const s=store(t);message(s);const b=new Briefings(s,{poll:false,clock:()=>now,fetchImpl:async()=>modelResponse(output(prepareBriefing(s,'!private:localhost',now)))});await b.runOne();
  savePersonNote(s,{room_id:'!private:localhost',person_id:'@discord_123:localhost',label:'My contact',note:'Keep these notes.'});
  s.statement('INSERT INTO discord_matrix_links VALUES(?,?)').run('$legacy','$a');
  const event=saveChatEvent(s,{room_id:'!private:localhost',title:'User plan',people:['@discord_123:localhost'],evidence:['$legacy']},now);assert.deepEqual(event.evidence,['$a']);
  s.redact('$a');b.configure('!private:localhost',{refresh:true});await b.runOne();
  assert.equal(b.room('!private:localhost').payload.people[0].customNote,'Keep these notes.');
  assert.equal(saveChatEvent(s,{...event,status:'done'},now+1).status,'done');await b.close();
});
