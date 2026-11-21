import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {BotStore} from '../discord-bot.mjs';
import {ArchiveStore} from '../store.mjs';
import {MistyRelay} from '../misty-relay.mjs';
import {knowledgeSignature} from '../misty-knowledge.mjs';
import {rolloutChunks,textChunks,codeFiles,knowledgePage,codexTranscriptChunks} from '../misty-knowledge-sync.mjs';
import {activateWhatsAppServers,MistyServerSummaries} from '../misty-server-summaries.mjs';
import {nativeSchema,applyNativeEvent} from '../native-ingest.mjs';
const thread='01a11111-1111-7111-8111-111111111111';
const response=p=>({message:{content:JSON.stringify(p)}});
function relay(t,options={}){const s=new BotStore(':memory:');t.after(()=>s.close());const r=new MistyRelay(s,{generate:async()=>response({reply:'Codex finished the change; its checks passed.'})},options);r.setCatalog({worker:'laptop',chats:[{id:thread,title:'Misty',cwd:process.cwd()}]});return r;}

test('knowledge snapshots are complete, atomic, paired and fully paginated',t=>{
 const r=relay(t),k=r.knowledge,rows=textChunks('start '+('a 😀 '.repeat(18000))+' end','user','turn','2026-10-23');
 const id='codex:'+thread,meta={kind:'codex',title:'Misty',path:process.cwd(),thread_id:thread,revision:knowledgeSignature(rows),parts:rows.length,characters:rows.reduce((n,r)=>n+r.text.length,0),updated:1};
 assert.throws(()=>k.publish({worker:'other',action:'begin',id,meta}),/pairing/);
 k.publish({worker:'laptop',action:'begin',id,meta});k.publish({worker:'laptop',action:'chunks',id,rows:rows.slice(0,1)});assert.throws(()=>k.publish({worker:'laptop',action:'commit',id}),/Incomplete/);assert.equal(k.execute('knowledge_read',{document:id}).available,false);
 k.publish({worker:'laptop',action:'chunks',id,rows:rows.slice(1)});k.publish({worker:'laptop',action:'commit',id});
 let text='',offset=0;do{const p=k.execute('knowledge_read',{document:id,offset});text+=p.rows.map(r=>r.text).join('');offset=p.nextOffset;}while(offset!==null);
 assert.equal(text,rows.map(r=>r.text).join(''));assert.equal(k.execute('knowledge_find',{query:'start',kind:'codex'}).hits.length,1);
 k.publish({worker:'laptop',action:'begin',id,meta:{...meta,revision:'a'.repeat(64)}});assert.ok(k.execute('knowledge_read',{document:id,offset:0}).rows.length);assert.throws(()=>k.publish({worker:'laptop',action:'commit',id}));
});

test('rollouts preserve all visible text and exclude reasoning, logs, secrets and generated code paths',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'misty-knowledge-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'session.jsonl'),events=[{type:'turn_context',payload:{turn_id:'t'}},...['user','assistant'].map(role=>({type:'response_item',timestamp:'now',payload:{type:'message',role,channel:'final',content:[{type:'output_text',text:role+' '+ 'sk-proj-'+'x'.repeat(50)}]}})),{type:'response_item',payload:{type:'message',role:'assistant',channel:'analysis',content:[{type:'output_text',text:'private reasoning'}]}},{type:'event_msg',payload:{type:'agent_message',message:'duplicate'}}];
 fs.writeFileSync(file,events.map(e=>JSON.stringify(e)).join('\n')+'\n');const rows=await rolloutChunks(file,fs.statSync(file).size);assert.equal(rows.length,2);assert.ok(rows.every(r=>r.text.includes('[REDACTED API KEY]')));assert.ok(!JSON.stringify(rows).includes('private reasoning'));
 fs.mkdirSync(path.join(dir,'app/data'),{recursive:true});fs.writeFileSync(path.join(dir,'app/data/secret.json'),'secret');fs.writeFileSync(path.join(dir,'app/example.mjs'),'code');assert.deepEqual(codeFiles(dir),[path.join(dir,'app/example.mjs')]);
});

