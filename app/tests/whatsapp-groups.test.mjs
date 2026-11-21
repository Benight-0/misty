import test from 'node:test';
import assert from 'node:assert/strict';
import {ArchiveStore} from '../store.mjs';
import {nativeSchema,applyNativeEvent} from '../native-ingest.mjs';
import {configureWhatsAppGroups,whatsappGroupPlans} from '../whatsapp-groups.mjs';
import {Briefings} from '../briefings.mjs';
import {prepareBriefing} from '../briefing-store.mjs';

const cutoff=Date.parse('2026-10-22T09:00:00Z');
const entries=[{id:'100@g.us',name:'History group',treatment:'G'},{id:'200@g.us',name:'Server group',treatment:'S'},{id:'300@g.us',name:'Ignored group',treatment:'I'},{id:'400@g.us',name:'Unassigned',treatment:''}];
const manifest={cutoff,continuousTracking:false,source:'review.md',choices:entries};
function fixture(t){const s=new ArchiveStore(':memory:');nativeSchema(s);s.set('whatsapp_group_inventory',{at:cutoff,groups:entries.map(g=>({...g,community:false}))});t.after(()=>s.close());return s;}
const historic=(chat='100@g.us',patch={})=>({kind:'whatsapp_group_history_message',chat,id:'OLD1',sender:'123@lid',name:'Person',at:cutoff-86400000,body:'I enjoy building software in Python.',type:'m.text',raw:{},...patch});

test('only explicit G groups accept historical messages; live groups and post-cutoff messages are rejected',t=>{
 const s=fixture(t);configureWhatsAppGroups(s,manifest);
 assert.deepEqual(whatsappGroupPlans(s).map(p=>p.id),['100@g.us']);
 for(const chat of entries.map(g=>g.id))applyNativeEvent(s,historic(chat));
 applyNativeEvent(s,historic('100@g.us',{id:'FUTURE',at:cutoff+1}));
 applyNativeEvent(s,{...historic(),id:'LIVE',kind:'whatsapp_message'});
 assert.equal(s.statement('SELECT count(*) n FROM messages').get().n,1);
 const room=s.statement("SELECT * FROM conversations WHERE remote_id='100@g.us'").get();assert.equal(room.tracked,0);assert.equal(room.connected,1);
 assert.equal(s.statement('SELECT count(*) n FROM conversations').get().n,1,'No S/I/unassigned conversations created');
 applyNativeEvent(s,historic());assert.equal(s.statement('SELECT count(*) n FROM messages').get().n,1,'Retransmission is idempotent');
 const snapshot=prepareBriefing(s,room.id,cutoff,{full:true});assert.equal(snapshot.baseline.coverage.messages,1);
});

test('G history reuses archived Matrix message IDs and preserves owner attribution',t=>{
 const s=fixture(t);s.statement("INSERT INTO conversations(id,name,platform,kind,remote_id,connected,tracked) VALUES('archived','History group','whatsapp','group','100@g.us',0,0)").run();
 s.statement("INSERT INTO messages(id,room_id,sender,ts,body,original_body,type,is_me) VALUES('$old','archived','@owner:localhost',?,'Old','Old','m.text',1)").run(cutoff-1000);
 s.touched.add('archived');s.refreshCounts();configureWhatsAppGroups(s,manifest);
 s.statement("INSERT INTO native_message_links VALUES('whatsapp','100@g.us','OLD1','$old')").run();
 applyNativeEvent(s,historic('100@g.us',{is_me:true,sender:'110000000000005@s.whatsapp.net'}));
 assert.equal(s.statement('SELECT count(*) n FROM messages').get().n,1);assert.equal(s.statement('SELECT sender,is_me FROM messages').get().sender,'@owner:localhost');
 const job=s.statement("SELECT * FROM briefing_jobs WHERE room_id='archived'").get();assert.ok(job.enabled);assert.ok(job.revision>1);
 configureWhatsAppGroups(s,manifest);assert.equal(s.statement("SELECT revision FROM briefing_jobs WHERE room_id='archived'").get().revision,job.revision,'Reapplying unchanged choices preserves checkpoints/revision');
});

test('only selected nonempty G chats are scheduled, and old trigger definitions migrate on reopen',t=>{
 const s=fixture(t);configureWhatsAppGroups(s,manifest);const b=new Briefings(s,{poll:false});assert.equal(b.status().total,0,'Empty history is not reported ready');
 applyNativeEvent(s,historic());
 assert.equal(b.status().total,1);assert.equal(b.room('whatsapp:group:100@g.us').eligible,true);
 assert.equal(b.room('whatsapp:group:200@g.us').eligible,false);
 assert.equal(s.get('whatsapp_group_classification').serverPolicy.active,false);
 assert.equal(s.get('whatsapp_group_classification').serverPolicy.rawRetentionHours,24);
 assert.equal(s.statement("SELECT sql FROM sqlite_master WHERE name='briefing_message_insert'").get().sql.includes('whatsapp_group_policies'),true);
});

