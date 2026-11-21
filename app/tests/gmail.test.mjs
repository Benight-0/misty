import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {request} from 'node:http';
import {ArchiveStore} from '../store.mjs';
import {Gmail,GMAIL_SCOPE,GMAIL_SCOPES,GMAIL_SEND_SCOPE,GMAIL_COMPOSE_SCOPE,GMAIL_MODIFY_SCOPE,desktopClient,webClient} from '../gmail.mjs';
import {prepareEmail,replyDefaults} from '../gmail-compose.mjs';
import {applyGmailPage,parseEmail} from '../gmail-store.mjs';
import {importArchive} from '../import.mjs';
import {createApplication} from '../server.mjs';

const client={installed:{client_id:'123.test.apps.googleusercontent.com',client_secret:'test-secret',token_uri:'https://untrusted.invalid/token'}};
const response=(value,status=200,headers={})=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json',...headers}});
function mail(id='m1',labels=['SENT'],body='My reply\n\nOn Tuesday, someone wrote:\n> Someone else loves chess',threadId='t1'){
  return {id,threadId,internalDate:'1700000000000',labelIds:labels,payload:{mimeType:'text/plain',headers:[{name:'Subject',value:'Planning'},{name:'From',value:'My alias <alias@example.com>'},{name:'To',value:'Friend <friend@example.com>'}],body:{data:Buffer.from(body).toString('base64url')}}};
}
function account(store,id='a',email='me@example.com') {store.statement('INSERT INTO gmail_accounts(id,email) VALUES(?,?)').run(id,email);return store.statement('SELECT * FROM gmail_accounts WHERE id=?').get(id);}
async function harness(t,fetchImpl=()=>{throw new Error('Unexpected Google request');}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'archival-gmail-test-'));
  const store=new ArchiveStore(':memory:');const g=new Gmail(store,fn=>Promise.resolve().then(fn),{directory,fetchImpl});
  g.wake=()=>{};await g.ready;
  t.after(async()=>{await g.close();store.close();assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('archival-gmail-test-'));await fs.rm(directory,{recursive:true,force:true});});
  await g.configure(client);return {g,store,directory};
}
function seed(g,store,id='a') {account(store,id);g.vault.accounts[id]={client_id:client.installed.client_id,refresh_token:'refresh',access_token:'access',expires:Date.now()+3600000};}

test('VM web OAuth requests only Gmail read access, completes once, and cannot send',async t=>{
  const origin='https://archival.example.com',redirect=origin+'/oauth/gmail/callback';
  const web={web:{client_id:'123.web.apps.googleusercontent.com',client_secret:'web-secret',redirect_uris:[redirect]}};
  assert.throws(()=>webClient({...web,web:{...web.web,redirect_uris:['https://other.example.com/callback']}},redirect),/exact Misty Gmail callback/);
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'archival-gmail-web-test-'));
  const store=new ArchiveStore(':memory:');
  const calls=[];
  const gmail=new Gmail(store,fn=>Promise.resolve().then(fn),{directory,publicOrigin:origin,readOnly:true,fetchImpl:async(url,options)=>{
    calls.push({url:String(url),options});
    if(String(url).includes('/token'))return response({access_token:'web-access',refresh_token:'web-refresh',expires_in:3600,scope:GMAIL_SCOPE});
    if(String(url).endsWith('/profile'))return response({emailAddress:'owner@example.com'});
    throw new Error('Unexpected request');
  }});
  gmail.wake=()=>{};
  t.after(async()=>{await gmail.close();store.close();await fs.rm(directory,{recursive:true,force:true});});
  await gmail.ready;
  await assert.rejects(gmail.configure(client),/Web application OAuth JSON/);
  await gmail.configure(web);
  const {url}=await gmail.authorize(),authorization=new URL(url);
  assert.equal(authorization.searchParams.get('scope'),GMAIL_SCOPE);
  assert.equal(authorization.searchParams.get('redirect_uri'),redirect);
  assert.equal(authorization.searchParams.get('code_challenge_method'),'S256');
  await assert.rejects(gmail.finishAuthorization({code:'code',state:'wrong'}),/sign-in state/);
  assert.equal(gmail.pending!==null,true);
  await gmail.finishAuthorization({code:'code',state:authorization.searchParams.get('state')});
  await assert.rejects(gmail.finishAuthorization({code:'code',state:authorization.searchParams.get('state')}),/sign-in state/);
  assert.equal((await gmail.status()).accounts[0].stored,0);
  assert.equal((await gmail.status()).accounts[0].canSend,false);
  await assert.rejects(gmail.prepare({}),/sending is disabled/);
  await assert.rejects(gmail.send('prepared'),/sending is disabled/);
  assert.equal(calls.filter(call=>call.url.includes('/token')).length,1);
  assert.doesNotMatch(JSON.stringify(await gmail.status()),/web-secret|web-refresh|web-access/);
});

