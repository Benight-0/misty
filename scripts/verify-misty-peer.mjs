// Read-only production inspection plus isolated replay. Never submits a Codex
// turn, fabricates an owner DM, or inserts replay messages into the live archive.
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import {ArchiveStore} from '../app/store.mjs';
import {nativeSchema} from '../app/native-ingest.mjs';
import {serverSummarySchema,MistyServerSummaries} from '../app/misty-server-summaries.mjs';
import {MistyKnowledge} from '/opt/misty-bot/app/misty-knowledge.mjs';
import {MISTY_CONTEXT} from '/opt/misty-bot/app/misty-persona.mjs';
import {OpenAIAnalysis} from '../app/openai-analysis.mjs';
import {ArchiveTools} from '../app/misty-archive.mjs';

const archive=new DatabaseSync('/var/lib/archival/data/archive.sqlite',{readOnly:true});
const bot=new DatabaseSync('/var/lib/misty-bot/chat.sqlite',{readOnly:true});
const usage=new DatabaseSync('/var/lib/misty-bot/chat.sqlite');usage.exec('PRAGMA busy_timeout=5000');
const client=new OpenAIAnalysis({keyFile:'/etc/archival/openai-key',onUsage:u=>usage.prepare('INSERT OR IGNORE INTO bot_usage(request_id,model,input_tokens,output_tokens,cached_tokens,at,status) VALUES(?,?,?,?,?,?,?)').run(u.requestId,u.model,u.inputTokens,u.outputTokens,u.cachedTokens,u.at,u.status)});
const started=Date.now();
try{
 if(process.argv.includes('--server')){
  const room=archive.prepare("SELECT p.room_id,p.name FROM whatsapp_group_policies p JOIN conversations c ON c.id=p.room_id WHERE p.treatment='S' AND c.message_count>=5 ORDER BY c.last_ts DESC LIMIT 1").get();if(!room)throw Error('No recorded S fixture available.');
  const rows=archive.prepare('SELECT * FROM messages WHERE room_id=? ORDER BY ts DESC LIMIT 50').all(room.room_id).reverse();
  const fixture=new ArchiveStore(':memory:');nativeSchema(fixture);serverSummarySchema(fixture.db);
  fixture.db.prepare("INSERT INTO conversations(id,name,platform,kind,remote_id,include_profile) VALUES(?,?,'whatsapp','group','user-18@example.com',0)").run(room.room_id,room.name);
  fixture.db.prepare('INSERT INTO misty_server_channels VALUES(?,?,?,?,?,1)').run(room.room_id,'fixture-server',room.name,room.name,rows[0].ts);
  for(const m of rows){fixture.db.prepare("INSERT OR IGNORE INTO identities(id,platform,name) VALUES(?,'whatsapp','Participant')").run(m.sender);fixture.db.prepare('INSERT INTO messages(id,room_id,sender,ts,body,original_body,is_me) VALUES(?,?,?,?,?,?,?)').run(m.id,room.room_id,m.sender,m.ts,m.body,m.body,m.is_me);}
  const summaries=new MistyServerSummaries(fixture,client);await summaries.step({force:true});
  const saved=fixture.db.prepare('SELECT * FROM misty_channel_summaries').get();if(!saved)throw Error('Replay summary was not committed.');const p=JSON.parse(saved.payload);
  console.log(JSON.stringify({isolatedServerReplay:true,model:saved.model,messages:saved.messages,summaryCharacters:p.summary.length,developments:p.developments.length,serverSummary:!!fixture.db.prepare('SELECT 1 FROM misty_server_summaries').get(),ms:Date.now()-started}));fixture.close();
 }else{
  const knowledge=Object.create(MistyKnowledge.prototype);knowledge.db=bot;
  const tools=knowledge.definitions().filter(t=>['knowledge_find','knowledge_read'].includes(t.name)),calls=[];
  const result=await client.generate({model:'gpt-6.1-sol',reasoningEffort:'high',room:'misty-peer-read-verification',schema:{type:'object',properties:{reply:{type:'string'},codeDocument:{type:'string'},transcriptDocument:{type:'string'}}},outputBudget:6000,signal:AbortSignal.timeout(150000),tools,executeTool:(name,args)=>{calls.push({name,...args});return knowledge.execute(name,args);},messages:[{role:'system',content:MISTY_CONTEXT+'\nThis is a read-only verification. Available tools are only knowledge_find and knowledge_read. Do not propose or execute a task or publish messages.'},{role:'user',content:'Check the actual Misty relay code for how exact Codex answers can be retrieved, then find the primary Misty / misty Codex transcript (legacy title Estimate Beeper backend effort) and read at least one page of its real messages. Explain the current result-delivery design in one short natural paragraph. Report the actual code document ID and transcript document ID used. Do not claim to have read an entire transcript from a single page.'}]});
  const p=JSON.parse(result.message.content),code=bot.prepare("SELECT * FROM misty_documents WHERE id=? AND kind='code'").get(p.codeDocument),chat=bot.prepare("SELECT * FROM misty_documents WHERE id=? AND kind='codex'").get(p.transcriptDocument);
  if(!code||!chat||!calls.some(c=>c.name==='knowledge_read'&&c.document===code.id)||!calls.some(c=>c.name==='knowledge_read'&&c.document===chat.id))throw Error('Source reads not verified.');
  console.log(JSON.stringify({model:'gpt-6.1-sol',realCodeRead:true,realTranscriptRead:true,tools:calls.length,reply:p.reply,ms:Date.now()-started}));
 }
 const api=new ArchiveTools({tokenFile:'/etc/archival/misty-archive-token'});const servers=await api.read('servers',{query:''});console.log(JSON.stringify({serverToolsRead:true,channels:servers.rows.length,truncated:servers.truncated}));
}finally{archive.close();bot.close();usage.close();}
