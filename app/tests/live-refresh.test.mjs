import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
function browser(){
  const elements=new Map();
  const document={querySelector(selector){
    if(!elements.has(selector))elements.set(selector,{innerHTML:'',scrollTop:0,hidden:false,textContent:'',clientHeight:200,
      get scrollHeight(){return (this.innerHTML.match(/<article /g)||[]).length*40+36;},
      classList:{add(){},remove(){},toggle(){}},setAttribute(){},addEventListener(){},
      insertAdjacentHTML(position,html){this.innerHTML=position==='afterbegin'?html+this.innerHTML:this.innerHTML+html;},getBoundingClientRect:()=>({top:0}),
      querySelectorAll(){const pane=this;return [...this.innerHTML.matchAll(/data-message="([^"]+)"/g)].map((m,index)=>({dataset:{message:m[1]},getBoundingClientRect:()=>({top:36+index*40-pane.scrollTop,bottom:76+index*40-pane.scrollTop})}));}});
    return elements.get(selector);
  },querySelectorAll:()=>[],addEventListener(){}};
  const ctx=vm.createContext({document,URLSearchParams,setTimeout,clearTimeout});
  vm.runInContext(source.slice(0,source.lastIndexOf('(async()=>')),ctx);
  return {ctx,elements,run:code=>vm.runInContext(code,ctx)};
}
function messages(count,start=count){return Array.from({length:count},(_,i)=>({id:'m'+String(start-i).padStart(5,'0'),room_id:'rumal',author:'Owner',body:'message '+(start-i),is_me:1,ts:start-i}));}
test('live message refresh preserves own/search filters, loaded history and scroll',async()=>{
  const b=browser(),calls=[];
  b.ctx.rows=messages(160);b.ctx.handler=async path=>{calls.push(new URLSearchParams(path.split('?')[1]));return b.ctx.rows;};
  b.run("api=handler;state.room={id:'rumal'};state.own=true;state.messageQuery='hello';messageRows=rows;messageScope=messageViewKey();messageRendered=true;state.messageOffset=80;$('#messages').innerHTML=[...rows].reverse().map(m=>messageMarkup(m)).join('');");
  b.run("$('#messages').scrollTop=123");
  await b.run('loadMessages(false,true)');
  assert.equal(calls.length,1);
  assert.equal(calls[0].has('offset'),false);assert.equal(calls[0].get('limit'),'160');
  assert.ok(calls.every(p=>p.get('own')==='true'&&p.get('q')==='hello'&&p.get('room')==='rumal'));
  assert.equal(b.run('state.messageOffset'),80);
  assert.equal(b.elements.get('#messages').scrollTop,123);
  assert.match(b.elements.get('#messages').innerHTML,/You · Owner/);
});
test('a late message response cannot replace a different selected conversation',async()=>{
  const b=browser();let resolve;
  b.ctx.handler=()=>new Promise(r=>resolve=r);
  b.run("api=handler;state.room={id:'old'};$('#messages').innerHTML='new room content';");
  const pending=b.run('loadMessages()');
  b.run("state.room={id:'new'}");resolve([{id:'old-message',body:'old'}]);await pending;
  assert.equal(b.elements.get('#messages').innerHTML,'new room content');
});
test('poll refreshes the room list and selected messages on a new archive checkpoint',async()=>{
  const b=browser();
  b.run("state.room={id:'rumal'};globalThis.calls=[];refreshStats=async()=>({cursor:2,messages:{total:4},rooms:{total:1}});loadRooms=async(...a)=>calls.push(['rooms',...a]);loadMessages=async(...a)=>{calls.push(['messages',...a]);return true;};api=async()=>({room:{id:'rumal',platform:'discord',message_count:4,own_count:2},fit:{}});");
  await b.run('pollInbox()');await b.run('pollInbox()');
  assert.deepEqual(JSON.parse(b.run('JSON.stringify(calls)')),[['rooms',false,true],['messages',false,true]]);
  assert.match(b.elements.get('#detail .detail-title small').textContent,/2 from you/);
});
test('automatic refresh does not cancel an in-flight older-history request',async()=>{
  const b=browser();let resolve;
  b.ctx.rows=messages(80,160);b.run("state.room={id:'rumal'}");await b.run('loadMessages(false,false,rows)');
  b.ctx.handler=()=>new Promise(r=>resolve=r);
  b.run("api=handler;");
  const pending=b.run('loadMessages(true)');
  assert.equal(await b.run('loadMessages(false,true)'),false);
  resolve([{id:'older',body:'history',ts:1}]);await pending;
  assert.equal(b.run('state.messageOffset'),1);
});

test('a chat opens oldest to newest, starts at the bottom and uses its bundled first page',async()=>{
 const b=browser(),calls=[];b.ctx.rows=messages(80);b.ctx.handler=async path=>{calls.push(path);return {room:{id:'rumal',name:'Rumal',platform:'discord',kind:'dm'},messages:b.ctx.rows};};b.run('api=handler;');await b.run("selectRoom('rumal')");
 const pane=b.elements.get('#messages');assert.ok(pane.innerHTML.indexOf('message 1<')<pane.innerHTML.indexOf('message 80<'));assert.equal(pane.scrollTop,pane.scrollHeight-pane.clientHeight);assert.equal(calls.length,1);assert.match(calls[0],/messages=true/);
});
test('older messages use an immutable cursor, prepend and preserve the visible reading position',async()=>{
 const b=browser();b.ctx.rows=messages(80,160);b.run("state.room={id:'rumal'}");await b.run('loadMessages(false,false,rows)');const pane=b.elements.get('#messages');pane.scrollTop=80;const height=pane.scrollHeight;
 let params;b.ctx.handler=async path=>{params=new URLSearchParams(path.split('?')[1]);return messages(80);};b.run('api=handler;');await b.run('loadMessages(true)');
 assert.equal(params.get('before'),'81');assert.equal(params.get('before_id'),'m00081');assert.equal(params.has('offset'),false);assert.equal(pane.scrollTop,80+pane.scrollHeight-height);assert.ok(pane.innerHTML.indexOf('message 1<')<pane.innerHTML.indexOf('message 160<'));
});
test('upward scrolling loads one older page automatically and stops at the beginning',async()=>{
 const b=browser();b.ctx.rows=messages(80,160);b.run("state.room={id:'rumal'}");await b.run('loadMessages(false,false,rows)');b.run('bindMessageScroll()');let resolve,calls=0;
 b.ctx.handler=()=>{calls++;return new Promise(r=>resolve=r);};b.run('api=handler;');const pane=b.elements.get('#messages');pane.scrollTop=100;pane.onscroll();pane.scrollTop=60;pane.onscroll();assert.equal(calls,1);
 resolve(messages(12,80));await new Promise(r=>setImmediate(r));assert.equal(b.run('messageHasOlder'),false);pane.scrollTop=0;pane.onscroll();assert.equal(calls,1);
});
test('live arrival follows the bottom, but does not move someone reading older messages',async()=>{
 const b=browser();b.ctx.rows=messages(80,160);b.run("state.room={id:'rumal'}");await b.run('loadMessages(false,false,rows)');b.ctx.handler=async()=>messages(80,161);b.run('api=handler;');await b.run('loadMessages(false,true)');const pane=b.elements.get('#messages');assert.equal(pane.scrollTop,pane.scrollHeight-pane.clientHeight);
 pane.scrollTop=80;const first=pane.querySelectorAll('[data-message]').find(el=>el.getBoundingClientRect().bottom>0);const top=first.getBoundingClientRect().top;
 b.ctx.handler=async()=>messages(81,162);await b.run('loadMessages(false,true)');const same=pane.querySelectorAll('[data-message]').find(el=>el.dataset.message===first.dataset.message);assert.equal(same.getBoundingClientRect().top,top);
});
test('refresh fills a large live gap before joining older loaded history',async()=>{
 const b=browser();b.ctx.rows=messages(80,160);b.run("state.room={id:'rumal'}");await b.run('loadMessages(false,false,rows)');const calls=[];
 b.ctx.handler=async path=>{calls.push(path);const params=new URLSearchParams(path.split('?')[1]);return params.has('before')?Number(params.get('before'))===361?messages(200,360):messages(80,160):messages(80,440);};b.run('api=handler;');await b.run('loadMessages(false,true)');assert.equal(calls.length,3);assert.equal(b.run('messageRows.length'),360);assert.equal(b.run('new Set(messageRows.map(m=>m.id)).size'),360);
});

test('a failed older page can retry with the same cursor and cannot overwrite changed filters',async()=>{
 const b=browser();b.ctx.rows=messages(80,160);b.run("state.room={id:'rumal'}");await b.run('loadMessages(false,false,rows)');
 let reject,calls=[];b.ctx.handler=path=>{calls.push(path);return new Promise((resolve,r)=>reject=r);};b.run('api=handler;');const failed=b.run('loadMessages(true)');reject(Error('Network interrupted'));await failed;
 assert.equal(b.run('messageRows.length'),80);assert.equal(b.elements.get('#older').disabled,false);assert.match(b.elements.get('#older').textContent,/Retry/);
 let resolve;b.ctx.handler=path=>{calls.push(path);return new Promise(r=>resolve=r);};b.run('api=handler;');const retry=b.run('loadMessages(true)');assert.equal(calls[0],calls[1]);
 b.ctx.newRows=messages(3,300);b.run('state.own=true');await b.run('loadMessages(false,false,newRows)');resolve(messages(80));await retry;assert.equal(b.run('messageRows.length'),3);assert.equal(b.run('messageRows[0].ts'),300);
});

test('refreshing multiple loaded chunks also uses stable cursors instead of shifting offsets',async()=>{
 const b=browser();b.ctx.rows=messages(240,300);b.run("state.room={id:'rumal'}");await b.run('loadMessages(false,false,rows)');const calls=[];
 b.ctx.handler=async path=>{const p=new URLSearchParams(path.split('?')[1]);calls.push(p);return p.has('before')?messages(40,100):messages(200,300);};b.run('api=handler;');await b.run('loadMessages(false,true)');
 assert.equal(calls.length,2);assert.ok(calls.every(p=>!p.has('offset')));assert.equal(calls[1].get('before'),'101');assert.equal(calls[1].get('before_id'),'m00101');assert.equal(b.run('messageRows.length'),240);
});
