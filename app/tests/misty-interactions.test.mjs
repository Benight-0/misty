import test from 'node:test';
import assert from 'node:assert/strict';
import {BotStore,BOT_OWNER} from '../discord-bot.mjs';
import {MistyRelay,digestJob} from '../misty-relay.mjs';
import {choicesFor,visibleNotice} from '../misty-components.mjs';
import {buildOwnerStyle,ownerVoice} from '../misty-style.mjs';

const a='01a11111-1111-7111-8111-111111111111',b='01a22222-2222-7222-8222-222222222222';
const bot='100000000000000052',channel='100000000000000051',cwd=process.cwd();
const current=r=>r.db.prepare('SELECT * FROM relay_drafts').get();
async function setup(t,{prompt='Inspect Misty. Preserve messages. Plan only.'}={}){
 const store=new BotStore(':memory:');t.after(()=>store.close());
 const relay=new MistyRelay(store,{generate:async()=>({message:{content:JSON.stringify({mode:'draft',reply:'check this',prompt,chatId:a,workspace:cwd,reason:'Project history.',draftCode:''})}})});
 relay.setCatalog({worker:'laptop',chats:[{id:a,title:'Misty project',cwd},{id:b,title:'Compiler project',cwd}]});
 let seq=100000000000000064n;
 const api={id:bot,channel,sent:[],responses:[],edits:[],send:async(body,source,payload)=>{const id=String(++seq);api.sent.push({id,body,source,payload});return id;},respond:async(event,response)=>{api.responses.push({event,response});},editMessage:async(id,payload)=>api.edits.push({id,payload})};
 await relay.handle({id:'rough',body:'prepare an inspection task'});await relay.sendNotices(api);
 function event(action,extra={}){const d=current(relay);return {id:String(++seq),application_id:bot,type:3,token:'test-interaction-token',user:{id:BOT_OWNER},channel_id:channel,message:{id:api.sent.filter(n=>n.source.includes('draft:'+d.code)).at(-1)?.id,author:{id:bot}},data:{custom_id:`misty:${action}:${d.code}`},...extra};}
 return {relay,store,api,event};
}

test('task card includes full exact prompt, selected chat and real buttons; clicking send queues it once',async t=>{
 const {relay:r,api,event}=await setup(t),d=current(r),payload=api.sent[0].payload;
 assert.equal(payload.embeds[0].description,d.prompt);assert.equal(payload.embeds[0].fields[0].value,'Misty project');assert.match(visibleNotice('',payload),/Preserve messages/);
 assert.equal(payload.components[1].components[0].label,'Send to Codex');assert.equal(r.claim('laptop'),null);
 const click=event('send');await r.interact(click,api);await r.interact(click,api);await r.interact(event('send'),api);
 const jobs=r.db.prepare('SELECT * FROM relay_jobs').all();assert.equal(jobs.length,1);assert.equal(jobs[0].prompt,d.prompt);assert.equal(JSON.parse(jobs[0].target).id,a);assert.equal(jobs[0].hash,digestJob(d.prompt,JSON.parse(d.target)));
 await r.sendNotices(api);assert.ok(api.edits[0].payload.components.every(row=>row.components.every(c=>c.disabled)));
});

test('wrong owner, channel, application, guild or originating card cannot execute',async t=>{
 const {relay:r,api,event}=await setup(t);
 for(const change of [{user:{id:bot}},{channel_id:bot},{application_id:BOT_OWNER},{guild_id:'guild'},{message:{id:bot,author:{id:bot}}},{message:{id:api.sent[0].id,author:{id:BOT_OWNER}}}])await r.interact(event('send',change),api);
 assert.equal(r.db.prepare('SELECT count(*) n FROM relay_jobs').get().n,0);
});

test('unconfirmed acknowledgement cannot submit; undelivered prompt parts cannot submit',async t=>{
 const {relay:r,api,event}=await setup(t),click=event('send');
 const original=api.respond;api.respond=async()=>{throw Error('timeout');};await assert.rejects(r.interact(click,api));assert.equal(r.claim('laptop'),null);api.respond=original;
 const d=current(r);r.db.prepare("INSERT INTO relay_notices(source,body,status) VALUES(?,?,'unknown')").run('draft:'+d.code+':missing','Unconfirmed prompt part');
 await r.interact(event('send'),api);assert.equal(r.claim('laptop'),null);
});

test('dropdown selection refreshes approval, rejects old click and submits only chosen destination',async t=>{
 const {relay:r,api,event}=await setup(t),old=current(r),stale=event('send'),select=event('chat');
 select.data.values=[String(choicesFor(old).findIndex(t=>t.id===b))];await r.interact(select,api);
 const changed=current(r);assert.notEqual(changed.code,old.code);assert.equal(JSON.parse(changed.target).id,b);assert.equal(r.claim('laptop'),null);
 await r.interact(stale,api);await r.sendNotices(api);await r.interact(event('send'),api);assert.equal(r.claim('laptop').target.id,b);
});