test('many short transcript messages obey both remote row and byte page limits',()=>{
 const rows=Array.from({length:591},(_,ordinal)=>({ordinal,role:'user',turn_id:'t',at:'now',text:'A short message.'})),received=[];
 for(let offset=0;offset<rows.length;){const page=knowledgePage(rows,offset);assert.ok(page.length<=80&&page.length>0);assert.ok(Buffer.byteLength(JSON.stringify(page))<1000000);received.push(...page);offset+=page.length;}
 assert.deepEqual(received,rows);
});

test('compressed chat history is read through all backend pages without resuming a conversation',async()=>{
 const calls=[];const a={id:'a',startedAt:100,items:[{type:'userMessage',content:[{type:'text',text:'Exact user text'}]},{type:'commandExecution',aggregatedOutput:'tool log'},{type:'agentMessage',phase:'commentary',text:'Exact commentary'}]},b={id:'b',items:[{type:'agentMessage',phase:'final_answer',text:'Final reply'}]};
 const rpc={request:async(method,p)=>{calls.push({method,p});return p.cursor?{data:[a,b]}:{data:[a],nextCursor:'next'};}};const rows=await codexTranscriptChunks(rpc,thread);
 assert.deepEqual(rows.map(r=>r.text),['Exact user text','Exact commentary','Final reply']);assert.ok(calls.every(c=>c.method==='thread/turns/list'&&c.p.itemsView==='full'));assert.equal(calls[1].p.cursor,'next');
});

