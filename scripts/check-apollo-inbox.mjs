// Real model + real Apollo call paths, isolated fictional archive/in-memory DB.
// No BotAPI instance, real owner turn, Discord request, or production data write.
import fs from 'node:fs';
import {BotStore} from '../app/discord-bot.mjs';
import {ApolloMessenger,apolloRuntime} from '../app/apollo.mjs';
import {MistyNotifications} from '../app/misty-notifications.mjs';
import {ApolloAnalysis} from '../app/apollo-client.mjs';

const runtime=apolloRuntime(process.env),store=new BotStore(':memory:'),requests=[],usage=[],calls=[];
const now=Date.now(),source='isolated-essay-source',room='isolated-essay-room';
const archive={definitions:()=>[],read:async(op,args={})=>{
 calls.push(op);
 if(op==='events')return {rows:[]};
 if(op==='profile')return {rows:[{id:'fixture-interest',title:'College essays',category:'Interests',summary:'The owner explicitly wants to discuss college essay writing and peer review.',source:'user',status:'confirmed'}]};
 if(op==='watch_context')return {eligible:true,valid:true,chat:{name:'Synthetic essay group',platform:'discord',kind:'group',treatment:'G'},coverage:{included:1},summary:null,recent:{rows:[]},
  newMessages:[{id:source,ts:now,body:'Sam asks you directly: could you review my college essay draft before Sunday? I need your feedback on the opening.',is_me:0}],hashes:{[source]:'fixture-body-hash'},sources:[{id:source,url:'https://discord.com/channels/@me/100000000000000005/100000000000000052'}]};
 if(op==='source')return {available:true,id:source,room_id:room,ts:now,body:'Sam asks you directly: could you review my college essay draft before Sunday? I need your feedback on the opening.',bodyHash:'fixture-body-hash',url:'https://discord.com/channels/@me/100000000000000005/100000000000000052'};
 throw Error('Unexpected fixture archive operation');
}};
const client=new ApolloAnalysis({keyFile:(process.env.CREDENTIALS_DIRECTORY||'/etc/archival')+'/openai-key',onUsage:u=>usage.push(u),fetchImpl:async(url,args)=>{
 const body=JSON.parse(args.body),response=await fetch(url,args);let actualModel='',phases=[];if(response.ok){const raw=await response.clone().json();actualModel=raw.model||'';phases=(raw.output||[]).filter(o=>o.type==='message').map(o=>o.phase||'unspecified');}
 requests.push({model:body.model,actualModel,effort:body.reasoning.effort,toolDefinitions:body.tools?.length||0,phases,status:response.status});return response;
}});
let a=new ApolloMessenger(store,client,archive,{model:runtime.chatModel,reasoningEffort:runtime.chatEffort});
const watch=new MistyNotifications(a,archive,{name:'Apollo',model:runtime.decisionModel,reasoningEffort:runtime.decisionEffort,serverMaxWaitMs:900000});a.notifications=watch;
try{
 watch.ingest([{seq:1,platform:'discord',kind:'group',treatment:'G',room_id:room,message_id:source,name:'Synthetic essay group',ts:now,is_me:0}]);await watch.tick();
 const saved=store.db.prepare('SELECT count(*) n FROM apollo_findings').get().n;
 if(saved!==1)throw Error('Clear relevant fixture was not saved; inspect the isolated decision.');
 let backgroundSends=0;await a.sendNotices({send:async()=>{backgroundSends++;throw Error('No background sends permitted');}});if(backgroundSends)throw Error('Background notice attempted');
 const add=(id,body)=>store.db.prepare('INSERT INTO bot_turns(id,channel,body,ts) VALUES(?,?,?,?)').run(id,'isolated-owner-dm',body,Date.now());
 add('100000000000000052','what relevant discussions were there today? Isolated read-only test: use apollo_inbox, include the saved discussion and its exact source ID. Do not call progress or change controls.');
 await a.pumpReplies();let ownerSinkCalls=0;const sink={send:async()=>String(100000000000000064n+BigInt(ownerSinkCalls++))};await a.sendNotices(sink);
 const first=store.db.prepare("SELECT * FROM bot_turns WHERE id='100000000000000052'").get();if(first.status!=='sent'||!a.inbox.lastContext()?.ids.length||!first.reply.includes('[source]'))throw Error('Recap did not use inbox and verified fixture source.');
 await a.close();a=new ApolloMessenger(store,client,archive,{model:runtime.chatModel,reasoningEffort:runtime.chatEffort});
 add('100000000000000053','send the source and its context. This is still the isolated fixture, not permission to send progress or change controls.');
 await a.pumpReplies();await a.sendNotices(sink);const second=store.db.prepare("SELECT * FROM bot_turns WHERE id='100000000000000053'").get();
 if(second.status!=='sent'||!second.reply.includes('[source]'))throw Error('Source follow-up failed');
 if(!requests.every(r=>r.model==='gpt-6-luna'&&r.actualModel.startsWith('gpt-6-luna')&&r.effort===runtime.chatEffort&&r.status===200))throw Error('Unexpected model/effort/status');
 const report={ok:true,runtime,requests,backgroundFindings:saved,backgroundSends,ownerRepliesVerified:2,verifiedFixtureSources:true,persistedRetrievalContext:true,archiveToolReads:calls,
  usageRequests:usage.length,inputTokens:usage.reduce((s,u)=>s+u.inputTokens,0),outputTokens:usage.reduce((s,u)=>s+u.outputTokens,0),realDiscordSends:0,productionDataWrites:0};
 console.log(JSON.stringify(report));if(process.env.APOLLO_CHECK_REPORT)fs.writeFileSync(process.env.APOLLO_CHECK_REPORT,JSON.stringify(report,null,2));
}finally{await watch.close();await a.close();store.close();}
