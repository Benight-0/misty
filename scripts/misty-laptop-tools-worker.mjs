import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {RPCProcess} from '../app/codex-relay-client.mjs';
import {LaptopExecutor,configuredRoots} from '../app/laptop-tools-local.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),directory=path.join(root,'data/deployment/laptop-tools');
fs.mkdirSync(directory,{recursive:true});const lock=path.join(directory,'worker.lock');
if(fs.existsSync(lock)){let alive=false;try{process.kill(Number(fs.readFileSync(lock,'utf8')),0);alive=true;}catch{}if(alive)process.exit(0);fs.unlinkSync(lock);}
fs.writeFileSync(lock,String(process.pid),{flag:'wx'});
const config=JSON.parse(fs.readFileSync(path.join(root,'data/deployment/misty-relay/config.json'),'utf8').replace(/^\uFEFF/,''));
const rootsFile=path.join(directory,'roots.json');
const scope=()=>JSON.parse(fs.readFileSync(rootsFile,'utf8').replace(/^\uFEFF/,''));
const initialScope=scope();
const roots=()=>configuredRoots(scope());
const db=new DatabaseSync(path.join(directory,'journal.sqlite')),executor=new LaptopExecutor({roots:configuredRoots(initialScope),fullAccess:initialScope?.scope==='all-drives',db,backupDir:path.join(directory,'preimages')});
let vm,stopping=false,running=null,beatBusy=false;
let lastRootsRefresh=Date.now();
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function status(state){fs.writeFileSync(path.join(directory,'status.json'),JSON.stringify({at:Date.now(),pid:process.pid,state,operation:running?.id||null,roots:executor.roots}));}
function shutdown(){stopping=true;running?.abort.abort();vm?.close();status('stopped');try{fs.unlinkSync(lock);}catch{}setTimeout(()=>process.exit(0),1000).unref();}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);process.on('exit',()=>{try{if(fs.readFileSync(lock,'utf8')===String(process.pid))fs.unlinkSync(lock);}catch{}});
async function heartbeat(){
 if(beatBusy||!vm||vm.closed)return;beatBusy=true;
 try{
  if(Date.now()-lastRootsRefresh>30000){const current=scope();executor.setRoots(configuredRoots(current));executor.fullAccess=current?.scope==='all-drives';lastRootsRefresh=Date.now();}
  const response=await vm.request('laptop_heartbeat',{worker:config.worker,roots:executor.roots,fullAccess:executor.fullAccess},12000);
  if(running&&(response.paused||response.cancellations.includes(running.id)))running.abort.abort();
 }
 finally{beatBusy=false;}
}
const timer=setInterval(()=>heartbeat().catch(()=>{}),3000);timer.unref();
while(!stopping){
 try{
  if(!vm||vm.closed){vm=new RPCProcess('ssh.exe',['-F',config.sshConfig,'-o','ConnectTimeout=12','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2','archival-vm','sudo runuser -u misty-bot -- /opt/misty-bot/bin/node --disable-warning=ExperimentalWarning /opt/misty-bot/scripts/misty-relay-agent.mjs'],{cwd:root});await heartbeat();}
  // Resend receipts, never side effects, after a lost acknowledgement.
  for(const row of db.prepare('SELECT * FROM laptop_operations WHERE delivered=0 AND result IS NOT NULL').all()){
   await vm.request('laptop_result',{worker:config.worker,id:row.id,hash:row.hash,result:JSON.parse(row.result)});db.prepare('UPDATE laptop_operations SET delivered=1 WHERE id=?').run(row.id);
  }
  const op=await vm.request('laptop_claim',{worker:config.worker},12000);
  if(op){
   running={id:op.id,abort:new AbortController()};status('executing');
   try{await executor.execute(op,running.abort.signal);}catch(e){
    // Preflight rejection: no executor started. Persist the failure for delivery.
    const result=JSON.stringify({state:'failed',error:String(e.message).slice(0,1000)});
    db.prepare("INSERT OR IGNORE INTO laptop_operations(id,hash,state,result,at) VALUES(?,?,'failed',?,?)").run(op.id,op.hash,result,Date.now());
   }finally{running=null;}
  }
  status('online');await pause(op?100:1000);
 }catch{status('reconnecting');vm?.close();vm=null;await pause(5000);}
}
