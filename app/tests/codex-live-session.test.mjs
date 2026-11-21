import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {CodexCoordination,LiveSessions,LIVE_EXTENSION_VERSION,LIVE_EXTENSION_VERSIONS,checkLiveCompatibility,resolveCodexBinary,liveTurns,applyStreamPatches} from '../codex-live-session.mjs';
import {CodexJobs} from '../codex-relay-client.mjs';
import {digestJob} from '../misty-relay.mjs';

const threadId='01a11111-1111-7111-8111-111111111111',owner='editor-owner';
const job=()=>{const target={kind:'existing',id:threadId,title:'Test chat',cwd:process.cwd()},prompt='Exact approved text\nwith Unicode: \u2601';return {id:'stable-job-id',target,prompt,hash:digestJob(prompt,target)};};
const frame=value=>{const b=Buffer.from(JSON.stringify(value)),h=Buffer.alloc(4);h.writeUInt32LE(b.length);return Buffer.concat([h,b]);};

test('staged extension updates accept only validated releases and resolve the registered binary',t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'misty-versions-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const binaries=LIVE_EXTENSION_VERSIONS.map(version=>{
  const root=path.join(directory,'openai.chatgpt-'+version),binary=path.join(root,'bin','windows-x86_64','codex.exe');
  fs.mkdirSync(path.dirname(binary),{recursive:true});fs.writeFileSync(binary,'fixture');fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({version}));return binary;
 });
 const inventory=path.join(directory,'extensions.json');
 const register=(version,relativeLocation='openai.chatgpt-'+version)=>fs.writeFileSync(inventory,JSON.stringify([{identifier:{id:'openai.chatgpt'},version,relativeLocation}]));
 register(LIVE_EXTENSION_VERSIONS[1]);
 assert(checkLiveCompatibility(binaries[0]));assert(checkLiveCompatibility(binaries[1]));
 assert.equal(resolveCodexBinary(binaries[0]),binaries[1]);
 register('future-unvalidated');assert.equal(checkLiveCompatibility(binaries[0]),false);assert.throws(()=>resolveCodexBinary(binaries[0]),/unsupported-extension-version/);
 register(LIVE_EXTENSION_VERSIONS[1],'../elsewhere');assert.throws(()=>resolveCodexBinary(binaries[0]),/unsupported-extension-version/);
 register(LIVE_EXTENSION_VERSIONS[1]);fs.rmSync(binaries[1]);assert.throws(()=>resolveCodexBinary(binaries[0]),/unsupported-extension-version/);
});

