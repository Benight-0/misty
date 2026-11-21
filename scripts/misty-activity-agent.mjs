import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {RPCProcess} from '../app/codex-relay-client.mjs';
import {WindowsActivityCollector,ActivityOutbox,readChrome,pruneChrome} from '../app/laptop-activity-local.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),directory=path.join(root,'data/deployment/laptop-activity');
fs.mkdirSync(directory,{recursive:true});const lock=path.join(directory,'worker.lock');
// Task Scheduler stop is asynchronous. Let the previous job tree finish exiting
// before admitting its replacement; an ordinary duplicate still exits quietly.
for(let attempt=0;fs.existsSync(lock);attempt++){
 let live=false;try{process.kill(Number(fs.readFileSync(lock,'utf8')),0);live=true;}catch{}
 if(!live){try{fs.unlinkSync(lock);}catch{}break;}
 if(attempt>=20)process.exit(0);
 await new Promise(resolve=>setTimeout(resolve,500));
}
fs.writeFileSync(lock,String(process.pid),{flag:'wx'});
const config=JSON.parse(fs.readFileSync(path.join(root,'data/deployment/misty-relay/config.json'),'utf8').replace(/^\uFEFF/,''));
const db=new DatabaseSync(path.join(directory,'outbox.sqlite')),outbox=new ActivityOutbox(db),collector=new WindowsActivityCollector(root);
let vm,stopping=false,remotePaused=false;
const localFile=path.join(directory,'control.json'),remoteFile=path.join(directory,'remote.json'),statusFile=path.join(directory,'status.json');
try{remotePaused=JSON.parse(fs.readFileSync(remoteFile,'utf8')).paused===true;}catch{}
const readControl=()=>{try{return JSON.parse(fs.readFileSync(localFile,'utf8'));}catch{return {};}};
function writeJSON(file,value){const temp=file+'.tmp-'+process.pid;fs.writeFileSync(temp,JSON.stringify(value),{mode:0o600});fs.renameSync(temp,file);}
function stop(){stopping=true;collector.close();vm?.close();try{db.close();fs.unlinkSync(lock);}catch{}process.exit(0);}
process.on('SIGTERM',stop);process.on('SIGINT',stop);process.on('exit',()=>{try{if(fs.readFileSync(lock,'utf8')===String(process.pid))fs.unlinkSync(lock);}catch{}});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
while(!stopping){
 const start=Date.now();let receipt=null,link='offline',error='';
 pruneChrome(path.join(directory,'chrome'));
 try{
  if(!vm||vm.closed)vm=new RPCProcess('ssh.exe',['-F',config.sshConfig,'-o','ConnectTimeout=12','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2','archival-vm','sudo runuser -u misty-bot -- /opt/misty-bot/bin/node --disable-warning=ExperimentalWarning /opt/misty-bot/scripts/misty-relay-agent.mjs'],{cwd:root});
  let control=readControl();
  if(typeof control.intent==='boolean'){
   const response=await vm.request('activity_control',{worker:config.worker,paused:control.intent},15000);remotePaused=response.paused;
   const latest=readControl();if(latest.requestedAt===control.requestedAt)writeJSON(localFile,{...latest,paused:false,intent:null});
  }else remotePaused=(await vm.request('activity_status',{worker:config.worker},15000)).paused;
  writeJSON(remoteFile,{paused:remotePaused,at:Date.now()});link='online';
 }catch{error='SSH link unavailable; latest bounded samples will be uploaded after reconnect.';vm?.close();vm=null;}
 const control=readControl(),paused=control.paused===true||remotePaused;
 let sample;
 try{
  const raw=paused?{capturedAt:Date.now(),sessionState:'paused',windows:[],chrome:null}:await collector.collect();
  if(paused)db.exec('DELETE FROM activity_outbox');
  if(!paused)raw.chrome=readChrome(path.join(directory,'chrome'));
  sample=outbox.add(raw);
  if(vm&&!vm.closed){receipt=await outbox.flush(vm,config.worker);if(receipt)remotePaused=receipt.paused;}
 }catch{error=error||'Collection or upload unavailable; retained snapshots are never treated as current.';vm?.close();vm=null;}
 writeJSON(statusFile,{at:Date.now(),pid:process.pid,link,paused,state:sample?.sessionState||'unavailable',capturedAt:sample?.capturedAt||null,receivedAt:receipt?.receivedAt||null,chrome:sample?.chrome?.state||'unavailable',chromeReason:sample?.chrome?.reason||'',pending:db.prepare('SELECT count(*) n FROM activity_outbox').get().n,error});
 await pause(Math.max(1000,30000-(Date.now()-start)));
}
