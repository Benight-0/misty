import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {randomBytes,createHash,randomUUID} from 'node:crypto';
import {applyGmailPage,parseEmail,textBodyPart} from './gmail-store.mjs';
import {prepareEmail,replyDefaults} from './gmail-compose.mjs';

export const GMAIL_SCOPE='https://www.googleapis.com/auth/gmail.readonly';
export const GMAIL_SEND_SCOPE='https://www.googleapis.com/auth/gmail.send';
export const GMAIL_COMPOSE_SCOPE='https://www.googleapis.com/auth/gmail.compose';
export const GMAIL_MODIFY_SCOPE='https://www.googleapis.com/auth/gmail.modify';
export const GMAIL_SCOPES=[GMAIL_SCOPE,GMAIL_SEND_SCOPE];
const canSend=scopes=>scopes?.includes(GMAIL_SEND_SCOPE)||scopes?.includes(GMAIL_COMPOSE_SCOPE);
const GOOGLE_TOKEN='https://oauth2.googleapis.com/token';
const API='https://gmail.googleapis.com/gmail/v1/users/me/';
const defaultDirectory=fileURLToPath(new URL('../data/gmail/',import.meta.url));
const accountKey=email=>createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0,24);
class GmailError extends Error {constructor(message,status=0){super(message);this.status=status;}}
export function desktopClient(json) {
  const client=json?.installed;
  if(!client || typeof client.client_id!=='string' || !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(client.client_id)
    || typeof client.client_secret!=='string' || !client.client_secret || client.client_secret.length>1000)
    throw new Error('Choose the downloaded Google OAuth JSON for a Desktop app (not a Web application or service account).');
  // Never trust endpoint URLs from an uploaded file.
  return {client_id:client.client_id,client_secret:client.client_secret};
}
export function webClient(json,redirect) {
  const client=json?.web;
  if(!client || typeof client.client_id!=='string' || !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(client.client_id)
    || typeof client.client_secret!=='string' || !client.client_secret || client.client_secret.length>1000
    || !Array.isArray(client.redirect_uris) || !client.redirect_uris.includes(redirect))
    throw new Error('Choose a Google Web application OAuth JSON with the exact Misty Gmail callback URL registered.');
  return {client_id:client.client_id,client_secret:client.client_secret};
}
async function concurrent(items,fn,limit=4) {
  const results=new Array(items.length);let next=0,failure=null;
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(!failure&&next<items.length){const i=next++;try{results[i]=await fn(items[i]);}catch(error){failure=error;}}}));
  if(failure)throw failure;
  return results;
}

