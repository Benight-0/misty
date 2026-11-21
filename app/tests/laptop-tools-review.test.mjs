import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {BotStore} from '../discord-bot.mjs';
import {LaptopToolsBroker} from '../laptop-tools-broker.mjs';
import {LaptopToolsReview} from '../laptop-tools-review.mjs';

const ownerId='100000000000000021',ownerChannel='100000000000000019',ownerMessage='100000000000000022';
function fixture(t,{decision=true,modelFails=false}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'misty-review-')),filename=path.join(dir,'laptop.sqlite');
 const store=new BotStore(path.join(dir,'chat.sqlite'),{owners:[ownerId]});
 store.db.prepare("INSERT INTO bot_turns(id,channel,body,ts,status) VALUES(?,?,?,?,'external')").run(ownerMessage,ownerChannel,'Read the requested fixture',Date.now());
 const db=new DatabaseSync(filename),broker=new LaptopToolsBroker(db,{pairedWorker:()=> 'paired',ownerAllowed:id=>id===ownerMessage,reviewRequired:true});
 broker.worker('heartbeat',{worker:'paired',roots:['C:\\fixture'],fullAccess:true});
 const taskId=broker.call('start',{ownerMessageId:ownerMessage,source:'owner',workspace:'C:\\fixture',objective:'Read the requested fixture'}).taskId;
 const sent=[];let nextMessage=BigInt(ownerMessage)+1n;
 const api={ownerChannels:new Map([[ownerId,ownerChannel]]),forChannel(channel){assert.equal(channel,ownerChannel);return {async send(body){sent.push(body);return String(nextMessage++);}};}};
 const client={async generate(){if(modelFails)throw Error('model unavailable');return {message:{content:JSON.stringify({approve:decision,reason:'synthetic review'})}};}};
 const review=new LaptopToolsReview({filename,bot:store,client,api});
 t.after(()=>{review.close();db.close();store.close();fs.rmSync(dir,{recursive:true,force:true});});
 function submit(){return broker.call('submit',{ownerMessageId:ownerMessage,source:'owner',taskId,tool:'read_files',arguments:{files:[{path:'fixture.txt'}]},operationId:randomUUID()});}
 function reply(body,{channel=ownerChannel,id='100000000000000025'}={}){store.db.prepare("INSERT INTO bot_turns(id,channel,body,ts,status) VALUES(?,?,?,?,'external')").run(id,channel,body,Date.now()+1000);}
 return {db,store,broker,review,sent,submit,reply};
}

test('review gate holds a laptop operation until the model approves',async t=>{
 const x=fixture(t),op=x.submit();assert.equal(op.state,'review_pending');assert.equal(x.broker.worker('claim',{worker:'paired'}),null);
 await x.review.tick();assert.equal(x.broker.call('result',{id:op.id}).state,'queued');
 assert.equal(x.broker.worker('claim',{worker:'paired'}).id,op.id);
});

test('denial requires the exact owner reply after a confirmed preview',async t=>{
 const x=fixture(t,{decision:false}),op=x.submit();await x.review.tick();
 assert.equal(x.broker.call('result',{id:op.id}).state,'awaiting_owner');assert.equal(x.broker.worker('claim',{worker:'paired'}),null);
 const code=x.db.prepare('SELECT code FROM work_reviews WHERE id=?').get(op.id).code;
 assert.ok(x.sent.some(body=>body.includes('Exact arguments:')&&body.includes('fixture.txt')));
 x.reply('approve laptop '+code,{channel:'100000000000000020'});x.review.ownerDecisions();assert.equal(x.broker.worker('claim',{worker:'paired'}),null);
 x.reply('approve laptop '+code,{id:'100000000000000026'});x.review.ownerDecisions();assert.equal(x.broker.worker('claim',{worker:'paired'}).id,op.id);
 assert.equal(x.db.prepare('SELECT approved_by FROM work_reviews WHERE id=?').get(op.id).approved_by,'100000000000000026');
});

test('review model failure and ambiguous preview delivery fail closed',async t=>{
 const x=fixture(t,{modelFails:true}),op=x.submit();
 x.review.api.forChannel=()=>({send:async()=>{throw Error('unconfirmed send');}});
 await x.review.tick();assert.equal(x.broker.call('result',{id:op.id}).state,'awaiting_owner');
 assert.equal(x.db.prepare('SELECT preview_state FROM work_reviews WHERE id=?').get(op.id).preview_state,'unknown');
 assert.equal(x.broker.worker('claim',{worker:'paired'}),null);
});

test('whole-laptop worker can claim owner work without per-operation review',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 const broker=new LaptopToolsBroker(db,{pairedWorker:()=> 'paired',ownerAllowed:()=>true});
 broker.worker('heartbeat',{worker:'paired',roots:['C:\\'],fullAccess:true});
 const taskId=broker.call('start',{ownerMessageId:ownerMessage,source:'owner',workspace:'C:\\fixture',objective:'Read fixture'}).taskId;
 const operation=broker.call('submit',{ownerMessageId:ownerMessage,source:'owner',taskId,
   tool:'read_files',arguments:{files:[{path:'fixture.txt'}]}});
 assert.equal(operation.state,'queued');
 assert.equal(broker.worker('claim',{worker:'paired'}).id,operation.id);
});

test('pause cancels operations still waiting for either review or owner approval',async t=>{
 const x=fixture(t,{decision:false}),first=x.submit();
 x.broker.call('control',{ownerMessageId:ownerMessage,source:'owner',action:'pause'});
 await x.review.tick();assert.equal(x.broker.call('result',{id:first.id}).state,'cancelled');
 x.broker.call('control',{ownerMessageId:ownerMessage,source:'owner',action:'resume'});
 const second=x.submit();await x.review.tick();assert.equal(x.broker.call('result',{id:second.id}).state,'awaiting_owner');
 x.broker.call('control',{ownerMessageId:ownerMessage,source:'owner',action:'pause'});
 assert.equal(x.broker.call('result',{id:second.id}).state,'cancelled');assert.equal(x.broker.worker('claim',{worker:'paired'}),null);
});
