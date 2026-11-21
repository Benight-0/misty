import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ArchiveStore} from '../store.mjs';
import {nativeSchema} from '../native-ingest.mjs';
import {Briefings} from '../briefings.mjs';
import {loadHistoryPlan,nextHistoryStep,saveHistoryNode} from '../briefing-history.mjs';
import {validateBriefing} from '../briefing-store.mjs';
import {OpenAIAnalysis} from '../openai-analysis.mjs';
import {startVMAnalysis} from '../vm-analysis-worker.mjs';
import {DatabaseSync} from 'node:sqlite';

const room='!optimized:localhost',now=Date.now()+60000,model='test';
function fixture(t,batches=18){
  const store=new ArchiveStore(':memory:');t.after(()=>store.close());
  store.ingest({kind:'room',id:room,state:{'m.room.name':{name:'Optimization test'},'m.bridge':{protocol:{id:'discordgo'},channel:{id:'123'},'com.beeper.room_type':'dm'}}});
  for(let i=0;i<batches*180;i++)store.ingestEvent({event_id:'$'+i,room_id:room,sender:'@owner:localhost',type:'m.room.message',origin_server_ts:now-100000+i,content:{msgtype:'m.text',body:'I enjoy coding '+i}});
  return store;
}
function output(input){
  const sources=input.messages?[input.messages[0].ref]:input.notes[0].overview[0].sources;
  return {overview:[{text:'Coding discussion.',sources}],recent:[],followups:[],people:[],events:[]};
}
function saveStep(s,plan,step){
  const payload=validateBriefing(output(step.snapshot.input),step.snapshot);saveHistoryNode(s,room,step.node,payload,now);
  plan.cached.set(step.node.hash,JSON.stringify(payload));plan.payloads.set(step.node.hash,payload);delete step.node.snapshot;return payload;
}
function seedMaps(s){
  const plan=loadHistoryPlan(s,room,model,now);
  for(;;){const step=nextHistoryStep(s,plan);if(step.node.stage!=='map')break;
    const payload=validateBriefing(output(step.snapshot.input),step.snapshot);
    // Saved author bookkeeping must not reduce wire-input capacity or alter evidence.
    payload.people[0].extraBookkeeping='x'.repeat(20000);
    payload.people[0].observations=Array.from({length:6},(_,i)=>({text:'Discusses project '+i+' '+('specific supported detail '.repeat(12)),evidence:[step.node.messages[0].id]}));
    saveHistoryNode(s,room,step.node,payload,now);plan.cached.set(step.node.hash,JSON.stringify(payload));
  }
}

test('wide synthesis packs six notes, keeps all original evidence and excludes saved bookkeeping',t=>{
  const s=fixture(t);seedMaps(s);const plan=loadHistoryPlan(s,room,model,now,{reductionPolicy:'wide'}),step=nextHistoryStep(s,plan);
  assert.equal(step.node.children.length,6);assert.equal(step.snapshot.input.notes.length,6);
  assert.ok(Buffer.byteLength(JSON.stringify(step.snapshot.input))<=90000);
  assert.ok(!JSON.stringify(step.snapshot.input).includes('extraBookkeeping'));
  const refs=new Map([...step.snapshot.refs].map(([ref,m])=>[m.id,ref]));
  for(const child of step.node.children)for(const claim of child.payload.people[0].observations)for(const id of claim.evidence)assert.ok(refs.has(id));
  assert.equal(step.snapshot.input.messages,undefined,'Reducer gets notes and original evidence metadata, not full transcripts');
  const baseline=plan.full.baseline;assert.equal(baseline.people[0].observations.length,0,'Snapshot validation cannot mutate the lifetime baseline');
});