export class Gmail {
  constructor(store,serial,{directory=defaultDirectory,fetchImpl=fetch,publicOrigin='',readOnly=false,requestedScopes=null}={}) {
    this.store=store;this.serial=serial;this.directory=directory;this.fetch=fetchImpl;
    this.publicOrigin=publicOrigin;this.readOnly=readOnly;
    this.requestedScopes=requestedScopes|| (readOnly?[GMAIL_SCOPE]:GMAIL_SCOPES);
    this.vault={client:null,accounts:{}};this.closed=false;this.running=false;this.timer=null;
    this.pending=null;this.writes=Promise.resolve();this.refreshing=new Map();this.retry=new Map();
    this.abort=new AbortController();
    this.authTasks=new Set();
    this.sendTasks=new Map();
    this.ready=this.load();
  }
  async load(){
    try{this.vault=JSON.parse(await fs.readFile(path.join(this.directory,'credentials.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw new Error('Cannot read local Gmail credentials. Restore the file or check its permissions.');}
    await this.serial(()=>this.store.statement("UPDATE gmail_outgoing SET status='unknown',error='Archival stopped during sending. Check Gmail Sent before composing another copy.',updated_at=? WHERE status='sending'").run(Date.now()));
    // One durable rescan discovers older Draft, Spam and Trash mail after upgrading.
    await this.serial(()=>this.store.statement("UPDATE gmail_accounts SET phase='full',page_token='',baseline='',checked=0,error='',generation=generation+1,coverage_version=2 WHERE coverage_version<2").run());
  }
  async persist() {
    const data=JSON.stringify(this.vault,null,2);
    const task=this.writes.then(async()=>{
      await fs.mkdir(this.directory,{recursive:true});
      const target=path.join(this.directory,'credentials.json'),tmp=target+'.tmp';
      await fs.writeFile(tmp,data,{mode:0o600});await fs.rename(tmp,target);
    });this.writes=task.catch(()=>{});return task;
  }
  async configure(json) {
    await this.ready;
    const client=this.publicOrigin?webClient(json,this.publicOrigin+'/oauth/gmail/callback'):desktopClient(json);
    if(this.vault.client && this.vault.client.client_id!==client.client_id && Object.keys(this.vault.accounts).length)
      throw new Error('Remove existing Gmail connections before replacing their OAuth client.');
    this.vault.client=client;this.vault.clientType=this.publicOrigin?'web':'desktop';await this.persist();return {ok:true};
  }
  async status() {
    await this.ready;
    const attachments=this.store.statement('SELECT count(*) stored,coalesce(sum(size),0) bytes FROM gmail_attachment_blobs').get();
    attachments.unavailable=this.store.statement('SELECT count(*) count FROM gmail_attachment_failures').get().count;
    attachments.pending=this.store.statement(`SELECT coalesce(sum(max(0,json_array_length(g.attachments_json)-
      (SELECT count(*) FROM gmail_attachment_blobs b WHERE b.message_id=g.message_id)-
      (SELECT count(*) FROM gmail_attachment_failures f WHERE f.message_id=g.message_id))),0) pending
      FROM gmail_messages g JOIN messages m ON m.id=g.message_id
      JOIN conversations c ON c.id=m.room_id JOIN gmail_accounts a ON a.id=g.account_id
      WHERE g.unavailable=0 AND c.connected=1 AND c.tracked=1 AND a.enabled=1`).get().pending;
    return {configured:!!this.vault.client,authorizing:!!this.pending,running:this.running,readOnly:this.readOnly,
      desktopClientOnVM:!!this.publicOrigin&&!!this.vault.client&&this.vault.clientType!=='web',
      attachments,
      accounts:this.store.statement(`SELECT a.*,count(g.message_id) stored FROM gmail_accounts a
        LEFT JOIN gmail_messages g ON g.account_id=a.id GROUP BY a.id ORDER BY a.email`).all().map(a=>({...a,linked:!!this.vault.accounts[a.id],authorizationRequired:!!this.vault.accounts[a.id]?.authorizationRequired,canSend:!this.vault.accounts[a.id]?.authorizationRequired&&!this.readOnly&&!!canSend(this.vault.accounts[a.id]?.scopes),canDraft:!this.vault.accounts[a.id]?.authorizationRequired&&!this.readOnly&&!!this.vault.accounts[a.id]?.scopes?.includes(GMAIL_COMPOSE_SCOPE),canManage:!this.vault.accounts[a.id]?.authorizationRequired&&!this.readOnly&&!!this.vault.accounts[a.id]?.scopes?.includes(GMAIL_MODIFY_SCOPE)}))};
  }
  attachment(messageId,partKey){
    const row=this.store.statement(`SELECT b.name,b.mime,b.size,b.sha256,b.content FROM gmail_attachment_blobs b
      JOIN messages m ON m.id=b.message_id JOIN conversations c ON c.id=m.room_id
      WHERE b.message_id=? AND b.part_key=? AND c.platform='gmail' AND c.connected=1`).get(String(messageId||''),String(partKey||''));
    if(!row)return null;
    if(createHash('sha256').update(row.content).digest('hex')!==row.sha256)throw new Error('Stored Gmail attachment failed its integrity check.');
    return row;
  }
  async modifyEmail(messageId,action){
    await this.ready;
    if(this.readOnly)throw new Error('Gmail changes are disabled on this archive.');
    const row=this.store.statement(`SELECT g.account_id,g.remote_id,g.labels_json FROM gmail_messages g
      JOIN messages m ON m.id=g.message_id JOIN conversations c ON c.id=m.room_id
      JOIN gmail_accounts a ON a.id=g.account_id
      WHERE g.message_id=? AND c.connected=1 AND a.enabled=1`).get(String(messageId||''));
    if(!row||!this.vault.accounts[row.account_id])throw new Error('Email is not available in a connected account.');
    if(!this.vault.accounts[row.account_id].scopes?.includes(GMAIL_MODIFY_SCOPE))
      throw new Error('Reconnect Gmail with gmail.modify permission to manage messages.');
    const changes={star:{addLabelIds:['STARRED']},unstar:{removeLabelIds:['STARRED']},
      read:{removeLabelIds:['UNREAD']},unread:{addLabelIds:['UNREAD']},
      archive:{removeLabelIds:['INBOX']},inbox:{addLabelIds:['INBOX'],removeLabelIds:['TRASH','SPAM']},
      spam:{addLabelIds:['SPAM'],removeLabelIds:['INBOX']},
      notSpam:{removeLabelIds:['SPAM'],addLabelIds:['INBOX']},
      trash:{addLabelIds:['TRASH'],removeLabelIds:['INBOX']},
      untrash:{removeLabelIds:['TRASH'],addLabelIds:['INBOX']}};
    const change=changes[action];if(!change)throw new Error('Unknown Gmail action.');
    const token=await this.accessToken(row.account_id);
    const response=await this.request(API+'messages/'+encodeURIComponent(row.remote_id)+'/modify',{
      method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(change)});
    if(!response.ok)throw new Error(response.status===403?'Google denied message changes. Reconnect Gmail with gmail.modify permission.':
      'Google did not confirm the message change (HTTP '+response.status+'). Refresh the inbox before retrying.');
    const result=await response.json();
    if(result.id!==row.remote_id||!Array.isArray(result.labelIds))throw new Error('Google returned an unexpected message result. Refresh the inbox.');
    await this.serial(()=>this.store.statement('UPDATE gmail_messages SET labels_json=? WHERE account_id=? AND remote_id=?')
      .run(JSON.stringify(result.labelIds),row.account_id,row.remote_id));
    return {id:messageId,labels:result.labelIds};
  }
  async request(url,options={}) {
    try{return await this.fetch(url,{...options,redirect:'error',signal:AbortSignal.any([this.abort.signal,AbortSignal.timeout(30000)])});}
    catch{throw new GmailError(this.closed?'Gmail stopped.':'Google could not be reached. Check your connection; the importer will retry.');}
  }
  async tokenRequest(params) {
    const response=await this.request(GOOGLE_TOKEN,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...this.vault.client,...params})});
    if(!response.ok){
      let code='';try{const body=await response.json();if(['invalid_grant','invalid_client','unauthorized_client','invalid_scope'].includes(body.error))code=body.error;}catch{}
      const error=new GmailError(code==='invalid_grant'?'Google authorization expired or was rejected. Use Add Gmail account to reconnect.':'Google token service unavailable or configuration rejected. Try again later.',response.status);
      error.oauthError=code;throw error;
    }
    const data=await response.json();
    if(!data.access_token)throw new GmailError('Google returned no access token. Try connecting again.');
    if(data.scope && !data.scope.split(' ').includes(GMAIL_SCOPE))throw new GmailError('Read-only Gmail access was not granted. Connect again and approve that permission.');
    return data;
  }
  async accessToken(id,force=false) {
    const credentials=this.vault.accounts[id];
    if(!credentials)throw new GmailError('Gmail is disconnected. Use Add Gmail account to reconnect.');
    if(!force && !credentials.authorizationRequired && credentials.expires>Date.now()+60000)return credentials.access_token;
    if(this.refreshing.has(id))return this.refreshing.get(id);
    const task=(async()=>{
      let data;
      try{data=await this.tokenRequest({grant_type:'refresh_token',refresh_token:credentials.refresh_token});}
      catch(error){if(error.oauthError==='invalid_grant'&&this.vault.accounts[id]===credentials){credentials.authorizationRequired=true;credentials.authFailedAt=Date.now();await this.persist();}throw error;}
      delete credentials.authorizationRequired;delete credentials.authFailedAt;
      if(this.vault.accounts[id]!==credentials)throw new GmailError('Gmail connection changed.');
      Object.assign(credentials,{access_token:data.access_token,expires:Date.now()+(data.expires_in||3600)*1000});
      if(data.scope)credentials.scopes=data.scope.split(' ');
      if(data.refresh_token)credentials.refresh_token=data.refresh_token;
      await this.persist();return data.access_token;
    })();this.refreshing.set(id,task);
    try{return await task;}finally{this.refreshing.delete(id);}
  }
  async api(id,endpoint,params={},retryAuth=true) {
    const url=new URL(API+endpoint);for(const [key,value]of Object.entries(params))if(value!=='')url.searchParams.set(key,String(value));
    const response=await this.request(url,{headers:{Authorization:'Bearer '+await this.accessToken(id)}});
    if(response.status===401 && retryAuth){await this.accessToken(id,true);return this.api(id,endpoint,params,false);}
    if(!response.ok){
      let reason='';try{reason=(await response.json()).error?.errors?.[0]?.reason||'';}catch{}
      if(response.status===429 || ['rateLimitExceeded','userRateLimitExceeded'].includes(reason)){
        const header=response.headers.get('retry-after'),seconds=Number(header),date=Date.parse(header);
        this.retry.set(id,Date.now()+Math.max(15000,Math.min(3600000,Number.isFinite(seconds)?seconds*1000:Number.isFinite(date)?date-Date.now():60000)));
        throw new GmailError('Google rate limit reached. Sync will resume automatically.',429);
      }
      const message=response.status===403?'Google denied Gmail access. Check that Gmail API is enabled, this account is an allowed test user, and your administrator permits access.':response.status===404?'Gmail item or history checkpoint is no longer available.':response.status===400?'Google rejected the Gmail request. A fresh history scan may be needed.':'Gmail request failed; sync will retry automatically.';
      throw new GmailError(message,response.status);
    }
    return response.json();
  }
  cancelAuthorization(){const p=this.pending;if(!p)return;this.pending=null;clearTimeout(p.timeout);p.server?.close();}
  async finishAuthorization({code='',state='',error=''}={}) {
    const pending=this.pending;
    if(!pending || state!==pending.state)throw new Error('Invalid or expired sign-in state. Start again in Misty.');
    this.pending=null;clearTimeout(pending.timeout); // Single use, including failed exchanges.
    if(error)throw new Error('Google sign-in was cancelled or denied. Start again in Misty.');
    if(!code)throw new Error('Google returned no authorization code.');
    if(pending.client.client_id!==this.vault.client?.client_id)throw new Error('OAuth configuration changed. Start again.');
    const data=await this.tokenRequest({grant_type:'authorization_code',code,redirect_uri:pending.redirect,code_verifier:pending.verifier});
    const profileResponse=await this.request(API+'profile',{headers:{Authorization:'Bearer '+data.access_token}});
    if(!profileResponse.ok)throw new Error('Gmail access was denied. Enable Gmail API and approve read-only access, then retry.');
    const profile=await profileResponse.json();
    if(typeof profile.emailAddress!=='string'||!profile.emailAddress.includes('@'))throw new Error('Google did not identify a Gmail mailbox.');
    const id=accountKey(profile.emailAddress),existing=this.vault.accounts[id];
    const refreshToken=data.refresh_token||(existing?.client_id===pending.client.client_id?existing.refresh_token:null);
    if(!refreshToken)throw new Error('Google returned no offline access. Remove this app in Google Account permissions, then reconnect.');
    this.vault.accounts[id]={client_id:pending.client.client_id,refresh_token:refreshToken,access_token:data.access_token,expires:Date.now()+(data.expires_in||3600)*1000,scopes:(data.scope||this.requestedScopes.join(' ')).split(' ')};
    await this.persist();
    await this.serial(()=>this.store.statement(`INSERT INTO gmail_accounts(id,email) VALUES(?,?)
      ON CONFLICT(id) DO UPDATE SET enabled=1,error='',generation=generation+1`).run(id,profile.emailAddress.toLowerCase()));
    this.retry.delete(id);this.wake();
    return {ok:true};
  }
  async authorize() {
    await this.ready;if(!this.vault.client)throw new Error(this.publicOrigin?'Upload the Web application OAuth JSON first.':'Upload the Desktop app OAuth JSON first.');
    if(this.publicOrigin&&this.vault.clientType!=='web')throw new Error('This mailbox uses the original Desktop OAuth client. Reconnect it on your laptop and transfer the refreshed token to the VM.');
    this.cancelAuthorization();
    const state=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url');
    const client={...this.vault.client};
    if(this.publicOrigin){
      const redirect=this.publicOrigin+'/oauth/gmail/callback';
      const timeout=setTimeout(()=>this.cancelAuthorization(),600000);timeout.unref();
      this.pending={redirect,timeout,state,verifier,client};
      return {url:this.authorizationUrl(client,redirect,state,verifier)};
    }
    const listener=http.createServer((req,res)=>{
      const task=handle(req,res);this.authTasks.add(task);task.finally(()=>this.authTasks.delete(task)).catch(()=>{});
    });
    const handle=async(req,res)=>{
      res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
      res.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'");
      const port=listener.address()?.port;
      if(req.method!=='GET'||req.headers.host!=='127.0.0.1:'+port){res.writeHead(403);res.end('Local callback rejected.');return;}
      const url=new URL(req.url,'http://127.0.0.1');
      const pending=this.pending;
      if(url.pathname!=='/oauth/gmail/callback'||!pending||pending.server!==listener||url.searchParams.get('state')!==state){res.writeHead(400);res.end('Invalid or expired sign-in state. Start again in Archival.');return;}
      try {
        await this.finishAuthorization({code:url.searchParams.get('code')||'',state:url.searchParams.get('state')||'',error:url.searchParams.get('error')||''});
        res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'});res.end('Gmail connected to your local Archival archive. Close this tab and return to Sync & storage. Import will begin automatically.');
      }catch(error){res.writeHead(400,{'Content-Type':'text/plain; charset=utf-8'});res.end(error instanceof GmailError?error.message:'Gmail could not be connected. Check Gmail API, test users, and permission settings, then try again in Archival.');}
      finally{listener.close();}
    };
    await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',resolve);});
    const redirect=`http://127.0.0.1:${listener.address().port}/oauth/gmail/callback`;
    const timeout=setTimeout(()=>this.cancelAuthorization(),600000);timeout.unref();
    this.pending={server:listener,redirect,timeout,state,verifier,client};
    return {url:this.authorizationUrl(client,redirect,state,verifier)};
  }
  authorizationUrl(client,redirect,state,verifier) {
    const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
    for(const [key,value]of Object.entries({client_id:client.client_id,redirect_uri:redirect,response_type:'code',scope:this.requestedScopes.join(' '),access_type:'offline',prompt:'consent select_account',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}))url.searchParams.set(key,value);
    return url.href;
  }
  async accountAction(id,action) {
    await this.ready;
    if(!this.store.statement('SELECT 1 FROM gmail_accounts WHERE id=?').get(id))throw new Error('Gmail account not found.');
    if(!['pause','resume','disconnect','rescan'].includes(action))throw new Error('Unknown Gmail action.');
    if(action==='disconnect'){delete this.vault.accounts[id];await this.persist();}
    await this.serial(()=>{
      if(action==='rescan'){
        this.store.statement('DELETE FROM gmail_attachment_failures WHERE message_id IN (SELECT message_id FROM gmail_messages WHERE account_id=?)').run(id);
        this.store.statement("UPDATE gmail_accounts SET phase='full',page_token='',baseline='',checked=0,error='',generation=generation+1 WHERE id=?").run(id);
      }
      else this.store.statement("UPDATE gmail_accounts SET enabled=?,error='',generation=generation+1 WHERE id=?").run(+['resume'].includes(action),id);
    });this.retry.delete(id);this.wake();return {ok:true};
  }
  async restoreThread(room) {
    if(room.platform!=='gmail')return;
    const [,account,id]=room.id.split(':');if(!account||!id)return;
    await this.serial(()=>this.store.statement('INSERT INTO gmail_thread_jobs(room_id) VALUES(?) ON CONFLICT DO NOTHING').run(room.id));this.wake();
  }
  outgoing(id='') {
    const rows=id?this.store.statement('SELECT * FROM gmail_outgoing WHERE id=?').all(id):this.store.statement('SELECT * FROM gmail_outgoing ORDER BY created_at DESC LIMIT 50').all();
    return rows.map(({raw,draft_json,...row})=>({...row,...JSON.parse(draft_json)}));
  }
  async previewEmail(input){
    await this.ready;
    const account=this.store.statement('SELECT * FROM gmail_accounts WHERE id=? AND enabled=1').get(String(input.account||''));
    if(!account||!this.vault.accounts[account.id])throw new Error('Choose a connected Gmail account.');
    if(!this.readOnly&&canSend(this.vault.accounts[account.id].scopes))await this.accessToken(account.id);
    const parent=input.replyTo?replyDefaults(this.store,String(input.replyTo)).parent:null;
    const {raw,messageId,...draft}=prepareEmail(account,input,parent);
    return {target:{platform:'gmail',account:account.id,from:account.email,to:draft.to,cc:draft.cc,bcc:draft.bcc,
      subject:draft.subject,replyTo:draft.replyTo,threadId:draft.threadId},
      capability:{allowed:!this.readOnly&&!!canSend(this.vault.accounts[account.id].scopes),
        reason:'Reconnect this Gmail account with gmail.compose permission before sending.',maxLength:20000}};
  }
  async saveDraft(input){
    await this.ready;
    if(this.readOnly)throw new Error('Gmail draft creation is disabled on this archive.');
    const account=this.store.statement('SELECT * FROM gmail_accounts WHERE id=? AND enabled=1').get(String(input.account||''));
    if(!account||!this.vault.accounts[account.id])throw new Error('Choose a connected Gmail account.');
    if(!this.vault.accounts[account.id].scopes?.includes(GMAIL_COMPOSE_SCOPE))throw new Error('Reconnect this Gmail account with gmail.compose permission before saving drafts.');
    const parent=input.replyTo?replyDefaults(this.store,String(input.replyTo)).parent:null;
    const {raw,...draft}=prepareEmail(account,input,parent);
    const token=await this.accessToken(account.id);
    const response=await this.request(API+'drafts',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
      body:JSON.stringify({message:{raw,...(draft.threadId?{threadId:draft.threadId}:{})}})});
    if(!response.ok)throw new Error('Gmail draft creation was not confirmed. Check Gmail Drafts before requesting another copy.');
    const created=await response.json();
    if(!created.id)throw new Error('Gmail did not confirm the draft ID. Check Gmail Drafts before requesting another copy.');
    this.wake();return {id:created.id,account:account.id,from:account.email,to:draft.to,cc:draft.cc,bcc:draft.bcc,subject:draft.subject};
  }
  async prepare(input) {
    await this.ready;
    if(this.readOnly)throw new Error('Gmail sending is disabled on this archive.');
    return this.serial(()=>{
      const account=this.store.statement('SELECT * FROM gmail_accounts WHERE id=?').get(String(input.account||''));
      if(!account || !this.vault.accounts[account.id])throw new Error('Connect the Gmail account first.');
      if(!canSend(this.vault.accounts[account.id].scopes))throw new Error('Sending permission is missing. Reconnect this account with gmail.compose or gmail.send.');
      const parent=input.replyTo?replyDefaults(this.store,String(input.replyTo)).parent:null;
      const {raw,...draft}=prepareEmail(account,input,parent);
      const id=input.submissionId||randomUUID(),now=Date.now();
      if(!/^[a-f0-9-]{36}$/i.test(id))throw new Error('Invalid email submission ID.');
      const previous=this.store.statement('SELECT * FROM gmail_outgoing WHERE id=?').get(id);
      if(previous){
        const old=JSON.parse(previous.draft_json);
        if(previous.account_id!==account.id||['to','cc','bcc','subject','body','replyTo','threadId'].some(key=>JSON.stringify(old[key])!==JSON.stringify(draft[key])))
          throw new Error('This email submission ID belongs to different content.');
        return this.outgoing(id)[0];
      }
      this.store.statement('INSERT INTO gmail_outgoing(id,account_id,draft_json,raw,created_at,updated_at) VALUES(?,?,?,?,?,?)')
        .run(id,account.id,JSON.stringify(draft),raw,now,now);
      return this.outgoing(id)[0];
    });
  }
  async send(id) {
    await this.ready;
    if(this.readOnly)throw new Error('Gmail sending is disabled on this archive.');
    if(this.sendTasks.has(id))return this.sendTasks.get(id);
    const task=this.deliver(id);this.sendTasks.set(id,task);
    try{return await task;}finally{this.sendTasks.delete(id);}
  }
  async deliver(id) {
    const row=await this.serial(()=>{
      const row=this.store.statement('SELECT * FROM gmail_outgoing WHERE id=?').get(id);
      if(!row)throw new Error('Prepared email not found. Review the email first.');
      if(row.status!=='ready')return row;
      if(!canSend(this.vault.accounts[row.account_id]?.scopes))throw new Error('Reconnect this Gmail account with sending permission.');
      this.store.statement("UPDATE gmail_outgoing SET status='sending',updated_at=? WHERE id=? AND status='ready'").run(Date.now(),id);
      return row;
    });
    if(row.status!=='ready')return this.outgoing(id)[0];
    let attempted=false,response;
    const update=async(status,error='',remote='',thread='')=>this.serial(()=>this.store.statement('UPDATE gmail_outgoing SET status=?,error=?,remote_id=?,thread_id=?,updated_at=? WHERE id=?').run(status,error,remote,thread,Date.now(),id));
    try {
      const token=await this.accessToken(row.account_id);
      if(!canSend(this.vault.accounts[row.account_id]?.scopes))throw new Error('Sending permission was not granted. Reconnect this account.');
      if(this.closed)throw new Error('Archival stopped before sending.');
      const draft=JSON.parse(row.draft_json),payload={raw:row.raw};if(draft.threadId)payload.threadId=draft.threadId;
      attempted=true;
      // A send is never retried automatically, including timeouts and server errors.
      response=await this.request(API+'messages/send',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(payload)});
      if(!response.ok){
        const uncertain=response.status>=500 || response.status===408;
        await update(uncertain?'unknown':'failed',uncertain?'Google could not confirm delivery. Check Gmail Sent before composing another copy.':response.status===403?'Google denied sending. Reconnect with gmail.send and check your account policies.':response.status===429?'Google rejected this send because of a limit. Nothing will be retried automatically.':'Google rejected this send (HTTP '+response.status+'). Review the email and account before trying again.');
        return this.outgoing(id)[0];
      }
      let sent={};try{sent=await response.json();}catch{}
      await update('sent','',sent.id||'',sent.threadId||draft.threadId||'');
      // Delivery is already confirmed. An archive failure must never turn this into a failed send.
      if(sent.id){
        try{const raw=await this.api(row.account_id,'messages/'+encodeURIComponent(sent.id),{format:'full'});
          await this.serial(()=>applyGmailPage(this.store,row.account_id,[raw]));}catch{}
      }
      this.wake();return this.outgoing(id)[0];
    }catch(error){
      await update(attempted?'unknown':'failed',attempted?'Connection ended without a delivery confirmation. Check Gmail Sent before composing another copy.':error instanceof GmailError?error.message:'Email was not sent. Check the account connection and review again.');
      return this.outgoing(id)[0];
    }
  }
  async fetchMessages(account,items) {
    return (await concurrent(items,async item=>{
      if(this.closed)return null;
      let raw;
      try{raw=await this.api(account.id,'messages/'+encodeURIComponent(item.id),{format:'full'});}
      catch(error){if(error.status===404)return null;throw error;}
      const hydrateText=async part=>{
        if(part?.body?.attachmentId && !part.body.data && textBodyPart(part)){
          const external=await this.api(account.id,'messages/'+encodeURIComponent(raw.id)+'/attachments/'+encodeURIComponent(part.body.attachmentId));
          if(typeof external.data!=='string'||Buffer.from(external.data,'base64url').length!==Number(external.size??part.body.size))
            throw new GmailError('Gmail text part size did not match its content; this page will retry.');
          part.body.data=external.data;
        }
        for(const child of part?.parts||[])await hydrateText(child);
      };
      await hydrateText(raw.payload);
      raw.attachmentContents=[];raw.attachmentFailures=[];
      for(const attachment of parseEmail(raw).attachments){
          let encoded,reported=attachment.size;
          if(attachment.id){
            let part;
            try{part=await this.api(account.id,'messages/'+encodeURIComponent(raw.id)+'/attachments/'+encodeURIComponent(attachment.id));}
            catch(error){if(error.status!==404)throw error;
              raw.attachmentFailures.push({key:attachment.key,reason:'Gmail no longer provides this attachment.'});continue;}
            encoded=part.data;reported=part.size??reported;
          }else{
            const steps=attachment.key.split('.').slice(1).map(Number);
            const part=steps.reduce((node,index)=>node?.parts?.[index],raw.payload);
            encoded=part?.body?.data;
          }
          if(typeof encoded!=='string')throw new GmailError('Gmail did not provide attachment bytes; this page will retry.');
          const content=Buffer.from(encoded,'base64url');
          if(Number(reported)!==content.length)throw new GmailError('Gmail attachment size did not match its content; this page will retry.');
          raw.attachmentContents.push({key:attachment.key,name:attachment.name,mime:attachment.mime,content});
      }
      return raw;
    },4)).filter(Boolean);
  }
  async syncAccount(account) {
    if(this.closed||!this.vault.accounts[account.id]||Date.now()<(this.retry.get(account.id)||0))return;
    if(account.phase==='full') {
      if(!account.baseline){const p=await this.api(account.id,'profile');account.baseline=p.historyId;await this.serial(()=>this.store.statement('UPDATE gmail_accounts SET baseline=? WHERE id=? AND generation=?').run(account.baseline,account.id,account.generation));}
      let page;
      try{page=await this.api(account.id,'messages',{maxResults:50,pageToken:account.page_token,includeSpamTrash:true});}
      catch(error){if(error.status===400&&account.page_token){await this.serial(()=>this.store.statement("UPDATE gmail_accounts SET page_token='',baseline='',checked=0 WHERE id=? AND generation=?").run(account.id,account.generation));return;}throw error;}
      const ids=page.messages||[];
      const missing=await this.serial(()=>ids.filter(item=>!this.store.statement('SELECT 1 FROM gmail_messages WHERE account_id=? AND remote_id=?').get(account.id,item.id)));
      const messages=await this.fetchMessages(account,missing);
      if(this.closed)return;
      const done=!page.nextPageToken;
      await this.serial(()=>applyGmailPage(this.store,account.id,messages,{page_token:page.nextPageToken||'',phase:done?'drafts':'full',checked:account.checked+ids.length,last_sync:Date.now(),error:''},{},account.generation));
      return;
    }
    if(account.phase==='drafts'){
      let page;
      try{page=await this.api(account.id,'drafts',{maxResults:100,pageToken:account.page_token,includeSpamTrash:true});}
      catch(error){if(error.status===400&&account.page_token){await this.serial(()=>this.store.statement("UPDATE gmail_accounts SET page_token='' WHERE id=? AND generation=?").run(account.id,account.generation));return;}throw error;}
      const ids=(page.drafts||[]).map(d=>d.message).filter(m=>m?.id);
      const missing=await this.serial(()=>ids.filter(item=>!this.store.statement('SELECT 1 FROM gmail_messages WHERE account_id=? AND remote_id=?').get(account.id,item.id)));
      const messages=await this.fetchMessages(account,missing);
      if(this.closed)return;
      const done=!page.nextPageToken;
      await this.serial(()=>applyGmailPage(this.store,account.id,messages,{page_token:page.nextPageToken||'',phase:done?'delta':'drafts',cursor:done?account.baseline:account.cursor,checked:account.checked+ids.length,last_sync:Date.now(),error:''},{},account.generation));
      return;
    }
    let page;
    try{page=await this.api(account.id,'history',{startHistoryId:account.cursor,maxResults:100,pageToken:account.page_token});}
    catch(error){if(error.status===404||(error.status===400&&account.page_token)){await this.serial(()=>this.store.statement("UPDATE gmail_accounts SET phase='full',page_token='',baseline='',checked=0 WHERE id=? AND generation=?").run(account.id,account.generation));return;}throw error;}
    const ids=new Set(),deleted=new Set(),labels=new Map();
    for(const item of page.history||[]) {
      for(const added of item.messagesAdded||[])ids.add(added.message.id);
      for(const removed of item.messagesDeleted||[])deleted.add(removed.message.id);
      for(const change of [...(item.labelsAdded||[]),...(item.labelsRemoved||[])])labels.set(change.message.id,change.message);
    }
    for(const id of labels.keys())ids.add(id); // Mail restored from Spam/Trash may have no messagesAdded event.
    // Fetch new messages only. Labels are metadata, never mark messages read or send mail.
    const missing=await this.serial(()=>[...ids].filter(id=>!deleted.has(id)&&!this.store.statement('SELECT 1 FROM gmail_messages WHERE account_id=? AND remote_id=?').get(account.id,id)).map(id=>({id})));
    const messages=await this.fetchMessages(account,missing);
    if(this.closed)return;
    await this.serial(()=>applyGmailPage(this.store,account.id,messages,
      {page_token:page.nextPageToken||'',cursor:page.nextPageToken?account.cursor:page.historyId||account.cursor,last_sync:Date.now(),error:''},{labels,deleted},account.generation));
  }
  async backfillAttachments(account){
    const rows=await this.serial(()=>this.store.statement(`SELECT g.remote_id FROM gmail_messages g
      JOIN messages m ON m.id=g.message_id JOIN conversations c ON c.id=m.room_id
      WHERE g.account_id=? AND g.unavailable=0 AND c.connected=1 AND c.tracked=1
      AND json_array_length(g.attachments_json)>(SELECT count(*) FROM gmail_attachment_blobs b WHERE b.message_id=g.message_id)+
        (SELECT count(*) FROM gmail_attachment_failures f WHERE f.message_id=g.message_id)
      ORDER BY m.ts DESC LIMIT 5`).all(account.id));
    for(const row of rows){
      const messages=await this.fetchMessages(account,[{id:row.remote_id}]);
      if(!messages.length){await this.serial(()=>this.store.statement('UPDATE gmail_messages SET unavailable=1 WHERE account_id=? AND remote_id=?').run(account.id,row.remote_id));continue;}
      if(this.closed)return;
      await this.serial(()=>applyGmailPage(this.store,account.id,messages,{},{},account.generation));
    }
  }
  async round() {
    await this.ready;
    const accounts=await this.serial(()=>this.store.statement('SELECT * FROM gmail_accounts WHERE enabled=1').all());
    for(const account of accounts) {
      try {
        if(Date.now()<(this.retry.get(account.id)||0))continue;
        const jobs=await this.serial(()=>this.store.statement('SELECT room_id FROM gmail_thread_jobs WHERE room_id LIKE ?').all('gmail:'+account.id+':%'));
        for(const {room_id:roomId} of jobs){
          const room=await this.serial(()=>this.store.room(roomId));
          if(!room?.connected||!room.tracked){await this.serial(()=>this.store.statement('DELETE FROM gmail_thread_jobs WHERE room_id=?').run(roomId));continue;}
          let thread;
          try{thread=await this.api(account.id,'threads/'+encodeURIComponent(room.remote_id),{format:'full'});}
          catch(error){if(error.status!==404)throw error;thread={messages:[]};}
          await this.serial(()=>{if(applyGmailPage(this.store,account.id,thread.messages||[],{},{},account.generation))this.store.statement('DELETE FROM gmail_thread_jobs WHERE room_id=?').run(roomId);});
        }
        await this.syncAccount(account);
        if(account.phase==='delta'&&!account.page_token)await this.backfillAttachments(account);
      }catch(error){if(!this.closed){this.retry.set(account.id,Math.max(Date.now()+30000,this.retry.get(account.id)||0));await this.serial(()=>this.store.statement('UPDATE gmail_accounts SET error=? WHERE id=? AND generation=?').run(error instanceof GmailError?error.message:'Gmail import failed; the saved checkpoint is unchanged. It will retry.',account.id,account.generation));}}
    }
    return accounts.some(a=>a.phase==='full'||a.phase==='drafts'||a.page_token);
  }
  wake(){if(this.closed)return;clearTimeout(this.timer);if(this.running){this.again=true;return;}this.timer=setTimeout(()=>this.tick(),20);this.timer.unref();}
  async tick(){if(this.closed||this.running)return;this.running=true;let quick=false;try{quick=await this.round();}catch{}finally{this.running=false;if(!this.closed){this.timer=setTimeout(()=>this.tick(),this.again||quick?250:15000);this.again=false;this.timer.unref();}}}
  async close(){this.closed=true;clearTimeout(this.timer);this.cancelAuthorization();this.abort.abort();if(this.running)await new Promise(resolve=>{const check=()=>this.running?setTimeout(check,25):resolve();check();});await Promise.allSettled([...this.authTasks,...this.sendTasks.values()]);await this.writes;}
}
