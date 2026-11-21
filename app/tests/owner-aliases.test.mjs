import test from 'node:test';
import assert from 'node:assert/strict';
import {BOT_OWNER,BotAPI,BotStore} from '../discord-bot.mjs';
import {MistyRelay} from '../misty-relay.mjs';
import {MistyMessages} from '../misty-messages.mjs';
import {ownerChannel} from '../owner-routing.mjs';

const alias='100000000000000034',primaryDM='100000000000000052',aliasDM='100000000000000053',bot='100000000000000046';
function fixture(t){
 const store=new BotStore(':memory:',{owners:[BOT_OWNER,alias]});t.after(()=>store.close());
 store.set('owner_channels',{[BOT_OWNER]:primaryDM,[alias]:aliasDM});store.set('bot',{channel:primaryDM});store.set('started_at',0);
 let now=Date.now(),seq=0n;const next=()=>{now+=10;return String((BigInt(now-1420070400000)<<22n)+(++seq));};
 const owner=(channel,body)=>{const id=next();store.db.prepare("INSERT INTO bot_turns(id,channel,body,ts,status) VALUES(?,?,?,?,'external')").run(id,channel,body,now);return id;};
 const relay=new MistyRelay(store,{generate:()=>{throw Error('No model calls permitted in these fixtures');}});
 const deliveries=[];const api={channel:primaryDM,id:bot,owns:(id,ch)=>({[BOT_OWNER]:primaryDM,[alias]:aliasDM}[id]===ch),forChannel(channel){assert([primaryDM,aliasDM,''].includes(channel));return {...this,channel:channel||primaryDM};},async send(body,source,payload){const id=next();deliveries.push({channel:this.channel,body,source,payload,id});return id;}};
 const target={room:'room',platform:'discord',kind:'dm',name:'Synthetic contact',remoteId:'100000000000000058'};
 const sent=[];const backend={async call(op,args){if(op==='inspect')return {target,capability:{allowed:true,maxLength:2000}};if(op==='send'){sent.push(args);return {id:args.id,room_id:'room',body:args.body,status:'sent',event_id:'100000000000000060'};}throw Error('unexpected backend call');}};
 relay.messages=new MistyMessages(relay,backend,{clock:()=>now});
 return {store,relay,api,deliveries,next,owner,sent,clock:()=>now};
}

test('bot API verifies each owner DM and binds sends without changing the primary destination',async()=>{
 const api=new BotAPI();const calls=[];
 api.request=async(path,body)=>{calls.push({path,body});if(path==='/users/@me')return {id:bot,bot:true,username:'Misty'};
  if(path==='/users/@me/channels')return {id:body.recipient_id===BOT_OWNER?primaryDM:aliasDM,type:1,recipients:[{id:body.recipient_id}]};
  return {id:'100000000000000063',channel_id:path.split('/')[2],author:{id:bot},content:body.content};};
 await api.connect();await api.addOwner(alias);assert(api.owns(alias,aliasDM));assert(!api.owns(alias,primaryDM));assert(!api.owns(undefined,undefined));
 await api.forChannel(aliasDM).send('fixture only','fixture');assert.equal(calls.at(-1).path,'/channels/'+aliasDM+'/messages');assert.deepEqual(calls.at(-1).body.allowed_mentions,{parse:[]});assert.equal(api.channel,primaryDM);
 assert.throws(()=>api.forChannel('100000000000000076'),/Unverified/);
 api.request=async()=>({id:aliasDM,type:1,recipients:[{id:BOT_OWNER}]});await assert.rejects(api.addOwner(alias),/additional owner DM/);
});

