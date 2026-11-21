import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {BotStore} from '../discord-bot.mjs';
import {MistyRelay} from '../misty-relay.mjs';
import {MistyMessages} from '../misty-messages.mjs';
import {serveMessageBackend,MessageBackend} from '../message-backend.mjs';
import {ProminenceBridge,serveProminenceBridge} from '../misty-prominence-bridge.mjs';
import {NativeChat} from '../native-chat.mjs';
import {ArchiveStore} from '../store.mjs';
import {ChatSender} from '../chat.mjs';
import {applyNativeEvent} from '../native-ingest.mjs';

function fixture(t,platform='discord'){
 const s=new BotStore(':memory:');t.after(()=>s.close());const r=new MistyRelay(s,{});
 let now=Date.now(),seq=0n,sendCalls=0,broken=false,changed=false;
 const id=()=>String((BigInt(now-1420070400000)<<22n)+(++seq));
 const owner=(body)=>{const oid=id();s.db.prepare("INSERT INTO bot_turns(id,channel,body,ts,status) VALUES(?,?,?,?,?)").run(oid,'owner',body,now,'external');return oid;};
 const target={room:'room',name:'Contact',platform,kind:'dm',remoteId:'100000000000000005'};
 const backend={call:async(op,args)=>{
  if(op==='inspect')return {target:changed?{...target,remoteId:'different'}:target,capability:{allowed:true,maxLength:platform==='discord'?2000:20000}};
  if(op==='send'){sendCalls++;if(broken)throw Error('lost response');return {id:args.id,room_id:args.room,body:args.body,status:'sent',event_id:'remote-id'};}
  return null;
 }};
 const m=new MistyMessages(r,backend,{clock:()=>now});r.messages=m;
 const delivered=()=>{for(const row of r.db.prepare("SELECT seq FROM relay_notices WHERE status='queued'").all())r.db.prepare("UPDATE relay_notices SET status='sent',message_id=? WHERE seq=?").run(id(),row.seq);};
 const draft=async(body='exact text')=>m.propose({ownerMessageId:owner('Send a message to Contact.'),room:'room',body});
 return {s,r,m,owner,delivered,draft,calls:()=>sendCalls,time:ms=>now+=ms,broken:()=>broken=true,changed:()=>changed=true};
}
for(const platform of ['discord','whatsapp'])test(`${platform}: app approval sends the exact preview once; Discord yes cannot send`,async t=>{
 const f=fixture(t,platform),d=await f.draft('Hello\nexact wording');
 assert.equal(f.calls(),0);
 await f.m.observe(f.owner('yes '+d.code));
 assert.equal(f.calls(),0);
 assert.equal(f.m.pendingApprovals().drafts[0].body,'Hello\nexact wording');
 const sent=await f.m.confirmOverlay({code:d.code,digest:d.digest});
 assert.equal(sent.state,'sent');assert.equal(sent.target.platform,platform);
 await assert.rejects(f.m.confirmOverlay({code:d.code,digest:d.digest}),/changed or expired/);
 assert.equal(f.calls(),1);
});
test('Gmail exact preview, app send, saved draft, and destination recheck',async t=>{
 const f=fixture(t);let sends=0,drafts=0,changed=false;
 const target={platform:'gmail',account:'a',from:'me@example.com',to:['friend@example.com'],cc:[],bcc:['hidden@example.com'],subject:'Hello',replyTo:'',threadId:''};
 f.m.backend={call:async(op,args)=>{
  if(op==='email_inspect')return {target:changed?{...target,to:['other@example.com']}:target,capability:{allowed:true,maxLength:20000}};
  if(op==='email_accounts')return {accounts:[{id:'a',canDraft:true,canSend:true}]};
  if(op==='email_save_draft'){drafts++;return {id:'draft-1',account:'a'};}
  if(op==='email_send'){sends++;return {id:args.id,target_json:JSON.stringify(args.target),body:args.body,status:'sent',remote_id:'sent-1'};}
  if(op==='email_status')return null;
  throw Error('Unexpected backend operation '+op);
 }};
 const input={account:'a',to:'friend@example.com',bcc:'hidden@example.com',subject:'Hello',body:'Exact email body'};
 const d=await f.m.proposeEmail({...input,ownerMessageId:f.owner('Send this email.')});
 assert.equal(sends,0);
 assert.equal(d.target.from,'me@example.com');assert.deepEqual(d.target.bcc,['hidden@example.com']);assert.equal(d.body,'Exact email body');
 assert.doesNotMatch(f.r.db.prepare("SELECT group_concat(body) body FROM relay_notices WHERE source LIKE 'personal:%:app'").get().body,/Exact email body/);
 assert.equal((await f.m.confirmOverlay({code:d.code,digest:d.digest})).state,'sent');assert.equal(sends,1);
 const draftOwner=f.owner('Save a draft in Gmail.');
 assert.equal((await f.m.saveEmailDraft({...input,ownerMessageId:draftOwner})).id,'draft-1');
 await f.m.saveEmailDraft({...input,ownerMessageId:draftOwner});assert.equal(drafts,1);
 const next=await f.m.proposeEmail({...input,ownerMessageId:f.owner('Send a revised email.')});changed=true;
 await assert.rejects(f.m.confirmOverlay({code:next.code,digest:next.digest}),/destination or connection changed/);
 assert.equal(sends,1);
});
test('app edit replaces preview and cancellation never sends',async t=>{
 const f=fixture(t),first=await f.draft('old');
 const edited=await f.m.editOverlay({code:first.code,digest:first.digest,fields:{body:'new exact body'}});
 assert.equal(f.m.status(first.code).state,'replaced');assert.equal(edited.body,'new exact body');
 await assert.rejects(f.m.confirmOverlay({code:first.code,digest:first.digest}),/changed or expired/);
 assert.equal(f.m.cancelOverlay({code:edited.code,digest:edited.digest}).state,'cancelled');
 assert.equal(f.calls(),0);
});
test('expired preview, changed destination and altered journal fail closed',async t=>{
 const f=fixture(t),a=await f.draft();f.time(24*3600000+1);
 await assert.rejects(f.m.confirmOverlay({code:a.code,digest:a.digest}),/expired/);
 const b=await f.draft();f.changed();
 await assert.rejects(f.m.confirmOverlay({code:b.code,digest:b.digest}),/destination or connection changed/);
 const c=await f.draft('another');
 f.r.db.prepare("UPDATE misty_message_drafts SET body='tampered' WHERE code=?").run(c.code);
 await assert.rejects(f.m.confirmOverlay({code:c.code,digest:c.digest}),/changed/);
 assert.equal(f.calls(),0);
});
test('concurrent app confirmations submit once and unknown delivery is never retried',async t=>{
 const f=fixture(t),d=await f.draft();f.broken();
 const both=await Promise.allSettled([f.m.confirmOverlay({code:d.code,digest:d.digest}),f.m.confirmOverlay({code:d.code,digest:d.digest})]);
 assert.equal(f.calls(),1);assert.equal(f.m.status(d.code).state,'unknown');
 await assert.rejects(f.m.confirmOverlay({code:d.code,digest:d.digest}),/changed or expired/);
 await f.m.refresh();assert.equal(f.calls(),1);assert.ok(both.some(x=>x.status==='fulfilled'));
});
test('long personal message retains app preview and complete exact DM preview before approval',async t=>{
 const f=fixture(t,'whatsapp'),d=await f.draft('x'.repeat(5000));
 assert.equal(f.m.pendingApprovals().drafts[0].body.length,5000);
 const notices=f.r.db.prepare('SELECT body FROM relay_notices ORDER BY seq').all();
 assert.equal(notices.length,6);
 assert.equal(notices.slice(1,-1).map(p=>p.body.slice(p.body.indexOf('\n')+1)).join(''),d.body);
 assert.equal(f.calls(),0);
});
test('backend is authenticated, checks actual destination and exposes read-only receipt reconciliation',async t=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'personal-message-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));const tokenFile=path.join(folder,'token');fs.writeFileSync(tokenFile,'a'.repeat(64));
 const room={id:'room',name:'Contact',platform:'discord',kind:'dm',remote_id:'123'};let sends=0;
 const chat={capability:()=>({allowed:true}),outgoing:()=>[],send:async()=>{sends++;return {status:'sending'};}};
 const server=serveMessageBackend({room:()=>room},chat,{tokenFile,port:0});await once(server,'listening');t.after(()=>server.close());const port=server.address().port;
 const client=new MessageBackend({tokenFile,port});const inspected=await client.call('inspect',{room:'room'});assert.equal(inspected.target.name,'Contact');
 await assert.rejects(client.call('send',{room:'room',target:{...inspected.target,name:'Other'}}),/destination changed/);assert.equal(sends,0);
 const response=await fetch(`http://127.0.0.1:${port}/call`,{method:'POST',body:'{}'});assert.equal(response.status,401);
 assert.equal(await client.call('status',{id:'missing'}),null);
});
test('Apollo read-only bridge rejects all personal-message operations',async t=>{
 const f=fixture(t),folder=fs.mkdtempSync(path.join(os.tmpdir(),'personal-reader-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));const tokenFile=path.join(folder,'token');fs.writeFileSync(tokenFile,'a'.repeat(64));
 const server=serveProminenceBridge(f.r,{tokenFile,port:0,readOnly:true});await once(server,'listening');t.after(()=>server.close());
 for(const op of ['message_draft','message_confirm','message_status']){const res=await fetch(`http://127.0.0.1:${server.address().port}/call`,{method:'POST',headers:{Authorization:'Bearer '+'a'.repeat(64)},body:JSON.stringify({op,args:{}})});assert.equal(res.status,400);}
 assert.equal(f.calls(),0);
});
test('WhatsApp capability obeys connection and group classification',async t=>{
 const room={id:'wa',platform:'whatsapp',kind:'group',remote_id:'123@g.us',connected:1,tracked:1};let treatment='S';
 const store={get:()=>({connected:true}),statement:()=>({get:()=>({treatment})})};
 const native=new NativeChat(store,{messageTokenFile:'not-read-for-capability'});assert.equal(native.capability(room).allowed,false);treatment='G';assert.equal(native.capability(room).allowed,true);
 assert.equal(native.capability({...room,connected:0}).allowed,false);
});

test('approval through the real localhost backend reaches the linked-session adapter and reconciles its saved receipt',async t=>{
 const f=fixture(t,'whatsapp'),archive=new ArchiveStore(':memory:');
 applyNativeEvent(archive,{kind:'whatsapp_message',chat:'123@lid',id:'seed',sender:'123@lid',name:'Contact',at:Date.now(),body:'hello',type:'m.text'});archive.set('native_whatsapp',{connected:true});
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'message-e2e-')),tokenFile=path.join(folder,'token');fs.writeFileSync(tokenFile,'a'.repeat(64));let calls=0;
 const native=new NativeChat(archive,{messageTokenFile:tokenFile,fetchImpl:async(url,options)=>{
  if(url.endsWith('/inspect'))return Response.json({ready:true});
  calls++;const input=JSON.parse(options.body);return Response.json({kind:'whatsapp_message',id:'ack',chat:input.chat,body:input.body,is_me:true,sender:'110000000000005@s.whatsapp.net',at:Date.now(),type:'m.text'});
 }});
 let queue=Promise.resolve();const serial=fn=>{const next=queue.then(fn);queue=next.catch(()=>{});return next;};const sender=new ChatSender(archive,serial,null,{native});
 const server=serveMessageBackend(archive,sender,{tokenFile,port:0});await once(server,'listening');
 t.after(async()=>{server.close();await sender.close();archive.close();fs.rmSync(folder,{recursive:true,force:true});});
 f.m.backend=new MessageBackend({tokenFile,port:server.address().port});
 const room=archive.statement("SELECT id FROM conversations WHERE platform='whatsapp'").get().id;
 const d=await f.m.propose({ownerMessageId:f.owner('Send this to Contact on WhatsApp'),room,body:'Exact approved message.'});
 assert.equal(calls,0);await f.m.confirmOverlay({code:d.code,digest:d.digest});
 await Promise.all([...sender.jobs.values()]);await f.m.refresh();
 assert.equal(f.m.status(d.code).state,'sent');assert.equal(calls,1);
 assert.equal(archive.statement('SELECT is_me FROM messages WHERE body=?').get('Exact approved message.').is_me,1);
});
