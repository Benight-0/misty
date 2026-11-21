import fs from 'node:fs';
import http from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {messageTarget} from './message-target.mjs';
import {GmailOverlay} from './gmail-overlay.mjs';

export {messageTarget} from './message-target.mjs';
export function serveMessageBackend(store,chat,{tokenFile,port=8795,gmail=null}={}){
 const token=fs.readFileSync(tokenFile,'utf8').trim();if(token.length<32)throw Error('Invalid message credential.');
 const overlay=gmail?new GmailOverlay(gmail):null;
 const server=http.createServer(async(req,res)=>{
  const actual=Buffer.from(req.headers.authorization||''),expected=Buffer.from('Bearer '+token);
  if(actual.length!==expected.length||!timingSafeEqual(actual,expected)){res.writeHead(401).end();return;}
  if(req.method!=='POST'||req.url!=='/call'){res.writeHead(404).end();return;}
  try{
   let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>100000)throw Error('Request too large.');}
   const {op,args={}}=JSON.parse(text);let result;
   if(typeof op!=='string'||!args||typeof args!=='object')throw Error('Invalid operation.');
   if(op.startsWith('email_')){
    if(!gmail)throw Error('Gmail agent access is unavailable.');
    if(op==='email_accounts'){
     const status=await gmail.status();result={accounts:status.accounts.map(a=>({id:a.id,email:a.email,enabled:!!a.enabled,linked:a.linked,canSend:a.canSend,canDraft:a.canDraft,canManage:a.canManage,authorizationRequired:a.authorizationRequired,error:a.error,lastSync:a.last_sync}))};
    }else if(op==='email_navigation')result=await overlay.navigation(args.account);
    else if(op==='email_list')result=await overlay.list(args);
    else if(op==='email_open')result=await overlay.open(args.id);
    else if(op==='email_category_save')result=overlay.saveCategory(args);
    else if(op==='email_category_delete')result=overlay.deleteCategory(args.id);
    else if(op==='email_action')result=await gmail.modifyEmail(args.id,args.action);
    else if(op==='email_attachment_chunk'){
     const offset=Number(args.offset||0);
     if(!Number.isSafeInteger(offset)||offset<0)throw Error('Invalid attachment offset.');
     const file=gmail.attachment(args.id,args.key);
     if(!file)throw Error('Attachment is not stored.');
     if(offset>file.content.length)throw Error('Attachment offset is beyond the file.');
     const bytes=file.content.subarray(offset,Math.min(file.content.length,offset+24000));
     result={name:file.name,mime:file.mime,size:file.content.length,offset,data:bytes.toString('base64'),next:offset+bytes.length<file.content.length?offset+bytes.length:null};
    }else if(op==='email_inspect')result=await gmail.previewEmail(args);
    else if(op==='email_save_draft')result=await gmail.saveDraft(args);
    else if(op==='email_status'){
     const row=args.id?gmail.outgoing(String(args.id))[0]:null;result=row?{id:row.id,target_json:JSON.stringify({platform:'gmail',account:row.account_id,from:row.from,to:row.to,cc:row.cc,bcc:row.bcc,subject:row.subject,replyTo:row.replyTo,threadId:row.threadId}),body:row.body,status:row.status,remote_id:row.remote_id,error:row.error}:null;
    }else if(op==='email_send'){
     const target=args.target;
     if(target?.platform!=='gmail'||typeof args.body!=='string'||typeof args.id!=='string')throw Error('Invalid email submission.');
     const input={account:target.account,to:target.to.join(', '),cc:target.cc.join(', '),bcc:target.bcc.join(', '),subject:target.subject,replyTo:target.replyTo,body:args.body};
     const verified=await gmail.previewEmail(input);
     if(!verified.capability.allowed||JSON.stringify(verified.target)!==JSON.stringify(target))throw Error('Email account or recipients changed. Request a fresh preview.');
     const prepared=await gmail.prepare({...input,submissionId:args.id});
     const sent=await gmail.send(prepared.id);
     result={id:sent.id,target_json:JSON.stringify(target),body:sent.body,status:sent.status,remote_id:sent.remote_id,error:sent.error};
    }else throw Error('Unsupported email operation.');
   }
   else if(op==='status')result=chat.outgoing('',String(args.id))[0]||null;
   else {
    const room=store.room(String(args.room||''));
    if(!room||!['discord','whatsapp'].includes(room.platform)||!(['dm','group'].includes(room.kind)||room.platform==='discord'&&room.kind==='channel'&&room.server_id))throw Error('Choose an existing connected DM, group DM or Discord server text channel.');
    if(!['inspect','send'].includes(op))throw Error('Unsupported message operation.');
    const inspected=chat.inspect?await chat.inspect(room,{replyTo:op==='send'?args.target?.replyTo?.messageId||'':args.replyTo||''}):{target:messageTarget(room),capability:chat.capability(room)};
    if(room.server_id&&!chat.inspect)throw Error('Server verification is unavailable.');
    const {target}=inspected;
    if(op==='inspect')result=inspected;
    else if(op==='send'){
     if(JSON.stringify(args.target)!==JSON.stringify(target))throw Error('The destination changed.');
     result=await chat.send(args);
    }else throw Error('Unsupported message operation.');
   }
   res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(result));
  }catch(error){res.writeHead(400,{'Content-Type':'application/json'}).end(JSON.stringify({error:error.message}));}
 });server.requestTimeout=60000;server.listen(port,'127.0.0.1');return server;
}
export class MessageBackend {
 constructor({tokenFile,port=8795,fetchImpl=fetch}={}){this.tokenFile=tokenFile;this.port=port;this.fetch=fetchImpl;}
 async call(op,args){
  const token=fs.readFileSync(this.tokenFile,'utf8').trim();
  const response=await this.fetch(`http://127.0.0.1:${this.port}/call`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({op,args}),signal:AbortSignal.timeout(60000)});
  const result=await response.json();if(!response.ok)throw Error(result.error||'Message service unavailable.');return result;
 }
}
