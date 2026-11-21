import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {RPCProcess,initializeCodex,listCodexChats,CodexJobs} from '../app/codex-relay-client.mjs';
import {LiveSessions,resolveCodexBinary} from '../app/codex-live-session.mjs';
import {MistyKnowledgeSync} from '../app/misty-knowledge-sync.mjs';
import {CodexEventSync,resolveRolloutPaths} from '../app/codex-events.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const directory=path.join(root,'data/deployment/misty-relay');fs.mkdirSync(directory,{recursive:true});
const config=JSON.parse(fs.readFileSync(path.join(directory,'config.json'),'utf8').replace(/^\uFEFF/,''));
const lock=path.join(directory,'worker.lock');
if(fs.existsSync(lock)){const previous=Number(fs.readFileSync(lock,'utf8'));let alive=false;try{process.kill(previous,0);alive=true;}catch{}if(alive)process.exit(0);fs.unlinkSync(lock);}
fs.writeFileSync(lock,String(process.pid),{flag:'wx'});
const status=(state,extra={})=>fs.writeFileSync(path.join(directory,'status.json'),JSON.stringify({state,at:Date.now(),pid:process.pid,...extra}));
const db=new DatabaseSync(path.join(directory,'journal.sqlite'));db.exec('PRAGMA journal_mode=WAL;PRAGMA busy_timeout=5000;');
let stopping=false,codex,vm,beat,jobs,live,eventTimer,eventTask,knowledgeTimer;
function cleanup(){if(beat)clearInterval(beat);if(eventTimer)clearInterval(eventTimer);if(knowledgeTimer)clearInterval(knowledgeTimer);jobs?.close();live?.close();codex?.close();vm?.close();}
function stop(){stopping=true;cleanup();status('stopped');try{fs.unlinkSync(lock);}catch{}process.exit(0);}
process.on('SIGINT',stop);process.on('SIGTERM',stop);process.on('exit',()=>{try{if(fs.readFileSync(lock,'utf8')===String(process.pid))fs.unlinkSync(lock);}catch{}});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const safeReasons=new Set(['unsupported-extension-version','queue-schema-changed','approved-workspace-mismatch','snapshot-timeout','connect-timeout','request-timeout','wrong-owner','invalid-owner','invalid-initialize','disconnected','unavailable','ENOENT','ECONNREFUSED','ECONNRESET']);
while(!stopping){
 let phase='codex_connect',reconnectDelay=15000;
 try{
  status('connecting');
  const binary=resolveCodexBinary(config.codex);
  codex=new RPCProcess(binary,['app-server','--stdio'],{cwd:root});
  const account=await initializeCodex(codex);if(!account.account)throw new Error('Codex is not signed in.');
  phase='ssh_connect';
  vm=new RPCProcess('ssh.exe',['-F',config.sshConfig,'-o','ConnectTimeout=15','-o','ConnectionAttempts=1','-o','ServerAliveInterval=20','-o','ServerAliveCountMax=3','archival-vm','sudo runuser -u misty-bot -- /opt/misty-bot/bin/node --disable-warning=ExperimentalWarning /opt/misty-bot/scripts/misty-relay-agent.mjs'],{cwd:root});
  let catalogAt=0,heartbeatBusy=false,chats=[];
  async function publish(){chats=resolveRolloutPaths(await listCodexChats(codex));await vm.request('catalog',{worker:config.worker,chats});catalogAt=Date.now();return chats.length;}
  phase='catalog_publish';const count=await publish();status('online',{chats:count,auth:account.account.type});phase='poll';
  beat=setInterval(async()=>{if(heartbeatBusy)return;heartbeatBusy=true;try{await vm.request('heartbeat',{worker:config.worker});if(Date.now()-catalogAt>15000)await publish();}catch{}finally{heartbeatBusy=false;}},15000);
  live=new LiveSessions(binary);
  jobs=new CodexJobs(codex,db,{liveSessions:live});
  const knowledge=new MistyKnowledgeSync({root,rpc:codex,vm,worker:config.worker,db});
  knowledgeTimer=setInterval(()=>{if(!stopping&&!vm.closed)knowledge.tick(chats).catch(()=>{});},1000);
  const events=new CodexEventSync({db,vm,worker:config.worker});
  eventTimer=setInterval(()=>{if(!eventTask&&!stopping&&!vm.closed)eventTask=events.tick(chats).catch(()=>{}).finally(()=>{eventTask=null;});},3000);
  await events.tick(chats);
  while(!stopping&&!codex.closed&&!vm.closed){
   const job=await vm.request('claim',{worker:config.worker});
   if(!job){
    try{await knowledge.tick(chats);}catch{status('knowledge_retry',{reason:'Snapshot upload interrupted; saved versions retained.'});throw Error('Knowledge sync disconnected.');}
    await pause(knowledge.current||knowledge.queue.length?80:3000);continue;
   }
   status('working',{job:job.code,chat:job.target.title});
   phase='run_job';
   const result=await jobs.run(job,p=>vm.request('progress',{...p,id:job.id,hash:job.hash,worker:config.worker}));
   if(result.blocked){status('waiting_for_chat',{job:job.code,reason:result.reason||'chat_busy',route:result.route||'appserver'});reconnectDelay=10000;break;}
   phase='post_result';await vm.request('result',{...result,id:job.id,hash:job.hash,worker:config.worker});
   status('online',{lastJob:job.code,outcome:result.status});reconnectDelay=0;break;
  }
 }catch(error){
  // Keep private prompt/response contents out of status files, while exposing the
  // actionable failure class instead of silently repeating resume attempts.
  const reason=safeReasons.has(error.code)?error.code:(/active writer/i.test(error.message)?'chat_owned_by_editor':error.rpcCode!==undefined?'codex_rpc_error':'connection_error');
  status('reconnecting',{phase,reason});
 }
 finally{cleanup();}
 // Start with a fresh Codex process for the next job so history changed in VS Code
 // between requests is reloaded rather than using an older in-memory session.
 if(!stopping)await pause(reconnectDelay);
}
