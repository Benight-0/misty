import test from 'node:test';
import assert from 'node:assert/strict';
import {ArchiveStore} from '../store.mjs';
import {ingestDiscord,deleteDiscord,ensureHistoryJobs,applyHistoryPage} from '../discord-history-store.mjs';
const channel='100000000000000037',room='!corzpp:localhost',remote='100000000000000042';
function setup(){const s=new ArchiveStore(':memory:');s.ingest({kind:'room',id:room,state:{'m.room.name':{name:'Corzpp'},'m.bridge':{protocol:{id:'discordgo'},channel:{id:channel},'com.beeper.room_type.v2':'group_dm'}}});return s;}
function raw(extra={}){return {id:remote,channel_id:channel,type:0,timestamp:'2026-10-09T15:44:55.713Z',content:'original',author:{id:'100000000000000023',username:'owner'},...extra};}
function matrix(s,id,body){s.ingestEvent({type:'m.room.message',event_id:id,room_id:room,sender:'@owner:localhost',origin_server_ts:1,content:{body}});}
test('lifetime import consolidates attachment parts and preserves existing evidence aliases',()=>{
  const s=setup();matrix(s,'$original','original');matrix(s,'$attachment','file.png');
  s.saveFinding({id:'f',title:'Test',category:'Test',summary:'Test',evidence_ids:['$attachment']});
  ingestDiscord(s,room,raw({attachments:[{filename:'file.png',url:'https://cdn.discordapp.com/file.png'}]}),[{event_id:'$original'},{event_id:'$attachment'}]);s.refreshCounts();
  assert.equal(s.room(room).message_count,1);assert.equal(s.room(room).own_count,1);
  assert.equal(s.messages({})[0].ts,Date.parse(raw().timestamp));
  assert.match(s.messages({})[0].body,/Attachment: file.png/);
  assert.equal(s.evidence('$attachment').event.id,'$original');assert.equal(s.findings().length,1);
  assert.equal(JSON.parse(s.statement('SELECT raw_json FROM discord_remote').get().raw_json).attachments.length,1);s.close();
});

test('persisted exact bridge mappings consolidate an older Matrix copy and later native replays',()=>{
 const s=setup();matrix(s,'$legacy','original');s.statement('INSERT INTO discord_source_links VALUES(?,?,?)').run(channel,remote,'$legacy');
 ingestDiscord(s,room,raw());assert.equal(s.messages({}).length,1);assert.equal(s.evidence('$legacy').event.id,'$legacy');
 ingestDiscord(s,room,raw({content:'edited',edited_timestamp:'2026-10-10T00:00:00Z'}));assert.equal(s.messages({}).length,1);assert.equal(s.evidence('$legacy').event.body,'edited');s.close();
});
test('native live events and raw historical messages deduplicate regardless of arrival order',()=>{
  const s=setup();ingestDiscord(s,room,raw());
  for(const id of ['$live','$part'])s.ingestEvent({event_id:id,room_id:room,type:'m.room.message',sender:'@owner:localhost',content:{body:'original','fi.mau.discord.raw':raw()}});
  assert.equal(s.messages({}).length,1);assert.equal(s.messages({})[0].is_me,1);
  assert.equal(s.evidence('$part').event.id,`discord:${channel}:${remote}`);s.close();
});
test('live edits of old archived messages survive stale page replay; deletes prevent resurrection',()=>{
  const s=setup();ingestDiscord(s,room,raw(),[],100);
  s.ingestEvent({event_id:'$edit-delta',room_id:room,type:'fi.mau.discord.history',sender:'@discordbot:localhost',content:{op:'upsert',message:raw({content:'edited',edited_timestamp:'2026-10-10T00:00:00Z'})}},2,200);
  ingestDiscord(s,room,raw(),[],300);assert.equal(s.messages({})[0].body,'edited');
  s.ingestEvent({room_id:room,type:'fi.mau.discord.history',sender:'@discordbot:localhost',content:{op:'delete',ids:[remote]}});
  ingestDiscord(s,room,raw(),[],400);assert.equal(s.messages({}).length,0);assert.equal(s.messages({q:'edited'}).length,0);s.close();
});
test('an attachment redaction cannot erase the consolidated Discord message',()=>{
  const s=setup();ingestDiscord(s,room,raw(),[{event_id:'$part'}]);s.redact('$part');assert.equal(s.messages({}).length,1);
  deleteDiscord(s,room,remote);assert.equal(s.messages({}).length,0);s.close();
});
test('a history page and its checkpoint commit together, and paused chats do not import',()=>{
  const s=setup();ensureHistoryJobs(s);
  const page={room,channel,messages:[raw()],links:[],before_id:remote,complete:false,fetched_at:100};
  applyHistoryPage(s,page);applyHistoryPage(s,{...page,messages:[],complete:true});
  assert.equal(s.messages({}).length,1);assert.equal(s.statement('SELECT complete FROM discord_history_jobs').get().complete,1);
  s.updateRoom(room,{tracked:false});assert.equal(applyHistoryPage(s,{...page,messages:[raw({id:'100000000000000043'})]}),false);assert.equal(s.messages({}).length,1);s.close();
});
test('a failed page leaves both messages and checkpoint unchanged',()=>{
  const s=setup();ensureHistoryJobs(s);
  const invalid=raw({id:'100000000000000043'});invalid.circular=invalid;
  assert.throws(()=>applyHistoryPage(s,{room,channel,messages:[raw(),invalid],links:[],before_id:remote,complete:false,fetched_at:100}));
  assert.equal(s.messages({}).length,0);assert.equal(s.statement('SELECT before_id FROM discord_history_jobs').get().before_id,'');s.close();
});

