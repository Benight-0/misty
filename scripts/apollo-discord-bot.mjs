import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {BOT_OWNER,BotAPI,BotStore} from '../app/discord-bot.mjs';
import {ApolloAnalysis} from '../app/apollo-client.mjs';
import {ArchiveTools} from '../app/misty-archive.mjs';
import {MistyNotifications} from '../app/misty-notifications.mjs';
import {ApolloMessenger,apolloRuntime} from '../app/apollo.mjs';
import {CodexReader,pumpCodexNotices} from '../app/codex-reader.mjs';

const dir=process.env.APOLLO_DATA||'/var/lib/apollo-bot';fs.mkdirSync(dir,{recursive:true,mode:0o700});
const credentials=process.env.CREDENTIALS_DIRECTORY||'/etc/apollo-bot';
const tokenFile=credentials+'/discord-token',store=new BotStore(dir+'/chat.sqlite'),api=new BotAPI({tokenFile});
const client=new ApolloAnalysis({keyFile:credentials+'/openai-key',onUsage:u=>store.usage(u)});
const archive=new ArchiveTools({tokenFile:credentials+'/archive-token'});
let child,connected=false,ready=false,stopping=false,syncJob=null,lastWatchError=0;
const codex=fs.existsSync(credentials+'/codex-token')?new CodexReader({tokenFile:credentials+'/codex-token'}):null;
const runtime=apolloRuntime(process.env);
const workflow=new ApolloMessenger(store,client,archive,{model:runtime.chatModel,reasoningEffort:runtime.chatEffort,onNotice:()=>drain(),codex});
let codexJob=null;
const codexTimer=setInterval(()=>{if(!stopping&&codex&&!codexJob)codexJob=pumpCodexNotices(workflow,codex).catch(()=>{}).finally(()=>{codexJob=null;});},3000);codexTimer.unref();
const notifications=new MistyNotifications(workflow,archive,{name:'Apollo',model:runtime.decisionModel,reasoningEffort:runtime.decisionEffort,serverMaxWaitMs:15*60*1000});workflow.notifications=notifications;
const status=state=>fs.writeFileSync(dir+'/status.json',JSON.stringify({state,connected,at:Date.now(),bot:store.get('bot'),runtime,delivery:workflow.deliveryStatus(),inbox:workflow.inbox.status(),lastWatchError,lastPoll:store.get('misty_watch_last_poll',0),notificationJobs:notifications.status(),turns:store.db.prepare('SELECT status,count(*) count FROM bot_turns GROUP BY status').all()}),{mode:0o600});
function drain(){
 if(!ready||stopping)return;
 workflow.pumpReplies().catch(()=>{status('reply_error');stop(1);});
 workflow.sendNotices(api).catch(()=>{status('delivery_error');stop(1);});
}
function accept(message){
 if(!store.accept(message,api.channel))return;
 const old=store.get('cursor','');if(!old||BigInt(message.id)>BigInt(old))store.set('cursor',message.id);drain();
}
function catchUp(){
 if(syncJob||stopping)return;ready=false;
 syncJob=(async()=>{
  await api.history({cursor:store.get('cursor',''),since:store.get('started_at'),onMessage:m=>accept(m)});
  ready=connected;status(ready?'online':'reconnecting');drain();
 })().catch(()=>{status('history_retry');setTimeout(catchUp,15000).unref();}).finally(()=>{syncJob=null;});
}
const tick=setInterval(()=>{
 if(stopping)return;
 // The watcher reads the shared journal independently of owner answer generation.
 notifications.pump().catch(()=>{lastWatchError=Date.now();});drain();
},1000);tick.unref();
const heartbeat=setInterval(()=>{if(!stopping)status(ready?'online':'reconnecting');},15000);heartbeat.unref();
async function stop(code=0){
 if(stopping)return;stopping=true;ready=false;clearInterval(tick);clearInterval(heartbeat);clearInterval(codexTimer);status('stopping');
 child?.stdin.end();child?.kill('SIGTERM');
 const force=setTimeout(()=>process.exit(code||1),170000);force.unref();
 await syncJob;await codexJob;await notifications.close();await workflow.close();status('stopped');store.close();clearTimeout(force);process.exit(code);
}
process.on('SIGTERM',()=>stop());process.on('SIGINT',()=>stop());
try{
 const identity=await api.connect(BOT_OWNER);
 if(identity.id==='100000000000000045'||identity.channel===store.get('misty_channel'))throw Error('Apollo needs a separate bot identity.');
 const expected=store.get('expected_bot');if(expected&&(expected.id!==identity.id||expected.channel!==identity.channel))throw Error('Unexpected Apollo identity.');
 store.set('bot',identity);status('connecting');
 child=spawn(process.env.APOLLO_GATEWAY||'/opt/misty-bot/bin/gateway',[],{stdio:['pipe','pipe','pipe'],env:{...process.env,GOMEMLIMIT:'40MiB',GOMAXPROCS:'1'}});
 child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
 child.stdin.write(JSON.stringify({token_file:tokenFile,owner:BOT_OWNER,channel:api.channel,presence:{status:'online',activity:'none',text:''}})+'\n');
 const lines=createInterface({input:child.stdout});
 lines.on('line',line=>{try{
  if(stopping)return;if(Buffer.byteLength(line)>131072)throw Error('Event too large.');const event=JSON.parse(line);
  if(event.kind==='ready'){connected=true;catchUp();}
  else if(event.kind==='disconnected'){connected=false;ready=false;status('reconnecting');}
  else if(event.kind==='message')accept(event.message);
 }catch{status('storage_error');stop(1);}});
 child.once('error',()=>{status('gateway_error');stop(1);});
 child.once('close',()=>{lines.close();if(!stopping){status('gateway_closed');stop(1);}});
}catch{status('connection_failed');await stop(1);}
