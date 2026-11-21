// Run on the VM as root to check the loopback broker without printing its credential.
import fs from 'node:fs';
const token=fs.readFileSync('/etc/misty-bot/prominence-token','utf8').trim();
const response=await fetch('http://127.0.0.1:8798/call',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({action:'status'}),signal:AbortSignal.timeout(10000)});
if(!response.ok)throw Error('Laptop broker status unavailable: HTTP '+response.status);
const status=await response.json();
console.log(JSON.stringify({reviewRequired:status.reviewRequired,laptopOnline:status.laptopOnline,roots:status.roots,pending:status.operations.filter(x=>['review_pending','reviewing','awaiting_owner'].includes(x.state)).length}));
if(status.reviewRequired!==false)process.exitCode=1;
