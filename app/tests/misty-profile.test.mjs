import test from 'node:test';
import assert from 'node:assert/strict';
import {ArchiveStore} from '../store.mjs';
import {Briefings} from '../briefings.mjs';
import {personProfile,roomMembers} from '../person-profile.mjs';
import {prepareBriefing,validateBriefing,savePersonNote} from '../briefing-store.mjs';
import {createApplication} from '../server.mjs';

const author='@discord_123:localhost',now=Date.now();
function fixture(t){const s=new ArchiveStore(':memory:');t.after(()=>s.close());return s;}
function room(s,id){s.ingest({kind:'room',id,state:{'m.room.name':{name:id},'m.bridge':{protocol:{id:'discordgo'},channel:{id},'com.beeper.room_type':'dm'}}});}
function message(s,room_id,id,sender=author,ts=now){s.ingestEvent({event_id:id,room_id,sender,type:'m.room.message',origin_server_ts:ts,content:{msgtype:'m.text',body:'I enjoy programming in Python.'}});}
function saved(s,b,id){const snap=prepareBriefing(s,id,now),ref=[...snap.refs.keys()][0],person=[...snap.personRefs.keys()][0];
 const p=validateBriefing({overview:[{text:'A coding conversation.',sources:[ref]}],recent:[],followups:[],people:[{person,observations:[{text:'Discusses practical coding.',sources:[ref]}],preferences:[{text:'Enjoys Python.',sources:[ref]}]}],events:[]},snap);
 s.statement('INSERT OR REPLACE INTO chat_briefings VALUES(?,?,?,?,?)').run(id,1,now,'fixture-model',JSON.stringify(p));return b.room(id);
}
test('recency controls chat order even when an older chat is followed and contains own messages',t=>{
 const s=fixture(t);room(s,'old');room(s,'new');message(s,'old','$old','@owner:localhost',now-10000);message(s,'new','$new');s.refreshCounts();s.updateRoom('old',{followed:true});
 assert.deepEqual(s.listRooms().rows.map(r=>r.id),['new','old']);assert.deepEqual(s.listRooms({view:'followed'}).rows.map(r=>r.id),['old']);
 assert.equal(s.messages()[0].id,'$new');
});
test('person profiles page only shared chats and keep same-name identities separate',t=>{
 const s=fixture(t);for(let i=0;i<8;i++){room(s,'chat'+i);message(s,'chat'+i,'$a'+i,author,now+i);}room(s,'unrelated');message(s,'unrelated','$other','@discord_456:localhost');s.refreshCounts();
 const b=new Briefings(s,{poll:false});const a=personProfile(s,b,author,{room:'chat0'}),next=personProfile(s,b,author,{room:'chat0',offset:5});
 assert.equal(a.total,8);assert.equal(a.chats.length,5);assert.equal(a.chats[0].room.id,'chat0');assert.equal(next.chats.length,3);
 assert.equal(new Set([...a.chats,...next.chats].map(x=>x.room.id)).size,8);assert.ok(!a.chats.some(x=>x.room.id==='unrelated'));
 assert.throws(()=>personProfile(s,b,'missing'),/not found/);
});
test('saved person observations, notes and summaries are filtered when evidence changes',t=>{
 const s=fixture(t);room(s,'private');message(s,'private','$a');s.refreshCounts();const b=new Briefings(s,{poll:false});saved(s,b,'private');
 savePersonNote(s,{room_id:'private',person_id:author,label:'Alex',note:'My private note.'});
 let chat=personProfile(s,b,author).chats[0];assert.equal(chat.person.name,'Alex');assert.equal(chat.person.customNote,'My private note.');assert.equal(chat.person.observations.length,1);assert.equal(chat.summary.length,1);
 s.statement('UPDATE messages SET body=? WHERE id=?').run('A revised message.','$a');chat=personProfile(s,b,author).chats[0];assert.equal(chat.person.observations.length,0);assert.equal(chat.summary.length,0);assert.equal(chat.person.customNote,'My private note.');
});
test('members come from all archived authors and paginate independently of analyzed people',t=>{
 const s=fixture(t);room(s,'private');for(let i=0;i<57;i++)message(s,'private','$m'+i,'@discord_'+i+':localhost');s.refreshCounts();
 const first=roomMembers(s,'private'),next=roomMembers(s,'private',{offset:50});assert.equal(first.total,57);assert.equal(first.rows.length,50);assert.equal(next.rows.length,7);
 assert.equal(new Set([...first.rows,...next.rows].map(p=>p.id)).size,57);assert.throws(()=>roomMembers(s,'missing'),/not found/);
});
test('new profile APIs and Misty assets stay behind application authentication',async t=>{
 const s=new ArchiveStore(':memory:');const app=createApplication({store:s,poll:false,port:8787,publicOrigin:'https://misty.example',authorizeRequest:async()=>false});t.after(()=>app.close());await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 const {request}=await import('node:http');for(const route of ['/misty.js','/misty.css','/api/person?id=x','/api/room/people?id=x']){
  const code=await new Promise((resolve,reject)=>{const req=request({host:'127.0.0.1',port:app.server.address().port,path:route,headers:{Host:'misty.example'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();});assert.equal(code,401);
 }
});

test('Misty HTML, styles, scripts and profile routes are served by the application',async t=>{
 const s=new ArchiveStore(':memory:');room(s,'private');message(s,'private','$a');s.refreshCounts();
 const app=createApplication({store:s,poll:false,port:8787});t.after(()=>app.close());await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 const {request}=await import('node:http');
 async function get(path){return new Promise((resolve,reject)=>{const req=request({host:'127.0.0.1',port:app.server.address().port,path,headers:{Host:'127.0.0.1:8787'}},res=>{let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({code:res.statusCode,text,type:res.headers['content-type']}));});req.on('error',reject);req.end();});}
 const html=await get('/');assert.equal(html.code,200);assert.match(html.text,/<title>Misty/);assert.match(html.text,/id="user-settings"/);
 for(const path of ['/app.js','/misty.js','/misty.css','/style.css','/briefings.js','/chat.js','/gmail.js']){const asset=await get(path);assert.equal(asset.code,200,path);assert.ok(asset.text.length>100);assert.match(asset.type,path.endsWith('.css')?/text\/css/:/text\/javascript/);}
 const people=await get('/api/room/people?id=private');assert.equal(people.code,200);assert.equal(JSON.parse(people.text).total,1);
 const person=await get('/api/person?'+new URLSearchParams({id:author,room:'private'}));assert.equal(person.code,200);assert.equal(JSON.parse(person.text).chats[0].room.id,'private');
});

test('older history cursors keep same-timestamp messages stable when a new message arrives',t=>{
 const s=fixture(t);room(s,'private');for(let i=0;i<86;i++)message(s,'private','$m'+String(i).padStart(3,'0'),author,1000);s.refreshCounts();
 const first=s.messages({room:'private'}),oldest=first.at(-1);assert.equal(first.length,80);
 message(s,'private','$new',author,1001);const next=s.messages({room:'private',before:oldest.ts,before_id:oldest.id});
 assert.equal(next.length,6);assert.equal(new Set([...first,...next].map(m=>m.id)).size,86);assert.ok(next.every(m=>m.id!=='$new'));assert.equal(next.at(-1).id,'$m000');
});

test('opening a chat bundles 80 messages without scanning the personal profile',async t=>{
 const s=new ArchiveStore(':memory:');room(s,'private');for(let i=0;i<100;i++)message(s,'private','$m'+i,author,1000+i);s.refreshCounts();
 const app=createApplication({store:s,poll:false,port:8787});t.after(()=>app.close());await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 let scans=0;const corpus=s.ownCorpus.bind(s);s.ownCorpus=()=>{scans++;return corpus();};
 const {request}=await import('node:http');async function get(path){return new Promise((resolve,reject)=>{const req=request({host:'127.0.0.1',port:app.server.address().port,path,headers:{Host:'127.0.0.1:8787'}},res=>{let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve(JSON.parse(text)));});req.on('error',reject);req.end();});}
 const data=await get('/api/room?id=private&messages=true');assert.equal(data.room.id,'private');assert.equal(data.messages.length,80);assert.equal(data.fit,null);assert.equal(scans,0);
 const preferences=await get('/api/room?id=private&fit=true');assert.ok(preferences.fit.label);assert.ok(scans>0);
});
