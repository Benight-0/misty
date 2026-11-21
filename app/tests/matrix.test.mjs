import test from 'node:test';
import assert from 'node:assert/strict';
import {MatrixController} from '../matrix.mjs';

test('management commands can ignore unrelated or stale bot acknowledgements',async()=>{
  const matrix=new MatrixController({get:()=>'!management:localhost'});
  matrix.login=async()=>{};
  const endpoints=[];
  let sync=0;
  matrix.request=async(endpoint,options)=>{
    endpoints.push(endpoint);
    if(options?.method==='PUT')return {event_id:'$submitted'};
    sync++;
    const content={body:'DM reconciliation finished for target; delivery verified'};
    const events=sync===1?[]:sync===2?[{sender:'@discordbot:localhost',type:'m.room.message',content}]:[{event_id:'$submitted',sender:'@owner:localhost',type:'m.room.message',content:{body:'repair-dm target after'}},{sender:'@discordbot:localhost',type:'m.room.message',content}];
    return {next_batch:'s'+sync,rooms:{join:{'!management:localhost':{timeline:{events}}}}};
  };
  const result=await matrix.command('discord','repair-dm target after',{acceptReply:c=>c.body.startsWith('DM reconciliation finished for target;')});
  assert.match(result.body,/for target;/);
  assert.equal(sync,3);
  assert.ok(endpoints.at(-1).includes('since=s2'));
});
