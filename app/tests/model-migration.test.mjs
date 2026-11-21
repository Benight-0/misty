import test from 'node:test';
import assert from 'node:assert/strict';
import {ArchiveStore} from '../store.mjs';
import {loadHistoryPlan,nextHistoryStep,saveHistoryNode} from '../briefing-history.mjs';
import {validateBriefing} from '../briefing-store.mjs';
import {reuseAnalysisCheckpoints} from '../../scripts/migrate-analysis-model.mjs';

test('model switch reuses unchanged maps and synthesis with original provenance, without overwriting old nodes',t=>{
  const store=new ArchiveStore(':memory:');t.after(()=>store.close());const room='!migrate:localhost',now=Date.now();
  store.ingest({kind:'room',id:room,state:{'m.room.name':{name:'Migration test'},'m.bridge':{protocol:{id:'discordgo'},channel:{id:'123'},'com.beeper.room_type':'dm'}}});
  for(let i=0;i<2400;i++)store.ingestEvent({event_id:'$'+i,room_id:room,sender:'@owner:localhost',type:'m.room.message',origin_server_ts:now-10000+i,content:{msgtype:'m.text',body:'I enjoy coding '+i}});
  for(let i=0;i<40;i++){
    const plan=loadHistoryPlan(store,room,'old-model',now),step=nextHistoryStep(store,plan);if(!step.node)break;
    const input=step.snapshot.input,source=input.messages?.[0]?.ref||input.notes[0].overview[0].sources[0];
    const payload=validateBriefing({overview:[{text:'Enjoys coding.',sources:[source]}],recent:[],followups:[],people:[],events:[]},step.snapshot);
    payload.modelDiagnostics={model:'old-model'};saveHistoryNode(store,room,step.node,payload,now);
  }
  const old=store.statement('SELECT hash,payload FROM briefing_history_nodes ORDER BY hash').all();assert.ok(old.length>=4);
  assert.equal(reuseAnalysisCheckpoints(store,room,'old-model','new-model',now),old.length);
  assert.ok(nextHistoryStep(store,loadHistoryPlan(store,room,'new-model',now)).payload.coverage.complete);
  assert.equal(reuseAnalysisCheckpoints(store,room,'old-model','new-model',now),0);
  for(const row of old)assert.equal(store.statement('SELECT payload FROM briefing_history_nodes WHERE hash=?').get(row.hash).payload,row.payload);
  const reused=store.statement("SELECT payload FROM briefing_history_nodes WHERE json_extract(payload,'$.checkpointReuse.targetModel')='new-model' LIMIT 1").get();
  assert.equal(JSON.parse(reused.payload).modelDiagnostics.model,'old-model');
  store.statement('UPDATE messages SET body=? WHERE id=?').run('I now prefer hiking.','$0');
  reuseAnalysisCheckpoints(store,room,'old-model','edited-model',now);
  const edited=nextHistoryStep(store,loadHistoryPlan(store,room,'edited-model',now));assert.equal(edited.node.stage,'map');assert.equal(edited.node.ordinal,0);assert.equal(edited.progress.completed_batches,13);
});