test('a migrated Desktop OAuth token can sync on the VM without offering a broken web callback',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'archival-gmail-desktop-vm-test-'));
  const store=new ArchiveStore(':memory:');account(store,'a');
  await fs.writeFile(path.join(directory,'credentials.json'),JSON.stringify({client:client.installed,clientType:'desktop',accounts:{a:{client_id:client.installed.client_id,refresh_token:'refresh',access_token:'access',expires:Date.now()+3600000,scopes:[GMAIL_SCOPE]}}}));
  const gmail=new Gmail(store,fn=>Promise.resolve().then(fn),{directory,publicOrigin:'https://archival.example.com',readOnly:true});
  t.after(async()=>{await gmail.close();store.close();await fs.rm(directory,{recursive:true,force:true});});
  const status=await gmail.status();
  assert.equal(status.desktopClientOnVM,true);
  assert.equal(status.accounts[0].linked,true);
  assert.equal(status.accounts[0].canSend,false);
  await assert.rejects(gmail.authorize(),/Reconnect it on your laptop/);
});

test('VM Gmail callback requires owner authentication and stores mail in the VM archive',async t=>{
  const origin='https://archival.example.com',redirect=origin+'/oauth/gmail/callback';
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'archival-gmail-http-test-'));
  const store=new ArchiveStore(':memory:');
  const app=createApplication({store,poll:false,runtime:{sync(){}},publicOrigin:origin,authorizeRequest:async req=>req.headers['x-test-owner']==='yes',
    gmailOptions:{directory,agentCompose:true,fetchImpl:async url=>String(url).includes('/token')?response({access_token:'access',refresh_token:'refresh',scope:GMAIL_SCOPE}):response({emailAddress:'owner@example.com'})}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await app.close();await fs.rm(directory,{recursive:true,force:true});});
  const port=app.server.address().port;
  const call=(method,p,headers={},body='')=>new Promise((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port,path:p,method,headers:{Host:'archival.example.com',...headers}},res=>{
      let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,text}));
    });req.on('error',reject);req.end(body);
  });
  const owner={'X-Test-Owner':'yes'};
  const bootstrap=await call('GET','/api/bootstrap',owner);
  assert.equal(bootstrap.status,200);
  const token=JSON.parse(bootstrap.text).token;
  const post=(path,data)=>call('POST','/api/'+path,{...owner,'Content-Type':'application/json','X-Archival-Token':token},JSON.stringify(data));
  const web={web:{client_id:'123.web.apps.googleusercontent.com',client_secret:'secret',redirect_uris:[redirect]}};
  assert.equal((await post('gmail/client',{client:web})).status,200);
  const auth=await post('gmail/authorize',{});
  assert.equal(auth.status,200);
  assert.equal(new URL(JSON.parse(auth.text).url).searchParams.get('scope'),[GMAIL_SCOPE,GMAIL_COMPOSE_SCOPE,GMAIL_MODIFY_SCOPE].join(' '));
  const state=new URL(JSON.parse(auth.text).url).searchParams.get('state');
  const callback='/oauth/gmail/callback?'+new URLSearchParams({code:'one-time',state});
  assert.equal((await call('GET',callback)).status,401);
  assert.equal((await call('GET',callback,owner)).status,200);
  assert.equal((await call('GET',callback,owner)).status,400);
  assert.equal(store.statement('SELECT count(*) n FROM gmail_accounts').get().n,1);
  assert.equal((await post('gmail/send',{id:'missing'})).status,400);
  assert.doesNotMatch((await call('GET','/api/gmail',owner)).text,/secret|refresh|access_token/);
  const accountId=store.statement('SELECT id FROM gmail_accounts').get().id,attached=mail('file',['INBOX'],'','file-thread');
  attached.payload={mimeType:'multipart/mixed',headers:attached.payload.headers,parts:[
    {mimeType:'text/plain',body:{data:Buffer.from('Body').toString('base64url')}},
    {mimeType:'application/octet-stream',filename:'data.bin',body:{attachmentId:'a1',size:4}}]};
  attached.attachmentContents=[{key:'0.1',name:'data.bin',mime:'application/octet-stream',content:Buffer.from('DATA')}];
  applyGmailPage(store,accountId,[attached]);
  const url='/api/gmail/attachment?'+new URLSearchParams({id:`gmail:${accountId}:file`,key:'0.1'});
  assert.equal((await call('GET',url)).status,401);
  const downloaded=await call('GET',url,owner);assert.equal(downloaded.status,200);assert.equal(downloaded.text,'DATA');
});

