// Real DOM execution of the shipped page, without a browser/profile or external requests.
// npm install --prefix data/deployment/misty-metrics/ui-check --no-save --ignore-scripts jsdom
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import path from 'node:path';
const require=createRequire(path.resolve('data/deployment/misty-metrics/ui-check/package.json'));
const {JSDOM,VirtualConsole}=require('jsdom');
const html=fs.readFileSync('metrics/public/index.html','utf8');
const script=fs.readFileSync('metrics/public/dashboard.js','utf8');
const real=JSON.parse(fs.readFileSync('data/deployment/misty-metrics/preview.json','utf8'));
async function check(fixture,live){
 const errors=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
 const dom=new JSDOM(html,{url:'http://127.0.0.1:8793/',runScripts:'outside-only',virtualConsole:vc});
 const w=dom.window,timers=[];let resource=live||{schema:1,updatedAt:fixture.updatedAt,host:fixture.host,history:fixture.history};w.AbortSignal=AbortSignal;w.setInterval=(fn,ms)=>{timers.push({fn,ms});return timers.length;};w.fetch=async url=>({ok:true,json:async()=>structuredClone(url==='/resources.json'?resource:fixture)});
 try{
  w.eval(script);await new Promise(r=>setTimeout(r,30));assert.deepEqual(errors,[]);
  const result=inspect(w.document);
  const originalPath=w.document.querySelector('#host-chart path')?.getAttribute('d');
  resource={...resource,updatedAt:fixture.updatedAt+5000,host:{...fixture.host,cpuPercent:87.6,memoryPercent:72.3},history:[...resource.history,{at:fixture.updatedAt+5000,cpuPercent:87.6,memoryPercent:72.3}]};
  await timers.find(t=>t.ms===5000).fn();
  assert.equal(w.document.getElementById('cpu').textContent,'87.6%');
  assert.equal(w.document.getElementById('memory').textContent,'72.3%');
  if(originalPath)assert.notEqual(w.document.querySelector('#host-chart path').getAttribute('d'),originalPath);
  await timers.find(t=>t.ms===30000).fn();
  assert.equal(w.document.getElementById('cpu').textContent,'87.6%','minute snapshot must not overwrite live metrics');
  w.document.getElementById('host-range').value='day';
  w.document.getElementById('host-range').dispatchEvent(new w.Event('change'));
  assert.equal(w.document.querySelectorAll('#host-chart path').length,fixture.history.length>1?2:0);
  return result;
 }
 finally{w.close();}
}
function inspect(doc){
 assert.notEqual(doc.getElementById('spend').textContent,'—');
 assert.equal(doc.querySelectorAll('#spend-chart svg rect').length,7);
 assert.equal(doc.querySelectorAll('#models tr').length,real.usage.models.length);
 assert.equal(doc.querySelectorAll('#model-share rect').length,real.usage.models.length);
 assert.equal(doc.getElementById('dot').className.startsWith('dot '),true);
 for(const node of doc.querySelectorAll('svg path'))assert(!/NaN|Infinity/.test(node.getAttribute('d')||''));
 return {cpuPaths:doc.querySelectorAll('#host-chart path').length,modelNames:doc.querySelectorAll('.model-name').length};
}
const fixture=structuredClone(real);
fixture.history=[{at:real.updatedAt-300000,cpuPercent:0,memoryPercent:50,diskPercent:47},{at:real.updatedAt,cpuPercent:100,memoryPercent:65,diskPercent:47}];
const filled=await check(fixture);assert.equal(filled.cpuPaths,2);
const empty=await check({...fixture,history:[]});assert.equal(empty.cpuPaths,0);
console.log(JSON.stringify({realSnapshotRendered:true,sevenSpendingBars:true,modelRows:filled.modelNames,cpuAndMemoryPaths:filled.cpuPaths,emptyHistoryHandled:true,liveUpdatesWithoutReload:true,minuteSnapshotDoesNotOverwriteLive:true,historyRangeSwitch:true,visualInspection:false}));
