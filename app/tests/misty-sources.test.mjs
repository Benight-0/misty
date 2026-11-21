import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {ArchiveStore} from '../store.mjs';

test('source reader returns real Discord IDs and private WhatsApp message links; disconnected and deleted sources disappear',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'misty-source-')),file=path.join(dir,'archive.sqlite'),store=new ArchiveStore(file);t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 store.db.exec("INSERT INTO conversations(id,name,platform,kind,remote_id) VALUES('d','Friend','discord','dm','100000000000000005'),('w','WA friend','whatsapp','dm','private');");
 const add=(id,room)=>store.db.prepare("INSERT INTO messages(id,room_id,sender,ts,body,original_body) VALUES(?,?,'@owner:localhost',1,'A birthday source.','A birthday source.')").run(id,room);add('dc','d');add('whatsapp:private:TEST','w');
 store.db.prepare("INSERT INTO discord_remote VALUES('100000000000000005','100000000000000011','d','dc','{}',1,1)").run();
 const read=(id,offset=0)=>{const result=spawnSync(process.platform==='win32'?'python':'python3',['scripts/misty-archive-query.py',file],{input:JSON.stringify({op:'source',args:{id,offset}}),encoding:'utf8'});assert.equal(result.status,0,result.stdout+result.stderr);return JSON.parse(result.stdout);};
 const discord=read('dc');assert.equal(discord.url,'https://discord.com/channels/@me/100000000000000005/100000000000000011');assert.equal(discord.body,'A birthday source.');assert.equal(discord.remote_id,undefined);
 store.db.prepare("INSERT INTO discord_matrix_links VALUES('$legacy:localhost','dc')").run();assert.equal(read('$legacy:localhost').url,discord.url);
 assert.equal(read('whatsapp:private:TEST').url,'https://archival.example.com/?source=whatsapp%3Aprivate%3ATEST');
 const long='Exact text with emoji 😀. '.repeat(400);store.db.prepare('UPDATE messages SET body=? WHERE id=?').run(long,'whatsapp:private:TEST');
 const first=read('whatsapp:private:TEST'),second=read('whatsapp:private:TEST',first.nextOffset);assert.equal(first.truncated,true);assert.equal(second.nextOffset,null);assert.equal(first.body+second.body,long);assert.equal(first.bodyHash,second.bodyHash);assert.equal(first.offset,0);assert.equal(second.offset,6000);
 store.db.prepare("UPDATE conversations SET connected=0 WHERE id='d'").run();assert.equal(read('dc').available,false);store.redact('whatsapp:private:TEST',{direct:true});assert.equal(read('whatsapp:private:TEST').available,false);assert.equal(read("' OR 1=1 --").available,false);
});
