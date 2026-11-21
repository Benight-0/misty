import fs from 'node:fs';
const base='http://127.0.0.1:8787/api/';
const result={at:new Date().toISOString(),requests:[]};
if(process.argv.includes('--full')) {
  const b=await(await fetch(base+'bootstrap')).json();
  const requestedAt=Date.now();
  await fetch(base+'sync',{method:'POST',headers:{'Content-Type':'application/json','X-Archival-Token':b.token},body:JSON.stringify({full:true})});
  while(Date.now()-requestedAt<120000) {
    await new Promise(r=>setTimeout(r,500));
    let s;
    try{s=await(await fetch(base+'stats',{signal:AbortSignal.timeout(100000)})).json();}catch{continue;}
    if(s.lastFullSync?.at>=requestedAt){result.fullRescan=s.lastFullSync;break;}
  }
  if(!result.fullRescan)throw new Error('Full rescan did not complete');
}
for(const endpoint of ['stats','rooms?kind=dm&limit=5','messages?q=neuroscience&limit=20','profile']) {
  const t=performance.now();
  const response=await fetch(base+endpoint,{signal:AbortSignal.timeout(10000)});
  const data=await response.json();
  if(!response.ok)throw new Error('HTTP '+response.status);
  result.requests.push({endpoint,durationMs:Math.round((performance.now()-t)*10)/10,status:response.status,
    ...(endpoint==='stats'?{sync:data.sync,messages:data.messages.total,own:data.messages.own}:endpoint==='profile'?{findings:data.findings.length,reviewed:data.coverage.review.messages}:endpoint.startsWith('rooms')?{total:data.total}:{matches:data.length})});
}
console.log(JSON.stringify(result,null,2));
fs.writeFileSync(new URL('../data/app/verification.json',import.meta.url),JSON.stringify(result,null,2));
