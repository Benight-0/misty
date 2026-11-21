// Executed on the VM over an authenticated SSH session, as the bot OS user.
// It exposes only the relay operations, never a shell or credentials to Discord.
import fs from 'node:fs';
import {createInterface} from 'node:readline';
const token=fs.readFileSync('/var/lib/misty-bot/relay-token','utf8').trim();
const methods=new Set(['catalog','heartbeat','claim','progress','result','status','knowledge','codex_events','activity_publish','activity_status','activity_control','laptop_heartbeat','laptop_claim','laptop_result']);
const lines=createInterface({input:process.stdin});
for await(const line of lines){
 let id=null;
 try{
  if(Buffer.byteLength(line)>1800000)throw new Error();const call=JSON.parse(line);id=call.id;if(!methods.has(call.method))throw new Error();
  const activity=call.method.startsWith('activity_'),laptop=call.method.startsWith('laptop_');
  const response=await fetch('http://127.0.0.1:'+(laptop?'8798/worker':activity?'8797/'+call.method.slice(9):'8790/'+call.method),{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(laptop?{action:call.method.slice(7),args:call.params||{}}:call.params||{}),signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error();console.log(JSON.stringify({id,result:await response.json()}));
 }catch{console.log(JSON.stringify({id,error:{code:-32000,message:'VM relay rejected the request.'}}));}
}
