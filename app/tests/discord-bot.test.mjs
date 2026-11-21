import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {BOT_OWNER,BotAPI,BotStore,BotReplies} from '../discord-bot.mjs';

const channel='100000000000000051',bot='100000000000000052';
const message=(id='100000000000000057',content='Hello')=>({id,channel_id:channel,author:{id:BOT_OWNER},content,timestamp:new Date().toISOString()});
function setup(t){const store=new BotStore(':memory:');store.set('started_at',Date.now()-60000);t.after(()=>store.close());return store;}
function apiSetup(t,handler){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'misty-bot-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const tokenFile=path.join(dir,'token');fs.writeFileSync(tokenFile,'test-bot-token');
 const calls=[],api=new BotAPI({tokenFile,fetchImpl:async(url,opts)=>{calls.push({url,opts});return handler(url,opts);}});return {api,calls};
}

test('bot accepts only owner text in the bound DM and deduplicates delivery',t=>{
 const store=setup(t),m=message();
 for(const invalid of [{...m,author:{id:bot,bot:true}},{...m,author:{id:'100000000000000053'}},{...m,guild_id:'100000000000000054'},{...m,channel_id:'100000000000000055'},{...m,id:'invalid'},{...m,timestamp:'invalid'},{...m,timestamp:new Date(0).toISOString()}])assert.equal(store.accept(invalid,channel),false);
 assert.equal(store.accept(m,channel),true);assert.equal(store.accept(m,channel),false);assert.equal(store.next().body,'Hello');
});

test('bot token authentication and destination verification reject normal accounts and other recipients',async t=>{
 for(const [me,dm] of [[{id:BOT_OWNER,bot:false},{}],[{id:bot,bot:true},{id:channel,type:3,recipients:[{id:BOT_OWNER}]}],[{id:bot,bot:true},{id:channel,type:1,recipients:[{id:bot}]}]]){
  const {api}=apiSetup(t,url=>Response.json(url.endsWith('/users/@me')?me:dm));await assert.rejects(api.connect());
 }
 const {api,calls}=apiSetup(t,url=>Response.json(url.endsWith('/users/@me')?{id:bot,bot:true,username:'Misty'}:{id:channel,type:1,recipients:[{id:BOT_OWNER}]}));
 await api.connect();assert.equal(api.channel,channel);assert.ok(calls.every(c=>c.opts.headers.Authorization==='Bot test-bot-token'));assert.equal(JSON.parse(calls[1].opts.body).recipient_id,BOT_OWNER);
});

test('bot replies once with an enforced nonce and disabled mentions',async t=>{
 const store=setup(t),{api,calls}=apiSetup(t,(url,opts)=>Response.json({id:'100000000000000062',channel_id:channel,author:{id:bot},content:JSON.parse(opts.body).content}));api.channel=channel;api.id=bot;
 let requests=0;const client={generate:async()=>{requests++;return {message:{content:JSON.stringify({body:'Hello there.'})}};}};
 const replies=new BotReplies(store,api,client);store.accept(message(),channel);await replies.drain();store.accept(message(),channel);await replies.drain();
 assert.equal(requests,1);assert.equal(calls.length,1);assert.equal(store.db.prepare('SELECT status,reply_id FROM bot_turns').get().status,'sent');
 const payload=JSON.parse(calls[0].opts.body);assert.equal(payload.enforce_nonce,true);assert.equal(payload.nonce.length,24);assert.deepEqual(payload.allowed_mentions,{parse:[]});
});

test('bot reset starts fresh context and preserves stored earlier messages',async t=>{
 const store=setup(t),inputs=[],sent=[];const replies=new BotReplies(store,{send:async body=>{sent.push(body);return '100000000000000062';}},{generate:async input=>{inputs.push(input.messages);return {message:{content:'{"body":"Answer."}'}};}});
 for(const [id,content] of [['100000000000000057','old secret topic'],['100000000000000059','!reset'],['100000000000000061','new topic']]){store.accept(message(id,content),channel);await replies.drain();}
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM bot_turns').get().n,3);assert.equal(inputs.length,2);assert.ok(!JSON.stringify(inputs[1]).includes('old secret topic'));assert.ok(JSON.stringify(inputs[1]).includes('new topic'));assert.equal(sent.length,3);
});

