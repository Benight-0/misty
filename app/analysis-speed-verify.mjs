// Read-only production audit; no chat bodies or credentials are exported.
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync('data/app/archive.sqlite',{readOnly:true});db.exec('PRAGMA busy_timeout=5000');
const started=Date.now(),old=db.prepare('SELECT room_id,hash FROM briefing_history_nodes').all();
const capacity=Number(process.argv.find(a=>a.startsWith('--capacity='))?.slice(11)||2);
if(![1,2,3,4].includes(capacity))throw new Error('Use capacity 1-4.');
const filename=process.argv.includes('--next')?'data/app/analysis-speed-next-verification.json':'data/app/analysis-speed-verification.json';
const deadline=started+300000;
let report,lastLog=0;
try{
  while(Date.now()<deadline){
    await new Promise(r=>setTimeout(r,2000));
    let briefings,stats;try{[briefings,stats]=await Promise.all(['/api/briefings','/api/stats'].map(async p=>(await fetch('http://127.0.0.1:8787'+p,{signal:AbortSignal.timeout(5000)})).json()));}catch{continue;}
    const nodes=db.prepare('SELECT stage,created_at,json_extract(payload,\'$.modelDiagnostics\') diagnostics FROM briefing_history_nodes WHERE created_at>=? ORDER BY created_at').all(started).filter(n=>n.diagnostics).map(n=>({...n,diagnostics:JSON.parse(n.diagnostics)}));
    const seen=db.prepare('SELECT 1 FROM briefing_history_nodes WHERE room_id=? AND hash=?');
    const retained=old.filter(n=>seen.get(n.room_id,n.hash)).length;
    const maps=nodes.filter(n=>n.stage==='map'),seconds=nodes.length>1?(nodes.at(-1).created_at-nodes[0].created_at)/1000:0;
    report={at:new Date().toISOString(),status:briefings.status,workerError:briefings.workerError,checkpointsBefore:old.length,checkpointsRetained:retained,newNodes:nodes.length,newMaps:maps.length,
      completionWindowSeconds:seconds,completedNodesPerHour:seconds?Math.round((nodes.length-1)*3600/seconds):null,
      diagnostics:nodes.map(n=>({stage:n.stage,...n.diagnostics})),sourceSync:stats.sync,discordLifetime:stats.history,profile:db.prepare('SELECT source,count(*) n FROM profile_findings GROUP BY source').all()};
    fs.writeFileSync(filename,JSON.stringify(report,null,2)+'\n');
    if(Date.now()-lastLog>30000){console.log(JSON.stringify({at:report.at,newNodes:nodes.length,ready:report.status.ready,parallelRequests:report.status.parallelRequests,errors:report.status.error,checkpointsRetained:retained}));lastLog=Date.now();}
    if(maps.length>=8&&briefings.status.parallelRequests===capacity&&!briefings.workerError&&stats.sync?.ok)break;
  }
  if(!report||report.status.parallelRequests!==capacity||report.workerError||report.checkpointsRetained!==old.length||report.newMaps<2||!report.sourceSync?.ok)throw new Error('Production speed verification did not satisfy its gates.');
  console.log(JSON.stringify(report));
}finally{db.close();}
