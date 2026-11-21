import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
function browser(){const elements=new Map(),document={querySelector(s){if(!elements.has(s))elements.set(s,{innerHTML:'',value:'',textContent:'',hidden:false,open:false,showModal(){this.open=true;},close(){this.open=false;},querySelectorAll:()=>[]});return elements.get(s);},querySelectorAll:()=>[],addEventListener(){}};
  const ctx=vm.createContext({document,URLSearchParams,setTimeout:()=>1,clearTimeout(){}}),app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');vm.runInContext(app.slice(0,app.lastIndexOf('(async()=>')),ctx);vm.runInContext(readFileSync(new URL('../public/briefings.js',import.meta.url),'utf8'),ctx);return {ctx,elements,run:code=>vm.runInContext(code,ctx)};
}
const data={eligible:true,job:{enabled:1,error:''},model:'gemma4:e4b',generatedAt:1,stale:false,events:[{id:'suggestion-a',room_id:'!private:localhost',title:'Meeting',description:'A suggested plan',date:'2026-10-11',time:'',status:'proposed',people:['p0'],evidence:['$a']}],payload:{room:{name:'Private chat'},coverage:{messages:10,texts:10,sampled:10,first:1,last:2},overview:[{text:'Discusses <script>coding</script>',evidence:['$a']}],recent:[],followups:[],trends:[],people:[{id:'p0',name:'Alex',messages:5,texts:5,first:1,last:2,customNote:'',customLabel:'',topics:[],observations:[],preferences:[]}]}};
test('briefing rendering is inert, source-linked, and does not confirm events automatically',async()=>{
  const b=browser(),calls=[];b.ctx.handler=async(path,input)=>{calls.push({path,input});return structuredClone(data);};b.run('api=handler;');await b.run("showChatBriefing('!private:localhost')");const html=b.elements.get('#modal-content').innerHTML;assert.match(html,/Conversation summary/);assert.match(html,/&lt;script&gt;/);assert.match(html,/Source 1/);assert.match(html,/proposed/);assert.equal(calls.length,1);
});
test('event review is a local form and saves only through explicit submission',async()=>{
  const b=browser(),calls=[];b.ctx.handler=async(path,input)=>{calls.push({path,input});return structuredClone(data);};b.run('api=handler;');await b.run("editChatEvent('!private:localhost','suggestion-a')");assert.equal(calls.filter(c=>c.input).length,0);assert.match(b.elements.get('#modal-content').innerHTML,/does not send invitations/);
  b.run("$('#event-title').value='Reviewed meeting';$('#event-description').value='Bring draft';$('#event-date').value='2026-10-12';$('#event-time').value='14:00';$('#event-status').value='confirmed';");await b.run("$('#briefing-event-form').onsubmit({preventDefault(){}})");const saved=calls.find(c=>c.path==='briefings/event');assert.equal(saved.input.title,'Reviewed meeting');assert.equal(saved.input.status,'confirmed');assert.deepEqual(JSON.parse(JSON.stringify(saved.input.evidence)),['$a']);
});

test('full-history coverage and chronological findings are rendered without claiming sampled work is complete',async()=>{
  const b=browser(),full=structuredClone(data);full.payload.coverage={...full.payload.coverage,mode:'full-history',analyzed:10,batches:2,complete:true};full.history={completed_texts:10,texts:10,completed_batches:2,total_batches:2,stage:'complete'};
  b.ctx.handler=async()=>structuredClone(full);b.run('api=handler;');await b.run("showChatBriefing('!private:localhost')");let html=b.elements.get('#modal-content').innerHTML;assert.match(html,/10 analyzed across 2 batches/);assert.match(html,/History findings/);assert.doesNotMatch(html,/sampled for interpretation/);
  b.ctx.handler=async()=>({total:2,offset:0,limit:5,progress:{completed_texts:10,texts:10,completed_batches:2},chapters:[{index:1,first:1,last:2,messages:5,status:'complete',payload:{overview:[{text:'<script>unsafe</script>',evidence:['$a']}],people:[],suggestedEvents:[]}}]});b.run('api=handler;');await b.run("showBriefingHistory('!private:localhost')");html=b.elements.get('#modal-content').innerHTML;assert.match(html,/&lt;script&gt;unsafe/);assert.match(html,/Source 1/);assert.match(html,/10 \/ 10 text messages read/);
});
