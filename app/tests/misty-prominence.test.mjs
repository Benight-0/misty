import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {BotStore} from '../discord-bot.mjs';
import {MistyRelay} from '../misty-relay.mjs';
import {ProminenceBridge,serveProminenceBridge} from '../misty-prominence-bridge.mjs';

function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'misty-fork-test-')),store=new BotStore(path.join(dir,'chat.sqlite'));
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const r=new MistyRelay(store,{generate:()=>{throw Error('No model call expected.');}},{compactCards:true});
 r.setCatalog({worker:'fixture',chats:[{id:'11111111-1111-1111-1111-111111111111',title:'Project',cwd:'C:\\work',preview:''}]});
 store.db.prepare('INSERT INTO bot_turns(id,channel,body,ts,status) VALUES(?,?,?,?,?)').run('100000000000000052','dm','work on this',Date.now(),'external');
 return {dir,store,r,b:new ProminenceBridge(r)};
}
const draft={ownerMessageId:'100000000000000052',chatId:'11111111-1111-1111-1111-111111111111',prompt:'Inspect the current code. Do not modify files.'};

test('fork prepares exact existing-chat cards without admitting work, and retries are idempotent',async t=>{
 const {b,r}=fixture(t),a=await b.execute('draft',draft),again=await b.execute('draft',draft);
 assert.equal(a.target.id,draft.chatId);assert.equal(a.requiresOwnerApproval,true);assert.equal(a.code,again.code);
 assert.equal(r.db.prepare('SELECT count(*) n FROM relay_jobs').get().n,0);
 assert.equal(r.db.prepare('SELECT count(*) n FROM relay_drafts').get().n,1);
 assert.throws(()=>r.approve(r.findDraft(a.code)),/preview/);
 await assert.rejects(b.execute('approve',{code:a.code}),/Unsupported/);
 await assert.rejects(b.execute('draft',{...draft,prompt:'changed'}),/different draft/);
});
test('fork rejects forged owner requests, unknown chats and invented workspaces',async t=>{
 const {b}=fixture(t);
 await assert.rejects(b.execute('draft',{...draft,ownerMessageId:'100000000000000053'}),/recorded owner/);
 await assert.rejects(b.execute('draft',{...draft,chatId:'made up'}),/catalog/);
 await assert.rejects(b.execute('draft',{...draft,chatId:'NEW',workspace:'C:\\invented'}),/known workspace/);
 assert.equal((await b.execute('draft',{...draft,chatId:'NEW',workspace:'C:\\work'})).target.kind,'new');
});
test('archive bridge reads selected data and current events, with an operation allowlist',async t=>{
 const {b,r}=fixture(t),calls=[];r.archive={read:async(op,args)=>{calls.push({op,args});return {rows:[]};}};
 await b.execute('archive',{op:'events',args:{after:10}});await b.execute('archive',{op:'sql',args:{sql:'SELECT 1',params:[]}});
 assert.deepEqual(calls[0],{op:'events',args:{after:10}});
 await assert.rejects(b.execute('archive',{op:'delete'}),/Unsupported/);
});
test('conversation recording only updates turns assigned to the fork',async t=>{
 const {b,r}=fixture(t);
 await b.execute('record',{ownerMessageIds:[draft.ownerMessageId],reply:'Checked it.'});
 assert.equal(r.db.prepare('SELECT reply FROM bot_turns WHERE id=?').get(draft.ownerMessageId).reply,'Checked it.');
 r.db.prepare("UPDATE bot_turns SET status='sent' WHERE id=?").run(draft.ownerMessageId);
 await assert.rejects(b.execute('record',{ownerMessageIds:[draft.ownerMessageId],reply:'overwrite'}),/assigned/);
 assert.equal((await b.execute('history')).rows[0].reply,'Checked it.');
});
test('owner agent can discover actual delivered bridge notices after its last turn',async t=>{
 const {b,r}=fixture(t),at=Date.now(),message=String((BigInt(at)-1420070400000n)<<22n);
 r.db.prepare("INSERT INTO relay_notices(source,body,status,message_id) VALUES(?,?,'sent',?)").run('result:fixture','Task finished.',message);
 r.db.prepare("INSERT INTO relay_notices(source,body,status) VALUES(?,?,'unknown')").run('result:unknown','Unconfirmed.');
 const rows=(await b.execute('outbound',{after:at-1})).rows;
 assert.equal(rows.length,1);assert.equal(rows[0].at,at);assert.equal(rows[0].body,'Task finished.');
 assert.equal((await b.execute('outbound',{after:at})).rows.length,0);
});
test('fork HTTP endpoint authenticates, binds localhost and rejects worker/approval operations',async t=>{
 const {dir,r}=fixture(t),token='a'.repeat(48),file=path.join(dir,'fork-token');fs.writeFileSync(file,token);
 const server=serveProminenceBridge(r,{tokenFile:file,port:0});await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
 assert.equal(server.address().address,'127.0.0.1');const url='http://127.0.0.1:'+server.address().port+'/call';
 assert.equal((await fetch(url,{method:'POST',body:'{}'})).status,401);
 const request=op=>fetch(url,{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify({op})});
 assert.equal((await request('status')).status,200);assert.equal((await request('claim')).status,400);assert.equal((await request('approve')).status,400);
});
