import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
function browser(){
 const elements=new Map(),listeners=new Map();
 function el(s){if(!elements.has(s))elements.set(s,{innerHTML:'',textContent:'',hidden:false,open:false,value:'',dataset:{},disabled:false,children:[],classList:{toggle(){},add(){},remove(){}},setAttribute(){},querySelectorAll:()=>[],addEventListener(name,fn){listeners.set(s+':'+name,fn);},append(child){child.parent=s;},showModal(){this.open=true;},close(){this.open=false;}});return elements.get(s);}
 const document={querySelector:el,querySelectorAll:()=>[],addEventListener(){},body:{dataset:{}}};
 const ctx=vm.createContext({document,URLSearchParams,setTimeout:()=>1,clearTimeout(){}}),app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 vm.runInContext(app.slice(0,app.lastIndexOf('(async()=>')),ctx);vm.runInContext(readFileSync(new URL('../public/gmail.js',import.meta.url),'utf8'),ctx);vm.runInContext(readFileSync(new URL('../public/briefings.js',import.meta.url),'utf8'),ctx);vm.runInContext(readFileSync(new URL('../public/misty.js',import.meta.url),'utf8'),ctx);
 return {ctx,elements,listeners,run:code=>vm.runInContext(code,ctx)};
}
const profile={identity:{id:'alex',name:'<Alex>',platform:'discord',alias:'',is_me:0},coverage:{messages:10,chats:6,first:1,last:2},total:6,chats:[{room:{id:'room',name:'Coding <chat>',platform:'discord',message_count:20,person_messages:10},person:{id:'alex',observations:[{text:'Uses <script> tags in examples.',evidence:['$a']}],preferences:[],topics:[]},summary:[],recent:[],followups:[],events:[]} ]};
test('person profiles show loading immediately, escape content and allow retry without mutations',async()=>{
 const b=browser();let resolve;const calls=[];b.ctx.handler=path=>{calls.push(path);return new Promise(r=>resolve=r);};b.run('api=handler;');const pending=b.run("showPersonProfile('alex','room')");assert.match(b.elements.get('#modal-content').innerHTML,/Loading profile/);resolve(profile);await pending;
 const html=b.elements.get('#modal-content').innerHTML;assert.match(html,/&lt;Alex&gt;/);assert.match(html,/&lt;script&gt;/);assert.match(html,/Personality & communication/);assert.match(html,/Load more conversations/);assert.equal(calls.length,1);
});
test('a slow person response cannot overwrite a later person or reopen a closed dialog',async()=>{
 const b=browser(),pending=new Map();b.ctx.handler=path=>new Promise(resolve=>pending.set(new URLSearchParams(path.split('?')[1]).get('id'),resolve));b.run('api=handler;');
 const a=b.run("showPersonProfile('first')"),c=b.run("showPersonProfile('second')");pending.get('second')({...profile,identity:{...profile.identity,id:'second',name:'Second'}});await c;pending.get('first')(profile);await a;assert.match(b.elements.get('#modal-content').innerHTML,/Second/);assert.doesNotMatch(b.elements.get('#modal-content').innerHTML,/&lt;Alex&gt;/);
 const closed=b.run("showPersonProfile('third')");b.run("$('#close-modal').onclick()");pending.get('third')(profile);await closed;assert.equal(b.elements.get('#modal').open,false);
});
test('profile pagination retains loaded conversation details and retries a failed page',async()=>{
 const b=browser();let failed=true;b.ctx.handler=async path=>{if(path.includes('offset=0'))return profile;if(failed)throw Error('Interrupted');return {...profile,chats:[{...profile.chats[0],room:{...profile.chats[0].room,id:'second',name:'Second chat'}}]};};b.run('api=handler;');await b.run("showPersonProfile('alex')");await b.run("showPersonProfile('alex','',true)");assert.match(b.elements.get('#modal-content').innerHTML,/Coding &lt;chat&gt;/);assert.equal(b.elements.get('#person-more').disabled,false);failed=false;await b.run("showPersonProfile('alex','',true)");assert.match(b.elements.get('#modal-content').innerHTML,/Second chat/);assert.match(b.elements.get('#modal-content').innerHTML,/Coding &lt;chat&gt;/);
});
test('settings move the actual content into a full-screen dialog and return it on close',()=>{
 const b=browser();b.run("syncSettingsShell('profile')");assert.equal(b.elements.get('#user-settings').open,true);assert.equal(b.elements.get('#content').parent,'#settings-slot');b.run("syncSettingsShell('inbox')");assert.equal(b.elements.get('#user-settings').open,false);assert.equal(b.elements.get('#content').parent,'#workspace-main');
});
test('a briefing closed during loading stays closed when the response arrives',async()=>{
 const b=browser();let resolve;b.ctx.handler=()=>new Promise(r=>resolve=r);b.run('api=handler;');const pending=b.run("showChatBriefing('room')");assert.match(b.elements.get('#modal-content').innerHTML,/Loading chat summary/);b.run("$('#close-modal').onclick()");resolve({eligible:false,reason:'Not connected.'});await pending;assert.equal(b.elements.get('#modal').open,false);assert.doesNotMatch(b.elements.get('#modal-content').innerHTML,/Not connected/);
});

test('a source deep link loads the exact original separately from nearby context and escapes its text',async()=>{
 const b=browser();let requested='';b.ctx.handler=async path=>{requested=path;return {event:{id:'exact',body:'Birthday <script>',author:'Friend',conversation:'Example',platform:'whatsapp',ts:1},context:[{id:'nearby',body:'Context',author:'Friend',ts:2}]};};
 b.run('api=handler;');await b.run("openSourceLink('?source=exact')");assert.equal(requested,'evidence?id=exact');assert.match(b.elements.get('#modal-content').innerHTML,/Original message/);assert.match(b.elements.get('#modal-content').innerHTML,/Birthday &lt;script&gt;/);assert.match(b.elements.get('#modal-content').innerHTML,/Nearby context/);
});

test('VM connections describe Misty email approval and expose no direct sending controls',async()=>{
 const b=browser();b.ctx.handler=async path=>path==='stats'?{sync:{ok:true},messages:{total:0},rooms:{total:0},platforms:[]}:path==='gmail'?{configured:false,accounts:[]}:{};
 b.run("api=handler;state.runtime='vm';state.page='sync'");
 await b.run('renderVmSync()');
 const card=b.elements.get('#gmail-accounts').innerHTML;
 assert.match(card,/Web application OAuth client JSON/);
 assert.match(card,/Archive Gmail on your VM/);
 assert.doesNotMatch(card,/id="gmail-compose"|id="gmail-send-history"/);
 assert.match(b.elements.get('#content').innerHTML,/exact preview with your fresh yes/);
});

test('migrated Desktop Gmail connection offers sync without a broken VM sign-in',async()=>{
 const b=browser();b.ctx.handler=async path=>path==='stats'?{sync:{ok:true},messages:{total:0},rooms:{total:0},platforms:[]}:path==='gmail'?{configured:true,desktopClientOnVM:true,accounts:[]}:{};
 b.run("api=handler;state.runtime='vm';state.page='sync'");
 await b.run('renderVmSync()');
 const card=b.elements.get('#gmail-accounts').innerHTML;
 assert.match(card,/Original Desktop OAuth client linked from your laptop/);
 assert.match(card,/id="gmail-sync"/);
 assert.doesNotMatch(card,/id="gmail-add"|id="gmail-compose"/);
 assert.match(card,/id="gmail-client-file"[^>]*disabled/);
});
