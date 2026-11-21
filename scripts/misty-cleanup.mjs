// Explicit owner-requested Discord cleanup. Keeps archive/context and owner text.
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {BotAPI,BOT_OWNER} from '../app/discord-bot.mjs';
import {MistySelf} from '../app/misty-self.mjs';

const [mode,filename]=process.argv.slice(2);
if(!['plan','apply','verify'].includes(mode)||!filename?.startsWith('/var/lib/misty-bot/cleanup-'))throw Error('Use plan/apply/verify and a private /var/lib/misty-bot/cleanup-* file.');
const api=new BotAPI({tokenFile:'/run/credentials/misty-bot.service/discord-token'});
await api.connect(BOT_OWNER);
async function inventory(){
 const own=[],other=[];let before='',newest='';
 for(let pages=0;;pages++){
  if(pages>=100)throw Error('History exceeds scan bound.');
  const page=await api.request('/channels/'+api.channel+'/messages?limit=100'+(before?'&before='+before:''));
  if(!Array.isArray(page)||page.some(m=>!/^\d{16,22}$/.test(m.id)||m.channel_id!==api.channel))throw Error('Invalid history.');
  for(const m of page){if(!newest||BigInt(m.id)>BigInt(newest))newest=m.id;(m.author?.id===api.id?own:other).push(m.id);}
  if(page.length<100)break;const next=page.reduce((a,m)=>BigInt(m.id)<BigInt(a)?m.id:a,page[0].id);
  if(before&&BigInt(next)>=BigInt(before))throw Error('History did not advance.');before=next;
 }
 return {own,other,newest};
}
if(mode==='plan'){
 const data=await inventory();const plan={created:Date.now(),bot:api.id,channel:api.channel,cutoff:String(BigInt(data.newest)+1n),own:data.own,other:data.other};
 fs.writeFileSync(filename,JSON.stringify(plan),{mode:0o600,flag:'wx'});
 console.log(JSON.stringify({planned:plan.own.length,ownerMessages:plan.other.length,cutoff:plan.cutoff}));
}else{
 const plan=JSON.parse(fs.readFileSync(filename,'utf8'));if(plan.bot!==api.id||plan.channel!==api.channel)throw Error('Cleanup binding changed.');
 if(mode==='apply'){
  // Raw DB handle deliberately avoids bot constructor recovery side effects.
  const db=new DatabaseSync('/var/lib/misty-bot/chat.sqlite');db.exec('PRAGMA busy_timeout=5000');
  const store={db,get:(key,fallback=null)=>{const row=db.prepare('SELECT value FROM bot_settings WHERE key=?').get(key);return row?JSON.parse(row.value):fallback;}};
  const relay={store,db,transaction:fn=>{db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}}};
  const self=new MistySelf(relay,api,null),results={selected:plan.own.length,deleted:0,missing:0,unconfirmed:0};
  for(let i=0;i<plan.own.length;i+=10){const r=await self.remove(plan.own.slice(i,i+10),plan.cutoff);for(const k of ['deleted','missing','unconfirmed'])results[k]+=r[k];console.log(JSON.stringify({...results,processed:Math.min(i+10,plan.own.length)}));}
  fs.writeFileSync(filename+'.result',JSON.stringify(results),{mode:0o600});db.close();
 }
 const now=await inventory(),remaining=plan.own.filter(id=>now.own.includes(id)),missingOwner=plan.other.filter(id=>!now.other.includes(id));
 console.log(JSON.stringify({verified:remaining.length===0&&missingOwner.length===0,remainingOldBotMessages:remaining.length,preservedOwnerMessages:plan.other.length-missingOwner.length,missingOwnerMessages:missingOwner.length,newBotMessages:now.own.filter(id=>!plan.own.includes(id)).length}));
 if(remaining.length||missingOwner.length)process.exitCode=1;
}
