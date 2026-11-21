import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {BotAPI,BotStore} from '../discord-bot.mjs';
import {MistyRelay} from '../misty-relay.mjs';
import {MistyPresence,MistySelf,normalizePresence} from '../misty-self.mjs';
import {faithfulPresentation} from '../misty-rephraser.mjs';

const channel='100000000000000051',bot='100000000000000052',owner='100000000000000023';
const a='100000000000000057',b='100000000000000059',request='100000000000000063';
function apiFixture(t,fetchImpl){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'misty-self-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const tokenFile=path.join(dir,'token');fs.writeFileSync(tokenFile,'test-only');const api=new BotAPI({tokenFile,fetchImpl});api.channel=channel;api.id=bot;return api;}
function setup(t,api={},client={}){const store=new BotStore(':memory:');t.after(()=>store.close());const relay=new MistyRelay(store,client);const presence=new MistyPresence(store,{write:()=>{}});const self=new MistySelf(relay,api,presence);relay.self=self;return {store,relay,presence,self};}

test('self deletion verifies actual author and bound channel before DELETE; missing is idempotent',async t=>{
 const calls=[];let author=owner,missing=false;
 const api=apiFixture(t,async(url,opts)=>{calls.push(opts.method);if(missing)return new Response(null,{status:404});if(opts.method==='DELETE')return new Response(null,{status:204});return Response.json({id:a,channel_id:channel,author:{id:author}});});
 await assert.rejects(api.deleteOwnMessage(a),/Misty-authored/);assert.deepEqual(calls,['GET']);
 author=bot;assert.equal((await api.deleteOwnMessage(a)).state,'deleted');assert.deepEqual(calls,['GET','GET','DELETE']);
 missing=true;assert.equal((await api.deleteOwnMessage(a)).state,'already_missing');assert.equal(calls.at(-1),'GET');
 await assert.rejects(api.deleteOwnMessage('../other'),/Invalid/);
});

test('own message pages skip owner text and preserve an advancing all-message cursor',async t=>{
 const api=apiFixture(t,async()=>Response.json([{id:b,channel_id:channel,author:{id:owner},content:'owner'},{id:a,channel_id:channel,author:{id:bot},content:'reply'}]));
 const page=await api.ownMessages({limit:2});assert.deepEqual(page.messages.map(m=>m.id),[a]);assert.equal(page.nextBefore,a);
 await assert.rejects(api.ownMessages({before:a,limit:2}),/advance/);
});

test('deleting a preview invalidates it without erasing saved turns or approved jobs',async t=>{
 const {self,relay:r}=setup(t,{channel,deleteOwnMessage:async id=>({id,state:'deleted'})});
 r.db.prepare("INSERT INTO relay_drafts VALUES('draft','source','aaaaaaaaaa','original','prompt','{}','[]','reason','pending',1,9999999999999)").run();
 r.db.prepare("INSERT INTO relay_notices(source,body,status,message_id) VALUES('draft:aaaaaaaaaa:card:0000','card','sent',?)").run(a);
 r.db.prepare("INSERT INTO relay_card_updates VALUES(1,'{}','queued',0)").run();
 r.db.prepare("INSERT INTO relay_jobs(id,code,prompt,target,hash,status,created,updated) VALUES('approved','other','prompt','{}','hash','running',1,1)").run();
 r.db.prepare("INSERT INTO bot_turns(id,channel,body,ts,status,reply,reply_id) VALUES('turn',?,'owner text',1,'sent','old reply',?)").run(channel,a);
 const result=await self.remove([a],request);assert.equal(result.deleted,1);
 assert.equal(r.db.prepare('SELECT state FROM relay_drafts').get().state,'cancelled');assert.equal(r.db.prepare('SELECT status FROM relay_notices').get().status,'deleted');assert.equal(r.db.prepare('SELECT status FROM relay_card_updates').get().status,'deleted');
 assert.equal(r.db.prepare('SELECT status FROM relay_jobs').get().status,'running');assert.equal(r.db.prepare('SELECT reply FROM bot_turns').get().reply,'old reply');assert.throws(()=>r.findDraft('aaaaaaaaaa'));
});

test('cleanup snapshots every page before deleting, bounds time and reports partial failures',async t=>{
 const calls=[];const api={channel,ownMessages:async({before})=>{calls.push('list:'+before);return before===request?{messages:[{id:b}],nextBefore:b}:{messages:[{id:a}],nextBefore:''};},deleteOwnMessage:async id=>{calls.push('delete:'+id);if(id===a)throw Error('ambiguous');return {id,state:'deleted'};}};
 const {self}=setup(t,api);assert.deepEqual(await self.clear(request),{selected:2,deleted:1,missing:0,unconfirmed:1});
 assert.deepEqual(calls,['list:'+request,'list:'+b,'delete:'+b,'delete:'+a]);
 await assert.rejects(self.remove([request],request));
 await assert.rejects(self.execute('misty_self_clear',{}, {id:request,body:'what can you do?'}),/explicit/);
 assert.equal(self.db.prepare('SELECT state FROM misty_deleted_messages WHERE id=?').get(a).state,'unconfirmed');
});

test('presence requires acknowledgement, rate limits, persists and keeps failures uncommitted',async t=>{
 const {store}=setup(t);let command,now=100000;
 const p=new MistyPresence(store,{write:v=>{command=v;},now:()=>now,timeoutMs:20});
 const value={status:'online',activity:'custom',text:'around'};const pending=p.set(value);assert.equal(store.get('misty_presence'),null);
 p.receive({kind:'presence',id:'unknown',ok:true});assert.equal(p.pending.size,1);p.receive({kind:'presence',id:command.id,ok:true});
 assert.equal((await pending).state,'gateway_sent');assert.deepEqual(store.get('misty_presence'),value);
 await assert.rejects(p.set(value),/20 seconds/);now+=20000;
 const rejected=p.set({...value,text:'new'});p.receive({kind:'presence',id:command.id,ok:false});await assert.rejects(rejected,/accept/);assert.deepEqual(store.get('misty_presence'),value);
 now+=20000;await assert.rejects(p.set(value),/not confirmed/);assert.deepEqual(store.get('misty_presence'),value);
 const offline=new MistyPresence(store,{write:()=>assert.fail(),isConnected:()=>false});await assert.rejects(offline.set(value),/reconnecting/);
 assert.throws(()=>normalizePresence({...value,text:'a\nprivate'}));assert.throws(()=>normalizePresence({...value,status:'invalid'}));assert.throws(()=>normalizePresence({...value,text:'x'.repeat(129)}));
});

test('natural self-management tools execute once per identical effect and have no routing authority',async t=>{
 let deletes=0,rounds=0;
 const client={generate:async p=>{rounds++;assert.ok(p.tools.some(t=>t.name==='misty_self_delete'));await p.executeTool('misty_self_delete',{ids:[a]});await p.executeTool('misty_self_delete',{ids:[a]});return {message:{content:JSON.stringify({mode:'chat',reply:'Removed my reply.',prompt:'',reason:'',chatId:'',workspace:'',draftCode:''})}};}};
 const {relay:r}=setup(t,{channel,deleteOwnMessage:async id=>{deletes++;return {id,state:'deleted'};}},client);
 assert.equal(await r.handle({id:request,body:'delete your last reply'}),'Removed my reply.');assert.equal(await r.handle({id:request,body:'delete your last reply'}),'Removed my reply.');assert.equal(deletes,1);assert.equal(rounds,1);assert.equal(r.db.prepare('SELECT count(*) n FROM relay_jobs').get().n,0);
});

test('presentation cannot deny a capability after a confirmed self action',async t=>{
 const actionReceipts=[{name:'misty_self_delete',result:{deleted:1,missing:0,unconfirmed:0}}];
 const original='Removed the duplicate reply.';
 assert.equal(faithfulPresentation(original,'I can’t actually change my status or delete replies here.',24000,{actionReceipts}),false);
 const {relay:r}=setup(t,{}, {generate:async p=>{assert.deepEqual(JSON.parse(p.messages.at(-1).content).actionReceipts,actionReceipts);return {message:{content:JSON.stringify({reply:'I cannot delete replies.'})}};}});
 r.rephraser.enabled=true;
 assert.equal(await r.rephraser.present({source:'receipt',request:'delete it',original,actionReceipts}),original);
});
