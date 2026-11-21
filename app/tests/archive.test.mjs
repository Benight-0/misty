import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArchiveStore } from '../store.mjs';
import { SELF_IDENTITIES,cleanBody } from '../identity.mjs';
import { importArchive } from '../import.mjs';
import { secureRequest,connectionCommand,createApplication } from '../server.mjs';

const self=SELF_IDENTITIES[1].id,other='@discord_100000000000000005:localhost';
function room(s,id='!test:localhost') {s.ingest({kind:'room',id,state:{'m.room.name':{name:'Test'},'m.bridge':{protocol:{id:'discordgo'},channel:{id:'100000000000000005'},'com.beeper.room_type.v2':'dm'}}});}
function event(s,id,body,sender=self,extra={}) {s.ingest({kind:'event',stream:1,event:{type:'m.room.message',event_id:id,room_id:'!test:localhost',sender,origin_server_ts:1000,content:{body,msgtype:'m.text',...extra}}});}

test('stable IDs, WhatsApp LID, and reply fallbacks determine own authorship',()=>{
  const s=new ArchiveStore(':memory:');room(s);
  s.ingest({kind:'identity',id:other,name:'Owner'});
  event(s,'$me','> <someone> I love astronomy\n\nI like neuroscience');event(s,'$other','same display name',other);
  event(s,'$wa','my WhatsApp words',SELF_IDENTITIES[3].id);
  assert.equal(s.ownCorpus().length,2);assert.equal(s.ownCorpus()[0].body,'I like neuroscience');
  assert.equal(cleanBody('> quoted\n\nmy reply'),'my reply');s.close();
});

test('empty-text messages and stickers are retained with their source IDs',()=>{
  const s=new ArchiveStore(':memory:');room(s);
  event(s,'$embed','',other,{'com.beeper.linkpreviews':[{title:'An embed'}]});
  s.ingest({kind:'event',stream:2,event:{type:'m.sticker',event_id:'$sticker',room_id:'!test:localhost',sender:self,origin_server_ts:1001,content:{body:'',url:'mxc://localhost/sticker'}}});
  const rows=s.messages({});assert.equal(rows.length,2);
  assert.equal(rows.find(r=>r.id==='$embed').body,'[Message without text]');
  assert.equal(rows.find(r=>r.id==='$sticker').type,'m.sticker');
  assert.equal(rows.find(r=>r.id==='$sticker').is_me,1);
  s.redact('$sticker');assert.equal(s.messages({}).length,1);s.close();
});

test('edits require the same author; redactions remove search evidence and prevent resurrection',()=>{
  const s=new ArchiveStore(':memory:');room(s);event(s,'$a','old astronomy');
  const edit=(id,body,sender)=>event(s,id,'* '+body,sender,{'m.relates_to':{rel_type:'m.replace',event_id:'$a'},'m.new_content':{body}});
  edit('$bad','forged',other);assert.equal(s.messages({q:'astronomy'}).length,1);
  edit('$edit','new neuroscience',self);assert.equal(s.messages({q:'astronomy'}).length,0);assert.equal(s.messages({q:'neuroscience'}).length,1);
  s.redact('$edit');assert.equal(s.messages({q:'astronomy'}).length,1);
  s.saveFinding({id:'f',title:'Interest',category:'Test',summary:'Test',evidence_ids:['$a']});
  s.redact('$a');event(s,'$a','old astronomy');assert.equal(s.messages({}).length,0);assert.equal(s.findings().length,0);s.close();
});

test('conversation preferences, user edits, aliases and checkpoints survive restart',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'archival-test-'));const filename=path.join(dir,'archive.sqlite');
  let s=new ArchiveStore(filename);room(s);event(s,'$a','hello');
  s.updateRoom('!test:localhost',{alias:'My alias',connected:false,followed:true,include_profile:false});
  s.updateIdentity(self,{alias:'Me'});
  s.saveFinding({id:'f',title:'Interest',category:'Test',summary:'Original',evidence_ids:['$a']});
  s.updateFinding('f',{summary:'My wording',status:'confirmed'});
  s.saveFinding({id:'f',title:'Interest',category:'Test',summary:'Overwrite attempt',source:'chat-interpretation',evidence_ids:['$a']});
  s.set('stream_cursor',42);s.close();s=new ArchiveStore(filename);
  assert.equal(s.room('!test:localhost').alias,'My alias');assert.equal(s.room('!test:localhost').followed,1);assert.equal(s.get('stream_cursor'),42);
  event(s,'$b','not imported');assert.equal(s.messages({}).length,1);assert.equal(s.ownCorpus().length,0);
  assert.equal(s.statement('SELECT summary FROM profile_findings WHERE id=?').get('f').summary,'My wording');
  s.close();
  assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));
  assert.ok(path.basename(dir).startsWith('archival-test-'));
  fs.rmSync(dir,{recursive:true,force:true});
});

