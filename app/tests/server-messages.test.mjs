import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {ArchiveStore} from '../store.mjs';
import {NativeChat} from '../native-chat.mjs';
import {ChatSender} from '../chat.mjs';
import {BotStore} from '../discord-bot.mjs';
import {MistyRelay} from '../misty-relay.mjs';
import {MistyMessages} from '../misty-messages.mjs';
import {serveMessageBackend,MessageBackend} from '../message-backend.mjs';
import {serveProminenceBridge} from '../misty-prominence-bridge.mjs';
import {replyId,postURL,channelPermissions} from '../message-target.mjs';

const owner='100000000000000023',guild='100000000000000030',channel='100000000000000031',parent='100000000000000032',original='100000000000000079',other='100000000000000040',sent='100000000000000080';
const permissions=(1n<<10n)|(1n<<11n)|(1n<<16n)|(1n<<38n);
function fixture(t,{type=0,persistent=false}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'misty-guild-')),tokenFile=path.join(dir,'token');fs.writeFileSync(tokenFile,'t'.repeat(64));
 const store=new ArchiveStore(persistent?path.join(dir,'archive.sqlite'):':memory:');
 store.statement('INSERT INTO discord_server_policies VALUES(?,?,?,?,?)').run(guild,'Synthetic guild','SP',Date.now(),Date.now());
 const live={id:channel,guild_id:guild,type,name:'general',permission_overwrites:[],...(type>=10?{parent_id:parent,thread_metadata:{archived:false,locked:false}}:{})};
 store.statement("INSERT INTO conversations(id,name,platform,kind,remote_id,server_id,server_name,connected,tracked) VALUES(?,?,'discord','channel',?,?,?,1,1)").run('discord:channel:'+channel,'general',channel,guild,'Synthetic guild');
 const room=store.room('discord:channel:'+channel);store.set('native_discord',{connected:true});
 const state={live,member:{user:{id:owner},roles:[],pending:false},guild:{id:guild,name:'Synthetic guild',owner_id:other},roles:[{id:guild,permissions:String(permissions)}],
  parent:{id:parent,guild_id:guild,type:0,name:'parent',permission_overwrites:[]},
  original:{id:original,channel_id:channel,guild_id:guild,author:{id:other,username:'Synthetic author'},content:'Synthetic original question',edited_timestamp:null},
  me:owner,posts:0,post:null,mode:'ok',ackChange:null,paths:[],beforeChannel:null};
 const native=new NativeChat(store,{tokenFile,fetchImpl:async(url,options)=>{
  const p=url.replace('https://discord.com/api/v9','');state.paths.push(p);
  if(options.method==='POST'){
   state.posts++;state.post=JSON.parse(options.body);
   if(state.mode==='lost')throw Error('lost acknowledgement');
   if(state.mode==='forbidden')return new Response('{}',{status:403});
   const ack={id:sent,channel_id:channel,guild_id:guild,author:{id:owner,username:'Owner'},content:state.post.content,timestamp:new Date().toISOString(),...(state.post.message_reference?{message_reference:{...state.post.message_reference}}:{})};
   if(state.ackChange)state.ackChange(ack);return Response.json(ack);
  }
  if(p==='/users/@me')return Response.json({id:state.me});
  if(p==='/channels/'+channel){if(state.beforeChannel)state.beforeChannel();return Response.json(state.live);}
  if(p==='/channels/'+parent)return Response.json(state.parent);
  if(p==='/guilds/'+guild)return Response.json(state.guild);
  if(p==='/guilds/'+guild+'/members/'+owner)return Response.json(state.member);
  if(p==='/guilds/'+guild+'/roles')return Response.json(state.roles);
  if(p==='/channels/'+channel+'/thread-members/@me')return Response.json(state.membership||{id:channel,user_id:owner});
  if(p==='/channels/'+channel+'/messages?around='+original+'&limit=1')return Response.json(state.original?[state.original]:[]);
  throw Error('Unexpected synthetic request: '+p);
 }});
 let queue=Promise.resolve();const serial=fn=>{const p=queue.then(fn);queue=p.catch(()=>{});return p;};
 const sender=new ChatSender(store,serial,null,{native});
 const bot=new BotStore(persistent?path.join(dir,'bot.sqlite'):':memory:'),relay=new MistyRelay(bot,{});
 let now=Date.now(),seq=0n;const id=()=>String((BigInt(now-1420070400000)<<22n)+(++seq));
 const ownerDM=text=>{const key=id();bot.db.prepare("INSERT INTO bot_turns(id,channel,body,ts,status) VALUES(?,?,?,?,?)").run(key,'owner',text,now,'external');return key;};
 const deliver=()=>{for(const n of bot.db.prepare("SELECT seq FROM relay_notices WHERE status='queued'").all())bot.db.prepare("UPDATE relay_notices SET status='sent',message_id=? WHERE seq=?").run(id(),n.seq);};
 const backend={call:async(op,args)=>op==='inspect'?sender.inspect(store.room(args.room),{replyTo:args.replyTo}):op==='send'?sender.send(args):sender.outgoing('',args.id)[0]};
 const messages=new MistyMessages(relay,backend,{clock:()=>now});relay.messages=messages;
 const draft=(body='Synthetic approved reply',replyTo=original)=>messages.propose({room:room.id,body,replyTo,ownerMessageId:ownerDM('Prepare a server reply')});
 t.after(async()=>{await sender.close();store.close();bot.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {dir,tokenFile,store,room,state,native,sender,bot,relay,messages,ownerDM,deliver,draft,advance:ms=>now+=ms,settle:()=>Promise.all([...sender.jobs.values()])};
}

test('reply reference parsing requires exact guild/channel, never resolves names',()=>{
 for(const ref of [original,`discord:${channel}:${original}`,postURL(guild,channel,original)])assert.equal(replyId(ref,channel,guild),original);
 for(const ref of ['Krishna','https://discord.com/channels/'+other+'/'+channel+'/'+original,`discord:${parent}:${original}`,{messageId:original}])assert.throws(()=>replyId(ref,channel,guild));
});
test('permission calculation honors everyone, combined role and member overwrites with big integers',()=>{
 const roles=[{id:guild,permissions:String(permissions)},{id:other,permissions:'0'}],member={roles:[other]};
 const c={permission_overwrites:[{id:guild,type:0,deny:String(1n<<11n),allow:'0'},{id:other,type:0,deny:'0',allow:String(1n<<11n)},{id:owner,type:1,deny:String(1n<<11n),allow:'0'}]};
 assert.equal(channelPermissions(c,member,roles,{id:guild,owner_id:other},owner)&(1n<<11n),0n);
 assert.ok(channelPermissions(c,member,roles,{id:guild,owner_id:owner},owner)&(1n<<11n));
 assert.throws(()=>channelPermissions(c,{roles:[parent]},roles,{id:guild},owner),/incomplete/);
});
for(const type of [0,5,10,11,12])test(`verified channel/thread type ${type}: exact preview, fresh yes, reply reference and durable acknowledgement`,async t=>{
 const f=fixture(t,{type}),d=await f.draft();assert.equal(f.state.posts,0);
 const notices=f.bot.db.prepare('SELECT body FROM relay_notices ORDER BY seq').all().map(n=>n.body).join('\n');
 for(const text of ['Synthetic guild',guild,channel,original,other,'Synthetic author','Synthetic original question',postURL(guild,channel,original),'Synthetic approved reply','pings: disabled'])assert.ok(notices.includes(text),text);
 f.deliver();await f.messages.confirm({code:d.code,ownerMessageId:f.ownerDM('yes')});await f.settle();await f.messages.refresh();
 const saved=f.messages.status(d.code);assert.equal(saved.state,'sent');assert.equal(saved.receipt.url,postURL(guild,channel,sent));assert.equal(f.state.posts,1);
 assert.equal(f.state.post.content,d.body);assert.deepEqual(f.state.post.allowed_mentions,{parse:[],replied_user:false});
 assert.deepEqual(f.state.post.message_reference,{message_id:original,channel_id:channel,guild_id:guild,fail_if_not_exists:true});
 const row=f.sender.outgoing('',f.messages.get(d.code).submission_id)[0];assert.equal(row.guild_id,guild);assert.equal(row.channel_id,channel);assert.equal(row.reply_id,original);assert.equal(row.post_url,saved.receipt.url);
 assert.equal(f.store.statement('SELECT is_me FROM messages WHERE body=?').get(d.body).is_me,1);
 await f.sender.send({id:row.id,room:f.room.id,body:d.body,target:d.target});assert.equal(f.state.posts,1);
 await assert.rejects(f.sender.send({id:row.id,room:f.room.id,body:d.body,target:{...d.target,replyTo:null}}),/different message/);
});
test('new top-level server posts explicitly preview no reply and suppress all mentions',async t=>{
 const f=fixture(t),d=await f.draft('Synthetic @everyone text','');assert.equal(d.target.replyTo,null);
 assert.match(f.bot.db.prepare('SELECT body FROM relay_notices ORDER BY seq LIMIT 1').get().body,/not a reply/);
 f.deliver();await f.messages.confirm({code:d.code,ownerMessageId:f.ownerDM('yes')});await f.settle();
 assert.equal(f.state.post.message_reference,undefined);assert.deepEqual(f.state.post.allowed_mentions,{parse:[],replied_user:false});
});
for(const [name,change,pattern] of [
 ['wrong owner',f=>f.state.me=other,/account/],
 ['wrong guild',f=>f.state.live.guild_id=other,/expected guild/],
 ['unsupported forum',f=>f.state.live.type=15,/text channel/],
 ['missing post permission',f=>f.state.roles[0].permissions=String(permissions&~(1n<<11n)),/permission/],
 ['missing history permission',f=>f.state.roles[0].permissions=String(permissions&~(1n<<16n)),/permission/],
 ['timeout',f=>f.state.member.communication_disabled_until=new Date(Date.now()+60000).toISOString(),/timed out/],
 ['pending member',f=>f.state.member.pending=true,/pending/],
 ['wrong member',f=>f.state.member.user.id=other,/owner/],
 ['wrong reply channel',f=>f.state.original.channel_id=parent,/exact reply/],
 ['wrong reply guild',f=>f.state.original.guild_id=other,/exact reply/],
 ['missing original',f=>f.state.original=null,/exact reply/],
 ['ignored server',f=>f.store.statement("UPDATE discord_server_policies SET treatment='I'").run(),/ignored/],
 ['unselected chat',f=>f.store.updateRoom(f.room.id,{tracked:false}),/enable/]
])test(name+' fails closed before draft or mutation',async t=>{
 const f=fixture(t);change(f);await assert.rejects(f.draft(),pattern);assert.equal(f.state.posts,0);assert.equal(f.bot.db.prepare('SELECT count(*) n FROM misty_message_drafts').get().n,0);
});
for(const [name,change] of [
 ['archived',f=>f.state.live.thread_metadata.archived=true],['locked',f=>f.state.live.thread_metadata.locked=true],
 ['unknown archive state',f=>delete f.state.live.thread_metadata.archived],['unknown lock state',f=>delete f.state.live.thread_metadata.locked],
 ['wrong parent guild',f=>f.state.parent.guild_id=other],['not a private member',f=>f.state.membership={id:channel,user_id:other}],
 ['missing thread permission',f=>f.state.roles[0].permissions=String(permissions&~(1n<<38n))]
])test(name+' thread cannot be opened, joined or posted',async t=>{
 const f=fixture(t,{type:12});change(f);await assert.rejects(f.draft());assert.equal(f.state.posts,0);assert.ok(f.state.paths.every(p=>!p.includes('/join')));
});
test('a thread auto-archived during permission/history verification is not implicitly reopened',async t=>{
 const f=fixture(t,{type:11});let reads=0;f.state.beforeChannel=()=>{if(++reads===2)f.state.live.thread_metadata.archived=true;};
 await assert.rejects(f.draft(),/thread changed/);assert.equal(f.state.posts,0);
});
test('reply edits, parent/destination changes and disabled tracking require new preview even after yes',async t=>{
 for(const change of [f=>f.state.original.content+=' edited',f=>f.state.live.name='renamed',f=>f.state.live.guild_id=other,f=>f.store.updateRoom(f.room.id,{tracked:false})]){
  const f=fixture(t),d=await f.draft();f.deliver();change(f);
  await assert.rejects(f.messages.confirm({code:d.code,ownerMessageId:f.ownerDM('yes')}));assert.equal(f.state.posts,0);
 }
});
test('immediate pre-post verification catches a target edited after confirmation inspection',async t=>{
 const f=fixture(t),d=await f.draft();f.deliver();let inspections=0;
 const inspect=f.messages.backend.call;f.messages.backend.call=async(op,args)=>{const result=await inspect(op,args);if(op==='inspect'&&++inspections===1)f.state.original.content='changed after inspection';return result;};
 await f.messages.confirm({code:d.code,ownerMessageId:f.ownerDM('yes')});await f.settle();await f.messages.refresh();
 assert.equal(f.messages.status(d.code).state,'failed');assert.equal(f.state.posts,0);
});
test('deleted or altered preview parts, stale yes and forged workflow/model approvals cannot authorize',async t=>{
 for(const mutation of ['delete','alter','stale','workflow','model','request']){
  const f=fixture(t),d=await f.draft();f.deliver();let key=f.ownerDM('yes');
  if(mutation==='delete')f.bot.db.prepare("DELETE FROM relay_notices WHERE source LIKE '%:preview:0001'").run();
  if(mutation==='alter')f.bot.db.prepare("UPDATE relay_notices SET body='different preview' WHERE source LIKE '%:preview:0001'").run();
  if(mutation==='stale')f.advance(120001);
  if(['workflow','model'].includes(mutation))f.bot.db.prepare("UPDATE bot_turns SET status='replied' WHERE id=?").run(key);
  if(mutation==='request')key=f.messages.get(d.code).owner_id;
  await assert.rejects(f.messages.confirm({code:d.code,ownerMessageId:key}));assert.equal(f.state.posts,0);
 }
});
test('destination, reply and body are immutable under the stored digest; request reuse cannot change reply',async t=>{
 for(const field of ['body','reply','target']){
  const f=fixture(t),d=await f.draft();f.deliver();const target=structuredClone(d.target);
  if(field==='body')f.bot.db.prepare("UPDATE misty_message_drafts SET body='modified' WHERE code=?").run(d.code);
  else {if(field==='reply')target.replyTo.messageId=sent;else target.guildId=other;f.bot.db.prepare('UPDATE misty_message_drafts SET target=? WHERE code=?').run(JSON.stringify(target),d.code);}
  await assert.rejects(f.messages.confirm({code:d.code,ownerMessageId:f.ownerDM('yes')}),/draft changed/);assert.equal(f.state.posts,0);
 }
 const f=fixture(t),d=await f.draft();await assert.rejects(f.messages.propose({ownerMessageId:f.messages.get(d.code).owner_id,room:f.room.id,body:d.body,replyTo:sent}),/different draft/);
});
test('cancelled and expired guild drafts cannot use a fresh yes',async t=>{
 const f=fixture(t),d=await f.draft();f.deliver();await f.messages.observe(f.ownerDM('cancel'));assert.equal(f.messages.status(d.code).state,'cancelled');
 await assert.rejects(f.messages.confirm({code:d.code,ownerMessageId:f.ownerDM('yes')}));
 const next=await f.draft();f.deliver();f.advance(600001);await assert.rejects(f.messages.confirm({code:next.code,ownerMessageId:f.ownerDM('yes')}),/expired/);assert.equal(f.state.posts,0);
});
for(const change of [ack=>ack.author.id=other,ack=>ack.content='changed',ack=>ack.channel_id=parent,ack=>ack.guild_id=other,ack=>ack.message_reference.message_id=sent])test('unexpected native acknowledgement is unknown and cannot be retried',async t=>{
 const f=fixture(t),d=await f.draft();f.state.ackChange=change;f.deliver();const yes=f.ownerDM('yes');await f.messages.confirm({code:d.code,ownerMessageId:yes});await f.settle();await f.messages.refresh();
 assert.equal(f.messages.status(d.code).state,'unknown');assert.equal(f.state.posts,1);await f.messages.confirm({code:d.code,ownerMessageId:yes});await f.messages.refresh();assert.equal(f.state.posts,1);
});
test('lost acknowledgement and persistent restart recover read-only without retrying or inventing sent',async t=>{
 const f=fixture(t,{persistent:true}),d=await f.draft();f.state.mode='lost';f.deliver();const yes=f.ownerDM('yes');await f.messages.confirm({code:d.code,ownerMessageId:yes});await f.settle();await f.messages.refresh();
 const id=f.messages.get(d.code).submission_id;assert.equal(f.messages.status(d.code).state,'unknown');
 const reloaded=new MistyMessages(f.relay,f.messages.backend);await reloaded.refresh();assert.equal(reloaded.status(d.code).state,'unknown');
 const reopened=new ArchiveStore(path.join(f.dir,'archive.sqlite'));try{assert.equal(reopened.statement('SELECT status FROM chat_outgoing WHERE id=?').get(id).status,'unknown');}finally{reopened.close();}
 const recovered=new ChatSender(f.store,fn=>Promise.resolve(fn()),null,{native:f.native});await recovered.ready;await recovered.close();assert.equal(f.state.posts,1);
 // A crash between journal insert and transport completion is unknown after restart.
 f.store.statement("UPDATE chat_outgoing SET status='sending' WHERE id=?").run(id);
 const afterCrash=new ChatSender(f.store,fn=>Promise.resolve(fn()),null,{native:f.native});await afterCrash.ready;assert.equal(afterCrash.outgoing('',id)[0].status,'unknown');await afterCrash.close();assert.equal(f.state.posts,1);
});
test('an explicit Discord permission rejection is failed, never retried and never reported sent',async t=>{
 const f=fixture(t),d=await f.draft();f.state.mode='forbidden';f.deliver();const yes=f.ownerDM('yes');
 await f.messages.confirm({code:d.code,ownerMessageId:yes});await f.settle();await f.messages.refresh();assert.equal(f.messages.status(d.code).state,'failed');
 await assert.rejects(f.messages.confirm({code:d.code,ownerMessageId:f.ownerDM('yes')}),/no longer/);assert.equal(f.state.posts,1);
});
test('real authenticated backend and owner-only bridge expose inspect without creating drafts or sending',async t=>{
 const f=fixture(t),server=serveMessageBackend(f.store,f.sender,{tokenFile:f.tokenFile,port:0});await once(server,'listening');t.after(()=>server.close());
 const backend=new MessageBackend({tokenFile:f.tokenFile,port:server.address().port});f.messages.backend=backend;
 const bridge=serveProminenceBridge(f.relay,{tokenFile:f.tokenFile,port:0});await once(bridge,'listening');t.after(()=>bridge.close());
 const call=(token,op,args)=>fetch(`http://127.0.0.1:${bridge.address().port}/call`,{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify({op,args})});
 assert.equal((await call('wrong','message_inspect',{room:f.room.id})).status,401);
 const response=await call('t'.repeat(64),'message_inspect',{room:f.room.id,replyTo:original});assert.equal(response.status,200);assert.equal((await response.json()).target.replyTo.messageId,original);
 const inspected=await backend.call('inspect',{room:f.room.id,replyTo:original});await assert.rejects(backend.call('send',{id:'chat-'+randomUUID(),room:f.room.id,body:'synthetic',target:{...inspected.target,guildId:other}}),/destination changed/);
 assert.equal(f.state.posts,0);assert.equal(f.bot.db.prepare('SELECT count(*) n FROM misty_message_drafts').get().n,0);
 const reader=serveProminenceBridge(f.relay,{tokenFile:f.tokenFile,port:0,readOnly:true});await once(reader,'listening');t.after(()=>reader.close());
 for(const op of ['message_inspect','message_draft','message_confirm','message_status'])assert.equal((await fetch(`http://127.0.0.1:${reader.address().port}/call`,{method:'POST',headers:{Authorization:'Bearer '+'t'.repeat(64)},body:JSON.stringify({op,args:{room:f.room.id}})})).status,400);
});
