import {Worker,parentPort,workerData} from 'node:worker_threads';
import {ArchiveStore} from './store.mjs';
import {Briefings} from './briefings.mjs';
import {OpenAIAnalysis} from './openai-analysis.mjs';
import {MistyServerSummaries} from './misty-server-summaries.mjs';

// Keep full-history planning and validation off the collector/HTTP event loop.
export function startVMAnalysis({filename,model,concurrency=3,keyFile='/etc/archival/openai-key',onError=()=>{}}){
  if(!Number.isInteger(concurrency)||concurrency<1||concurrency>4)throw new Error('Invalid API analysis concurrency.');
  let worker,stopped=false,restart;
  let readyResolve;const ready=new Promise(resolve=>{readyResolve=resolve;});
  function launch(){
    worker=new Worker(new URL(import.meta.url),{workerData:{filename,model,concurrency,keyFile},resourceLimits:{maxOldGenerationSizeMb:192}});
    worker.on('message',message=>{if(message==='ready')readyResolve();});
    worker.on('error',()=>onError('Analysis worker interrupted; saved checkpoints will resume automatically.'));
    worker.on('exit',()=>{if(!stopped){onError('Analysis worker restarting from saved checkpoints.');restart=setTimeout(launch,2000);restart.unref();}});
  }
  launch();
  return {ready,close:async()=>{
    stopped=true;clearTimeout(restart);
    if(!worker||worker.threadId===-1)return;
    await new Promise(resolve=>{
      const timeout=setTimeout(()=>worker.terminate().finally(resolve),8000);timeout.unref();
      worker.once('exit',()=>{clearTimeout(timeout);resolve();});worker.postMessage('stop');
    });
  }};
}

if(parentPort){
  const store=new ArchiveStore(workerData.filename);
  store.db.exec('PRAGMA cache_size=-8192; PRAGMA wal_autocheckpoint=500;');
  const analysisClient=new OpenAIAnalysis({keyFile:workerData.keyFile,onUsage:u=>{
    store.statement('INSERT OR IGNORE INTO openai_usage VALUES(?,?,?,?,?,?,?,?)').run(u.requestId,u.room,u.model,u.inputTokens,u.outputTokens,u.cachedTokens,u.at,u.status);
  }});
  const briefings=new Briefings(store,{analysisClient,model:workerData.model,concurrency:workerData.concurrency,planCacheLimit:1,maxActiveRooms:1,reductionPolicy:'wide'});
  const servers=new MistyServerSummaries(store,analysisClient,{model:workerData.model});
  const serverTimer=setInterval(()=>servers.tick().catch(()=>{}),15000);serverTimer.unref();
  store.set('briefing_worker_capacity',workerData.concurrency);
  store.set('briefing_worker_notice','Private-chat summaries use OpenAI. Full history and detailed batch findings remain stored on your VM.');
  store.set('briefing_worker_error','');store.set('briefing_worker_phase','processing');
  const heartbeat=()=>store.set('briefing_worker_runtime',{at:Date.now(),active:briefings.active,rooms:briefings.activeRooms.size,heapBytes:process.memoryUsage().heapUsed,reductionPolicy:'wide'});
  heartbeat();const timer=setInterval(heartbeat,15000);timer.unref();let closing=false;
  parentPort.on('message',async message=>{if(message==='stop'&&!closing){closing=true;clearInterval(timer);clearInterval(serverTimer);await Promise.all([briefings.close(),servers.close()]);store.close();parentPort.close();}});
  parentPort.postMessage('ready');
}
