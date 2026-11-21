// Isolated calibration: real compact profile, synthetic evidence, no Discord API.
import {spawnSync} from 'node:child_process';
import {BotStore} from '../app/discord-bot.mjs';
import {ApolloMessenger} from '../app/apollo.mjs';
import {MistyNotifications} from '../app/misty-notifications.mjs';
import {OpenAIAnalysis} from '../app/openai-analysis.mjs';

const p=spawnSync('python3',['scripts/misty-archive-query.py','/var/lib/archival/data/archive.sqlite'],{input:JSON.stringify({op:'profile',args:{compact:true}}),encoding:'utf8'});
if(p.status)throw Error('Read-only profile fixture failed.');const profile=JSON.parse(p.stdout);
const fixtures=[
 {name:'useful-discussion-without-owner-request',treatment:'S',expected:true,texts:[
  'I have been building a local agent that searches messages with SQLite FTS5 instead of uploading the entire archive.',
  'The useful part is combining cheap chunk summaries with original-message retrieval; dense-only search missed exact names and old code identifiers.',
  'A hybrid of prefix FTS queries and short semantic summaries worked much better for our coding-agent memory experiments.',
  'I can explain the implementation tradeoffs here. Does anyone have experience with incremental indexes for local-first personal tools?']},
 {name:'routine-filler',treatment:'S',expected:false,texts:['gm','lol','nice','I reached 2000 today','haha','25','26','27']},
 {name:'priority-mild-creative-discussion',treatment:'SP',expected:true,texts:[
  'I was experimenting with photographing the evening sky; the softer colours seem nicer than boosting every colour in the edit.',
  'I like that atmospheric look too. I am trying to pair short poems with those photos in a small personal page.',
  'Thinking about how to keep it simple, mostly a photo and a few lines, rather than a heavy portfolio layout.']}
];
const report=[];
for(const fixture of fixtures){
 const store=new BotStore(':memory:'),client=new OpenAIAnalysis({keyFile:'/etc/archival/openai-key'});
 const messages=Array.from({length:50},(_,i)=>({id:'fixture-'+i,body:i<fixture.texts.length?fixture.texts[i]:'continued routine chatter '+i,is_me:0,ts:Date.now(),author:'fixture member'}));
 const archive={read:async(op,args)=>op==='events'?{rows:[]}:op==='profile'?profile:args.hashes?{eligible:true,valid:true,sources:args.ids.map(id=>({id,url:'https://example.invalid/fixture/'+id}))}:{eligible:true,chat:{name:fixture.name,treatment:fixture.treatment},newMessages:messages,hashes:Object.fromEntries(messages.map(m=>[m.id,'fixture-hash'])),coverage:{included:50,truncated:false},recent:{rows:[]},summary:{available:false}}};
 const relay=new ApolloMessenger(store,client,archive),watch=new MistyNotifications(relay,archive,{name:'Apollo'});
 watch.ingest(messages.map((m,i)=>({seq:i+1,message_id:m.id,room_id:fixture.name,name:fixture.name,kind:'channel',platform:'discord',treatment:fixture.treatment,ts:m.ts,is_me:0})));
 await watch.tick();const job=store.db.prepare('SELECT state,decision FROM misty_watch_jobs').get(),decision=JSON.parse(job.decision);
 report.push({fixture:fixture.name,expected:fixture.expected,actual:decision.notify,state:job.state,reason:decision.reason,profileFindings:profile.rows.length,profileTruncated:profile.truncated});
 await watch.close();await relay.close();store.close();
}
console.log(JSON.stringify({fixtures:report,discordSends:0,productionWrites:0}));
if(report.some(r=>r.state!=='done'||r.expected!==r.actual))process.exitCode=1;
