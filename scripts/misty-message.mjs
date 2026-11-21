// Owner-only VM tool. A draft is generated unless --send is explicitly supplied.
// Usage: node scripts/misty-message.mjs --channel ID --instruction "..." [--send] [--id chat-UUID]
//        node scripts/misty-message.mjs --channel ID --message "..." --send
import {randomUUID} from 'node:crypto';
import {ArchiveStore} from '../app/store.mjs';
import {ChatSender} from '../app/chat.mjs';
import {NativeChat} from '../app/native-chat.mjs';
import {draftChat} from '../app/chat-ai.mjs';
import {OpenAIAnalysis} from '../app/openai-analysis.mjs';

const flags=new Map(),args=process.argv.slice(2);
for(let k=0;k<args.length;k++){const key=args[k];if(key==='--send')flags.set(key,true);else if(['--channel','--room','--instruction','--message','--id'].includes(key)&&args[k+1]&&!args[k+1].startsWith('--'))flags.set(key,args[++k]);else throw new Error('Unknown or incomplete argument: '+key);}
const store=new ArchiveStore(process.env.ARCHIVAL_DB||'/var/lib/archival/data/archive.sqlite');
let queue=Promise.resolve();const serial=fn=>{const next=queue.then(fn);queue=next.catch(()=>{});return next;};
const sender=new ChatSender(store,serial,null,{native:new NativeChat(store),recover:false});
try{
 const room=flags.get('--room')?store.room(flags.get('--room')):store.statement("SELECT * FROM conversations WHERE platform='discord' AND remote_id=? AND server_id='' AND kind IN ('dm','group')").get(flags.get('--channel')||'');
 if(!room)throw new Error('Choose an existing private Discord conversation with --room or --channel.');
 const id=flags.get('--id')||'chat-'+randomUUID();
 const existing=sender.outgoing('',id)[0];
 if(existing){if(existing.room_id!==room.id)throw new Error('Submission ID belongs to another conversation.');console.log(JSON.stringify({id,status:existing.status,platform:existing.platform,messageId:existing.event_id,repeated:true}));}
 else{
  if(flags.has('--instruction')===flags.has('--message'))throw new Error('Supply either --instruction or --message.');
  let body=flags.get('--message');
  if(flags.has('--instruction')){
   const client=new OpenAIAnalysis({keyFile:'/etc/archival/openai-key',onUsage:u=>store.statement('INSERT OR IGNORE INTO openai_usage VALUES(?,?,?,?,?,?,?,?)').run(u.requestId,u.room,u.model,u.inputTokens,u.outputTokens,u.cachedTokens,u.at,u.status)});
   body=(await draftChat(store,sender,client,{room:room.id,instruction:flags.get('--instruction'),model:process.env.ARCHIVAL_MODEL||'gpt-5.6-luna'})).body;
  }
  if(!flags.get('--send'))console.log(JSON.stringify({room:room.id,body,sent:false}));
  else{
   const row=await sender.send({id,room:room.id,body});await sender.jobs.get(row.id);
   const result=sender.outgoing('',id)[0];
   console.log(JSON.stringify({id,status:result.status,platform:result.platform,messageId:result.event_id,error:result.error}));
   if(result.status!=='sent')process.exitCode=2;
  }
 }
}finally{await sender.close();store.close();}
