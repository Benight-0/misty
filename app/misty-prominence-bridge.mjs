import http from 'node:http';
import fs from 'node:fs';
import {randomUUID,randomBytes,timingSafeEqual} from 'node:crypto';
import {MistyDirect} from './misty-direct.mjs';
import {CodexEvents} from './codex-events.mjs';

// Card admission and owner-request-scoped direct admission share the durable queue.
export class ProminenceBridge {
 constructor(relay){this.relay=relay;relay.direct??=new MistyDirect(relay);relay.codexEvents??=new CodexEvents(relay);}
 async execute(op,args={}){
  const r=this.relay;
  if(op==='overlay_input'){
   const {id,channel,owner,body,at}=args;
   if(!/^\d{16,22}$/.test(id||'')||!r.messageApi?.owns(owner,channel)||typeof body!=='string'||!body.trim()||body.length>16000||
      !Number.isSafeInteger(at)||Math.abs(Date.now()-at)>30000||
      Math.abs(Number((BigInt(id)>>22n)+1420070400000n)-at)>1)throw Error('Invalid owner overlay input.');
   const old=r.db.prepare('SELECT channel,body,ts,status FROM bot_turns WHERE id=?').get(id);
   if(old){if(old.channel!==channel||old.body!==body||old.ts!==at||!['external','external_sent'].includes(old.status))throw Error('Overlay message ID collision.');return {accepted:true,reused:true};}
   r.db.prepare("INSERT INTO bot_turns(id,channel,body,ts,status) VALUES(?,?,?,?,'external')").run(id,channel,body.trim(),at);
   return {accepted:true,reused:false};
  }
  if(op.startsWith('overlay_gmail_')){
   const allowed={overlay_gmail_accounts:'email_accounts',overlay_gmail_navigation:'email_navigation',
    overlay_gmail_list:'email_list',overlay_gmail_open:'email_open',
    overlay_gmail_category_save:'email_category_save',overlay_gmail_category_delete:'email_category_delete',
    overlay_gmail_action:'email_action',overlay_gmail_attachment_chunk:'email_attachment_chunk'};
   if(!allowed[op])throw Error('Unsupported overlay Gmail operation.');
   return r.messages.backend.call(allowed[op],args);
  }
  if(op==='overlay_approvals')return r.messages.pendingApprovals();
  if(op==='overlay_approval_send')return r.messages.confirmOverlay(args);
  if(op==='overlay_approval_cancel')return r.messages.cancelOverlay(args);
  if(op==='overlay_approval_edit')return r.messages.editOverlay(args);
  if(op==='overlay_email_preview')return r.messages.proposeOverlayEmail(args);
  if(op.startsWith('message_')){
   if(!r.messages)throw Error('Personal-account messaging is unavailable.');
   if(op==='message_inspect')return r.messages.inspect(args);
   if(op==='message_draft'){const result=await r.messages.propose(args);r.onNotice();return result;}
   if(op==='message_confirm')throw Error('Confirm this message in the Misty app.');
   if(op==='message_status')return r.messages.status(String(args.code||''));
   throw Error('Unsupported personal-message operation.');
  }
  if(op.startsWith('email_')){
   if(!r.messages)throw Error('Gmail agent access is unavailable.');
   if(op==='email_accounts')return r.messages.emailAccounts();
   if(op==='email_save_draft')return r.messages.saveEmailDraft(args);
   if(op==='email_send_preview'){const result=await r.messages.proposeEmail(args);r.onNotice();return result;}
   if(op==='email_send_confirm')return r.messages.confirmText(String(args.code||''),String(args.ownerMessageId||''));
   if(op==='email_send_status')return r.messages.status(String(args.code||''));
   throw Error('Unsupported Gmail operation.');
  }
  if(op==='send'){const result=await r.direct.send(args);r.onNotice();return result;}
  if(op==='overlay_codex_send')return r.direct.sendFromOverlay(args);
  if(op==='events'){
   const feed=r.codexEvents.read(args.after);
   return {...feed,events:feed.events.map(e=>({...e,title:r.catalog().chats.find(c=>c.id===e.thread_id)?.title||e.thread_id}))};
  }
  if(op==='status')return {laptopOnline:r.online(),catalogAt:r.catalog().at,notifications:r.notifications?.details()||null,work:r.work.list(),jobs:r.db.prepare('SELECT code,status,thread_id,created,updated FROM relay_jobs ORDER BY created DESC LIMIT 30').all()};
  if(op==='chats'){
   const q=String(args.query||'').toLowerCase();
   return {laptopOnline:r.online(),catalogAt:r.catalog().at,chats:r.catalog().chats.filter(t=>(t.title+' '+t.cwd+' '+t.preview).toLowerCase().includes(q)).slice(0,100)};
  }
  if(op==='history'){
   const before=Number(args.before)||Number.MAX_SAFE_INTEGER;
   const rows=r.db.prepare('SELECT id,body,reply,ts,status FROM bot_turns WHERE ts<? ORDER BY ts DESC,id DESC LIMIT 50').all(before).reverse();
   return {rows,nextBefore:rows.length===50?rows[0].ts:null,coverage:'Saved owner/Misty turns from the previous runtime. Originals are retained.'};
  }
  if(op==='outbound'){
   const after=Number(args.after)||0;
   const rows=r.db.prepare("SELECT seq,source,body,message_id FROM relay_notices WHERE status='sent' AND body<>'' AND message_id<>'' AND (?=0 OR source NOT LIKE 'watch:%') ORDER BY seq DESC LIMIT 100").all(Number(r.store.get('conversation_monitor')==='apollo')).reverse();
   return {rows:rows.filter(n=>/^\d{16,22}$/.test(n.message_id)).map(n=>({...n,at:Number((BigInt(n.message_id)>>22n)+1420070400000n)})).filter(n=>n.at>after),limit:100};
  }
  if(op==='record'){
   if(!Array.isArray(args.ownerMessageIds)||!args.ownerMessageIds.length||args.ownerMessageIds.length>100||typeof args.reply!=='string'||args.reply.length>100000)throw Error('Invalid conversation record.');
   return r.transaction(()=>{
    for(const id of args.ownerMessageIds){
     const row=r.db.prepare('SELECT status FROM bot_turns WHERE id=?').get(id);
     if(!row||!['external','external_sent'].includes(row.status))throw Error('Owner message is not assigned to the fork.');
     r.db.prepare("UPDATE bot_turns SET reply=?,status='external_sent' WHERE id=?").run(args.reply,id);
    }
    return {saved:args.ownerMessageIds.length};
   });
  }
  if(op==='knowledge_find'||op==='knowledge_read')return r.knowledge.execute(op,args);
  if(op==='result')return r.knowledge.execute('misty_details',{kind:'result',id:String(args.code||''),offset:Number(args.offset)||0});
  if(op==='archive'){
   if(!r.archive)throw Error('Archive unavailable.');
   const allowed=new Set(['chats','search','source','summary','context','servers','server_summary','server_history','profile','schema','sql','events','supervisor_events']);
   if(!allowed.has(args.op))throw Error('Unsupported archive operation.');
   return r.archive.read(args.op,args.args||{});
  }
  if(op==='control')return r.knowledge.execute('misty_control',args);
  if(op==='draft'){
   const ownerId=String(args.ownerMessageId||'');
   if(!/^\d{16,22}$/.test(ownerId)||!r.db.prepare('SELECT 1 FROM bot_turns WHERE id=?').get(ownerId))throw Error('A recorded owner message is required.');
   if(typeof args.prompt!=='string'||!args.prompt.trim()||args.prompt.length>10000)throw Error('Provide an exact prompt up to 10000 characters.');
   const chat=r.catalog().chats.find(t=>t.id===args.chatId);
   if(args.chatId!=='NEW'&&!chat)throw Error('Choose an actual catalog chat ID.');
   const known=[r.defaultCwd,...r.catalog().chats.map(t=>t.cwd)];
   if(!chat&&!known.includes(args.workspace))throw Error('Choose a known workspace.');
   const target=chat?{kind:'existing',id:chat.id,title:chat.title,cwd:chat.cwd}:{kind:'new',title:String(args.title||'Misty work').slice(0,150),cwd:args.workspace};
   const source='prominence:'+ownerId;
   return r.transaction(()=>{
    const old=r.db.prepare('SELECT * FROM relay_drafts WHERE source=?').get(source);
    if(old){
     if(old.prompt!==args.prompt||old.target!==JSON.stringify(target))throw Error('This owner request already has a different draft; edit the existing card or request a new one.');
     return {code:old.code,state:old.state,requiresOwnerApproval:true,reused:true};
    }
    const now=Date.now(),d={id:randomUUID(),source,code:randomBytes(5).toString('hex'),original:r.db.prepare('SELECT body FROM bot_turns WHERE id=?').get(ownerId).body,prompt:args.prompt,target:JSON.stringify(target),candidates:JSON.stringify([target]),reason:String(args.reason||'Chosen from the current Codex catalog.').slice(0,500),state:'pending',created:now,expires:now+86400000};
    r.db.prepare('INSERT INTO relay_drafts VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(...Object.values(d));r.preview(d,{formal:true});r.onNotice();
    return {code:d.code,state:'pending',target,requiresOwnerApproval:true};
   });
  }
  throw Error('Unsupported bridge operation.');
 }
}

export function serveProminenceBridge(relay,{tokenFile,port=8792,readOnly=false}={}){
 const token=fs.readFileSync(tokenFile,'utf8').trim();if(token.length<32)throw Error('Invalid fork bridge credential.');
 const bridge=new ProminenceBridge(relay);
 const server=http.createServer(async(req,res)=>{
  const auth=Buffer.from(String(req.headers.authorization||'')),expected=Buffer.from('Bearer '+token);
  if(auth.length!==expected.length||!timingSafeEqual(auth,expected)){res.writeHead(401).end();return;}
  if(req.method!=='POST'||req.url!=='/call'){res.writeHead(404).end();return;}
  try{let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>32768)throw Error('Request too large.');}
   const {op,args={}}=JSON.parse(body);
   if(readOnly){
    if(!['status','chats','knowledge_find','knowledge_read','events'].includes(op))throw Error('Read-only Codex history access.');
    if(op==='knowledge_find'&&args.kind!=='codex')throw Error('Codex history only.');
    if(op==='knowledge_read'&&!String(args.document||'').startsWith('codex:'))throw Error('Codex history only.');
   }
   const result=await bridge.execute(op,args);res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(result));
  }catch(e){res.writeHead(400,{'Content-Type':'application/json'}).end(JSON.stringify({error:String(e.message).slice(0,300)}));}
 });
 server.requestTimeout=15000;server.listen(port,'127.0.0.1');return server;
}
