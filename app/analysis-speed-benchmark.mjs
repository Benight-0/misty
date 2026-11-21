// Synthetic conversations only. No messages are sent to contacts or external services.
import fs from 'node:fs';
import {ArchiveStore} from './store.mjs';
import {Briefings,COMPACT_OUTPUT_PROMPT} from './briefings.mjs';
import {LocalOllama} from './ollama-runtime.mjs';
import {validateBriefing} from './briefing-store.mjs';
import {loadHistoryPlan,nextHistoryStep} from './briefing-history.mjs';

const now=Date.parse('2026-10-10T09:00:00Z');
const store=new ArchiveStore(':memory:'),id='!benchmark:localhost';
store.ingest({kind:'room',id,state:{'m.room.name':{name:'Synthetic project discussion'},'m.bridge':{protocol:{id:'discordgo'},channel:{id:'123'},'com.beeper.room_type':'dm'}}});
const exchanges=[
  'I like graph theory and competitive programming. I prefer discussing a concrete example before a formal proof.',
  'I enjoy astronomy and building small telescopes. I prefer written explanations so I can review them later.',
  'The project is a telescope tracking app. We need a calibration screen and a clear indicator when tracking is lost.',
  'I can implement the calibration screen. Could you check the graph search used for route planning?',
  'I tested the route search with disconnected components. It now reports unreachable targets instead of hanging.',
  'I reviewed your patch. The tests look useful, but please keep the previous settings when calibration fails.',
  'We planned to meet on 2026-10-11 to test the prototype at the park.',
  'The park test on 2026-10-11 is cancelled because the equipment is unavailable. We have not chosen a replacement date.',
  'I like asynchronous collaboration and concise written updates. Calls are harder for me to schedule.',
  'I prefer a hands-on prototype to a presentation. Let us record measured tracking error during the next test.',
  'The calibration regression is fixed. I checked that an unsuccessful calibration preserves the previous saved settings.',
  'Thanks, I will review the error measurements after you share them. Could you also include the test conditions?'
];
for(let i=0;i<80;i++)store.ingestEvent({event_id:'$fixture'+i,room_id:id,sender:i%2?'@discord_123:localhost':'@owner:localhost',type:'m.room.message',origin_server_ts:now-86400000+i*60000,content:{msgtype:'m.text',body:exchanges[i%exchanges.length]}});
const plan=loadHistoryPlan(store,id,'gemma4:e4b',now),snapshot=nextHistoryStep(store,plan).snapshot;
let optimized;
const capture=new Briefings(store,{poll:false,clock:()=>now,fetchImpl:async(url,options)=>{optimized=JSON.parse(options.body);throw new Error('Capture only');}});
await capture.runOne();await capture.close();
const original=structuredClone(optimized);
original.messages[1].content=JSON.stringify(snapshot.input);
original.messages[0].content=original.messages[0].content.replace('\n'+COMPACT_OUTPUT_PROMPT,'');
let runtime;
const optimizedOnly=process.argv.includes('--optimized-only');
const capacities=process.argv.find(a=>a.startsWith('--capacities='))?.slice(13).split(',').map(Number);
const requests=Number(process.argv.find(a=>a.startsWith('--requests='))?.slice(11)||2);
if((capacities&&capacities.some(n=>!Number.isInteger(n)||n<1||n>4))||!Number.isInteger(requests)||requests<2||requests>12)throw new Error('Use capacities 1-4 and 2-12 requests.');
const filename=process.argv.includes('--citation-test')?'data/app/analysis-speed-citations.json':capacities?'data/app/analysis-speed-next-benchmark.json':'data/app/analysis-speed-benchmark.json';
const prior=optimizedOnly?JSON.parse(fs.readFileSync('data/app/analysis-speed-benchmark.json','utf8')):null;
const report={at:new Date().toISOString(),synthetic:true,model:'gemma4:e4b',messages:snapshot.input.messages.length,originalInputBytes:Buffer.byteLength(original.messages[1].content),optimizedInputBytes:Buffer.byteLength(optimized.messages[1].content),runs:prior?.runs.filter(r=>r.label==='serial-original')||[]};
try{
  for(const [label,capacity,request] of capacities?capacities.map(n=>['parallel-'+n,n,optimized]):(optimizedOnly?[]:[['serial-original',1,original]]).concat([['parallel-2',2,optimized]])){
    runtime=new LocalOllama({directory:'data/app/speed-benchmark',concurrency:capacity});await runtime.start();
    await fetch(runtime.base+'/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'gemma4:e4b',prompt:'Reply OK.',think:false,stream:false,options:{num_ctx:32768,num_predict:4},keep_alive:'30m'})});
    const started=Date.now(),results=[];
    for(let offset=0;offset<requests;offset+=capacity)await Promise.all(Array.from({length:Math.min(capacity,requests-offset)},async()=>{
      const r=await fetch(runtime.endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(240000)});
      if(!r.ok)throw new Error('Model HTTP '+r.status);
      const output=await r.json(),raw=JSON.parse(output.message.content),validated=validateBriefing(raw,snapshot);
      if(output.done_reason==='length'||!validated.overview.length||validated.people.filter(p=>p.observations.length).length!==2)throw new Error('Fixture lost grounded overview/author profiles or truncated.');
      if(validated.people.filter(p=>p.preferences.length).length!==2||!validated.suggestedEvents.some(e=>/cancel/i.test(e.description)))throw new Error('Fixture lost explicit author preferences or cancelled plan.');
      const claims=[...raw.overview,...raw.recent,...raw.followups,...raw.people.flatMap(p=>[...p.observations,...p.preferences]),...raw.events];
      const maxCitations=Math.max(...claims.map(c=>c.sources.length));if(process.argv.includes('--citation-test')&&maxCitations>4)throw new Error('Model ignored bounded citation schema.');
      results.push({promptTokens:output.prompt_eval_count,outputTokens:output.eval_count,durationMs:Math.round(output.total_duration/1e6),generationMs:Math.round(output.eval_duration/1e6),overview:validated.overview.length,profileAuthors:validated.people.filter(p=>p.observations.length).length,preferences:validated.people.reduce((n,p)=>n+p.preferences.length,0),cancelledEvent:validated.suggestedEvents.some(e=>/cancel/i.test(e.description)),maxCitations});
      console.log(JSON.stringify({label,completed:results.length,outputTokens:output.eval_count}));
    }));
    const seconds=(Date.now()-started)/1000,ps=await(await fetch(runtime.base+'/api/ps')).json();
    const row={label,capacity,requests:results.length,seconds,batchesPerHour:Math.round(results.length*3600/seconds),results,gpuModels:ps.models.map(m=>({size:m.size,sizeVram:m.size_vram,context:m.context_length}))};
    report.runs.push(row);fs.writeFileSync(filename,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(row));await runtime.close();runtime=null;
  }
}finally{await runtime?.close();store.close();}