test('compact proposals cannot execute until exact card delivered; raw results stay stored until requested',async t=>{
 const r=relay(t,{compactCards:true,naturalResults:true}),now=Date.now(),d={id:'job',source:'owner',code:'abc1234567',original:'fix',prompt:'Fix this one issue.',target:JSON.stringify({kind:'existing',id:thread,title:'Misty',cwd:process.cwd()}),candidates:'[]',reason:'Relevant project.',state:'pending',created:now,expires:now+86400000};
 r.db.prepare('INSERT INTO relay_drafts VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(...Object.values(d));r.preview(d);await r.sendNotices({send:async()=> '123'});assert.throws(()=>r.approve(d),/entire preview/);assert.equal(r.claim('laptop'),null);
 const formal=r.refresh(d,{},{formal:true});await r.sendNotices({send:async()=> '124'});r.approve(formal);const j=r.claim('laptop');r.progress({id:j.id,worker:'laptop',hash:j.hash,status:'running',threadId:thread,turnId:'turn'});r.result({id:j.id,worker:'laptop',hash:j.hash,status:'completed',threadId:thread,turnId:'turn',answer:'VERBATIM RAW ANSWER'});
 assert.equal(r.db.prepare("SELECT count(*) n FROM relay_notices WHERE body LIKE '%VERBATIM%'").get().n,0);await r.summarizeResult();assert.match(r.db.prepare("SELECT body FROM relay_notices WHERE source LIKE 'natural-result:%'").get().body,/Codex finished/);
 r.knowledge.execute('misty_details',{kind:'exact',id:j.code});assert.equal(r.db.prepare("SELECT count(*) n FROM relay_notices WHERE body='VERBATIM RAW ANSWER'").get().n,1);
 const historical=r.knowledge.execute('misty_details',{kind:'card',id:j.code});assert.equal(historical.readOnly,true);const payload=JSON.parse(r.db.prepare("SELECT payload FROM relay_notices WHERE source LIKE 'requested-card:%' ORDER BY seq DESC LIMIT 1").get().payload);assert.ok(payload.components.every(row=>row.components.every(c=>c.disabled)));assert.equal(r.db.prepare('SELECT count(*) n FROM relay_jobs').get().n,1);
 assert.throws(()=>r.knowledge.execute('misty_control',{action:'approve',id:formal.code}));
});

function serverStore(t){const s=new ArchiveStore(':memory:');t.after(()=>s.close());nativeSchema(s);const now=Date.now();
 s.db.exec(`CREATE TABLE IF NOT EXISTS whatsapp_group_policies(chat_id TEXT PRIMARY KEY,name TEXT,treatment TEXT,room_id TEXT,cutoff INTEGER);`);
 s.db.prepare("INSERT INTO whatsapp_group_policies(chat_id,name,treatment,room_id,cutoff) VALUES('110000000000001@g.us','S group','S',NULL,0),('110000000000002@g.us','Ignored','I',NULL,0)").run();s.set('misty_live_servers',true);s.set('whatsapp_group_inventory',{groups:[{id:'110000000000001@g.us',name:'S group',parent:'110000000000003@g.us'},{id:'110000000000003@g.us',name:'Community',community:true}]});activateWhatsAppServers(s,now);return {s,now};}
const wa=(at,id='one',body='We meet tomorrow at 3.')=>({kind:'whatsapp_message',chat:'110000000000001@g.us',id,sender:'110000000000004@s.whatsapp.net',is_me:false,name:'Contact',at,body,type:'text'});

test('only selected S groups collect from activation; old history and ignored groups stay excluded',t=>{
 const {s,now}=serverStore(t);applyNativeEvent(s,wa(now-1,'old'));applyNativeEvent(s,{...wa(now+1,'ignored'),chat:'110000000000002@g.us'});assert.equal(s.db.prepare('SELECT count(*) n FROM messages').get().n,0);
 applyNativeEvent(s,wa(now+1));assert.equal(s.db.prepare('SELECT count(*) n FROM misty_server_pending').get().n,1);activateWhatsAppServers(s,now+5000);assert.equal(s.db.prepare('SELECT from_ts FROM misty_server_channels').get().from_ts,now);assert.equal(s.db.prepare('SELECT server_name FROM misty_server_channels').get().server_name,'Community');
});

test('server summary retries preserve raw text; successful verified coverage permits 24h retention only',async t=>{
 const {s,now}=serverStore(t),room=s.db.prepare('SELECT room_id FROM misty_server_channels').get().room_id;applyNativeEvent(s,wa(now+1));
 let fail=true;const client={generate:async()=>{if(fail)throw Error('offline');return response({channelSummary:'A meeting was proposed for tomorrow at 3.',serverSummary:'S group discussed a meeting.',newDevelopments:[{text:'Meeting proposed',sources:['whatsapp:110000000000001@g.us:one']}],followups:['Confirm the date and time.']});}};
 let clock=now+4000000;const summaries=new MistyServerSummaries(s,client,{clock:()=>clock});await summaries.step();assert.equal(s.db.prepare('SELECT count(*) n FROM misty_channel_summaries').get().n,0);assert.equal(s.db.prepare('SELECT count(*) n FROM messages').get().n,1);
 fail=false;clock+=60001;await summaries.step();assert.equal(s.db.prepare('SELECT messages FROM misty_channel_summaries').get().messages,1);assert.equal(s.db.prepare('SELECT count(*) n FROM misty_server_pending').get().n,0);
 clock+=86400000;summaries.retain();assert.equal(s.db.prepare('SELECT count(*) n FROM messages').get().n,0);assert.equal(s.db.prepare('SELECT count(*) n FROM native_whatsapp_raw').get().n,0);assert.equal(s.db.prepare('SELECT count(*) n FROM misty_server_pending').get().n,0);assert.equal(s.db.prepare('SELECT count(*) n FROM misty_server_batches').get().n,1);assert.match(JSON.parse(s.db.prepare('SELECT payload FROM misty_server_batches').get().payload).summary,/meeting/);
});

test('edits during server inference cannot commit stale coverage or permit deletion',async t=>{
 const {s,now}=serverStore(t);applyNativeEvent(s,wa(now+1));const summaries=new MistyServerSummaries(s,{generate:async()=>{applyNativeEvent(s,wa(now+1,'one','Changed plan'));return response({channelSummary:'Stale',serverSummary:'Stale',newDevelopments:[],followups:[]});}},{clock:()=>now+4000000});
 await summaries.step();assert.equal(s.db.prepare('SELECT count(*) n FROM misty_channel_summaries').get().n,0);assert.equal(s.db.prepare('SELECT count(*) n FROM misty_server_pending').get().n,1);assert.equal(s.db.prepare('SELECT body FROM messages').get().body,'Changed plan');
});
