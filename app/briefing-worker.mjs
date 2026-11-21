import {parentPort,workerData} from 'node:worker_threads';
import {ArchiveStore} from './store.mjs';
import {Briefings} from './briefings.mjs';
import path from 'node:path';
import {LocalOllama} from './ollama-runtime.mjs';
const store=new ArchiveStore(workerData.filename);
const runtime=new LocalOllama({directory:path.dirname(workerData.filename),concurrency:workerData.concurrency||3});
let endpoint='http://127.0.0.1:11434/api/chat',concurrency=1;
try{await runtime.start();endpoint=runtime.endpoint;concurrency=runtime.concurrency;store.set('briefing_worker_notice','');}
catch{store.set('briefing_worker_notice','Parallel local runtime unavailable; using the normal local Ollama service with one request at a time.');}
store.set('briefing_worker_capacity',concurrency);
const briefings=new Briefings(store,{poll:true,concurrency,endpoint});
store.set('briefing_worker_error','');
store.set('briefing_worker_phase','preparing previews');
briefings.seedPreviews();
store.set('briefing_worker_phase','checking history checkpoints');
briefings.seedHistoryProgress();
store.set('briefing_worker_phase','processing');
const previewTimer=setInterval(()=>briefings.seedPreviews(),30000);previewTimer.unref();
parentPort.on('message',async message=>{if(message==='stop'){clearInterval(previewTimer);await briefings.close();await runtime.close();store.close();parentPort.postMessage('stopped');parentPort.close();}});
parentPort.postMessage('ready');