test('wide synthesis reuses partial legacy subtrees, resumes deterministically and never overwrites them',t=>{
  const s=fixture(t);seedMaps(s);let legacy=loadHistoryPlan(s,room,model,now);
  for(let i=0;i<4;i++)saveStep(s,legacy,nextHistoryStep(s,legacy));
  const original=s.statement('SELECT hash,payload FROM briefing_history_nodes').all();
  let plan=loadHistoryPlan(s,room,model,now,{reductionPolicy:'wide'}),calls=0;
  let step=nextHistoryStep(s,plan);assert.ok(step.node.children.some(n=>n.stage==='reduce'),'Completed legacy reductions feed the new tree');
  assert.equal(step.node.children.reduce((n,c)=>n+c.parts,0),step.node.parts);
  saveStep(s,plan,step);calls++;
  const expected=nextHistoryStep(s,plan).node.hash;
  plan=loadHistoryPlan(s,room,model,now,{reductionPolicy:'wide'});
  assert.equal(nextHistoryStep(s,plan).node.hash,expected,'Restart reuses the same wide tree');
  for(let i=0;i<20;i++){
    step=nextHistoryStep(s,plan);if(step.payload)break;
    assert.notEqual(step.node.stage,'map');saveStep(s,plan,step);calls++;
  }
  assert.ok(step.payload.coverage.complete);assert.equal(step.payload.coverage.analyzed,18*180);
  assert.ok(calls<8,'Six-note synthesis needs far fewer than one call per original batch');
  for(const row of original)assert.equal(s.statement('SELECT payload FROM briefing_history_nodes WHERE hash=?').get(row.hash).payload,row.payload);
  for(const node of plan.nodes.values())if(plan.cached.has(node.hash))assert.equal(node.snapshot,undefined,'Cached reductions retain no reconstructed request snapshots');
  assert.ok(step.payload.people[0].observations.length,'Quiet-author fallback retains supported detailed findings');
  s.statement('UPDATE messages SET body=? WHERE id=?').run('I now prefer hiking.','$0');
  const edited=nextHistoryStep(s,loadHistoryPlan(s,room,model,now,{reductionPolicy:'wide'}));assert.equal(edited.node.stage,'map');assert.equal(edited.node.ordinal,0);
});

test('completed legacy root is reused without a new model call when enabling wide synthesis',t=>{
  const s=fixture(t,3);const plan=loadHistoryPlan(s,room,model,now);
  let step;for(let i=0;i<10;i++){step=nextHistoryStep(s,plan);if(step.payload)break;saveStep(s,plan,step);}
  assert.ok(step.payload.coverage.complete);
  const wide=nextHistoryStep(s,loadHistoryPlan(s,room,model,now,{reductionPolicy:'wide'}));
  assert.equal(wide.node,undefined);assert.deepEqual(wide.payload.overview,step.payload.overview);
});

test('parallel wide reductions claim different groups and wait for every child before final publication',async t=>{
  const s=fixture(t,12);seedMaps(s);const pending=[],inputs=[];
  const analysisClient={generate:async request=>{
    const input=JSON.parse(request.messages[1].content);inputs.push(input);
    return new Promise(resolve=>pending.push(()=>resolve({message:{content:JSON.stringify(output(input))},done_reason:'stop'})));
  }};
  const b=new Briefings(s,{poll:false,clock:()=>now,model,analysisClient,concurrency:3,maxActiveRooms:1});
  try{
    const first=b.runOne(),second=b.runOne();assert.equal(inputs.length,2);assert.equal(inputs[0].notes.length,6);assert.equal(inputs[1].notes.length,6);
    assert.notEqual(inputs[0].notes[0].first,inputs[1].notes[0].first);assert.equal(await b.runOne(),false);
    pending[1]();await second;assert.equal(b.status().ready,0);assert.equal(await b.runOne(),false);
    pending[0]();await first;assert.equal(b.status().ready,0);
    const final=b.runOne();assert.equal(inputs[2].stage,'final');assert.equal(inputs[2].notes.length,2);
    pending[2]();await final;assert.equal(b.status().upToDate,1);assert.equal(b.room(room).payload.coverage.analyzed,12*180);
  }finally{await b.close();}
});