test('mailbox IDs stay separate; own sent aliases and quote-free profile evidence are preserved',()=>{
  const s=new ArchiveStore(':memory:');account(s);account(s,'b','other@example.com');
  applyGmailPage(s,'a',[mail()]);applyGmailPage(s,'b',[mail()]);applyGmailPage(s,'a',[mail()]);
  assert.equal(s.messages({}).length,2);assert.equal(s.ownCorpus().length,0);
  s.updateRoom('gmail:a:t1',{include_profile:true});assert.equal(s.ownCorpus()[0].body,'My reply');
  assert.match(s.messages({room:'gmail:a:t1'})[0].body,/Someone else loves chess/);
  const incoming=mail('spoof',[]);incoming.payload.headers[1].value='me@example.com';applyGmailPage(s,'a',[incoming]);
  assert.equal(s.messages({room:'gmail:a:t1'}).find(m=>m.id.endsWith(':spoof')).is_me,0);
  assert.equal(s.messages({room:'gmail:a:t1'}).find(m=>m.id.endsWith(':m1')).is_me,1);
  applyGmailPage(s,'a',[mail('draft',['DRAFT','SENT']),mail('spam',['SPAM']),mail('trash',['TRASH'])]);
  assert.equal(s.messages({}).length,6);
  assert.equal(s.messages({room:'gmail:a:t1'}).find(m=>m.id.endsWith(':draft')).is_me,1);
  assert.match(s.messages({room:'gmail:a:t1'}).find(m=>m.id.endsWith(':spam')).body,/Folder: SPAM/);
  s.close();
});

test('MIME plain text wins over HTML; HTML is inert and attachment metadata is retained',()=>{
  const raw=mail();raw.payload.mimeType='multipart/mixed';delete raw.payload.body;
  raw.payload.parts=[{mimeType:'multipart/alternative',parts:[{mimeType:'text/plain',body:{data:Buffer.from('Plain text').toString('base64url')}},{mimeType:'text/html',body:{data:Buffer.from('<p>Duplicate HTML</p>').toString('base64url')}}]},
    {mimeType:'application/pdf',filename:'notes.pdf',body:{attachmentId:'a1',size:40}}];
  const parsed=parseEmail(raw);assert.match(parsed.body,/Plain text/);assert.doesNotMatch(parsed.body,/Duplicate HTML/);assert.equal(parsed.attachments[0].name,'notes.pdf');
  raw.payload.parts=[{mimeType:'text/html',body:{data:Buffer.from('<script>bad()</script><p>My &amp; words</p><blockquote>Other person</blockquote><img src="https://tracker.invalid/pixel">').toString('base64url')}}];
  const html=parseEmail(raw);assert.match(html.body,/My & words/);assert.doesNotMatch(html.body,/bad\(\)|tracker.invalid|<img/);assert.equal(html.authored,'My & words');
});

