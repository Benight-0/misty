import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {ArchiveStore} from '../app/store.mjs';
import {Briefings} from '../app/briefings.mjs';
import {OpenAIAnalysis} from '../app/openai-analysis.mjs';

const model=process.argv[2]||'gpt-5.6-luna',now=Date.now(),room='!model-check:localhost';
const store=new ArchiveStore(':memory:');
store.ingest({kind:'room',id:room,state:{'m.room.name':{name:'Synthetic model check'},'m.bridge':{protocol:{id:'discordgo'},channel:{id:'synthetic'},'com.beeper.room_type':'dm'}}});
const messages=[['@owner:localhost','I enjoy competitive programming and prefer detailed written explanations.'],['@friend:localhost','I enjoy astronomy and prefer discussing ideas in the evening.'],['@owner:localhost','I am practicing graph algorithms this week.'],['@friend:localhost','I am reading about telescopes this week.']];
messages.forEach(([sender,body],i)=>store.ingestEvent({event_id:'$model-check-'+i,room_id:room,sender,type:'m.room.message',origin_server_ts:now-10000+i,content:{msgtype:'m.text',body}}));
let usage;
const client=new OpenAIAnalysis({keyFile:'/etc/archival/openai-key',onUsage:value=>{
  usage=value;const archive=new DatabaseSync('/var/lib/archival/data/archive.sqlite');
  try{archive.prepare('INSERT OR IGNORE INTO openai_usage VALUES(?,?,?,?,?,?,?,?)').run(value.requestId,'_synthetic_model_check_',value.model,value.inputTokens,value.outputTokens,value.cachedTokens,value.at,value.status);}finally{archive.close();}
}});
const briefings=new Briefings(store,{poll:false,model,analysisClient:client,clock:()=>now});
try{
  assert.equal(await briefings.runOne(),true);
  const result=briefings.room(room);assert.equal(result.job.status,'ready');assert.equal(result.payload.coverage.analyzed,4);
  assert.ok(result.payload.overview.length>0);assert.equal(result.payload.people.length,2);
  assert.ok(result.payload.people.every(person=>person.preferences.length>0));
  console.log(JSON.stringify({model,validGroundedOutput:true,profiledPeople:result.payload.people.length,modelDiagnostics:result.payload.modelDiagnostics,usage:usage?{input:usage.inputTokens,output:usage.outputTokens,cached:usage.cachedTokens,status:usage.status}:null}));
}finally{await briefings.close();store.close();}
