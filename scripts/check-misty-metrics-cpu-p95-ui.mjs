import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import path from 'node:path';
const require=createRequire(path.resolve('data/deployment/misty-metrics/ui-check/package.json'));
const {JSDOM,VirtualConsole}=require('jsdom');
const html=fs.readFileSync('metrics/public/index.html','utf8');
const script=fs.readFileSync('metrics/public/dashboard.js','utf8');
const real=JSON.parse(fs.readFileSync(process.argv[2]||'data/deployment/misty-metrics-tasks/preview.json','utf8'));
async function check(summary){
 const errors=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
 const dom=new JSDOM(html,{url:'https://status.example.com/',runScripts:'outside-only',virtualConsole:vc});
 const w=dom.window,timers=[];let current={...real,cpuSevenDays:summary};
 w.AbortSignal=AbortSignal;w.setInterval=(fn,ms)=>{timers.push({fn,ms});return timers.length;};
 w.fetch=async url=>({ok:true,json:async()=>structuredClone(url==='/resources.json'?{...real,host:{...real.host,cpuPercent:77}}:current)});
 try{
  w.eval(script);await new Promise(r=>setTimeout(r,25));assert.deepEqual(errors,[]);
  const value=()=>w.document.getElementById('cpu-p95').textContent;
  assert.equal(value(),Number.isFinite(summary?.p95Percent)?summary.p95Percent.toFixed(1)+'%':'Unavailable');
  assert(!/NaN|Infinity|undefined/.test(w.document.querySelector('.cpu-percentile').textContent));
  if(summary?.sampleCount)assert(w.document.getElementById('cpu-p95-coverage').textContent.includes('available since'));
  else assert.equal(w.document.getElementById('cpu-p95-coverage').textContent,'Collecting CPU history');
  const original=value();await timers.find(t=>t.ms===5000).fn();assert.equal(value(),original);
  assert.equal(w.document.getElementById('cpu').textContent,'77.0%');
  current={...current,cpuSevenDays:{p95Percent:42.3,sampleCount:25,firstAt:real.updatedAt}};
  await timers.find(t=>t.ms===30000).fn();assert.equal(value(),'42.3%');
  assert.equal(w.document.getElementById('cpu').textContent,'77.0%');
 }finally{w.close();}
}
for(const summary of [real.cpuSevenDays,{p95Percent:0,sampleCount:1,firstAt:real.updatedAt},
 {p95Percent:95,sampleCount:100,firstAt:real.updatedAt-86400000},{p95Percent:null,sampleCount:0}])await check(summary);
console.log(JSON.stringify({percentileRendered:true,zeroAndUnavailableHandled:true,partialHistoryLabel:true,
 minuteRefreshUpdatesPercentile:true,liveCpuDoesNotOverwritePercentile:true,domErrors:0,visualInspection:false}));