test('Gmail stores external and inline attachment bytes atomically and backfills older metadata',async t=>{
  const raw=mail();raw.payload.mimeType='multipart/mixed';delete raw.payload.body;
  raw.payload.parts=[
    {mimeType:'text/plain',body:{data:Buffer.from('Body').toString('base64url')}},
    {mimeType:'application/pdf',filename:'report.pdf',body:{attachmentId:'part-a',size:4}},
    {mimeType:'text/plain',filename:'note.txt',body:{data:Buffer.from('note').toString('base64url'),size:4}}
  ];
  let fail=true;
  const {g,store}=await harness(t,async url=>{
    const u=new URL(url);
    if(u.pathname.endsWith('/profile'))return response({historyId:'100'});
    if(u.pathname.endsWith('/messages'))return response({messages:[{id:'m1'}]});
    if(u.pathname.endsWith('/messages/m1'))return response(structuredClone(raw));
    if(u.pathname.endsWith('/attachments/part-a'))return fail?response({},500):response({data:Buffer.from('PDF!').toString('base64url'),size:4});
    throw Error('Unexpected Gmail request: '+u.pathname);
  });seed(g,store);
  await assert.rejects(g.syncAccount(store.statement('SELECT * FROM gmail_accounts').get()));
  assert.equal(store.statement('SELECT count(*) n FROM gmail_messages').get().n,0);
  assert.equal(store.statement('SELECT count(*) n FROM gmail_attachment_blobs').get().n,0);
  fail=false;
  await g.syncAccount(store.statement('SELECT * FROM gmail_accounts').get());
  assert.equal(store.statement('SELECT count(*) n FROM gmail_attachment_blobs').get().n,2);
  assert.equal(Buffer.from(g.attachment('gmail:a:m1','0.1').content).toString(),'PDF!');
  assert.equal(Buffer.from(g.attachment('gmail:a:m1','0.2').content).toString(),'note');
  assert.equal((await g.status()).attachments.pending,0);
  store.statement('DELETE FROM gmail_attachment_blobs').run();
  assert.equal((await g.status()).attachments.pending,2);
  await g.backfillAttachments(store.statement('SELECT * FROM gmail_accounts').get());
  assert.equal(store.statement('SELECT count(*) n FROM gmail_attachment_blobs').get().n,2);
});
test('a Gmail attachment that is gone does not block later mail or attachment backfill',async t=>{
  const raw=mail();raw.payload.mimeType='multipart/mixed';delete raw.payload.body;
  raw.payload.parts=[{mimeType:'application/pdf',filename:'gone.pdf',body:{attachmentId:'gone',size:4}}];
  let requests=0;
  const {g,store}=await harness(t,async url=>{
    const u=new URL(url);
    if(u.pathname.endsWith('/profile'))return response({historyId:'100'});
    if(u.pathname.endsWith('/messages'))return response({messages:[{id:'m1'}]});
    if(u.pathname.endsWith('/messages/m1'))return response(structuredClone(raw));
    if(u.pathname.endsWith('/attachments/gone')){requests++;return response({},404);}
    throw Error('Unexpected Gmail request: '+u.pathname);
  });seed(g,store);
  await g.syncAccount(store.statement('SELECT * FROM gmail_accounts').get());
  assert.equal(store.statement('SELECT count(*) n FROM gmail_messages').get().n,1);
  assert.equal((await g.status()).attachments.unavailable,1);
  assert.equal((await g.status()).attachments.pending,0);
  await g.backfillAttachments(store.statement('SELECT * FROM gmail_accounts').get());
  assert.equal(requests,1);
  await g.accountAction('a','rescan');
  assert.equal((await g.status()).attachments.pending,1);
});
test('external Gmail text body is archived as text, not a downloadable attachment',async t=>{
  const raw=mail();raw.payload.mimeType='multipart/mixed';delete raw.payload.body;
  raw.payload.parts=[{mimeType:'text/plain',body:{attachmentId:'large-text',size:10}},
    {mimeType:'image/png',filename:'image.png',body:{attachmentId:'image',size:3}}];
  const {g,store}=await harness(t,async url=>{
    const u=new URL(url);
    if(u.pathname.endsWith('/profile'))return response({historyId:'100'});
    if(u.pathname.endsWith('/messages'))return response({messages:[{id:'m1'}]});
    if(u.pathname.endsWith('/messages/m1'))return response(structuredClone(raw));
    if(u.pathname.endsWith('/attachments/large-text'))return response({data:Buffer.from('Large body').toString('base64url'),size:10});
    if(u.pathname.endsWith('/attachments/image'))return response({data:Buffer.from('PNG').toString('base64url'),size:3});
    throw Error('Unexpected Gmail request: '+u.pathname);
  });seed(g,store);
  await g.syncAccount(store.statement('SELECT * FROM gmail_accounts').get());
  assert.match(store.messages({room:'gmail:a:t1'})[0].body,/Large body/);
  assert.equal(store.statement('SELECT count(*) n FROM gmail_attachment_blobs').get().n,1);
});
test('existing Gmail checkpoints switch once to a complete mailbox rescan',async t=>{
  const store=new ArchiveStore(':memory:');account(store);
  store.statement("UPDATE gmail_accounts SET phase='delta',cursor='old-cursor',coverage_version=0").run();
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'archival-gmail-coverage-'));
  t.after(async()=>{store.close();await fs.rm(directory,{recursive:true,force:true});});
  const serial=fn=>Promise.resolve().then(fn);
  const first=new Gmail(store,serial,{directory});await first.ready;
  let row=store.statement('SELECT phase,cursor,coverage_version FROM gmail_accounts').get();
  assert.equal(row.phase,'full');assert.equal(row.coverage_version,2);assert.equal(row.cursor,'old-cursor');
  await first.close();store.statement("UPDATE gmail_accounts SET phase='delta'").run();
  const second=new Gmail(store,serial,{directory});await second.ready;
  row=store.statement('SELECT phase,coverage_version FROM gmail_accounts').get();
  assert.equal(row.phase,'delta');assert.equal(row.coverage_version,2);await second.close();
});

test('Gmail compose scope saves a draft and prepares an idempotent send without sending early',async t=>{
  const calls=[];
  const {g,store}=await harness(t,async(url,options={})=>{
    const u=new URL(url);calls.push({path:u.pathname,method:options.method||'GET'});
    if(u.pathname.endsWith('/drafts')&&options.method==='POST')return response({id:'draft-1',message:{id:'draft-message'}});
    if(u.pathname.endsWith('/messages/send'))return response({id:'sent-1',threadId:'thread-1'});
    if(u.pathname.endsWith('/messages/sent-1'))return response(mail('sent-1',['SENT'],'Delivered','thread-1'));
    throw Error('Unexpected Gmail request: '+u.pathname);
  });seed(g,store);g.vault.accounts.a.scopes=[GMAIL_SCOPE,GMAIL_COMPOSE_SCOPE];
  const input={account:'a',to:'friend@example.com',subject:'Hello',body:'Exact body'};
  const preview=await g.previewEmail(input);assert.equal(preview.capability.allowed,true);
  assert.deepEqual(preview.target.to,['friend@example.com']);
  const saved=await g.saveDraft(input);assert.equal(saved.id,'draft-1');
  assert.equal(calls.filter(c=>c.path.endsWith('/messages/send')).length,0);
  const submissionId='4fae222a-33b1-4e95-a234-e3f713c86d79';
  const prepared=await g.prepare({...input,submissionId});
  assert.equal((await g.prepare({...input,submissionId})).id,prepared.id);
  await assert.rejects(g.prepare({...input,body:'Changed',submissionId}),/different content/);
  assert.equal(calls.filter(c=>c.path.endsWith('/messages/send')).length,0);
  const sent=await g.send(submissionId);assert.equal(sent.status,'sent');
  assert.equal((await g.send(submissionId)).status,'sent');
  assert.equal(calls.filter(c=>c.path.endsWith('/messages/send')).length,1);
});

