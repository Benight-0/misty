import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {ProminenceBridge} from '../misty-prominence-bridge.mjs';

test('overlay input records one exact verified owner request for existing tools',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec('CREATE TABLE bot_turns(id TEXT PRIMARY KEY,channel TEXT NOT NULL,body TEXT NOT NULL,ts INTEGER NOT NULL,status TEXT NOT NULL)');
 const relay={db,messageApi:{owns:(owner,channel)=>owner==='100000000000000023'&&channel==='100000000000000046'}};
 const at=Date.now(),id=String((BigInt(at-1420070400000)*4194304n)+5n);
 const args={id,channel:'100000000000000046',owner:'100000000000000023',body:'check this file',at};
 assert.deepEqual(await ProminenceBridge.prototype.execute.call({relay},'overlay_input',args),{accepted:true,reused:false});
 assert.deepEqual(await ProminenceBridge.prototype.execute.call({relay},'overlay_input',args),{accepted:true,reused:true});
 const saved=db.prepare('SELECT body,status FROM bot_turns').get();
 assert.equal(saved.body,'check this file');assert.equal(saved.status,'external');
 await assert.rejects(ProminenceBridge.prototype.execute.call({relay},'overlay_input',{...args,body:'changed'}),/collision/);
 await assert.rejects(ProminenceBridge.prototype.execute.call({relay},'overlay_input',{...args,owner:'another'}),/Invalid owner/);
 await assert.rejects(ProminenceBridge.prototype.execute.call({relay},'overlay_input',{...args,at:at-60000}),/Invalid owner/);
 assert.equal(db.prepare('SELECT count(*) n FROM bot_turns').get().n,1);
});
