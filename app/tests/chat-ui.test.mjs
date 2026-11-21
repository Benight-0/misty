import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
function browser(){
  const elements=new Map();const document={querySelector(selector){if(!elements.has(selector))elements.set(selector,{innerHTML:'',value:'',textContent:'',dataset:{},hidden:false,disabled:false,querySelectorAll:()=>[]});return elements.get(selector);},querySelectorAll:()=>[],addEventListener(){}};
  const ctx=vm.createContext({document,URLSearchParams,crypto:webcrypto,setTimeout:()=>1,clearTimeout(){}});
  const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');vm.runInContext(app.slice(0,app.lastIndexOf('(async()=>')),ctx);vm.runInContext(readFileSync(new URL('../public/chat.js',import.meta.url),'utf8'),ctx);
  return {ctx,elements,run:code=>vm.runInContext(code,ctx)};
}
const room={id:'!test:localhost',platform:'discord',name:'Test chat'};
async function setup(handler){const b=browser();b.ctx.room=room;b.ctx.handler=handler;b.run("api=handler;state.room=room;");await b.run('renderChatComposer(room)');return b;}
const cap={allowed:true,maxLength:2000};
test('typing and polling never send; explicit submit keeps a plain text immutable destination',async()=>{
  const sends=[],rows=[];const b=await setup(async(path,input)=>{if(path.startsWith('chat/capability'))return cap;if(path.startsWith('chat/outgoing'))return rows;if(path==='chat/send'){sends.push(input);const row={...input,status:'pending',platform:'discord'};rows.push(row);return row;}throw Error(path);});
  assert.equal(b.elements.get('#chat-send').disabled,true);b.run("$('#chat-body').value='Hello 🙂';$('#chat-body').oninput()");await b.run('refreshChatComposer()');assert.equal(sends.length,0);
  await b.run("$('#chat-send-form').onsubmit({preventDefault(){}})");assert.equal(sends.length,1);assert.equal(sends[0].room,room.id);assert.equal(sends[0].body,'Hello 🙂');assert.match(sends[0].id,/^chat-/);assert.equal(b.elements.get('#chat-body').value,'');assert.match(b.elements.get('#chat-status').textContent,/awaiting bridge/);
  rows[0].status='sent';await b.run('refreshChatComposer()');assert.match(b.elements.get('#chat-status').textContent,/Sent to Discord/);
});
test('lost local responses retain the draft and reuse the identical submission ID on explicit retry',async()=>{
  const sends=[];const b=await setup(async(path,input)=>{if(path.startsWith('chat/capability'))return cap;if(path.startsWith('chat/outgoing'))return [];if(path==='chat/send'){sends.push(input);throw Error('Connection interrupted');}});
  b.run("$('#chat-body').value='Hello';$('#chat-body').oninput()");await b.run("$('#chat-send-form').onsubmit({preventDefault(){}})");assert.equal(sends.length,1);assert.equal(b.elements.get('#chat-body').value,'Hello');assert.match(b.elements.get('#chat-send').textContent,/Retry same/);
  await b.run("$('#chat-send-form').onsubmit({preventDefault(){}})");assert.equal(sends.length,2);assert.equal(sends[0].id,sends[1].id);
});
test('switching rooms during submission preserves the other room draft and blocks duplicate clicks',async()=>{
  let resolve,calls=0;const b=await setup(async(path,input)=>{if(path.startsWith('chat/capability'))return cap;if(path.startsWith('chat/outgoing'))return [];if(path==='chat/send'){calls++;return new Promise(r=>resolve=()=>r({...input,status:'pending'}));}});
  b.run("$('#chat-body').value='Original';$('#chat-body').oninput()");const pending=b.run("$('#chat-send-form').onsubmit({preventDefault(){}})");await b.run("$('#chat-send-form').onsubmit({preventDefault(){}})");assert.equal(calls,1);
  b.run("state.room={...room,id:'!other:localhost'}");await b.run('renderChatComposer(state.room)');b.run("$('#chat-body').value='Other draft';$('#chat-body').oninput()");resolve();await pending;
  assert.equal(b.elements.get('#chat-body').value,'Other draft');b.run('state.room=room');await b.run('renderChatComposer(room)');assert.equal(b.elements.get('#chat-body').value,'');
});
test('uncertain submissions require an explicit unlock and failed messages retain editable drafts',async()=>{
  let outcome='unknown';const rows=[];const b=await setup(async(path,input)=>{if(path.startsWith('chat/capability'))return cap;if(path.startsWith('chat/outgoing'))return rows;if(path==='chat/send'){const row={...input,status:outcome,platform:'discord',error:'Check native app'};rows.unshift(row);return row;}});
  b.run("$('#chat-body').value='Hello';$('#chat-body').oninput()");await b.run("$('#chat-send-form').onsubmit({preventDefault(){}})");assert.equal(b.elements.get('#chat-send').disabled,true);assert.equal(b.elements.get('#chat-unlock').hidden,false);assert.equal(b.elements.get('#chat-body').value,'Hello');
  b.run("$('#chat-unlock').onclick()");outcome='failed';await b.run("$('#chat-send-form').onsubmit({preventDefault(){}})");assert.equal(b.elements.get('#chat-body').disabled,false);assert.equal(b.elements.get('#chat-body').value,'Hello');
});
test('excluded chats show the reason and do not expose a send form',async()=>{
  const b=await setup(async path=>path.startsWith('chat/capability')?{allowed:false,reason:'This Discord server is excluded from Archival.'}:[]);
  assert.match(b.elements.get('#chat-composer').innerHTML,/server is excluded/);assert.doesNotMatch(b.elements.get('#chat-composer').innerHTML,/id="chat-send-form"/);
});

test('VM conversations use the working composer and refresh sent status',async()=>{
  const rows=[],sends=[],b=browser();b.ctx.room=room;
  b.ctx.handler=async(path,input)=>{if(path.startsWith('chat/capability'))return {...cap,transport:'native'};if(path.startsWith('chat/outgoing'))return rows;if(path==='chat/send'){sends.push(input);const row={...input,status:'sent',platform:'discord'};rows.push(row);return row;}throw Error(path);};
  b.run("api=handler;state.runtime='vm';state.room=room;");await b.run('renderChatComposer(room)');
  assert.match(b.elements.get('#chat-composer').innerHTML,/chat-send-form/);
  b.run("$('#chat-body').value='VM test';$('#chat-body').oninput()");await b.run("$('#chat-send-form').onsubmit({preventDefault(){}})");
  assert.equal(sends.length,1);assert.equal(sends[0].room,room.id);assert.match(b.elements.get('#chat-status').textContent,/Sent to Discord/);
});