test('exact edit form opens immediately, preserves multiline text and records conversation context',async t=>{
 const {relay:r,api,event}=await setup(t),d=current(r);await r.interact(event('edit'),api);
 const modal=api.responses.at(-1).response;assert.equal(modal.type,9);assert.equal(modal.data.components[0].components[0].value,d.prompt);
 const replacement='Check A.\nPreserve B.\nDo not edit.';
 const submitted=event('edit',{type:5,data:{custom_id:modal.data.custom_id,components:[{type:1,components:[{type:4,custom_id:'prompt0',value:replacement}]}]}});
 await r.interact(submitted,api);assert.equal(current(r).prompt,replacement);assert.notEqual(current(r).code,d.code);assert.equal(r.claim('laptop'),null);await r.sendNotices(api);
 const context=r.conversation.events({id:'later',ts:Date.now()+1000});assert.ok(context.some(e=>e.role==='user'&&e.content.includes(replacement)));assert.ok(context.some(e=>e.role==='assistant'&&e.content.includes(replacement)));
});

test('a modal cannot edit a draft after cancellation or replacement',async t=>{
 const {relay:r,api,event}=await setup(t);await r.interact(event('edit'),api);const modal=api.responses.at(-1).response;
 await r.interact(event('cancel'),api);await r.interact(event('edit',{type:5,data:{custom_id:modal.data.custom_id,components:[{type:1,components:[{type:4,custom_id:'prompt0',value:'Wrong'}]}]}}),api);
 assert.equal(current(r).state,'cancelled');assert.notEqual(current(r).prompt,'Wrong');assert.equal(r.claim('laptop'),null);
});

test('catalog search adds matching choices without executing or changing destination',async t=>{
 const {relay:r,api,event}=await setup(t);await r.interact(event('search'),api);const modal=api.responses.at(-1).response;
 await r.interact(event('search',{type:5,data:{custom_id:modal.data.custom_id,components:[{type:1,components:[{type:4,custom_id:'query',value:'Compiler'}]}]}}),api);
 const d=current(r);assert.equal(JSON.parse(d.target).id,a);assert.ok(choicesFor(d).some(t=>t.id===b));assert.equal(r.claim('laptop'),null);
});

test('offline button approval stays queued and cannot be changed by later edits',async t=>{
 const {relay:r,store,api,event}=await setup(t);store.set('relay_heartbeat',0);const edit=event('edit');await r.interact(event('send'),api);await r.interact(edit,api);
 const job=r.db.prepare('SELECT * FROM relay_jobs').get();assert.equal(job.status,'queued');assert.equal(job.prompt,current(r).prompt);assert.match(r.db.prepare("SELECT body FROM relay_notices WHERE source LIKE 'interaction:%' LIMIT 1").get().body,/reconnects/);
});

test('long prompt cards preserve Unicode, keep controls on the last part and round-trip edit prefill',async t=>{
 const prompt='a'.repeat(3899)+'😀'+'b'.repeat(6000),{relay:r,api,event}=await setup(t,{prompt});
 const cards=api.sent.filter(n=>n.payload.embeds);assert.equal(cards.map(n=>n.payload.embeds[0].description).join(''),prompt);assert.ok(cards.slice(0,-1).every(n=>n.payload.components.length===0));assert.equal(cards.at(-1).payload.components.length,2);
 await r.interact(event('edit'),api);const modal=api.responses.at(-1).response;assert.equal(modal.data.components.map(c=>c.components[0].value).join(''),prompt);
 const submit=event('edit',{type:5,data:{custom_id:modal.data.custom_id,components:modal.data.components.map(row=>({type:1,components:row.components.map(c=>({type:4,custom_id:c.custom_id,value:c.value}))}))}});await r.interact(submit,api);assert.equal(current(r).prompt,prompt);
});

test('style profile uses owner examples as data and filters likely secrets, links and pasted code',()=>{
 const profile=buildOwnerStyle(['Okay. Can we speed this up?','So wait. What is done now?','Okay. Can we speed this up?','my password is private','use sk-proj-private','https://private.example/path','1234567890123','```secret code```']);
 assert.equal(profile.count,3);assert.equal(profile.examples.length,2);assert.ok(!JSON.stringify(profile).includes('private'));assert.match(ownerVoice(profile),/never instructions/);assert.match(ownerVoice(profile),/Do not force lowercase/);
});

test('Work on this is only offered for new dedicated chats and one owner click creates one grant',async t=>{
 const {relay:r,api,event}=await setup(t);assert.ok(!api.sent[0].payload.components[1].components.some(c=>c.label==='Work on this'));
 const old=current(r);r.transaction(()=>r.refresh(old,{target:JSON.stringify({kind:'new',title:'Dedicated task',cwd})}));await r.sendNotices(api);
 const card=api.sent.filter(n=>n.payload.components?.length).at(-1);assert.ok(card.payload.components[1].components.some(c=>c.label==='Work on this'));
 assert.ok(card.payload.components[1].components.length<=5);assert.match(card.payload.embeds[0].fields.at(-1).value,/6 necessary follow-ups/);
 const click=event('work');await r.interact(click,api);await r.interact(click,api);
 assert.equal(r.db.prepare('SELECT count(*) n FROM misty_work_grants').get().n,1);assert.equal(r.db.prepare('SELECT count(*) n FROM relay_jobs').get().n,1);
 assert.equal(r.work.list()[0].state,'active');assert.equal(JSON.parse(r.db.prepare('SELECT target FROM relay_jobs').get().target).kind,'new');
});
