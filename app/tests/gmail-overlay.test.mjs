import test from 'node:test';
import assert from 'node:assert/strict';
import {ArchiveStore} from '../store.mjs';
import {ingestEmail} from '../gmail-store.mjs';
import {GmailOverlay} from '../gmail-overlay.mjs';
import {Gmail,GMAIL_MODIFY_SCOPE} from '../gmail.mjs';

const account={id:'mailbox',email:'owner@example.com'};
function fixture(t){
 const store=new ArchiveStore(':memory:');t.after(()=>store.close());
 store.statement('INSERT INTO gmail_accounts(id,email) VALUES(?,?)').run(account.id,account.email);
 const mail=(id,subject,labels=['INBOX','UNREAD'])=>ingestEmail(store,account,{
  id,threadId:'thread'+id,internalDate:String(Date.now()),labelIds:labels,
  payload:{mimeType:'text/plain',headers:[{name:'From',value:'University <user-19@example.com>'},{name:'To',value:account.email},
   {name:'Subject',value:subject}],body:{data:Buffer.from('Tuition and courses').toString('base64url')}}});
 mail('one','College course');mail('two','A promotion',['INBOX']);
 const gmail={store,ready:Promise.resolve(),vault:{accounts:{mailbox:{scopes:[]}}},
  status:async()=>({accounts:[{id:'mailbox',canDraft:true,canSend:true,canManage:false}]})};
 return {store,mail,gmail,overlay:new GmailOverlay(gmail)};
}
test('native Gmail navigation lists inbox and editable categories with full body',async t=>{
 const {overlay}=fixture(t);
 const nav=await overlay.navigation('mailbox');
 assert.equal(nav.folders.find(row=>row.id==='inbox').count,2);
 assert.equal(nav.categories.find(row=>row.id==='college').count,2);
 const page=await overlay.list({account:'mailbox',folder:'inbox',query:'College'});
 assert.equal(page.messages.length,1);
 const opened=await overlay.open(page.messages[0].id);
 assert.match(opened.body,/Tuition and courses/);
 assert.equal(opened.reply.to,'user-19@example.com');
 const saved=overlay.saveCategory({name:'Fees',rules:{subject:'tuition, invoice'}});
 assert.equal(saved.name,'Fees');
 assert.equal(overlay.categories().find(row=>row.id===saved.id).rules.subject.length,2);
 assert.deepEqual(overlay.deleteCategory(saved.id),{ok:true});
});
test('Gmail actions require the management grant and update only after Google confirms',async t=>{
 const {store}=fixture(t);let posted=0;
 const gmail=new Gmail(store,fn=>Promise.resolve().then(fn),{directory:'missing-local-test-vault',fetchImpl:async(url,options)=>{
  posted++;assert.equal(options.method,'POST');assert.match(String(url),/messages\/one\/modify$/);
  return Response.json({id:'one',labelIds:['INBOX','STARRED']});
 }});
 await gmail.ready;gmail.vault.accounts.mailbox={scopes:[],access_token:'test',expires:Date.now()+3600000};
 await assert.rejects(gmail.modifyEmail('gmail:mailbox:one','star'),/gmail.modify/);
 assert.equal(posted,0);
 gmail.vault.accounts.mailbox.scopes=[GMAIL_MODIFY_SCOPE];
 const result=await gmail.modifyEmail('gmail:mailbox:one','star');
 assert.deepEqual(result.labels,['INBOX','STARRED']);
 assert.equal(posted,1);
 assert.equal(JSON.parse(store.statement('SELECT labels_json FROM gmail_messages WHERE message_id=?').get('gmail:mailbox:one').labels_json).includes('STARRED'),true);
 await gmail.close();
});