test('an ambiguous send is kept unknown and never automatically sent again',async t=>{
 const store=setup(t);let sends=0;const replies=new BotReplies(store,{send:async()=>{sends++;throw new Error('private upstream information');}},{});
 store.accept(message(undefined,'!ping'),channel);await replies.drain();await replies.drain();assert.equal(sends,1);
 const row=store.db.prepare('SELECT * FROM bot_turns').get();assert.equal(row.status,'unknown');assert.ok(!row.error.includes('private'));
});

test('restart recovers an unfinished draft and does not resend a pending confirmation',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'misty-bot-db-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const filename=path.join(dir,'bot.sqlite');
 let store=new BotStore(filename);store.set('started_at',Date.now()-60000);store.accept(message(),channel);store.accept(message('100000000000000059'),channel);store.update('100000000000000057',{status:'sending'});store.update('100000000000000059',{status:'generating'});store.close();
 store=new BotStore(filename);try{assert.equal(store.db.prepare('SELECT status FROM bot_turns WHERE id=?').get('100000000000000057').status,'unknown');assert.equal(store.next().id,'100000000000000059');}finally{store.close();}
});

test('bot catches up multiple pages in chronological order and stops at durable cursor',async t=>{
 const base=200000000000000200n,since=Date.now()-60000,at=new Date().toISOString();
 const first=Array.from({length:100},(_,i)=>({...message(String(base-BigInt(i))),timestamp:at}));
 const second=[message(String(base-100n)),message(String(base-101n)),message(String(base-102n))];let pages=0;
 const {api,calls}=apiSetup(t,()=>Response.json(pages++===0?first:second));api.channel=channel;
 const received=[];await api.history({since,cursor:String(base-101n),onMessage:m=>received.push(m.id)});
 assert.equal(calls.length,2);assert.ok(calls[1].url.endsWith('before='+String(base-99n)));
 assert.equal(received[0],String(base-100n));assert.equal(received.at(-1),String(base));assert.equal(received.length,101);
});

test('AI failure sends a plain retry notice with no upstream secrets',async t=>{
 const store=setup(t);let body;const replies=new BotReplies(store,{send:async text=>{body=text;return '100000000000000062';}},{generate:async()=>{throw new Error('private upstream payload');}});
 store.accept(message(),channel);await replies.drain();assert.match(body,/try your message again/);assert.ok(!body.includes('private'));assert.equal(store.next(),undefined);
});

test('interactive send verifies the returned card and only retries explicit rate-limit rejections',async t=>{
 let attempts=0;
 const payload={embeds:[{title:'Review task',description:'Exact prompt'}],components:[{type:1,components:[{type:2,label:'Send',custom_id:'misty:send:1234567890',style:3,disabled:false}]}]};
 const {api,calls}=apiSetup(t,(_url,options)=>{
  if(attempts++===0)return Response.json({retry_after:0},{status:429});
  const echoed=JSON.parse(options.body);delete echoed.components[0].components[0].disabled;
  return Response.json({id:'100000000000000062',channel_id:channel,author:{id:bot},...echoed});
 });api.id=bot;api.channel=channel;await api.send('','card',payload);
 assert.equal(calls.length,2);assert.equal(calls[0].opts.body,calls[1].opts.body);
 const {api:bad}=apiSetup(t,()=>Response.json({id:'100000000000000062',channel_id:channel,author:{id:bot},content:''}));bad.id=bot;bad.channel=channel;await assert.rejects(bad.send('','card',payload),/complete interactive card/);
});

test('interaction callback uses the immediate deadline; message edits use PATCH',async t=>{
 const {api,calls}=apiSetup(t,()=>new Response(null,{status:204}));api.id=bot;api.channel=channel;
 await api.respond({id:'100000000000000062',token:'private-test-token'},{type:6});await api.editMessage('100000000000000062',{components:[]});
 assert.equal(calls[0].opts.method,'POST');assert.match(calls[0].url,/\/callback$/);assert.equal(calls[1].opts.method,'PATCH');assert.deepEqual(JSON.parse(calls[1].opts.body).allowed_mentions,{parse:[]});
});
