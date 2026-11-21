import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ArchiveStore} from '../store.mjs';
import {applyNativeEvent} from '../native-ingest.mjs';
import {NativeChat} from '../native-chat.mjs';
import {ChatSender} from '../chat.mjs';
import {draftChat} from '../chat-ai.mjs';

const channel='100000000000000029',owner='100000000000000023';
function harness(t,fetchImpl){
 const store=new ArchiveStore(':memory:');applyNativeEvent(store,{kind:'discord_channel',channel:{id:channel,type:1,name:'Test recipient'}});store.set('native_discord',{connected:true});
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'misty-send-')),tokenFile=path.join(dir,'token');fs.writeFileSync(tokenFile,'test-session');
 const calls=[],native=new NativeChat(store,{tokenFile,fetchImpl:async(url,options)=>{
  calls.push({url,options});if(fetchImpl)return fetchImpl(url,options);
  return Response.json(url.endsWith('/users/@me')?{id:owner}:url.endsWith('/messages')?{id:'100000000000000052',channel_id:channel,author:{id:owner,username:'Owner'},content:JSON.parse(options.body).content,timestamp:new Date().toISOString()}:{id:channel,type:1});
 }});
 let queue=Promise.resolve();const serial=fn=>{const next=queue.then(fn);queue=next.catch(()=>{});return next;};
 const sender=new ChatSender(store,serial,null,{native});const room=store.statement("SELECT * FROM conversations WHERE remote_id=?").get(channel);
 t.after(async()=>{await sender.close();store.close();fs.rmSync(dir,{recursive:true,force:true});});return {store,sender,room,calls};
}
test('native sends verify owner and private destination, archive the own message, and never resend an ID',async t=>{
 const {store,sender,room,calls}=harness(t);const input={id:'chat-'+randomUUID(),room:room.id,body:'Misty test'};
 await sender.send(input);await Promise.all([...sender.jobs.values()]);await sender.send(input);
 assert.equal(sender.outgoing('',input.id)[0].status,'sent');assert.equal(calls.filter(c=>c.options.method==='POST').length,1);
 const request=JSON.parse(calls.at(-1).options.body);assert.equal(request.enforce_nonce,true);assert.equal(request.nonce.length,24);assert.deepEqual(request.allowed_mentions,{parse:[]});
 assert.equal(store.statement('SELECT is_me FROM messages').get().is_me,1);assert.equal(store.room(room.id).message_count,1);
 assert.equal(sender.capability({...room,server_id:'123'}).allowed,false);assert.equal(sender.capability({...room,platform:'whatsapp'}).allowed,false);
 await assert.rejects(sender.send({...input,body:'Changed'}),/different message/);
});
test('wrong account and a changed destination cannot send',async t=>{
 for(const wrongAccount of [true,false]){
  const {sender,room,calls}=harness(t,url=>Response.json(url.endsWith('/users/@me')?{id:wrongAccount?'someone-else':owner}:{id:channel,type:0,guild_id:'123'}));
  const row=await sender.send({id:'chat-'+randomUUID(),room:room.id,body:'Test'});await Promise.all([...sender.jobs.values()]);
  assert.equal(sender.outgoing('',row.id)[0].status,'failed');assert.equal(calls.filter(c=>c.options.method==='POST').length,0);
 }
});
test('Discord group DMs keep the existing private-channel target and send path',async t=>{
 const {sender,store,room,calls}=harness(t,(url,options)=>Response.json(url.endsWith('/users/@me')?{id:owner}:options.method==='POST'?{id:'100000000000000053',channel_id:channel,author:{id:owner},content:JSON.parse(options.body).content,timestamp:new Date().toISOString()}:{id:channel,type:3}));
 store.statement("UPDATE conversations SET kind='group' WHERE id=?").run(room.id);
 const inspected=await sender.inspect(store.room(room.id));assert.equal(inspected.target.kind,'group');assert.equal(inspected.target.guildId,undefined);
 const input={id:'chat-'+randomUUID(),room:room.id,body:'exact group DM',target:inspected.target};await sender.send(input);await Promise.all([...sender.jobs.values()]);
 assert.equal(sender.outgoing('',input.id)[0].status,'sent');assert.equal(calls.filter(c=>c.options.method==='POST').length,1);
 assert.equal(JSON.parse(calls.at(-1).options.body).message_reference,undefined);
});
test('ambiguous Discord failures remain unknown and are not retried',async t=>{
 const {sender,room,calls}=harness(t,(url,options)=>{
  if(options.method==='POST')throw Error('private upstream diagnostic');
  return Response.json(url.endsWith('/users/@me')?{id:owner}:{id:channel,type:1});
 });
 const input={id:'chat-'+randomUUID(),room:room.id,body:'Test'};await sender.send(input);await Promise.all([...sender.jobs.values()]);await sender.send(input);
 const saved=sender.outgoing('',input.id)[0];assert.equal(saved.status,'unknown');assert.doesNotMatch(saved.error,/private upstream/);assert.equal(calls.filter(c=>c.options.method==='POST').length,1);
});
test('AI drafting fixes the recipient, treats history as reference, and never sends by itself',async t=>{
 const {store,sender,room,calls}=harness(t);let request;
 const client={generate:async args=>{request=args;return {message:{content:JSON.stringify({body:'A short test message.'})}};}};
 const result=await draftChat(store,sender,client,{room:room.id,instruction:'Write a brief test notice.'});
 assert.equal(result.sent,false);assert.equal(result.room,room.id);assert.match(request.messages[0].content,/untrusted reference/);assert.equal(calls.length,0);assert.equal(sender.outgoing(room.id).length,0);
 await assert.rejects(draftChat(store,sender,client,{room:room.id,instruction:''}),/instruction/);
});

test('WhatsApp uses the existing linked session, archives own text and submits each ID once',async t=>{
 const store=new ArchiveStore(':memory:');
 applyNativeEvent(store,{kind:'whatsapp_message',chat:'123@lid',id:'old',sender:'123@lid',is_me:false,name:'Contact',at:Date.now(),body:'Hi',type:'m.text'});store.set('native_whatsapp',{connected:true});
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'wa-send-')),tokenFile=path.join(folder,'token');fs.writeFileSync(tokenFile,'test-credential');
 const room=store.statement("SELECT * FROM conversations WHERE platform='whatsapp'").get();let posts=0;
 const native=new NativeChat(store,{messageTokenFile:tokenFile,fetchImpl:async(url,options)=>{
  if(url.endsWith('/inspect'))return Response.json({ready:true});
  posts++;const args=JSON.parse(options.body);
  return Response.json({kind:'whatsapp_message',id:'sent-id',chat:args.chat,body:args.body,is_me:true,sender:'110000000000005@s.whatsapp.net',name:'You',at:Date.now(),type:'m.text'});
 }});
 let queue=Promise.resolve();const serial=fn=>{const next=queue.then(fn);queue=next.catch(()=>{});return next;};const sender=new ChatSender(store,serial,null,{native});
 t.after(async()=>{await sender.close();store.close();fs.rmSync(folder,{recursive:true,force:true});});
 const input={id:'chat-'+randomUUID(),room:room.id,body:'exact WhatsApp text'};
 await sender.send(input);await Promise.all([...sender.jobs.values()]);await sender.send(input);
 assert.equal(sender.outgoing('',input.id)[0].status,'sent');assert.equal(posts,1);
 assert.equal(store.statement("SELECT is_me FROM messages WHERE body=?").get(input.body).is_me,1);
});
