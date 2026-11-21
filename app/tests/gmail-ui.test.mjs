import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

function browser(){
  const elements=new Map();
  const document={querySelector(selector){
    if(!elements.has(selector))elements.set(selector,{innerHTML:'',value:'',textContent:'',hidden:false,disabled:false,open:false,showModal(){this.open=true;},close(){this.open=false;},querySelectorAll:()=>[]});return elements.get(selector);
  },querySelectorAll:()=>[],addEventListener(){}};
  const ctx=vm.createContext({document,URLSearchParams,setTimeout:()=>1,clearTimeout(){}});
  const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  vm.runInContext(app.slice(0,app.lastIndexOf('(async()=>')),ctx);
  vm.runInContext(readFileSync(new URL('../public/gmail.js',import.meta.url),'utf8'),ctx);
  return {ctx,elements,run:code=>vm.runInContext(code,ctx)};
}
test('composer reviews an immutable email before sending and submits only its prepared ID',async()=>{
  const b=browser(),calls=[];const row={id:'draft-1',account_id:'a',from:'me@example.com',to:['friend@example.com'],cc:[],bcc:[],subject:'Hello',body:'Message',replyTo:'',status:'ready'};
  b.ctx.handler=async(path,input)=>{calls.push({path,input});if(path==='gmail')return {accounts:[{id:'a',email:'me@example.com',linked:true,canSend:true}]};if(path==='gmail/prepare')return row;if(path==='gmail/send')return {...row,status:'sent'};throw new Error('Unexpected path');};
  b.run('api=handler;refreshStats=async()=>({});');await b.run('composeEmail()');
  b.run("$('#mail-to').value='friend@example.com';$('#mail-cc').value='';$('#mail-bcc').value='';$('#mail-subject').value='Hello';$('#mail-body').value='Message';");
  await b.run("$('#gmail-compose-form').onsubmit({preventDefault(){}})");assert.equal(calls.filter(c=>c.path==='gmail/send').length,0);
  assert.match(b.elements.get('#modal-content').innerHTML,/Review your email/);assert.match(b.elements.get('#modal-content').innerHTML,/friend@example.com/);
  await b.run("$('#mail-send').onclick()");assert.deepEqual(JSON.parse(JSON.stringify(calls.find(c=>c.path==='gmail/send').input)),{id:'draft-1'});
  assert.match(b.elements.get('#modal-content').innerHTML,/Email sent/);
});

test('a lost send HTTP response checks durable outcome without issuing another send',async()=>{
  const b=browser();let sends=0;const row={id:'draft-1',from:'me@example.com',to:['friend@example.com'],cc:[],bcc:[],subject:'Hello',body:'Message',status:'ready'};
  b.ctx.row=row;b.ctx.handler=async path=>{if(path==='gmail/send'){sends++;throw new Error('Local response lost');}if(path.startsWith('gmail/outgoing'))return [{...row,status:'sent'}];throw new Error('Unexpected path');};
  b.run('api=handler;refreshStats=async()=>({});showEmailReview(row,{})');await b.run("$('#mail-send').onclick()");assert.equal(sends,1);assert.match(b.elements.get('#modal-content').innerHTML,/Email sent/);
});

test('read-only accounts explain reauthorization and do not open a send form',async()=>{
  const b=browser();b.ctx.handler=async()=>({accounts:[{id:'a',linked:true,canSend:false}]});b.run('api=handler;');await b.run('composeEmail()');
  assert.match(b.elements.get('#modal-content').innerHTML,/Enable Gmail sending/);assert.match(b.elements.get('#modal-content').innerHTML,/gmail.send/);
  assert.doesNotMatch(b.elements.get('#modal-content').innerHTML,/id="mail-send"/);
});
