import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {BOT_OWNER,BotAPI,BotStore,BotReplies} from '../app/discord-bot.mjs';
import {OpenAIAnalysis} from '../app/openai-analysis.mjs';
import {MistyRelay,serveRelay} from '../app/misty-relay.mjs';
import {ArchiveTools} from '../app/misty-archive.mjs';
import {MistyNotifications} from '../app/misty-notifications.mjs';
import {MistyPresence,MistySelf} from '../app/misty-self.mjs';
import {serveProminenceBridge} from '../app/misty-prominence-bridge.mjs';
import {MistyMessages} from '../app/misty-messages.mjs';
import {MessageBackend} from '../app/message-backend.mjs';
import {LaptopToolsReview} from '../app/laptop-tools-review.mjs';

const dir=process.env.MISTY_BOT_DATA||'/var/lib/misty-bot';fs.mkdirSync(dir,{recursive:true,mode:0o700});
const credentials=process.env.CREDENTIALS_DIRECTORY||'/etc/misty-bot';
const tokenFile=process.env.MISTY_BOT_TOKEN_FILE||credentials+'/discord-token';
const ownerFile=process.env.MISTY_OWNER_ACCOUNTS_FILE||credentials+'/owner-accounts.json';
const owners=fs.existsSync(ownerFile)?JSON.parse(fs.readFileSync(ownerFile,'utf8')):[BOT_OWNER];
if(!Array.isArray(owners)||!owners.includes(BOT_OWNER)||owners.length>5||new Set(owners).size!==owners.length)throw Error('Invalid verified owner account configuration.');
const store=new BotStore(dir+'/chat.sqlite',{owners});
const activated=store.get('owner_activation',{}),previousOwners=store.get('verified_owner_accounts',[BOT_OWNER]);
for(const owner of owners)if(owner!==BOT_OWNER&&(!previousOwners.includes(owner)||!activated[owner]))activated[owner]=Date.now();
store.set('owner_activation',activated);store.set('verified_owner_accounts',owners);
const api=new BotAPI({tokenFile});
const client=new OpenAIAnalysis({keyFile:process.env.MISTY_BOT_OPENAI_KEY_FILE||credentials+'/openai-key',onUsage:u=>store.usage(u)});
const laptopReview=process.env.MISTY_LAPTOP_REVIEW==='on'?new LaptopToolsReview({filename:dir+'/laptop-tools.sqlite',bot:store,client,api}):null;
const bridgeOnly=process.env.MISTY_BRIDGE_ONLY==='1';
let child,connected=false,ready=false,syncJob=null,stopping=false;
const interactionJobs=new Set();
const writeStatus=(state)=>fs.writeFileSync(dir+'/status.json',JSON.stringify({state,connected,at:Date.now(),bot:store.get('bot'),presence:store.get('misty_presence_receipt'),counts:store.db.prepare('SELECT status,count(*) AS count FROM bot_turns GROUP BY status').all()}),{mode:0o600});
const archiveToken=process.env.MISTY_ARCHIVE_TOKEN_FILE||credentials+'/archive-token';
const archive=fs.existsSync(archiveToken)?new ArchiveTools({tokenFile:archiveToken}):null;
const workflow=new MistyRelay(store,client,{model:process.env.MISTY_BOT_MODEL||'gpt-6.1-sol',reasoningEffort:process.env.MISTY_BOT_REASONING||'high',onNotice:()=>drain(),archive,compactCards:true,naturalResults:true,rephrase:process.env.MISTY_REPHRASER_ENABLED!=='off',rephraserModel:process.env.MISTY_REPHRASER_MODEL||'gpt-5.6-luna'});
const messageToken=credentials+'/message-token';
if(fs.existsSync(messageToken))workflow.messages=new MistyMessages(workflow,new MessageBackend({tokenFile:messageToken}));
const notifications=archive&&process.env.MISTY_CHAT_NOTIFICATIONS!=='off'?new MistyNotifications(workflow,archive,{model:process.env.MISTY_DECISION_MODEL||'gpt-5.6-luna'}):null;
workflow.notifications=notifications;
workflow.messageApi=api;
const presence=new MistyPresence(store,{write:value=>{if(!child||child.stdin.destroyed)throw Error('Gateway unavailable.');child.stdin.write(JSON.stringify(value)+'\n');},isConnected:()=>connected&&!stopping});
workflow.self=new MistySelf(workflow,api,presence);
let associateJob=null;
const associateTimer=setInterval(()=>{
 if(stopping||associateJob||store.db.prepare("SELECT 1 FROM bot_turns WHERE status IN ('queued','generating') LIMIT 1").get())return;
 associateJob=(async()=>{await workflow.dialogue.tick();await workflow.work.tick();await workflow.summarizeResult();drain();})().catch(()=>{}).finally(()=>{associateJob=null;});
},1000);associateTimer.unref();
const watchTimer=setInterval(()=>{if(!stopping)notifications?.pump().catch(()=>{});},1000);watchTimer.unref();
const laptopReviewTimer=setInterval(()=>{if(ready&&!stopping)laptopReview?.tick().catch(()=>{});},1000);laptopReviewTimer.unref();
const server=serveRelay(workflow,{dir,port:Number(process.env.MISTY_RELAY_PORT||8790)});
const forkToken=credentials+'/prominence-token';
const forkServer=fs.existsSync(forkToken)?serveProminenceBridge(workflow,{tokenFile:forkToken}):null;
const apolloReaderToken=credentials+'/apollo-reader-token';
const readerServer=fs.existsSync(apolloReaderToken)?serveProminenceBridge(workflow,{tokenFile:apolloReaderToken,port:8794,readOnly:true}):null;
readerServer?.on('error',()=>stop(1));
forkServer?.on('error',()=>stop(1));
server.on('error',()=>{writeStatus('relay_error');stop(1);});
const replies=new BotReplies(store,api,client,{model:workflow.model,workflow,onState:()=>writeStatus(connected?'online':'reconnecting')});
function drain(){if(ready&&!stopping)(bridgeOnly?Promise.resolve():replies.drain()).then(()=>workflow.messages?.refresh()).then(()=>workflow.sendNotices(api)).catch(()=>{writeStatus('processing_error');stop(1);});}
const noticeTimer=setInterval(drain,2000);noticeTimer.unref();
function received(message){const channel=api.ownerChannels.get(message.author?.id);if(!channel||!api.owns(message.author?.id,message.channel_id))return;const accepted=store.accept(message,channel);if(bridgeOnly)store.db.prepare("UPDATE bot_turns SET status='external' WHERE id=? AND status='queued'").run(message.id||'');if(accepted&&bridgeOnly)workflow.messages?.observe(message.id).catch(()=>{});if(ready){if(/^\d{16,22}$/.test(message.id||'')){const key=channel===api.channel?'cursor':'cursor:'+channel,previous=store.get(key,'');if(!previous||BigInt(message.id)>BigInt(previous))store.set(key,message.id);}drain();}}
function catchUp(){
 if(syncJob||stopping)return;ready=false;
 syncJob=(async()=>{
  for(const channel of api.ownerChannels.values()){
   const bound=api.forChannel(channel),key=channel===api.channel?'cursor':'cursor:'+channel;
   await bound.history({cursor:store.get(key,''),since:store.get('started_at'),onMessage:m=>{if(api.owns(m.author?.id,m.channel_id))store.accept(m,channel);}});
   const latest=store.db.prepare('SELECT id FROM bot_turns WHERE channel=? ORDER BY ts DESC,id DESC LIMIT 1').get(channel)?.id;if(latest)store.set(key,latest);
  }
  if(bridgeOnly)store.db.prepare("UPDATE bot_turns SET status='external' WHERE status='queued'").run();
  ready=connected;writeStatus(ready?'online':'reconnecting');drain();
 })().catch(()=>{writeStatus('history_retry');setTimeout(catchUp,15000).unref();}).finally(()=>{syncJob=null;});
}
async function stop(code=0){
 if(stopping)return;stopping=true;ready=false;connected=false;clearInterval(noticeTimer);clearInterval(associateTimer);clearInterval(watchTimer);clearInterval(laptopReviewTimer);server.close();forkServer?.close();readerServer?.close();writeStatus('stopping');presence.close();child?.stdin.end();child?.kill('SIGTERM');
 const force=setTimeout(()=>{child?.kill('SIGKILL');process.exit(code||1);},100000);force.unref();
 await syncJob;await replies.close();await Promise.allSettled([...interactionJobs]);await Promise.all([workflow.work.close(),notifications?.close(),laptopReview?.running]);await associateJob;await workflow.sending;laptopReview?.close();writeStatus('stopped');store.close();clearTimeout(force);process.exit(code);
}
process.on('SIGTERM',()=>stop());process.on('SIGINT',()=>stop());
try{
 const identity=await api.connect(BOT_OWNER);for(const id of owners)if(id!==BOT_OWNER)await api.addOwner(id);store.set('bot',identity);store.set('owner_channels',Object.fromEntries(api.ownerChannels));writeStatus('connecting');
 child=spawn(process.env.MISTY_BOT_GATEWAY||'/opt/misty-bot/bin/gateway',[],{stdio:['pipe','pipe','pipe'],env:{...process.env,GOMEMLIMIT:'40MiB',GOMAXPROCS:'1'}});
 child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
 child.stdin.write(JSON.stringify({token_file:tokenFile,owner:BOT_OWNER,channel:api.channel,owner_channels:Object.fromEntries(api.ownerChannels),presence:presence.current()})+'\n');
 const lines=createInterface({input:child.stdout});
 lines.on('line',line=>{
  try{
   if(stopping)return;
   if(Buffer.byteLength(line)>131072)throw new Error('Event too large.');const event=JSON.parse(line);
   if(event.kind==='ready'){connected=true;catchUp();}
   else if(event.kind==='presence')presence.receive(event);
   else if(event.kind==='presence_restored'){store.set('misty_presence_receipt',{state:event.ok?'gateway_sent':'unconfirmed',at:Date.now(),value:presence.current()});writeStatus(connected?'online':'connecting');}
   else if(event.kind==='disconnected'){connected=false;ready=false;writeStatus('reconnecting');}
   else if(event.kind==='message')received(event.message);
   else if(event.kind==='interaction'){
    const job=workflow.interact(event.interaction,api.forChannel(event.interaction.channel_id)).then(()=>drain()).catch(()=>{if(!stopping)writeStatus('interaction_retry');}).finally(()=>interactionJobs.delete(job));
    interactionJobs.add(job);
   }
  }catch{writeStatus('storage_error');stop(1);}
 });
 child.once('error',()=>{writeStatus('gateway_error');stop(1);});
 child.once('close',()=>{lines.close();if(!stopping){writeStatus('gateway_closed');stop(1);}});
}catch{writeStatus('connection_failed');await stop(1);}