async function fixture(t,{active=false,queue=[],version=LIVE_EXTENSION_VERSION}={}){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'misty-live-'));
 const stateFile=path.join(directory,'state.json'),binary=path.join(directory,'bin','windows-x86_64','codex.exe');
 fs.mkdirSync(path.dirname(binary),{recursive:true});fs.writeFileSync(path.join(directory,'package.json'),JSON.stringify({version}));
 const f={requests:[],queue,turns:[],owned:true,active,dropQueueReply:false,connections:new Set()};
 f.persist=()=>fs.writeFileSync(stateFile,JSON.stringify({'queued-follow-ups':{[threadId]:f.queue}}));f.persist();
 f.state=()=>({id:threadId,cwd:process.cwd(),hostId:'local',resumeState:'resumed',threadRuntimeStatus:{type:f.active?'active':'idle'},turns:[]});
 const server=net.createServer(socket=>{
  f.connections.add(socket);socket.once('close',()=>f.connections.delete(socket));let buffer=Buffer.alloc(0);
  const reply=(m,result,extra={})=>socket.write(frame({type:'response',requestId:m.requestId,resultType:'success',handledByClientId:owner,result,...extra}));
  socket.on('data',bytes=>{
   buffer=Buffer.concat([buffer,bytes]);
   while(buffer.length>=4&&buffer.length>=4+buffer.readUInt32LE(0)){
    const size=buffer.readUInt32LE(0),m=JSON.parse(buffer.subarray(4,size+4));buffer=buffer.subarray(size+4);
    f.requests.push(m);
    if(m.type==='client-discovery-response')continue;
    if(m.method==='initialize'){
     const b=frame({type:'response',requestId:m.requestId,resultType:'success',result:{clientId:'misty-client'}});
     socket.write(b.subarray(0,2));socket.write(b.subarray(2,7));socket.write(b.subarray(7));
     socket.write(frame({type:'client-discovery-request',requestId:'probe',method:'thread-owner-discovery'}));
    }else if(m.method==='thread-owner-discovery'){
     if(f.owned)reply(m,{ownerClientId:owner});else socket.write(frame({type:'response',requestId:m.requestId,resultType:'error',error:'no-client-found'}));
    }else if(m.method==='thread-stream-following-changed'&&m.params.following){
     const base={type:'broadcast',sourceClientId:owner,method:'thread-stream-state-changed',version:11,params:{conversationId:threadId,hostId:'local',change:{type:'snapshot',revision:1,conversationState:f.state()}}};
     // A different client's state must never be accepted, even for the same ID.
     socket.write(frame({...base,sourceClientId:'other-editor',params:{...base.params,change:{...base.params.change,conversationState:{...f.state(),cwd:'wrong'}}}}));
     socket.write(frame(base));
    }else if(m.method==='thread-follower-set-queued-follow-ups-state'){
     assert.equal(m.targetClientId,owner);assert.equal(m.version,1);assert.equal(m.hostId,undefined);
     f.queue=m.params.state[threadId];f.persist();
     if(f.onQueue)f.onQueue(f.queue[0]);
     if(f.dropQueueReply)socket.destroy();else reply(m,{ok:true});
    }else if(m.method==='wrong-owner')reply(m,{}, {handledByClientId:'imposter'});
    else if(m.method==='disconnect')socket.destroy();
   }
  });
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const connection=new CodexCoordination({connect:()=>net.connect(server.address().port,'127.0.0.1'),timeout:1000});
 f.live=new LiveSessions(binary,{connection,stateFile});
 f.rpc=new class extends EventEmitter{
  closed=false;calls=[];
  async request(method,p){
   this.calls.push({method,p});
   if(method==='thread/read')return {thread:{id:threadId,cwd:process.cwd(),status:{type:'notLoaded'}}};
   if(method==='thread/turns/list')return f.pages?f.pages(p):{data:f.turns};
   throw Error('Unexpected mutation on separate app-server: '+method);
  }
 };
 f.db=new DatabaseSync(':memory:');f.jobs=new CodexJobs(f.rpc,f.db,{liveSessions:f.live,pollMs:5,busyCheck:async()=>false});
 t.after(async()=>{f.jobs.close();f.live.close();f.db.close();for(const s of f.connections)s.destroy();await new Promise(resolve=>server.close(resolve));fs.rmSync(directory,{recursive:true,force:true});});
 return f;
}

test('framed local IPC handles fragmented frames, refuses ownership, binds replies and disconnects cleanly',async t=>{
 const f=await fixture(t);await f.live.connection.connect();
 assert.equal(await f.live.connection.owner(threadId),owner);
 await assert.rejects(f.live.connection.request('wrong-owner',{}, {targetClientId:owner}),/wrong-owner/);
 await assert.rejects(f.live.connection.request('disconnect',{}, {targetClientId:owner}),/disconnected/);
 assert.equal(f.live.connection.pending.size,0);
 assert.equal(f.requests.find(m=>m.type==='client-discovery-response').response.canHandle,false);
});

test('fresh snapshots ignore other clients and require the exact approved workspace and supported extension',async t=>{
 const f=await fixture(t);const session=await f.live.open(threadId,process.cwd());assert.equal(session.state.cwd,process.cwd());
 await assert.rejects(f.live.open(threadId,'C:\\wrong-workspace'),/workspace-mismatch/);
 f.live.compatible=false;await assert.rejects(f.live.open(threadId,process.cwd()),/unsupported-extension-version/);
 assert.equal(f.requests.filter(m=>m.method==='thread-follower-set-queued-follow-ups-state').length,0);
 f.owned=false;assert.equal(await f.live.open(threadId,process.cwd()),null);
});

test('open idle chat executes exact approved text through its owner and settled journal cannot replay it',async t=>{
 const f=await fixture(t),j=job();let admissionStage;
 f.onQueue=message=>{
  admissionStage=f.jobs.row(j.id).stage;
  assert.equal(message.id,j.id);assert.equal(message.text,j.prompt);assert.equal(message.context.prompt,j.prompt);
  assert.equal(message.cwd,j.target.cwd);assert.equal(message.submission.queueModeOverride,'queue');
  assert.equal(message.submissionOptions,undefined); // Inherit the editor's model/permissions.
  f.turns=[{id:'live-turn',status:'completed',items:[{type:'userMessage',clientId:j.id},{type:'agentMessage',phase:'commentary',text:'Do not return this'},{type:'agentMessage',phase:'final_answer',text:'Live final answer'}]}];
  f.queue=[];f.persist();
 };
 const result=await f.jobs.run(j);assert.equal(result.status,'completed');assert.equal(result.answer,'Live final answer');assert.equal(result.turnId,'live-turn');assert.equal(admissionStage,'submitting');
 assert.equal(f.jobs.row(j.id).route,'live');assert.deepEqual(await f.jobs.run(j),result);
 assert.equal(f.requests.filter(m=>m.method==='thread-follower-set-queued-follow-ups-state').length,1);
 assert.ok(!f.rpc.calls.some(c=>['thread/resume','turn/start'].includes(c.method)));
});

test('new validated extension still submits once to the existing owner and preserves the exact prompt',async t=>{
 const f=await fixture(t,{version:LIVE_EXTENSION_VERSIONS[1]}),j=job();
 f.onQueue=()=>{f.turns=[{id:'new-release-turn',status:'completed',items:[{type:'userMessage',clientId:j.id},{type:'agentMessage',phase:'final_answer',text:'Completed'}]}];f.queue=[];f.persist();};
 assert.equal((await f.jobs.run(j)).status,'completed');assert.equal((await f.jobs.run(j)).status,'completed');
 assert.equal(f.requests.filter(m=>m.method==='thread-follower-set-queued-follow-ups-state').length,1);
 assert(!f.rpc.calls.some(c=>['thread/resume','turn/start'].includes(c.method)));
});

test('busy editor or existing native queue waits without steering, interrupting or replacing queued work',async t=>{
 const f=await fixture(t,{active:true}),j=job();assert.equal((await f.jobs.run(j)).blocked,true);
 f.active=false;f.queue=[{id:'user-queued',text:'Preserve this'}];f.persist();
 assert.equal((await f.jobs.run(j)).blocked,true);assert.equal(f.live.readQueue(threadId)[0].id,'user-queued');
 assert.equal(f.requests.filter(m=>m.method?.startsWith('thread-follower-')).length,0);
 const session=await f.live.open(threadId,process.cwd());assert.deepEqual(await f.live.enqueue(session,j),{blocked:true});
});

test('lost admission response reconciles receipt and never repeats the exact prompt',async t=>{
 const f=await fixture(t),j=job();f.dropQueueReply=true;
 f.onQueue=()=>{f.turns=[{id:'accepted-turn',status:'completed',items:[{type:'userMessage',clientId:j.id},{type:'agentMessage',text:'Recovered answer',phase:'final_answer'}]}];f.queue=[];f.persist();};
 assert.equal((await f.jobs.run(j)).answer,'Recovered answer');assert.equal((await f.jobs.run(j)).status,'completed');
 assert.equal(f.requests.filter(m=>m.method==='thread-follower-set-queued-follow-ups-state').length,1);
});

test('restart recovery searches beyond first history page and cannot start another backend',async t=>{
 const f=await fixture(t),j=job();
 f.db.prepare("INSERT INTO codex_jobs(id,hash,stage,thread_id,route) VALUES(?,?,'submitting',?,'live')").run(j.id,j.hash,threadId);
 f.pages=p=>p.cursor?{data:[{id:'old-receipt',status:'completed',items:[{type:'userMessage',clientId:j.id},{type:'agentMessage',text:'Previously completed',phase:'final_answer'}]}]}:{data:[],nextCursor:'older'};
 const result=await f.jobs.run(j);assert.equal(result.answer,'Previously completed');assert.equal(result.turnId,'old-receipt');
 assert.equal(f.requests.filter(m=>m.method?.startsWith('thread-follower-')).length,0);assert.ok(f.rpc.calls.some(c=>c.p.cursor==='older'));
});

test('queued work survives editor closing and is not submitted to another backend',async t=>{
 const f=await fixture(t),j=job();f.owned=false;f.queue=[{id:j.id,text:j.prompt,cwd:j.target.cwd}];f.persist();
 f.db.prepare("INSERT INTO codex_jobs(id,hash,stage,thread_id,route) VALUES(?,?,'queued',?,'live')").run(j.id,j.hash,threadId);
 assert.deepEqual(await f.jobs.run(j),{blocked:true,reason:'waiting_for_editor',route:'live'});
 assert.equal(f.jobs.row(j.id).stage,'queued');assert.equal(f.requests.filter(m=>m.method==='thread-follower-set-queued-follow-ups-state').length,0);
});

test('canonical stream history exposes turn receipts without loading the entire chat again',()=>{
 const receipt={turnId:'turn',params:{clientUserMessageId:'job'},items:[]};
 assert.deepEqual(liveTurns({turns:[],turnHistory:{kind:'canonical',history:{entitiesByKey:{key:receipt}}}}),[receipt]);
});

test('live owner completion overrides a separate reader falsely labeling its active rollout interrupted',async t=>{
 const f=await fixture(t),j=job();let liveTurn;
 f.state=()=>({id:threadId,cwd:process.cwd(),hostId:'local',resumeState:'resumed',threadRuntimeStatus:{type:liveTurn?.status==='inProgress'?'active':'idle'},turns:liveTurn?[liveTurn]:[]});
 f.onQueue=()=>{
  liveTurn={turnId:'owned-turn',status:'inProgress',params:{clientUserMessageId:j.id},items:[]};
  f.turns=[{id:'owned-turn',status:'interrupted',completedAt:null,items:[{type:'userMessage',clientId:j.id}]}];
  f.queue=[];f.persist();
  setTimeout(()=>{
   liveTurn={...liveTurn,status:'completed',items:[{type:'agentMessage',text:'Owner says finished',phase:'final_answer'}]};
   const m={type:'broadcast',sourceClientId:owner,method:'thread-stream-state-changed',version:11,params:{hostId:'local',conversationId:threadId,change:{type:'patches',baseRevision:1,revision:2,patches:[{op:'replace',path:['turns',0],value:liveTurn},{op:'replace',path:['threadRuntimeStatus'],value:{type:'idle'}}]}}};
   for(const socket of f.connections)socket.write(frame(m));
  },50);
 };
 const result=await f.jobs.run(j);assert.equal(result.status,'completed');assert.equal(result.answer,'Owner says finished');
 assert.equal(f.requests.filter(m=>m.method==='thread-follower-set-queued-follow-ups-state').length,1);
});

test('stream patches handle array operations and reject prototype or missing-parent writes',()=>{
 const state={turns:[{status:'inProgress'}]};
 applyStreamPatches(state,[{op:'replace',path:['turns',0,'status'],value:'completed'},{op:'add',path:['turns',1],value:{status:'inProgress'}},{op:'remove',path:['turns',0]}]);
 assert.deepEqual(state,{turns:[{status:'inProgress'}]});
 assert.throws(()=>applyStreamPatches(state,[{op:'add',path:['__proto__','polluted'],value:true}]),/invalid-patch/);
 assert.throws(()=>applyStreamPatches(state,[{op:'replace',path:['missing','key'],value:true}]),/missing-patch-parent/);
 assert.equal({}.polluted,undefined);
});