test('second owner is admitted only in its verified DM, with no retroactive authorization or Apollo access',t=>{
 const {store}=fixture(t);const m={id:'100000000000000065',channel_id:aliasDM,author:{id:alias},content:'current owner task',timestamp:new Date().toISOString()};
 store.set('owner_activation',{[alias]:Date.now()-100});assert.equal(store.accept(m,aliasDM),true);assert.equal(store.accept(m,aliasDM),false);
 assert.equal(store.accept({...m,id:'100000000000000066',channel_id:primaryDM},primaryDM),false);
 assert.equal(store.accept({...m,id:'100000000000000067',author:{id:'100000000000000072'}},aliasDM),false);
 assert.equal(store.accept({...m,id:'100000000000000068',guild_id:'123'},aliasDM),false);
 assert.equal(store.accept({...m,id:'100000000000000069',author:{id:alias,bot:true}},aliasDM),false);
 assert.equal(store.accept({...m,id:'100000000000000070',timestamp:new Date(Date.now()-10000).toISOString()},aliasDM),false);
 const apollo=new BotStore(':memory:');t.after(()=>apollo.close());apollo.set('started_at',0);assert.equal(apollo.accept(m,aliasDM),false);
});

test('owner notices and Codex cards retain the requesting DM; unrelated background notices retain primary',async t=>{
 const f=fixture(t),id=f.owner(aliasDM,'inspect a project');f.relay.notice('conversation:'+id,'owner reply');f.relay.notice('independent-background','default owner update');
 const draft={code:'aaaaaaaaaa',source:'prominence:'+id,prompt:'fixture prompt',target:JSON.stringify({kind:'new',title:'Fixture',cwd:'C:\\fixture'}),candidates:'[]',reason:'fixture',expires:Date.now()+10000};
 f.relay.preview(draft,{formal:true});await f.relay.sendNotices(f.api);
 assert.equal(f.deliveries[0].channel,aliasDM);assert.equal(f.deliveries[1].channel,primaryDM);assert.equal(f.deliveries[2].channel,aliasDM);
 assert.equal(ownerChannel(f.store.db,'unknown-source'),'');
});

test('personal message approval requires complete preview and fresh yes in the originating verified DM',async t=>{
 const f=fixture(t),request=f.owner(aliasDM,'prepare an exact message');const draft=await f.relay.messages.propose({ownerMessageId:request,room:'room',body:'Synthetic exact reply'});
 const queued=f.store.db.prepare('SELECT owner_channel FROM relay_notices').all();assert(queued.length>=3&&queued.every(n=>n.owner_channel===aliasDM));
 await f.relay.sendNotices(f.api);
 const wrong=f.owner(primaryDM,'yes '+draft.code);await assert.rejects(f.relay.messages.confirm({ownerMessageId:wrong,code:draft.code}),/same owner DM/);assert.equal(f.sent.length,0);
 const yes=f.owner(aliasDM,'yes '+draft.code);const result=await f.relay.messages.confirm({ownerMessageId:yes,code:draft.code});assert.equal(result.state,'sent');assert.equal(f.sent.length,1);
 assert.equal((await f.relay.messages.confirm({ownerMessageId:yes,code:draft.code})).state,'sent');assert.equal(f.sent.length,1);
 const restored=new MistyMessages(f.relay,{call:()=>{throw Error('Do not resend');}},{clock:f.clock});assert.equal(restored.status(draft.code).state,'sent');assert.equal(f.store.db.prepare('SELECT owner_channel FROM misty_message_drafts WHERE code=?').get(draft.code).owner_channel,aliasDM);
});

test('a preview delivered to another DM cannot authorize personal sending',async t=>{
 const f=fixture(t),request=f.owner(aliasDM,'prepare message');const draft=await f.relay.messages.propose({ownerMessageId:request,room:'room',body:'Synthetic reply'});
 await f.relay.sendNotices(f.api);f.store.db.prepare('UPDATE relay_notices SET owner_channel=?').run(primaryDM);
 const yes=f.owner(aliasDM,'yes '+draft.code);await assert.rejects(f.relay.messages.confirm({ownerMessageId:yes,code:draft.code}),/preview.*this owner DM/);assert.equal(f.sent.length,0);
});