test('a rejected combining response cannot contaminate the successful retry with partial claims',async t=>{
  const s=fixture(t,6);seedMaps(s);let attempt=0;
  const client={generate:async request=>{
    const input=JSON.parse(request.messages[1].content),value=output(input);
    if(attempt++===0){value.overview=[];value.people=[{person:'p0',observations:[{text:'Rejected attempt observation.',sources:input.notes[0].overview[0].sources}],preferences:[]}];}
    return {message:{content:JSON.stringify(value)},done_reason:'stop'};
  }};
  const b=new Briefings(s,{poll:false,clock:()=>now,model,analysisClient:client});
  try{
    await b.runOne();assert.equal(b.status().ready,0);assert.equal(b.room(room).job.status,'error');
    s.statement('UPDATE briefing_jobs SET not_before=0').run();await b.runOne();
    assert.equal(b.status().ready,1);assert.ok(!JSON.stringify(b.room(room).payload).includes('Rejected attempt'));
  }finally{await b.close();}
});

test('long-message parts retain first-part preferences during indexed validation',t=>{
  const s=fixture(t,0);s.ingestEvent({event_id:'$long',room_id:room,sender:'@owner:localhost',type:'m.room.message',origin_server_ts:now,content:{msgtype:'m.text',body:'I enjoy coding. '+('ordinary text '.repeat(600))}});
  const step=nextHistoryStep(s,loadHistoryPlan(s,room,model,now));assert.ok(step.snapshot.refs.size>1);
  const value=output(step.snapshot.input);value.people=[{person:'p0',observations:[],preferences:[{text:'Enjoys coding.',sources:['m0']}]}];
  assert.equal(validateBriefing(value,step.snapshot).people[0].preferences.length,1);
});

test('API rate-limit backoff is shared across lanes and honors Retry-After without leaking upstream bodies',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'misty-backoff-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const keyFile=path.join(dir,'key');fs.writeFileSync(keyFile,'sk-test-placeholder');
  const client=new OpenAIAnalysis({keyFile,fetchImpl:async()=>new Response('private upstream content',{status:429,headers:{'retry-after':'2'}})});
  const start=Date.now();await assert.rejects(client.generate({schema:{},messages:[],model:'test'}),error=>error.retryAt>=start+2000&&!error.message.includes('private upstream'));
  assert.ok(client.retryAt>=start+2000);
  const s=fixture(t,1),b=new Briefings(s,{poll:false,analysisClient:client,clock:()=>start});
  assert.equal(await b.runOne(),false);assert.equal(b.active,0);await b.close();
});

test('VM worker starts independently, reports bounded capacity and shuts down without API calls',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'misty-worker-')),filename=path.join(dir,'archive.sqlite');
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const s=new ArchiveStore(filename);nativeSchema(s);
  const errors=[],worker=startVMAnalysis({filename,model:'test',concurrency:3,keyFile:path.join(dir,'missing-key'),onError:e=>errors.push(e)});
  try{await Promise.race([worker.ready,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Worker startup timeout')),5000);timer.unref();})]);
    assert.equal(s.get('briefing_worker_capacity'),3);assert.equal(s.get('briefing_worker_runtime').reductionPolicy,'wide');assert.deepEqual(errors,[]);
  }finally{await worker.close();s.close();}
});

test('ingestion reserves the WAL writer before reading so analysis cannot invalidate its snapshot',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'misty-writers-')),filename=path.join(dir,'archive.sqlite');
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const s=new ArchiveStore(filename),other=new DatabaseSync(filename);
  other.exec('PRAGMA busy_timeout=0;');
  try{
    s.begin();assert.equal(s.get('concurrent-test'),null);
    assert.throws(()=>other.prepare('INSERT INTO settings VALUES(?,?)').run('other-writer','true'),/locked/);
    s.set('concurrent-test',true);s.commit();
    other.prepare('INSERT INTO settings VALUES(?,?)').run('other-writer','true');assert.equal(s.get('other-writer'),true);
  }finally{if(s.db.isTransaction)s.rollback();other.close();s.close();}
});