test('failed pages roll back bodies, labels, deletions and checkpoints; pause protects imports',()=>{
  const s=new ArchiveStore(':memory:');account(s);applyGmailPage(s,'a',[mail()],{cursor:'10'});
  const labelsBefore=s.statement('SELECT labels_json FROM gmail_messages').get().labels_json;
  assert.throws(()=>applyGmailPage(s,'a',[mail('new'),{id:'bad!',threadId:'t1'}],{cursor:'20'},{deleted:['m1'],labels:new Map([['m1',{labelIds:['TRASH']}]])}));
  assert.equal(s.messages({}).length,1);assert.equal(s.statement('SELECT cursor FROM gmail_accounts').get().cursor,'10');
  assert.equal(s.statement('SELECT unavailable FROM gmail_messages').get().unavailable,0);assert.equal(s.statement('SELECT labels_json FROM gmail_messages').get().labels_json,labelsBefore);
  s.updateRoom('gmail:a:t1',{tracked:false});applyGmailPage(s,'a',[mail('paused')],{cursor:'30'});assert.equal(s.messages({}).length,1);
  s.statement('UPDATE gmail_accounts SET enabled=0').run();assert.equal(applyGmailPage(s,'a',[mail('blocked',[],'blocked','t2')],{cursor:'40'}),false);
  assert.equal(s.statement('SELECT cursor FROM gmail_accounts').get().cursor,'30');s.close();
});

test('Synapse metadata does not mark direct Gmail threads as left',async()=>{
  const s=new ArchiveStore(':memory:');account(s);applyGmailPage(s,'a',[mail()]);
  await importArchive(s,{reader:async()=>({records:0})});assert.equal(s.room('gmail:a:t1').source_joined,1);s.close();
});

test('an in-flight page cannot overwrite a user-requested rescan or pause/resume',async t=>{
  let release,started;const fetching=new Promise(r=>started=r);
  const {g,store}=await harness(t,async url=>{
    if(new URL(url).pathname.endsWith('/profile'))return response({historyId:'100'});
    if(new URL(url).pathname.endsWith('/messages'))return response({messages:[{id:'m1'}]});
    started();await new Promise(r=>release=r);return response(mail());
  });seed(g,store);
  const pending=g.syncAccount(store.statement('SELECT * FROM gmail_accounts').get());await fetching;
  await g.accountAction('a','rescan');release();await pending;
  const a=store.statement('SELECT * FROM gmail_accounts').get();assert.equal(a.phase,'full');assert.equal(a.baseline,'');assert.equal(a.checked,0);assert.equal(store.messages({}).length,0);
});

test('a failed concurrent fetch waits for outstanding requests and leaves its page untouched',async t=>{
  let active=0,maximum=0,started=0;
  const {g,store}=await harness(t,async url=>{
    const u=new URL(url);
    if(u.pathname.endsWith('/profile'))return response({historyId:'100'});
    if(u.pathname.endsWith('/messages'))return response({messages:Array.from({length:20},(_,i)=>({id:'m'+i}))});
    active++;maximum=Math.max(maximum,active);started++;
    try{await new Promise(r=>setTimeout(r,u.pathname.endsWith('/m0')?1:20));return u.pathname.endsWith('/m0')?response({},500):response(mail(u.pathname.split('/').at(-1)));}finally{active--;}
  });seed(g,store);
  await assert.rejects(g.syncAccount(store.statement('SELECT * FROM gmail_accounts').get()));
  assert.equal(maximum,4);assert.equal(active,0);assert.equal(started,4);assert.equal(store.messages({}).length,0);assert.equal(store.statement('SELECT page_token FROM gmail_accounts').get().page_token,'');
});

