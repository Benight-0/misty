'use strict';
const $=id=>document.getElementById(id),colors=['#3269da','#20958d','#8c66b8','#c98b36','#69778c'];
const money=n=>n===null||n===undefined?'Unavailable':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:2}).format(n);
const count=n=>new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:2}).format(n||0);
const date=(n,options={})=>new Intl.DateTimeFormat('en-IN',{timeZone:'Asia/Kolkata',...options}).format(new Date(n));
const size=n=>n>=1073741824?(n/1073741824).toFixed(1)+' GiB':(n/1048576).toFixed(0)+' MiB';
const text=(id,value)=>{$(id).textContent=value;};
function svg(tag,attrs={},content){const el=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const[k,v]of Object.entries(attrs))el.setAttribute(k,String(v));if(content!==undefined)el.textContent=content;return el;}
function chartRoot(container,label){const root=svg('svg',{viewBox:'0 0 480 190',role:'img','aria-label':label});container.replaceChildren(root);return root;}
function spendChart(rows){
 const root=chartRoot($('spend-chart'),'Daily estimated spending in US dollars');
 const max=Math.max(...rows.map(r=>r.estimatedUsd),.01),left=42,bottom=160,height=125;
 for(let i=0;i<=2;i++){const y=bottom-i*height/2;root.append(svg('line',{x1:left,x2:472,y1:y,y2:y,class:'grid-line'}),svg('text',{x:left-8,y:y+3,'text-anchor':'end'},money(max*i/2)));}
 rows.forEach((r,i)=>{const x=left+i*61+12,h=r.estimatedUsd/max*height,rect=svg('rect',{x,y:bottom-h,width:34,height:h,fill:colors[0]});rect.append(svg('title',{},r.date+': '+money(r.estimatedUsd)+' · '+r.records+' records'));root.append(rect,svg('text',{x:x+17,y:180,'text-anchor':'middle'},date(r.date+'T12:00:00+05:30',{day:'numeric',month:'short'})));});
}
function hostChart(rows){
 if(rows.length<2||rows.at(-1).at<=rows[0].at){$('host-chart').textContent='Collecting history — the next samples will appear here.';return;}
 const root=chartRoot($('host-chart'),'CPU and memory percentage over time');
 const left=32,right=470,top=16,bottom=160,start=rows[0].at,end=rows.at(-1).at;
 for(const n of[0,50,100]){const y=bottom-(bottom-top)*n/100;root.append(svg('line',{x1:left,x2:right,y1:y,y2:y,class:'grid-line'}),svg('text',{x:left-7,y:y+3,'text-anchor':'end'},n+'%'));}
 for(const[field,color]of[['cpuPercent',colors[0]],['memoryPercent',colors[1]]]){
  let path='';let gap=true;for(const r of rows){if(r[field]===null||r[field]===undefined){gap=true;continue;}const x=left+(r.at-start)/(end-start)*(right-left),y=bottom-r[field]/100*(bottom-top);path+=(gap?'M':'L')+x.toFixed(1)+' '+y.toFixed(1);gap=false;}
  root.append(svg('path',{d:path,fill:'none',stroke:color,'stroke-width':2,'stroke-linejoin':'round'}));
 }
 for(const[r,anchor,x]of[[rows[0],'start',left],[rows.at(-1),'end',right]])root.append(svg('text',{x,y:180,'text-anchor':anchor},date(r.at,{hour:'2-digit',minute:'2-digit',second:rows.length<30?'2-digit':undefined})));
}
function models(rows,total){
 const body=$('models');body.replaceChildren();const shares=svg('svg',{viewBox:'0 0 1000 9',preserveAspectRatio:'none',role:'img','aria-label':'Share of recorded tokens by model'});let x=0;
 rows.forEach((r,i)=>{const tokens=r.inputTokens+r.outputTokens,share=total?tokens/total*100:0,color=colors[i%colors.length],tr=document.createElement('tr');
  const name=document.createElement('td'),label=document.createElement('span');label.className='model-name';const dot=svg('svg',{viewBox:'0 0 7 7','aria-hidden':'true'});dot.append(svg('rect',{width:7,height:7,fill:color}));label.append(dot,document.createTextNode(r.model));name.append(label);tr.append(name);
  for(const value of[share.toFixed(1)+'%',count(r.inputTokens),count(r.outputTokens),count(r.cachedTokens),r.unpricedRecords?'Incomplete':money(r.estimatedUsd)]){const td=document.createElement('td');td.textContent=value;tr.append(td);}
  body.append(tr);const rect=svg('rect',{x,width:share*10,y:0,height:9,fill:color});rect.append(svg('title',{},r.model+': '+share.toFixed(1)+'%'));shares.append(rect);x+=share*10;
 });
 if(!rows.length){const row=document.createElement('tr'),cell=document.createElement('td');cell.colSpan=6;cell.textContent='No recorded model usage yet.';row.append(cell);body.append(row);}
 $('model-share').replaceChildren(shares);
}
function tasks(rows,note){
 const body=$('tasks');body.replaceChildren();
 rows.forEach(r=>{
  const tr=document.createElement('tr'),name=document.createElement('td'),label=document.createElement('span'),detail=document.createElement('small');
  label.className='task-name';label.textContent=r.label;detail.className='task-detail';detail.textContent=r.note;name.append(label,detail);tr.append(name);
  const share=document.createElement('td'),cost=document.createElement('td');
  share.textContent=r.shareOfPricedCostPercent===null?'—':r.shareOfPricedCostPercent.toFixed(1)+'%';
  cost.textContent=r.estimatedUsd===null?'Unpriced':money(r.estimatedUsd);
  if(r.unpricedRecords&&r.estimatedUsd!==null){const missing=document.createElement('small');missing.className='task-unpriced';missing.textContent='+ '+count(r.unpricedRecords)+' unpriced records';cost.append(missing);}
  tr.append(share,cost);body.append(tr);
 });
 if(!rows.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=3;td.textContent='No task usage recorded yet.';tr.append(td);body.append(tr);}
 text('task-coverage',note||'Task detail is not available in this snapshot yet.');
}
let latest,latestResources,resourcesBusy=false,metricsBusy=false;
function freshness(){
 const sample=latestResources||latest;if(!sample)return;
 const age=Date.now()-sample.updatedAt,stale=age>(latestResources?20000:180000);
 $('dot').className='dot '+(stale?'stale':'live');
 text('freshness',stale?'Last resource sample '+Math.floor(age/1000)+'s ago':'Updated '+date(sample.updatedAt,{hour:'2-digit',minute:'2-digit',second:'2-digit'}));
}
function renderHost(h){
 text('cpu',h.cpuPercent===null?'?':h.cpuPercent.toFixed(1)+'%');text('memory',h.memoryPercent.toFixed(1)+'%');text('memory-detail',size(h.memoryUsedBytes)+' / '+size(h.memoryTotalBytes));text('disk',h.diskPercent.toFixed(1)+'%');text('disk-detail',size(h.diskUsedBytes)+' / '+size(h.diskTotalBytes));
}
function renderHistory(){
 const live=$('host-range').value==='live';
 hostChart(live?(latestResources?.history||[]):(latest?.history||[]));
 text('history-note',live?'5-second samples ? history starts when monitor starts':'5-minute averages ? retained across restarts');
}
function render(data){
 latest=data;const u=data.usage;
 const cpu=data.cpuSevenDays;
 text('cpu-p95',Number.isFinite(cpu?.p95Percent)?cpu.p95Percent.toFixed(1)+'%':'Unavailable');
 text('cpu-p95-coverage',cpu?.sampleCount?new Intl.NumberFormat('en-US').format(cpu.sampleCount)+' minute samples · available since '+date(cpu.firstAt,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})+' IST':'Collecting CPU history');
 text('spend',money(u.estimatedUsd));text('today',money(u.todayEstimatedUsd));text('tokens',count(u.tokens));text('records',new Intl.NumberFormat('en-US').format(u.records)+' usage records');
 if(!latestResources)renderHost(data.host);
 text('since',u.firstAt?'Since '+date(u.firstAt,{day:'numeric',month:'short',year:'numeric'})+' ? USD, estimated':'No recorded history');
 text('coverage',data.coverage.note);text('warnings',[...data.coverage.warnings,...(u.unpricedRecords?[u.unpricedRecords+' usage records have no verified price and are excluded from the cost total.']:[])].join(' '));text('rates-date',data.coverage.ratesChecked);text('updated','India time ? Costs updated '+date(data.updatedAt,{hour:'2-digit',minute:'2-digit',second:'2-digit'}));
 spendChart(u.daily);renderHistory();models(u.models,u.tokens);tasks(u.tasks||[],u.taskBreakdownNote);freshness();
}
async function load(path){
 const r=await fetch(path,{cache:'no-store',signal:AbortSignal.timeout(12000)});if(!r.ok)throw Error();const data=await r.json();if(data.schema!==1)throw Error();return data;
}
async function refresh(){
 if(metricsBusy)return;metricsBusy=true;
 try{render(await load('/metrics.json'));}
 catch{if(!latest){text('freshness','Waiting for metrics');$('dot').className='dot stale';}}
 finally{metricsBusy=false;}
}
async function refreshResources(){
 if(resourcesBusy)return;resourcesBusy=true;
 try{
  const data=await load('/resources.json');
  if(!latestResources||data.updatedAt>=latestResources.updatedAt){latestResources=data;renderHost(data.host);renderHistory();}
  freshness();
 }catch{if(latestResources)freshness();else if(latest){freshness();text('freshness','Live refresh unavailable ? showing minute sample');$('dot').className='dot stale';}}
 finally{resourcesBusy=false;}
}
$('host-range').addEventListener('change',renderHistory);
document.addEventListener('visibilitychange',()=>{if(!document.hidden){refresh();refreshResources();}});
refresh();refreshResources();setInterval(refresh,30000);setInterval(refreshResources,5000);setInterval(freshness,1000);
