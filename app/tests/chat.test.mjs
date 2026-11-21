import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ArchiveStore} from '../store.mjs';
import {ChatSender,chatCapability,validateChatBody} from '../chat.mjs';
import {MatrixController} from '../matrix.mjs';
import {importArchive} from '../import.mjs';
import {createApplication} from '../server.mjs';

const allowedGuilds=new Set(['123']);
function room(store,platform='discord',id='!test:localhost'){
  store.ingest({kind:'room',id,state:{'m.room.name':{name:'Test chat'},'m.bridge':{protocol:{id:platform==='discord'?'discordgo':platform},channel:{id:platform==='discord'?'456':'456@s.whatsapp.net'},'com.beeper.room_type':'dm'}}});return store.room(id);
}
const submission=(body='Hello',target='!test:localhost')=>({id:'chat-'+randomUUID(),room:target,body});
function harness(t,matrix={}){
  const store=new ArchiveStore(':memory:');room(store);
  let queue=Promise.resolve();const serial=fn=>{const next=queue.then(fn);queue=next.catch(()=>{});return next;};
  const calls=[];const sender=new ChatSender(store,serial,{login:async()=>{},verifyChatRoom:async()=>{},sendChat:async(...args)=>{calls.push(args);return {event_id:'$submitted'};},...matrix},{allowedGuilds});
  t.after(async()=>{await sender.close();store.close();});return {store,sender,calls};
}
async function settled(sender){await Promise.all([...sender.jobs.values()]);}
function status(store,status='SUCCESS',stream=1,sender='@discord_999:localhost',room_id='!test:localhost',event_id='$submitted'){
  store.ingestEvent({type:'com.beeper.message_send_status',room_id,sender,content:{'m.relates_to':{event_id},status,internal_error:'private diagnostic',error:'private raw error'}},stream);
}
test('capabilities require connected local supported chats and preserve server exclusions',()=>{
  const base={id:'!test:localhost',platform:'discord',kind:'dm',connected:1,source_joined:1,encrypted:0,server_id:''};
  assert.ok(chatCapability(base,allowedGuilds).allowed);
  assert.ok(chatCapability({...base,tracked:0},allowedGuilds).allowed);
  assert.ok(chatCapability({...base,id:'!'+'a'.repeat(43),platform:'whatsapp'},allowedGuilds).allowed);
  assert.equal(chatCapability({...base,id:'!invalid-hash'},allowedGuilds).allowed,false);
  for(const patch of [{platform:'gmail'},{id:'!test:external'},{kind:'space'},{connected:0},{source_joined:0},{encrypted:1},{server_id:'excluded'}])assert.equal(chatCapability({...base,...patch},allowedGuilds).allowed,false);
  assert.ok(chatCapability({...base,kind:'channel',server_id:'123'},allowedGuilds).allowed);
  for(const body of ['', '  ', 'bad\0text','x'.repeat(2001),null])assert.throws(()=>validateChatBody(base,body,allowedGuilds));
  validateChatBody(base,'🙂'.repeat(1000),allowedGuilds);
  validateChatBody({...base,platform:'whatsapp'},'x'.repeat(20000),allowedGuilds);
});
test('concurrent duplicate requests submit once; Matrix acceptance remains pending until bridge success',async t=>{
  const {store,sender,calls}=harness(t),input=submission();
  await Promise.all([sender.send(input),sender.send(input)]);await settled(sender);
  assert.equal(calls.length,1);assert.deepEqual(calls[0],[input.room,input.body,input.id]);
  assert.equal(sender.outgoing('',input.id)[0].status,'pending');
  status(store);assert.equal(sender.outgoing('',input.id)[0].status,'sent');
  await sender.send(input);assert.equal(calls.length,1);
  await assert.rejects(sender.send({...input,body:'Changed'}),/different message/);
  await assert.rejects(sender.send({...input,room:'!other:localhost'}),/different message/);
});
test('bridge success arriving before the Matrix PUT response is reconciled',async t=>{
  let storeRef;const {store,sender}=harness(t,{sendChat:async()=>{status(storeRef);return {event_id:'$submitted'};}});storeRef=store;
  const input=submission();await sender.send(input);await settled(sender);
  assert.equal(sender.outgoing('',input.id)[0].status,'sent');
});
test('trusted status events update paused chats without becoming archived messages or leaking raw errors',async t=>{
  const {store,sender}=harness(t),input=submission();await sender.send(input);await settled(sender);
  store.updateRoom(input.room,{tracked:false,connected:false});
  status(store,'SUCCESS',1,'@someone:localhost');status(store,'SUCCESS',2,'@whatsappbot:localhost');
  assert.equal(sender.outgoing('',input.id)[0].status,'pending');
  status(store,'FAIL_RETRIABLE',3);assert.equal(sender.outgoing('',input.id)[0].status,'pending');
  assert.doesNotMatch(sender.outgoing('',input.id)[0].error,/private/);
  status(store,'FAIL_PERMANENT',4);assert.equal(sender.outgoing('',input.id)[0].status,'failed');
  status(store,'SUCCESS',2);assert.equal(sender.outgoing('',input.id)[0].status,'failed');
  status(store,'SUCCESS',5);status(store,'PENDING',6);assert.equal(sender.outgoing('',input.id)[0].status,'sent');
  assert.equal(store.messages({}).length,0);
});
test('WhatsApp bridge status matches only its own room and event',async t=>{
  const {store,sender}=harness(t);room(store,'whatsapp','!wa:localhost');const input=submission('Hello','!wa:localhost');
  await sender.send(input);await settled(sender);
  status(store,'SUCCESS',1,'@whatsappbot:localhost','!test:localhost');
  status(store,'SUCCESS',2,'@whatsappbot:localhost','!wa:localhost','$other');
  assert.equal(sender.outgoing('',input.id)[0].status,'pending');
  status(store,'SUCCESS',3,'@whatsappbot:localhost','!wa:localhost');assert.equal(sender.outgoing('',input.id)[0].status,'sent');
});
test('local permission checks fail before mutation and preferences are checked again after network reads',async t=>{
  let storeRef,calls=0;const {store,sender}=harness(t,{verifyChatRoom:async()=>{storeRef.updateRoom('!test:localhost',{connected:false});},sendChat:async()=>{calls++;}});storeRef=store;
  const input=submission();await sender.send(input);await settled(sender);
  assert.equal(calls,0);assert.equal(sender.outgoing('',input.id)[0].status,'failed');
  await assert.rejects(sender.send(submission()),/Reconnect/);
});
test('uncertain submissions and rejected requests have durable outcomes and are never automatically resent',async t=>{
  for(const [httpStatus,expected] of [[undefined,'unknown'],[503,'unknown'],[403,'failed'],[429,'failed']]){
    let calls=0;const {sender}=harness(t,{sendChat:async()=>{calls++;const error=new Error('secret upstream diagnostic');error.status=httpStatus;throw error;}});
    const input=submission();await sender.send(input);await settled(sender);
    assert.equal(sender.outgoing('',input.id)[0].status,expected);assert.doesNotMatch(sender.outgoing('',input.id)[0].error,/secret/);
    await sender.send(input);assert.equal(calls,1);
  }
});
test('interrupted local submissions become unknown on restart without sending',async t=>{
  const {store,sender,calls}=harness(t);await sender.ready;const input=submission();
  store.statement('INSERT INTO chat_outgoing(id,room_id,platform,body,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(input.id,input.room,'discord',input.body,1,1);
  const restarted=new ChatSender(store,fn=>Promise.resolve().then(fn),{sendChat:async()=>{throw new Error('Must not send');}});
  await restarted.ready;assert.equal(restarted.outgoing('',input.id)[0].status,'unknown');await restarted.send(input);assert.equal(calls.length,0);await restarted.close();
});
test('status changes and source checkpoints roll back together',async t=>{
  const {store,sender}=harness(t),input=submission();await sender.send(input);await settled(sender);
  const ingest=store.ingest.bind(store);store.ingest=record=>{if(record.kind==='watermark')throw new Error('Checkpoint failure');ingest(record);};
  await assert.rejects(importArchive(store,{metadata:false,reader:async(c,m,push)=>{
    push({kind:'event',stream:4,event:{type:'com.beeper.message_send_status',room_id:input.room,sender:'@discordbot:localhost',content:{status:'SUCCESS','m.relates_to':{event_id:'$submitted'}}}});push({kind:'watermark',cursor:4});return {};
  }}),/Checkpoint failure/);
  assert.equal(sender.outgoing('',input.id)[0].status,'pending');assert.equal(store.get('stream_cursor',0),0);
});
function matrixState(platform='discord'){
  return [{type:'m.room.member',state_key:'@owner:localhost',content:{membership:'join'}},{type:'m.bridge',state_key:'bridge',content:{channel:{id:platform==='discord'?'456':'456@s.whatsapp.net'},protocol:{id:platform==='discord'?'discordgo':platform},network:{id:''}}}];
}
test('Matrix runtime validation verifies membership, encryption, destination and write power',async()=>{
  let state=matrixState();const matrix=new MatrixController(null,{fetchImpl:async()=>new Response(JSON.stringify(state))});
  const room={id:'!test:localhost',remote_id:'456',server_id:'',platform:'discord'};
  await matrix.verifyChatRoom(room);
  const invalidStates=[[],[...matrixState(),{type:'m.room.encryption',content:{}}],matrixState('whatsapp'),[...matrixState(),{type:'m.room.power_levels',state_key:'',content:{events_default:50}}]];
  for(const invalid of invalidStates){state=invalid;await assert.rejects(matrix.verifyChatRoom(room));}
  state=matrixState();state[1].content.network.id='different';await assert.rejects(matrix.verifyChatRoom(room),/destination changed/);
});
test('Matrix chat PUT uses the stable transaction, plain text, local endpoint and no automatic retry',async()=>{
  const calls=[];const matrix=new MatrixController(null,{fetchImpl:async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({errcode:'M_LIMIT_EXCEEDED',retry_after_ms:1}),{status:429});}});matrix.token='test';
  await assert.rejects(matrix.sendChat('!test:localhost','Hello 🙂','chat-transaction'));
  assert.equal(calls.length,1);assert.equal(calls[0].url,'http://127.0.0.1:8008/_matrix/client/v3/rooms/!test%3Alocalhost/send/m.room.message/chat-transaction');
  assert.equal(calls[0].options.method,'PUT');assert.deepEqual(JSON.parse(calls[0].options.body),{msgtype:'m.text',body:'Hello 🙂'});
});
test('chat HTTP mutations require local CSRF checks and route sends through the injected bridge only',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'archival-chat-test-')),store=new ArchiveStore(':memory:'),roomId='!'+'a'.repeat(43);room(store,'whatsapp',roomId);let calls=0;
  const app=createApplication({store,poll:false,port:18789,gmailOptions:{directory},source:{close(){},read(){throw new Error('No source read expected');}},matrixController:{login:async()=>{},verifyChatRoom:async()=>{},sendChat:async()=>{calls++;return {event_id:'$submitted'};}}});
  await new Promise(resolve=>app.server.listen(18789,'127.0.0.1',resolve));
  try{
    const base='http://127.0.0.1:18789/api/',bootstrap=await(await fetch(base+'bootstrap')).json(),input=submission('🙂\n'.repeat(6000),roomId);
    const send=extra=>fetch(base+'chat/send',{method:'POST',headers:{'Content-Type':'application/json',...extra},body:JSON.stringify(input)});
    assert.equal((await send({})).status,403);assert.equal((await send({'X-Archival-Token':bootstrap.token,Origin:'https://foreign.invalid'})).status,403);assert.equal(calls,0);
    assert.equal((await send({'X-Archival-Token':bootstrap.token})).status,202);assert.equal((await send({'X-Archival-Token':bootstrap.token})).status,202);
    const rows=await(await fetch(base+'chat/outgoing?room='+encodeURIComponent(input.room))).json();assert.equal(rows[0].body,input.body);assert.equal(calls,1);
    assert.equal((await fetch('http://127.0.0.1:18789/chat.js')).status,200);
  }finally{await app.close();assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('archival-chat-test-'));await fs.rm(directory,{recursive:true,force:true});}
});