test('OAuth enforces desktop credentials, read-only scope, PKCE and single-use state; tokens stay private',async t=>{
  const calls=[];
  const {g,store,directory}=await harness(t,async(url,options)=>{calls.push({url:String(url),options});
    if(String(url).includes('/token'))return response({access_token:'secret-access',refresh_token:'secret-refresh',expires_in:3600,scope:GMAIL_SCOPE});
    return response({emailAddress:'Me@example.com',historyId:'100'});
  });
  assert.throws(()=>desktopClient({web:client.installed}));
  const start=await g.authorize(),auth=new URL(start.url),redirect=new URL(auth.searchParams.get('redirect_uri'));
  assert.equal(auth.searchParams.get('scope'),GMAIL_SCOPES.join(' '));assert.equal(auth.searchParams.get('code_challenge_method'),'S256');assert.equal(redirect.hostname,'127.0.0.1');
  redirect.searchParams.set('state','forged');redirect.searchParams.set('code','test-code');assert.equal((await fetch(redirect)).status,400);assert.equal(calls.length,0);
  redirect.searchParams.set('state',auth.searchParams.get('state'));assert.equal((await fetch(redirect)).status,200);
  const tokenCall=calls.find(c=>c.url.endsWith('/token'));assert.equal(tokenCall.url,'https://oauth2.googleapis.com/token');
  const verifier=tokenCall.options.body.get('code_verifier');assert.equal(createHash('sha256').update(verifier).digest('base64url'),auth.searchParams.get('code_challenge'));
  const status=await g.status();assert.equal(status.accounts[0].email,'me@example.com');assert.equal(status.accounts[0].linked,true);
  assert.doesNotMatch(JSON.stringify(status),/secret-access|secret-refresh|test-secret/);
  assert.equal(g.pending,null);assert.equal(store.statement('SELECT count(*) n FROM gmail_accounts').get().n,1);
  const restored=new Gmail(store,fn=>Promise.resolve().then(fn),{directory,fetchImpl:()=>{throw new Error('No network expected');}});await restored.ready;
  assert.equal(await restored.accessToken(status.accounts[0].id),'secret-access');await restored.close();
});

test('full import captures baseline before listing, resumes pages, and reuses cached bodies',async t=>{
  const calls=[];
  const {g,store}=await harness(t,async url=>{const u=new URL(url);calls.push(u.pathname+u.search);
    if(u.pathname.endsWith('/profile'))return response({historyId:'100'});
    if(u.pathname.endsWith('/messages'))return response(u.searchParams.has('pageToken')?{messages:[{id:'m1'},{id:'m2'}]}:{messages:[{id:'m1'}],nextPageToken:'page2'});
    if(u.pathname.endsWith('/drafts'))return response({drafts:[{message:{id:'draft1'}}]});
    return response(mail(u.pathname.endsWith('/draft1')?'draft1':u.pathname.endsWith('/m2')?'m2':'m1',u.pathname.endsWith('/draft1')?['DRAFT']:['SENT']));
  });seed(g,store);
  await g.syncAccount(store.statement('SELECT * FROM gmail_accounts').get());
  let a=store.statement('SELECT * FROM gmail_accounts').get();assert.equal(a.phase,'full');assert.equal(a.page_token,'page2');assert.equal(a.cursor,'');assert.equal(a.baseline,'100');
  await g.syncAccount(a);a=store.statement('SELECT * FROM gmail_accounts').get();assert.equal(a.phase,'drafts');assert.equal(a.cursor,'');
  await g.syncAccount(a);a=store.statement('SELECT * FROM gmail_accounts').get();assert.equal(a.phase,'delta');assert.equal(a.cursor,'100');assert.equal(a.checked,4);
  assert.equal(store.messages({}).length,3);assert.equal(calls.filter(c=>c.startsWith('/gmail/v1/users/me/messages/m1')).length,1);
  assert.ok(calls[0].endsWith('/profile'));assert.ok(calls.some(c=>c.includes('pageToken=page2')));
  assert.ok(calls.some(c=>c.includes('includeSpamTrash=true')));
});

test('incremental pages keep the original cursor until completion and archive mail restored from Trash',async t=>{
  const {g,store}=await harness(t,async url=>{const u=new URL(url);
    if(u.pathname.endsWith('/history'))return response(u.searchParams.has('pageToken')?{history:[],historyId:'900'}:{history:[{labelsRemoved:[{message:{id:'restored',threadId:'t1',labelIds:[]},labelIds:['TRASH']}],messagesDeleted:[{message:{id:'m1'}}]}],historyId:'800',nextPageToken:'next'});
    return response(mail('restored',[],'Recovered mail'));
  });seed(g,store);applyGmailPage(store,'a',[mail()],{phase:'delta',cursor:'100'});
  await g.syncAccount(store.statement('SELECT * FROM gmail_accounts').get());
  let a=store.statement('SELECT * FROM gmail_accounts').get();assert.equal(a.cursor,'100');assert.equal(a.page_token,'next');
  assert.equal(store.messages({}).length,2);assert.equal(store.statement("SELECT unavailable FROM gmail_messages WHERE remote_id='m1'").get().unavailable,1);
  await g.syncAccount(a);a=store.statement('SELECT * FROM gmail_accounts').get();assert.equal(a.cursor,'900');assert.equal(a.page_token,'');
});

