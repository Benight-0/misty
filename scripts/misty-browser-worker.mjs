// Isolated VM Playwright worker. Its credential cannot claim laptop operations.
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {VmBrowserExecutor} from '../app/vm-browser-executor.mjs';

const token=fs.readFileSync(process.env.CREDENTIALS_DIRECTORY+'/vm-browser-token','utf8').trim();
const db=new DatabaseSync('/var/lib/misty-bot/vm-browser.sqlite');
const executor=new VmBrowserExecutor({db,stateDir:'/var/lib/misty-bot/vm-browser-sessions'});
const call=async(action,args={})=>{
 const response=await fetch('http://127.0.0.1:8798/worker',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({action,args:{...args,worker:'vm-browser'}}),signal:AbortSignal.timeout(30000)});
 const result=await response.json();if(!response.ok)throw Error(result.error||'Broker rejected VM browser worker.');return result;
};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let stopping=false;
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{stopping=true;});
while(!stopping){
 try{
  await call('heartbeat');
  for(const row of db.prepare('SELECT * FROM vm_browser_operations WHERE delivered=0 AND result IS NOT NULL').all()){
   await call('result',{id:row.id,hash:row.hash,result:JSON.parse(row.result)});
   db.prepare('UPDATE vm_browser_operations SET delivered=1 WHERE id=?').run(row.id);
  }
  const op=await call('claim');
  if(op){
   try{await executor.execute(op);}catch(error){
    const result={state:'failed',error:String(error.message).slice(0,500)};
    db.prepare("INSERT OR IGNORE INTO vm_browser_operations VALUES(?,?,'failed',?,?,0)").run(op.id,op.hash,JSON.stringify(result),Date.now());
   }
  }
  await pause(op?100:1000);
 }catch{await pause(5000);}
}
await executor.close();db.close();
