import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {ArchiveStore} from '../app/store.mjs';
import {BRIEFING_VERSION,PRIVATE_SCOPE} from '../app/briefing-store.mjs';
import {loadHistoryPlan,nextHistoryStep,saveHistoryNode} from '../app/briefing-history.mjs';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Opt-in reuse of unchanged, validated notes. Source rows and published summaries stay intact.
export function reuseAnalysisCheckpoints(store,room,sourceModel,targetModel,now=Date.now()){
  if(sourceModel===targetModel)throw new Error('Source and target models must differ.');
  const plan=loadHistoryPlan(store,room,targetModel,now),sourceHashes=new Map();
  const existing=new Map(store.statement('SELECT hash,payload,created_at FROM briefing_history_nodes WHERE room_id=?').all(room).map(row=>[row.hash,row]));
  let copied=0;
  function reuse(node,sourceHash){
    sourceHashes.set(node.hash,sourceHash);
    if(existing.has(node.hash))return true;
    const old=existing.get(sourceHash);if(!old)return false;
    const payload=JSON.parse(old.payload);
    payload.modelDiagnostics={...payload.modelDiagnostics,model:payload.modelDiagnostics?.model||sourceModel};
    payload.checkpointReuse={sourceModel,targetModel,sourceHash};
    saveHistoryNode(store,room,node,payload,old.created_at);
    const row={hash:node.hash,payload:JSON.stringify(payload),created_at:old.created_at};existing.set(node.hash,row);
    if(plan.cached)plan.cached.set(node.hash,row.payload);
    copied++;return true;
  }
  for(const node of plan.leaves){
    const sourceHash=digest([BRIEFING_VERSION,sourceModel,'map',node.messages.map(m=>[m.id,m.sender,m.person,m.ts,m.signature,m.part,m.body,m.profileEligible])]);
    reuse(node,sourceHash);
  }
  // Hydrate the tree in one traversal; repeated next-step scans are quadratic on large chats.
  nextHistoryStep(store,plan,{hydrateNode:node=>{
    const children=node.children.map(child=>sourceHashes.get(child.hash));
    if(children.some(hash=>!hash))return;
    reuse(node,digest([BRIEFING_VERSION,sourceModel,node.stage,children]));
  }});
  return copied;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const [filename,sourceModel,targetModel]=process.argv.slice(2);
  if(!filename||!sourceModel||!targetModel)throw new Error('Usage: migrate-analysis-model.mjs DATABASE SOURCE_MODEL TARGET_MODEL');
  const store=new ArchiveStore(filename);store.db.exec('PRAGMA cache_size=-8192;');
  let copied=0,chats=0;
  try{
    for(const room of store.statement(`SELECT id FROM conversations WHERE connected=1 AND ${PRIVATE_SCOPE}`).all()){
      store.db.exec('BEGIN');
      try{const count=reuseAnalysisCheckpoints(store,room.id,sourceModel,targetModel);store.db.exec('COMMIT');copied+=count;if(count)chats++;}
      catch(error){store.db.exec('ROLLBACK');throw error;}
      global.gc?.();
    }
    store.set('analysis_model_migration',{sourceModel,targetModel,copied,chats,at:Date.now()});
    console.log(JSON.stringify({sourceModel,targetModel,copied,chats,originalRowsPreserved:true}));
  }finally{store.close();}
}