test('expired history cursor falls back to a cached full scan, and rate limits back off',async t=>{
  let throttle=false;
  const {g,store}=await harness(t,async()=>throttle?response({error:{}},429,{'retry-after':'120'}):response({error:{}},404));seed(g,store);
  applyGmailPage(store,'a',[mail()],{phase:'delta',cursor:'old'});await g.syncAccount(store.statement('SELECT * FROM gmail_accounts').get());
  assert.equal(store.statement('SELECT phase FROM gmail_accounts').get().phase,'full');assert.equal(store.messages({}).length,1);
  throttle=true;await assert.rejects(g.api('a','profile'),/rate limit/);assert.ok(g.retry.get('a')>=Date.now()+119000);
});

test('concurrent token refreshes share one request; disconnect removes local tokens while keeping archive',async t=>{
  let requests=0;
  const {g,store,directory}=await harness(t,async()=>{requests++;await new Promise(r=>setTimeout(r,15));return response({access_token:'renewed',expires_in:3600});});seed(g,store);g.vault.accounts.a.expires=0;
  applyGmailPage(store,'a',[mail()]);assert.deepEqual(await Promise.all([g.accessToken('a'),g.accessToken('a')]),['renewed','renewed']);assert.equal(requests,1);
  await g.accountAction('a','disconnect');assert.equal(store.messages({}).length,1);assert.equal((await g.status()).accounts[0].linked,false);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory,'credentials.json'),'utf8')).accounts.a,undefined);
});

test('resuming a paused thread queues durable recovery and imports its missed messages',async t=>{
  const {g,store}=await harness(t,async url=>new URL(url).pathname.includes('/threads/')?response({messages:[mail(),mail('missed')]}):response({history:[],historyId:'101'}));seed(g,store);
  applyGmailPage(store,'a',[mail()],{phase:'delta',cursor:'100'});store.updateRoom('gmail:a:t1',{tracked:false});store.updateRoom('gmail:a:t1',{tracked:true});
  await g.restoreThread(store.room('gmail:a:t1'));assert.equal(store.statement('SELECT count(*) n FROM gmail_thread_jobs').get().n,1);
  await g.round();assert.equal(store.messages({}).length,2);assert.equal(store.statement('SELECT count(*) n FROM gmail_thread_jobs').get().n,0);
});

test('Gmail HTTP routes require the local mutation token and never expose client secrets',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'archival-gmail-test-'));const store=new ArchiveStore(':memory:');
  const app=createApplication({store,poll:false,port:18788,gmailOptions:{directory},source:{close(){},read(){throw new Error('No bridge expected');}}});
  await new Promise(r=>app.server.listen(18788,'127.0.0.1',r));
  try{
    const base='http://127.0.0.1:18788/api/';const {token}=await(await fetch(base+'bootstrap')).json();
    assert.equal((await fetch(base+'gmail/client',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client})})).status,403);
    assert.equal((await fetch(base+'gmail/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'forged'})})).status,403);
    const configured=await fetch(base+'gmail/client',{method:'POST',headers:{'Content-Type':'application/json','X-Archival-Token':token},body:JSON.stringify({client})});assert.equal(configured.status,200);
    const status=await(await fetch(base+'gmail')).json();assert.equal(status.configured,true);assert.doesNotMatch(JSON.stringify(status),/test-secret/);
  }finally{await app.close();assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('archival-gmail-test-'));await fs.rm(directory,{recursive:true,force:true});}
});

test('MIME send formatting preserves Unicode and Bcc while rejecting header injection',()=>{
  const draft=prepareEmail({id:'a',email:'me@example.com'},{to:'"Doe, Jane" <jane@example.com>',cc:'team@example.com',bcc:'private@example.com',subject:'Hello 🌸',body:'Line one\nनमस्ते'},null,{now:1700000000000,uuid:'unit-test'});
  const decoded=Buffer.from(draft.raw,'base64url').toString();
  assert.match(decoded,/From: me@example.com\r\nTo: jane@example.com/);assert.match(decoded,/Bcc: private@example.com/);
  assert.match(decoded,/Subject: =\?UTF-8\?B\?/);assert.match(decoded,/Message-ID: <unit-test@example.com>/);
  const encodedBody=decoded.split('\r\n\r\n')[1];assert.equal(Buffer.from(encodedBody.replace(/\s/g,''),'base64').toString(),'Line one\r\nनमस्ते');
  for(const [field,value]of [['to','a@example.com\r\nBcc: secret@example.com'],['subject','Hello\nBcc: hidden@example.com']])
    assert.throws(()=>prepareEmail({id:'a',email:'me@example.com'},{to:'ok@example.com',subject:'Hello',body:'Body',[field]:value}),/Invalid/);
});