test('replayed page acknowledgements cannot count the same history twice',()=>{
  const s=setup();ensureHistoryJobs(s);
  const page={room,channel,messages:[raw()],links:[],from_before:'',before_id:remote,complete:false,fetched_at:100};
  assert.equal(applyHistoryPage(s,page),true);assert.equal(applyHistoryPage(s,page),true);
  assert.equal(s.statement('SELECT fetched FROM discord_history_jobs').get().fetched,1);
  assert.throws(()=>applyHistoryPage(s,{...page,before_id:'100000000000000041'}),/Stale history page/);
  applyHistoryPage(s,{...page,from_before:remote,messages:[],complete:true});
  assert.equal(s.statement('SELECT complete FROM discord_history_jobs').get().complete,1);s.close();
});

test('profile corpus uses authored Discord text rather than embedded third party descriptions',()=>{
  const s=setup();ingestDiscord(s,room,raw({content:'my own words',embeds:[{description:'someone else wrote this'}]}));
  assert.match(s.messages({})[0].body,/someone else/);
  assert.equal(s.ownCorpus()[0].body,'my own words');s.close();
});

test('the final page reconciles Matrix parts created after their earlier history page',()=>{
  const s=setup();ensureHistoryJobs(s);ingestDiscord(s,room,raw());matrix(s,'$late-part','original');
  applyHistoryPage(s,{room,channel,messages:[],links:[{remote_id:remote,event_id:'$late-part'}],from_before:'',before_id:'',complete:true,fetched_at:200});
  assert.equal(s.messages({}).length,1);assert.equal(s.evidence('$late-part').event.body,'original');s.close();
});

test('profile exclusions resolve historical aliases and keep the archive searchable',()=>{
  const s=setup();ingestDiscord(s,room,raw({content:'quoted third party interests'}),[{event_id:'$quoted-part'}]);
  s.saveFinding({id:'quoted',title:'Should be hidden',category:'Test',summary:'Unsupported',evidence_ids:['$quoted-part']});
  s.set('profile_excluded_messages',['$quoted-part']);
  assert.equal(s.ownCorpus().length,0);assert.equal(s.findings().length,0);
  assert.equal(s.messages({q:'third party'}).length,1);assert.ok(s.evidence('$quoted-part'));
  s.set('profile_excluded_messages',[]);assert.equal(s.ownCorpus().length,1);s.close();
});
