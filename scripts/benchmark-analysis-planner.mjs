// Read-only production benchmark: counts/timings only; no API calls or chat text output.
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const root=process.argv[2]||'/opt/archival/app';
const {ArchiveStore}=await import(pathToFileURL(path.join(root,'store.mjs')));
const {loadHistoryPlan,nextHistoryStep}=await import(pathToFileURL(path.join(root,'briefing-history.mjs')));
const db=new DatabaseSync('/var/lib/archival/data/archive.sqlite',{readOnly:true}),store=Object.create(ArchiveStore.prototype);store.db=db;store.cache=new Map();
const room=process.argv[3]||db.prepare('SELECT room_id FROM briefing_history_progress WHERE completed_batches=total_batches AND total_batches>10 ORDER BY total_batches DESC LIMIT 1').get()?.room_id;
if(!room)throw new Error('No completed reading batches to benchmark.');
let at=performance.now();const plan=loadHistoryPlan(store,room,'gpt-5.6-luna',Date.now(),{reductionPolicy:'wide'});
console.log(JSON.stringify({operation:'load full plan',ms:Math.round(performance.now()-at),batches:plan.leaves.length}));
for(let run=1;run<=2;run++){
  at=performance.now();const step=nextHistoryStep(store,plan);
  console.log(JSON.stringify({operation:'select next step with saved work',run,ms:Math.round(performance.now()-at),stage:step.progress.stage,remainingInputNotes:step.node?.children?.length||0}));
}
// Inspect first-level grouping from the same real map outputs, without writing any nodes.
plan.cached=new Map([...plan.cached].filter(([key])=>plan.leaves.some(n=>n.hash===key)));delete plan.frontier;
at=performance.now();const step=nextHistoryStep(store,plan);
const groups=plan.groups.get('wide:'+plan.leaves.map(n=>n.hash).join(','));
console.log(JSON.stringify({operation:'first combining level from saved reading batches',ms:Math.round(performance.now()-at),notes:plan.leaves.length,groups:groups?.length,groupSizes:groups?.map(g=>g.length),firstInputBytes:Buffer.byteLength(JSON.stringify(step.snapshot?.input||{}))}));
db.close();