test('a failed source snapshot cannot advance the durable checkpoint or partially import',async()=>{
  const s=new ArchiveStore(':memory:');room(s);s.set('stream_cursor',42);
  const record={kind:'event',stream:43,event:{type:'m.room.message',event_id:'$new',room_id:'!test:localhost',sender:self,origin_server_ts:1000,content:{body:'new'}}};
  await assert.rejects(importArchive(s,{reader:async(c,m,receive)=>{receive(record);receive({kind:'watermark',cursor:44,messages:1});throw new Error('Simulated disconnect');}}));
  assert.equal(s.get('stream_cursor'),42);assert.equal(s.messages({}).length,0);
  await importArchive(s,{reader:async(c,m,receive)=>{receive(record);receive({kind:'watermark',cursor:44,messages:1});return{records:2};}});
  assert.equal(s.get('stream_cursor'),44);assert.equal(s.messages({}).length,1);s.close();
});

test('local API rejects foreign hosts/origins and missing mutation tokens; connection input is constrained',()=>{
  const req={method:'POST',headers:{host:'127.0.0.1:8787','x-archival-token':'secret'}};
  assert.equal(secureRequest(req,8787,'secret'),true);
  assert.equal(secureRequest({...req,headers:{...req.headers,origin:'https://evil.example'}},8787,'secret'),false);
  assert.equal(secureRequest({...req,headers:{host:'evil.example'}},8787,'secret'),false);
  assert.equal(secureRequest({...req,headers:{host:'127.0.0.1:8787'}},8787,'secret'),false);
  assert.deepEqual(connectionCommand('discord','https://discord.com/channels/100000000000000005/100000000000000013'),{command:'create-portal 100000000000000013'});
  assert.deepEqual(connectionCommand('matrix','https://matrix.to/#/!room:localhost'),{room:'!room:localhost'});
  assert.throws(()=>connectionCommand('discord','100000000000000005\nlogout'));
  assert.throws(()=>connectionCommand('matrix','!room:remote.example'));
});

test('full-rescan duplicate filtering keeps later edits and redactions effective',()=>{
  const s=new ArchiveStore(':memory:');room(s);event(s,'$a','old text');
  s.begin({dedupe:true});event(s,'$a','duplicate raw text');
  event(s,'$e','* new text',self,{'m.relates_to':{rel_type:'m.replace',event_id:'$a'},'m.new_content':{body:'new text'}});
  s.commit();assert.equal(s.messages({})[0].body,'new text');
  s.begin({dedupe:true});s.ingest({kind:'redacted',id:'$a'});event(s,'$a','resurrection');s.commit();
  assert.equal(s.messages({}).length,0);s.close();
});

test('HTTP browsing and profile evidence work without contacting any upstream bridge',async()=>{
  const s=new ArchiveStore(':memory:');room(s);event(s,'$a','neuroscience');
  const app=createApplication({store:s,poll:false,port:18787,source:{close(){},read(){throw new Error('No upstream calls expected');}}});
  await new Promise(r=>app.server.listen(18787,'127.0.0.1',r));
  try {
    const base='http://127.0.0.1:18787/api/';
    const b=await(await fetch(base+'bootstrap')).json();assert.ok(b.token);
    const rejected=await fetch(base+'room',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'!test:localhost',patch:{alias:'forged'}})});assert.equal(rejected.status,403);
    const saved=await fetch(base+'room',{method:'POST',headers:{'Content-Type':'application/json','X-Archival-Token':b.token},body:JSON.stringify({id:'!test:localhost',patch:{alias:'Readable name'}})});assert.equal(saved.status,200);
    const rows=await(await fetch(base+'messages?q=neuro')).json();assert.equal(rows[0].is_me,1);
    assert.equal((await(await fetch(base+'rooms')).json()).rows[0].alias,'Readable name');
  }finally{await app.close();}
});