test('replies honor Reply-To, the original mailbox, message ID, references and subject',()=>{
  const store=new ArchiveStore(':memory:');account(store);
  const original=mail('incoming',[],'Original');original.payload.headers.push({name:'Reply-To',value:'"Doe, Jane" <jane@example.com>'},{name:'Message-ID',value:'<original@example.com>'},{name:'References',value:'<first@example.com>'});
  applyGmailPage(store,'a',[original]);const defaults=replyDefaults(store,'gmail:a:incoming');assert.equal(defaults.to,'jane@example.com');
  const draft=prepareEmail({id:'a',email:'me@example.com'},{...defaults,subject:'Changed',body:'Reply'},defaults.parent);
  assert.equal(draft.threadId,'t1');assert.equal(draft.subject,'Re: Planning');const decoded=Buffer.from(draft.raw,'base64url').toString();
  assert.match(decoded,/In-Reply-To: <original@example.com>/);assert.match(decoded,/References: <first@example.com>\r\n <original@example.com>/);
  assert.throws(()=>prepareEmail({id:'b',email:'different@example.com'},{...defaults,body:'Reply'},defaults.parent),/mailbox/);store.close();
});

test('old read-only connections keep receiving but require explicit consent before preparing sends',async t=>{
  const {g,store}=await harness(t);seed(g,store);
  assert.equal((await g.status()).accounts[0].canSend,false);
  await assert.rejects(g.prepare({account:'a',to:'friend@example.com',subject:'Hello',body:'Hello'}),/permission is missing/);
  assert.equal(store.statement('SELECT count(*) n FROM gmail_outgoing').get().n,0);
});

test('reviewing never sends; sends use the prepared snapshot once and archive the confirmed outgoing mail',async t=>{
  let sends=0;const {g,store}=await harness(t,async(url,options)=>{
    if(String(url).endsWith('/messages/send')){sends++;const payload=JSON.parse(options.body);assert.match(Buffer.from(payload.raw,'base64url').toString(),/From: me@example.com/);await new Promise(r=>setTimeout(r,15));return response({id:'outgoing',threadId:'t1'});}
    return response(mail('outgoing',['SENT'],'Hello from Archival'));
  });seed(g,store);g.vault.accounts.a.scopes=GMAIL_SCOPES;
  const prepared=await g.prepare({account:'a',to:'friend@example.com',subject:'Hello',body:'Hello from Archival'});
  assert.equal(sends,0);assert.equal(prepared.status,'ready');assert.equal(prepared.raw,undefined);
  const results=await Promise.all([g.send(prepared.id),g.send(prepared.id)]);assert.ok(results.every(r=>r.status==='sent'));assert.equal(sends,1);
  assert.equal((await g.send(prepared.id)).status,'sent');assert.equal(sends,1);assert.equal(store.messages({}).length,1);assert.equal(store.messages({})[0].is_me,1);
});

test('network uncertainty and rejected sends are not retried, including after restart recovery',async t=>{
  let calls=0;const {g,store,directory}=await harness(t,async()=>{calls++;throw new Error('Socket ended after writing request');});seed(g,store);g.vault.accounts.a.scopes=GMAIL_SCOPES;
  const prepared=await g.prepare({account:'a',to:'friend@example.com',subject:'Hello',body:'Hello'});
  assert.equal((await g.send(prepared.id)).status,'unknown');await g.send(prepared.id);assert.equal(calls,1);
  const interrupted=await g.prepare({account:'a',to:'friend@example.com',subject:'Interrupted',body:'Hello'});
  store.statement("UPDATE gmail_outgoing SET status='sending' WHERE id=?").run(interrupted.id);
  const restarted=new Gmail(store,fn=>Promise.resolve().then(fn),{directory,fetchImpl:()=>{throw new Error('Never retry');}});await restarted.ready;
  assert.equal(restarted.outgoing(interrupted.id)[0].status,'unknown');await restarted.close();
  g.fetch=async()=>{calls++;return response({},403);};
  const rejected=await g.prepare({account:'a',to:'friend@example.com',subject:'Rejected',body:'Hello'});
  assert.equal((await g.send(rejected.id)).status,'failed');await g.send(rejected.id);assert.equal(calls,2);
});

test('a confirmed delivery stays sent when archiving fails, and replies include the thread ID',async t=>{
  const {g,store}=await harness(t,async(url,options)=>{
    if(String(url).endsWith('/messages/send')){assert.equal(JSON.parse(options.body).threadId,'t1');return response({id:'sent1',threadId:'t1'});}
    return response({},500);
  });seed(g,store);g.vault.accounts.a.scopes=GMAIL_SCOPES;
  const original=mail('incoming',[]);original.payload.headers.push({name:'Message-ID',value:'<original@example.com>'});applyGmailPage(store,'a',[original]);
  const prepared=await g.prepare({account:'a',replyTo:'gmail:a:incoming',to:'friend@example.com',subject:'ignored',body:'A reply'});
  const sent=await g.send(prepared.id);assert.equal(sent.status,'sent');assert.equal(sent.remote_id,'sent1');assert.equal(sent.thread_id,'t1');
});
