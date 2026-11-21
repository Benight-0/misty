import {randomBytes} from 'node:crypto';
import {BOT_OWNER} from './discord-bot.mjs';
import {choicesFor} from './misty-components.mjs';
import {commandText} from './misty-style.mjs';
import {ownerChannel} from './owner-routing.mjs';

const snowflake=id=>typeof id==='string'&&/^\d{16,22}$/.test(id);
const fields=components=>(components||[]).flatMap(c=>c.type===4?[c]:fields(c.components||(c.component?[c.component]:[])));
const input=(id,label,value,style=2)=>({type:1,components:[{type:4,custom_id:id,label,style,value,max_length:4000,required:false}]});

// Called directly from Gateway delivery, outside the AI reply queue. No model
// request can delay the initial acknowledgement past Discord's three seconds.
export async function handleInteraction(relay,event,api){
 if(!event||event.guild_id||!(api.owns?api.owns(event.user?.id,event.channel_id):event.user?.id===BOT_OWNER&&event.channel_id===api.channel)||event.user?.bot||event.channel_id!==api.channel||event.application_id!==api.id||!snowflake(event.id)||![3,5].includes(event.type))return false;
 const respond=data=>api.respond(event,data);
 const reject=message=>respond({type:4,data:{content:message,flags:64,allowed_mentions:{parse:[]}}});
 if(relay.db.prepare('SELECT id FROM relay_interactions WHERE id=?').get(event.id))return false;
 const match=/^misty:(review|send|work|chat|edit|search|cancel|editform|searchform):([a-f0-9]{10,32})$/.exec(event.data?.custom_id||'');
 if(!match){await reject('that control is no longer available.');return false;}
 const [,action,key]=match;
 let form,d;
 try{
  if(event.type===5){
   form=relay.db.prepare('SELECT * FROM relay_forms WHERE id=? AND state=\'open\' AND expires>?').get(key,Date.now());
   if(!form||form.kind+'form'!==action)throw new Error('stale');
   d=relay.findDraft(form.code);
  }else{
   if(action.endsWith('form'))throw new Error('invalid');
   d=relay.findDraft(key);
   if(event.message?.author?.id!==api.id||!snowflake(event.message?.id))throw new Error('invalid');
   const notice=relay.db.prepare("SELECT payload FROM relay_notices WHERE message_id=? AND status='sent' AND source LIKE ?").get(event.message.id,'draft:'+d.code+':%');
   if(!notice||!JSON.parse(notice.payload).components?.some(row=>row.components.some(c=>c.custom_id===event.data.custom_id)))throw new Error('invalid');
  }
  const channel=ownerChannel(relay.db,d.source);
  if(channel&&channel!==event.channel_id)throw Error('wrong owner DM');
 }catch{await reject(commandText.stale);return false;}
 if(event.type===3&&['edit','search'].includes(action)){
  const id=randomBytes(12).toString('hex');
  let components;
  if(action==='search')components=[input('query','Chat title or project','',1)];
  else{
   const parts=[];for(let i=0;i<d.prompt.length;){let end=Math.min(i+3900,d.prompt.length);if(/[\uD800-\uDBFF]/.test(d.prompt[end-1]))end--;parts.push(d.prompt.slice(i,end));i=end;}
   components=parts.map((part,i)=>input('prompt'+i,parts.length===1?'Exact prompt':`Exact prompt (${i+1}/${parts.length}, joined in order)`,part));
  }
  relay.db.prepare("INSERT INTO relay_forms(id,code,kind,expires,state) VALUES(?,?,?,?,'open')").run(id,d.code,action,Date.now()+600000);
  try{
   await respond({type:9,data:{custom_id:`misty:${action}form:${id}`,title:action==='edit'?'Edit task prompt':'Find a Codex chat',components}});
   relay.db.prepare('INSERT OR IGNORE INTO relay_interactions VALUES(?,?,?,?,?)').run(event.id,d.code,action,action==='edit'?'Opened the exact prompt editor.':'Opened chat search.',Date.now());
   return true;
  }catch{relay.db.prepare("UPDATE relay_forms SET state='failed' WHERE id=?").run(id);throw new Error('Could not open form.');}
 }
 // Ack first. If delivery is ambiguous, perform no action; another click can
 // retry safely. Database transactions then bind exact prompt and destination.
 await respond({type:6});
 relay.transaction(()=>{
  if(relay.db.prepare('SELECT id FROM relay_interactions WHERE id=?').get(event.id))return;
  let body,reply;
  try{
   d=relay.findDraft(d.code);
   if(action==='review'){
    relay.refresh(d,{},{formal:true});reply='Here’s the exact prompt and destination to review.';body='Requested the exact command card; no work submitted.';
   }else if(action==='send'||action==='work'){
    reply=action==='work'?relay.work.approve(d):relay.approve(d);body=action==='work'?'Approved bounded continuation of the displayed task in a new dedicated chat.':'Approved the displayed exact prompt and chat with Send to Codex.';
   }else if(action==='cancel'){
    relay.db.prepare("UPDATE relay_drafts SET state='cancelled' WHERE id=?").run(d.id);relay.retire(d,'Cancelled');reply=commandText.cancelled;body='Cancelled this pending draft.';
   }else if(action==='chat'){
    const values=event.data.values,choice=values?.length===1&&/^\d{1,2}$/.test(values[0])?choicesFor(d)[Number(values[0])]:null;
    if(!choice)throw new Error('choose one of the chats in the dropdown.');
    if(choice.kind==='existing'&&!relay.catalog().chats.some(t=>t.id===choice.id&&t.cwd.toLowerCase()===choice.cwd.toLowerCase()))throw new Error('that chat is no longer in the laptop catalog.');
    relay.refresh(d,{target:JSON.stringify(choice),reason:'Selected by you from the chat menu.'});reply=commandText.revised;body='Selected destination: '+JSON.stringify(choice);
   }else if(action==='editform'){
    const entries=fields(event.data.components),expected=Math.ceil(d.prompt.length/3900);
    const byId=new Map(entries.map(f=>[f.custom_id,f.value]));
    // The actual split may gain one part when a surrogate pair crosses a boundary.
    const count=entries.length;
    if(count<expected||count>5||byId.size!==count||entries.some(f=>!/^prompt[0-4]$/.test(f.custom_id)||typeof f.value!=='string'||f.value.length>4000))throw new Error('the prompt form was incomplete. open Edit prompt again.');
    let prompt='';for(let i=0;i<count;i++){if(!byId.has('prompt'+i))throw new Error('the prompt form was incomplete.');prompt+=byId.get('prompt'+i);}
    if(!prompt.trim()||prompt.length>16000)throw new Error('the prompt needs to contain text, up to 16,000 characters.');
    relay.refresh(d,{prompt,reason:'Prompt edited by you; the selected chat is unchanged.'});reply=commandText.revised;body='Replaced the exact draft prompt: '+prompt;
   }else if(action==='searchform'){
    const query=fields(event.data.components).find(f=>f.custom_id==='query')?.value?.trim().toLowerCase();
    if(!query||query.length>300)throw new Error('enter a chat title or project name, up to 300 characters.');
    const all=relay.catalog().chats.filter(t=>(t.title+' '+t.cwd+' '+t.preview).toLowerCase().includes(query));
    if(!all.length)throw new Error('no chats matched that. try Find chat again with a title or workspace name.');
    const target=JSON.parse(d.target),matches=all.slice(0,23).map(t=>({kind:'existing',id:t.id,title:t.title,cwd:t.cwd}));
    relay.refresh(d,{candidates:JSON.stringify([target,{kind:'new',title:'New conversation',cwd:target.cwd},...matches])});
    reply=`found ${all.length} matching chats${all.length>23?' (showing the first 23; narrow your search for more)':''}. choose one in the new card's dropdown, then send when it looks right.`;body='Searched the Codex catalog for: '+query;
   }else throw new Error('that control is unavailable.');
   if(form)relay.db.prepare("UPDATE relay_forms SET state='used' WHERE id=?").run(form.id);
  }catch(error){reply=error.message;body='Tried '+action+' on the displayed draft; it was not applied.';}
  relay.db.prepare('INSERT INTO relay_interactions VALUES(?,?,?,?,?)').run(event.id,d.code,action,body,Date.now());
  relay.notice('interaction:'+event.id,reply);
 });
 relay.onNotice();return true;
}
