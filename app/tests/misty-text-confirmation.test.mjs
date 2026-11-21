import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {MistyMessages} from '../misty-messages.mjs';
const base=1793367400000, channel='100000000000000046';
const snow=ts=>String((BigInt(ts)-1420070400000n)<<22n);
function fixture(){
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE bot_turns(id TEXT PRIMARY KEY,channel TEXT,body TEXT,ts INTEGER,status TEXT);
 CREATE TABLE relay_notices(seq INTEGER PRIMARY KEY AUTOINCREMENT,source TEXT UNIQUE,body TEXT,status TEXT DEFAULT 'queued',message_id TEXT DEFAULT '',owner_channel TEXT DEFAULT '');`);
 let now=base,changeTarget=false,failSend=false,sends=[];
 const target={room:'whatsapp:dm:test@lid',platform:'whatsapp',kind:'dm',remoteId:'test@lid',name:'Test teacher'};
 const backend={async call(op,args){
  if(op==='inspect')return {target:changeTarget?{...target,name:'Someone else'}:{...target},capability:{allowed:true,maxLength:20000}};
  if(op==='send'){sends.push(args);if(failSend)throw Error('Network response lost');return {id:args.id,room_id:args.room,body:args.body,status:'sent',event_id:'test-event'};}
  throw Error('Unexpected operation '+op);
 }};
 const relay={db,transaction(fn){db.exec('BEGIN IMMEDIATE');try{const v=fn();db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}},notice(source,body){db.prepare('INSERT OR IGNORE INTO relay_notices(source,body,owner_channel) VALUES(?,?,?)').run(source,body,channel);}};
 const messages=new MistyMessages(relay,backend,{clock:()=>now});
 function owner(body,ts=now,ch=channel){now=Math.max(now,ts);const id=snow(ts);db.prepare("INSERT INTO bot_turns VALUES(?,?,?,?,'external')").run(id,ch,body,ts);return id;}
 const request=owner('Please send the follow-up');now+=1000;
 async function draft(body='Dear teacher\n\nPlease confirm receipt by 1 November'){return messages.propose({ownerMessageId:request,room:target.room,body});}
 function delivered(code){let ts=base+2000;for(const row of db.prepare('SELECT seq FROM relay_notices WHERE source LIKE ? ORDER BY seq').all(`personal:${code}:preview:%`))db.prepare("UPDATE relay_notices SET status='sent',message_id=? WHERE seq=?").run(snow(ts++),row.seq);now=base+3000;}
 return {db,messages,sends,owner,draft,delivered,request,target,setTime:t=>now=t,changeTarget:()=>changeTarget=true,failSend:()=>failSend=true};
}

test('proposing queues full destination/body/footer without sending',async()=>{const f=fixture(),d=await f.draft();assert.equal(f.sends.length,0);const rows=f.db.prepare('SELECT body,owner_channel FROM relay_notices ORDER BY seq').all();assert.equal(rows.length,3);assert.ok(rows.every(x=>x.owner_channel===channel));assert.match(rows[0].body,/To: Test teacher\nRoom:/);assert.equal(rows[1].body,'Exact message body (1/1):\n'+d.body);assert.match(rows[2].body,new RegExp('yes '+d.code));});
test('fresh yes after complete delivered preview sends exact body once',async()=>{const f=fixture(),d=await f.draft();f.delivered(d.code);const yes=f.owner('yes');await f.messages.observe(yes);assert.equal(f.messages.status(d.code).state,'sent');assert.equal(f.sends.length,1);assert.equal(f.sends[0].body,d.body);await f.messages.observe(yes);assert.equal(f.sends.length,1);});
test('yes before preview delivery cannot send',async()=>{const f=fixture(),d=await f.draft();const yes=f.owner('yes',base+3000);await f.messages.observe(yes);assert.equal(f.sends.length,0);assert.equal(f.messages.status(d.code).state,'pending');});
test('partial long preview cannot send until every part delivered',async()=>{const f=fixture(),d=await f.draft('a'.repeat(1701)+'\nexact ending');f.delivered(d.code);const tail=f.db.prepare('SELECT seq FROM relay_notices ORDER BY seq DESC LIMIT 1').get();f.db.prepare("UPDATE relay_notices SET status='unknown' WHERE seq=?").run(tail.seq);await f.messages.observe(f.owner('yes'));assert.equal(f.sends.length,0);const parts=f.db.prepare("SELECT body FROM relay_notices WHERE source LIKE ? ORDER BY source").all(`personal:${d.code}:preview:%`);assert.equal(parts.slice(1,-1).map(p=>p.body.slice(p.body.indexOf('\n')+1)).join(''),d.body);});
test('another verified owner DM cannot approve this DM preview',async()=>{const f=fixture(),d=await f.draft();f.delivered(d.code);await f.messages.observe(f.owner('yes',base+3000,'100000000000000047'));assert.equal(f.sends.length,0);});
test('a yes older than delivered preview cannot approve',async()=>{const f=fixture(),d=await f.draft();f.delivered(d.code);const yes=f.owner('yes',base+1500);await f.messages.observe(yes);assert.equal(f.sends.length,0);});
test('text approval expires after ten minutes despite app 24h lifetime',async()=>{const f=fixture(),d=await f.draft();f.delivered(d.code);f.setTime(base+11*60000);await f.messages.observe(f.owner('yes',base+11*60000));assert.equal(f.sends.length,0);});
test('no cancels and later yes cannot send',async()=>{const f=fixture(),d=await f.draft();f.delivered(d.code);await f.messages.observe(f.owner('no'));assert.equal(f.messages.status(d.code).state,'cancelled');await f.messages.observe(f.owner('yes',base+4000));assert.equal(f.sends.length,0);});
test('changed live recipient rejects approval',async()=>{const f=fixture(),d=await f.draft();f.delivered(d.code);f.changeTarget();await f.messages.observe(f.owner('yes'));assert.equal(f.sends.length,0);});
test('changed draft body invalidates existing preview digest',async()=>{const f=fixture(),d=await f.draft();f.delivered(d.code);f.db.prepare('UPDATE misty_message_drafts SET body=? WHERE code=?').run('changed body',d.code);await f.messages.observe(f.owner('yes'));assert.equal(f.sends.length,0);});
test('a newer owner instruction invalidates a previous yes',async()=>{const f=fixture(),d=await f.draft();f.delivered(d.code);const yes=f.owner('yes');f.owner('Wait, change it',base+4000);await assert.rejects(()=>f.messages.confirmText(d.code,yes));assert.equal(f.sends.length,0);});
test('app and chat simultaneous approval submits at most once',async()=>{const f=fixture(),d=await f.draft();f.delivered(d.code);const yes=f.owner('yes');await Promise.allSettled([f.messages.confirmText(d.code,yes),f.messages.confirmOverlay({code:d.code,digest:d.digest})]);assert.equal(f.sends.length,1);assert.equal(f.messages.status(d.code).state,'sent');});
test('lost send response stays unknown and is never resent',async()=>{const f=fixture(),d=await f.draft();f.delivered(d.code);f.failSend();await f.messages.observe(f.owner('yes'));assert.equal(f.messages.status(d.code).state,'unknown');await f.messages.observe(f.owner('yes',base+4000));assert.equal(f.sends.length,1);});
test('wrong draft code cannot authorize another pending draft',async()=>{const f=fixture(),d=await f.draft();f.delivered(d.code);await f.messages.observe(f.owner('yes 0000000000'));assert.equal(f.sends.length,0);});
test('app-only draft without DM preview still cannot be approved by chat',async()=>{const f=fixture(),d=await f.draft();f.db.prepare("UPDATE relay_notices SET source=replace(source,':preview:',':app-fixture:')").run();await f.messages.observe(f.owner('yes',base+3000));assert.equal(f.sends.length,0);});
test('unrecorded owner confirmation is rejected',async()=>{const f=fixture(),d=await f.draft();f.delivered(d.code);await assert.rejects(()=>f.messages.confirmText(d.code,snow(base+3000)));assert.equal(f.sends.length,0);});