test('import cursor checkpoints resume unfinished G downloads and exclude settled imports',t=>{
 const s=fixture(t);configureWhatsAppGroups(s,manifest);
 applyNativeEvent(s,{kind:'whatsapp_group_import_status',chat:'100@g.us',state:'downloading',phase:'older',before:'PAGE1',at:cutoff-10000,from_me:true,pages:1,recent_gap:true});
 const [plan]=whatsappGroupPlans(s);assert.equal(plan.before,'PAGE1');assert.equal(plan.from_me,true);assert.equal(plan.recent_gap,true);
 applyNativeEvent(s,{kind:'whatsapp_group_import_status',chat:'100@g.us',state:'phone_unavailable',phase:'older',before:'PAGE1',at:cutoff-10000,pages:1});
 assert.equal(whatsappGroupPlans(s).length,0,'No automatic polling of a settled one-off import');
 assert.throws(()=>applyNativeEvent(s,{kind:'whatsapp_group_import_status',chat:'200@g.us',state:'downloading',phase:'older',before:'x',at:cutoff,pages:1}),/Invalid group import/);
});

test('invalid/community classifications fail before any flags or jobs change',t=>{
 const s=fixture(t);s.set('whatsapp_group_inventory',{groups:[{id:'100@g.us',community:true}]});
 assert.throws(()=>configureWhatsAppGroups(s,manifest),/community container/);assert.equal(s.statement('SELECT count(*) n FROM conversations').get().n,0);
 assert.throws(()=>configureWhatsAppGroups(s,{...manifest,continuousTracking:true}),/Invalid historical/);
});

test('a recent gap clears only after a newer-history pass overlaps the saved older archive',t=>{
 const s=fixture(t);configureWhatsAppGroups(s,manifest);
 s.statement("UPDATE whatsapp_group_policies SET recent_gap=1,known_ts=?,phase='recent' WHERE chat_id='100@g.us'").run(cutoff-50000);
 const progress={kind:'whatsapp_group_import_status',chat:'100@g.us',state:'downloading',phase:'older',before:'CURSOR',at:cutoff-10000,pages:1};
 applyNativeEvent(s,progress);assert.equal(whatsappGroupPlans(s)[0].recent_gap,true,'A newer page alone does not prove overlap');
 s.statement("UPDATE whatsapp_group_policies SET phase='recent' WHERE chat_id='100@g.us'").run();
 applyNativeEvent(s,{...progress,at:cutoff-60000,pages:2});
 assert.equal(whatsappGroupPlans(s)[0].recent_gap,false,'Chronological overlap closes the recent gap');
});

test('historical G analysis waits for download to settle, preserves saved output, then resumes automatically',async t=>{
 const s=fixture(t);configureWhatsAppGroups(s,manifest);applyNativeEvent(s,historic());
 let calls=0;
 const b=new Briefings(s,{poll:false,clock:()=>Date.now()+60000,analysisClient:{generate:async()=>{calls++;return {message:{content:JSON.stringify({overview:[{text:'Discusses building software in Python.',sources:['m0']}],recent:[],followups:[],people:[],events:[]})}};}}});
 t.after(()=>b.close());b.seedPreviews();
 const id='whatsapp:group:100@g.us',saved=s.statement('SELECT payload FROM chat_briefings WHERE room_id=?').get(id).payload;
 for(const state of ['queued','requesting','downloading','retrying']){
  s.statement('UPDATE whatsapp_group_policies SET import_state=? WHERE room_id=?').run(state,id);
  assert.equal(await b.runOne(),false,state+' should wait');
  assert.equal(b.room(id).import.import_state,state);
  assert.equal(b.list()[0].import_state,state);
 }
 assert.equal(calls,0,'No paid requests while importing');
 assert.equal(s.statement('SELECT payload FROM chat_briefings WHERE room_id=?').get(id).payload,saved,'Keep existing summaries while downloading');
 applyNativeEvent(s,{kind:'whatsapp_group_import_status',chat:'100@g.us',state:'available_exhausted',phase:'older',before:'OLD1',at:cutoff-86400000,pages:1});
 assert.equal(await b.runOne(),true);assert.equal(calls,1,'Settled import starts full archived-history analysis');
});
