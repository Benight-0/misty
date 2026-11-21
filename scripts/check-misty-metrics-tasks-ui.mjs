import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import path from 'node:path';
const require=createRequire(path.resolve('data/deployment/misty-metrics/ui-check/package.json'));
const {JSDOM,VirtualConsole}=require('jsdom');
const html=fs.readFileSync('metrics/public/index.html','utf8');
const script=fs.readFileSync('metrics/public/dashboard.js','utf8');
const real=JSON.parse(fs.readFileSync('data/deployment/misty-metrics-tasks/preview.json','utf8'));
async function run(fixture){
 const errors=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
 const dom=new JSDOM(html,{url:'https://status.example.com/',runScripts:'outside-only',virtualConsole:vc});
 const w=dom.window,timers=[];let current=fixture;
 w.AbortSignal=AbortSignal;w.setInterval=(fn,ms)=>{timers.push({fn,ms});return timers.length;};
 w.fetch=async()=>({ok:true,json:async()=>structuredClone(current)});
 try{
  w.eval(script);await new Promise(r=>setTimeout(r,25));assert.deepEqual(errors,[]);
  assert(!/NaN|Infinity|undefined/.test(w.document.querySelector('.tasks').textContent));
  assert.equal(w.document.querySelectorAll('#tasks tr').length,fixture.usage.tasks?.length||1);
  return {w,timers,set:value=>current=value,close:()=>w.close()};
 }catch(e){w.close();throw e;}
}
const live=await run(real);
try{
 const rows=[...live.w.document.querySelectorAll('#tasks tr')];
 real.usage.tasks.forEach((r,i)=>{assert(rows[i].textContent.includes(r.label));assert(rows[i].textContent.includes(r.shareOfPricedCostPercent.toFixed(1)+'%'));});
 assert.equal(live.w.document.getElementById('task-coverage').textContent,real.usage.taskBreakdownNote);
 const changed=structuredClone(real);changed.usage.tasks[0].estimatedUsd=987.65;
 live.set(changed);await live.timers.find(t=>t.ms===30000).fn();
 assert(live.w.document.querySelector('#tasks tr').textContent.includes('$987.65'));
}finally{live.close();}
for(const tasks of [[],[{task:'other',label:'<img src=x onerror=alert(1)>',note:'unclassified',estimatedUsd:null,shareOfPricedCostPercent:null,unpricedRecords:1}],
 [{task:'apollo',label:'Apollo',note:'combined',estimatedUsd:0,shareOfPricedCostPercent:null,unpricedRecords:2}]]){
 const check=await run({...real,usage:{...real.usage,tasks}});
 try{assert.equal(check.w.document.querySelectorAll('#tasks img').length,0);if(tasks[0]?.estimatedUsd===null)assert(check.w.document.querySelector('#tasks').textContent.includes('Unpriced'));}
 finally{check.close();}
}
console.log(JSON.stringify({realSnapshotRendered:true,taskRows:real.usage.tasks.length,percentageAndCostDisplayed:true,automaticCostRefresh:true,emptyAndUnpricedHandled:true,noHtmlInjection:true,visualInspection:false}));
