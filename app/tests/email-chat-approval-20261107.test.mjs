import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import {MistyMessages} from '../misty-messages.mjs';
const base=1794059000000,snow=t=>String((BigInt(t)-1420070400000n)<<22n);
function fixture(body='Exact body',header='Subject'){
 let now=base;const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE bot_turns(id TEXT PRIMARY KEY,channel TEXT,body TEXT,ts INTEGER,status TEXT);CREATE TABLE relay_notices(source TEXT UNIQUE,body TEXT,owner_channel TEXT,status TEXT DEFAULT 'queued',message_id TEXT);`);
 const relay={db,transaction:f=>{db.exec('BEGIN');try{const r=f();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}},notice:()=>{}};
 const target={platform:'gmail',account:'acct',from:'owner@example.org',to:['to@example.org'],cc:['cc@example.org'],bcc:['bcc@example.org'],subject:header,replyTo:'gmail:acct:original',threadId:'thread'};
 let sends=0,mode='sent',changed=false,allowed=true;
 const backend={call:async(op,args)=>{if(op==='email_inspect')return {target:changed?{...target,to:['changed@example.org']}:target,capability:{allowed}};
 if(op==='email_send'){sends++;if(mode==='throw')throw Error('timeout');return {id:args.id,target_json:JSON.stringify(args.target),body:args.body,status:'sent',remote_id:'remote'};}throw Error(op);}};
 const api=new MistyMessages(relay,backend,{clock:()=>now});
 function owner(text,channel='dm'){now+=100;const id=snow(now);db.prepare('INSERT INTO bot_turns VALUES(?,?,?,?,?)').run(id,channel,text,now,'external');return id;}
 const original=owner('confirm interview');
 async function propose(){return api.proposeEmail({ownerMessageId:original,body});}
 function delivered(){let t=now+1;for(const n of db.prepare('SELECT source FROM relay_notices ORDER BY source').all())db.prepare("UPDATE relay_notices SET status='sent',message_id=? WHERE source=?").run(snow(t++),n.source);now=t+1;}
 return {db,api,target,owner,propose,delivered,get sends(){return sends;},set mode(v){mode=v;},set changed(v){changed=v;},set allowed(v){allowed=v;},advance:ms=>now+=ms};
}
let passed=0;
async function test(name,fn){await fn();passed++;console.log('PASS',name);}
await test('full email fields, original body, zero sends on proposal',async()=>{const f=fixture();const d=await f.propose();const texts=f.db.prepare('SELECT body FROM relay_notices ORDER BY source').all().map(x=>x.body).join('\n');for(const v of ['From: owner@','To: to@','Cc: cc@','Bcc: bcc@','Subject: Subject','gmail:acct:original','Exact body'])assert.ok(texts.includes(v));assert.equal(f.sends,0);f.delivered();const r=await f.api.confirmText(d.code,f.owner('yes '+d.code));assert.equal(r.state,'sent');assert.equal(f.sends,1);await assert.rejects(f.api.confirmText(d.code,f.owner('yes '+d.code)));assert.equal(f.sends,1);});
await test('queued preview cannot approve',async()=>{const f=fixture(),d=await f.propose();await assert.rejects(f.api.confirmText(d.code,f.owner('yes')));assert.equal(f.sends,0);});
await test('partial delivery rejected',async()=>{const f=fixture('x'.repeat(4000)),d=await f.propose();f.delivered();f.db.prepare("UPDATE relay_notices SET status='queued' WHERE source LIKE '%0002'").run();await assert.rejects(f.api.confirmText(d.code,f.owner('yes')));});
await test('different owner DM rejected',async()=>{const f=fixture(),d=await f.propose();f.delivered();await assert.rejects(f.api.confirmText(d.code,f.owner('yes','alias-dm')));});
await test('wrong code rejected',async()=>{const f=fixture(),d=await f.propose();f.delivered();await assert.rejects(f.api.confirmText(d.code,f.owner('yes 0000000000')));});
await test('expiry rejected',async()=>{const f=fixture(),d=await f.propose();f.delivered();f.advance(601000);await assert.rejects(f.api.confirmText(d.code,f.owner('yes')));});
await test('body tampering rejected',async()=>{const f=fixture(),d=await f.propose();f.delivered();f.db.prepare('UPDATE misty_message_drafts SET body=? WHERE code=?').run('tampered',d.code);await assert.rejects(f.api.confirmText(d.code,f.owner('yes')));});
await test('changed target rejected before sending',async()=>{const f=fixture(),d=await f.propose();f.delivered();f.changed=true;await assert.rejects(f.api.confirmText(d.code,f.owner('yes')));assert.equal(f.sends,0);});
await test('revoked connection rejected',async()=>{const f=fixture(),d=await f.propose();f.delivered();f.allowed=false;await assert.rejects(f.api.confirmText(d.code,f.owner('yes')));});
await test('unknown send never retried',async()=>{const f=fixture(),d=await f.propose();f.delivered();f.mode='throw';assert.equal((await f.api.confirmText(d.code,f.owner('yes'))).state,'unknown');await assert.rejects(f.api.confirmText(d.code,f.owner('yes')));assert.equal(f.sends,1);});
await test('automatic owner yes observation sends email',async()=>{const f=fixture(),d=await f.propose();f.delivered();await f.api.observe(f.owner('yes '+d.code));assert.equal(f.api.status(d.code).state,'sent');});
await test('app approval retained, subsequent chat yes cannot duplicate',async()=>{const f=fixture(),d=await f.propose();await f.api.confirmOverlay({code:d.code,digest:d.digest});f.delivered();await assert.rejects(f.api.confirmText(d.code,f.owner('yes')));assert.equal(f.sends,1);});
await test('long header and body chunks all required',async()=>{const f=fixture('z'.repeat(6000),'subject'.repeat(700)),d=await f.propose();const rows=f.db.prepare('SELECT body FROM relay_notices').all();assert.ok(rows.length>6);assert.ok(rows.every(x=>x.body.length<1900));f.delivered();assert.equal((await f.api.confirmText(d.code,f.owner('yes'))).state,'sent');});
await test('cancel prevents later send',async()=>{const f=fixture(),d=await f.propose();f.delivered();await f.api.observe(f.owner('no '+d.code));assert.equal(f.api.status(d.code).state,'cancelled');await assert.rejects(f.api.confirmText(d.code,f.owner('yes')));});
await test('stale yes cannot create new draft',async()=>{const f=fixture();const id=f.owner('yes');await assert.rejects(f.api.proposeEmail({ownerMessageId:id,body:'body'}));});
console.log(`${passed} tests passed`);