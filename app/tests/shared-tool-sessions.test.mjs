import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {LaptopToolsBroker,serveLaptopTools} from '../laptop-tools-broker.mjs';
import {personalSendSurface,validateBrowserCall} from '../browser-harness-adapter.mjs';

const parent={source:'owner',ownerMessageId:'owner-1'};
const childId='a'.repeat(32),child={source:'specialist',ownerMessageId:'owner-1',agentTaskId:childId};
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 const b=new LaptopToolsBroker(db,{pairedWorker:()=> 'paired',ownerAllowed:id=>['owner-1','owner-2'].includes(id),
  taskAllowed:args=>args.source==='specialist'&&args.agentTaskId===childId,
  canHandoff:args=>args.childAgentTaskId===childId,canReclaim:()=>true});
 b.worker('heartbeat',{worker:'paired',roots:['C:\\']});
 return b;
}
function task(b,flags={}){return b.call('start',{...parent,workspace:'C:\\work',objective:'Bounded UI test',...flags}).taskId;}

test('one owner per tab and desktop, with a narrowed verified specialist handoff',t=>{
 const b=fixture(t),id=task(b,{browserAct:true,desktopAct:true});
 const browser=b.call('session_open',{...parent,taskId:id,kind:'browser',backend:'chrome',target:'tab-A',grant:{act:true,maxActions:4,hosts:['example.com']}});
 assert.throws(()=>b.call('session_open',{...parent,taskId:id,kind:'browser',backend:'chrome',target:'tab-A'}),/owned/);
 const desktop=b.call('session_open',{...parent,taskId:id,kind:'desktop',backend:'hcu',grant:{act:true,apps:['Spotify']}});
 assert.throws(()=>b.call('session_open',{...parent,taskId:id,kind:'desktop',backend:'hcu'}),/owned/);
 assert.throws(()=>b.call('session_handoff',{...parent,sessionId:browser.id,childAgentTaskId:childId,grant:{act:true,maxActions:5}}),/narrower/);
 b.call('session_handoff',{...parent,sessionId:browser.id,childAgentTaskId:childId,grant:{act:false,maxActions:2,hosts:['example.com']}});
 assert.equal(b.call('session_assigned',{...child}).length,1);
 assert.throws(()=>b.call('submit',{...parent,taskId:id,sessionId:browser.id,tool:'browser_inspect',arguments:{view:'page'}}),/another agent/);
 assert.throws(()=>b.call('submit',{...child,taskId:id,sessionId:browser.id,tool:'browser_run',arguments:{actions:[{type:'click',x:1,y:2}]}}),/does not allow/);
 const read=b.call('submit',{...child,taskId:id,sessionId:browser.id,tool:'browser_inspect',arguments:{view:'page'},operationId:randomUUID()});
 assert.equal(read.state,'queued');assert.throws(()=>b.call('session_reclaim',{...parent,sessionId:browser.id}),/child session operation/);
 const op=b.worker('claim',{worker:'paired'});assert.equal(op.sessionGrant.act,false);
 b.worker('result',{worker:'paired',id:op.id,hash:op.hash,result:{state:'succeeded',output:{page:'ok'},sessionTarget:'tab-A'}});
 assert.equal(b.call('session_reclaim',{...parent,sessionId:browser.id}).grant.act,true);
 assert.equal(b.call('session_cancel',{...parent,sessionId:desktop.id}).state,'cancelled');
});

test('a later verified owner turn can hand off and reclaim an older session',t=>{
 const b=fixture(t),id=task(b,{browserAct:true});
 const session=b.call('session_open',{...parent,taskId:id,kind:'browser',backend:'chrome',target:'tab-B',grant:{act:true}});
 const next={...parent,ownerMessageId:'owner-2'};
 b.call('session_handoff',{...next,sessionId:session.id,childAgentTaskId:childId,grant:{act:false}});
 assert.equal(b.call('session_status',{source:'specialist',ownerMessageId:'owner-2',agentTaskId:childId,sessionId:session.id}).state,'active');
 assert.equal(b.call('session_reclaim',{...next,sessionId:session.id}).grant.act,true);
 assert.equal(b.call('session_status',{...next,sessionId:session.id}).state,'active');
});

test('HTTP worker credential selects the VM role, never a caller supplied role',async t=>{
 const b=fixture(t),server=serveLaptopTools(b,{readerToken:'reader',relayToken:'laptop',vmToken:'vm',port:0});
 await new Promise(resolve=>server.once('listening',resolve));t.after(()=>{server.closeAllConnections();server.close();});
 const url='http://127.0.0.1:'+server.address().port+'/worker';
 const call=(token,args)=>fetch(url,{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify({action:'heartbeat',args})});
 assert.equal((await call('reader',{worker:'vm-browser'})).status,400);
 assert.equal((await call('laptop',{worker:'vm-browser',workerRole:'vm'})).status,400);
 assert.equal((await call('vm',{worker:'vm-browser',workerRole:'laptop'})).status,200);
});

test('VM browser claims are isolated from laptop claims and receipts',t=>{
 const b=fixture(t);
 const id=b.call('start',{...parent,location:'vm',workspace:'',objective:'Independent VM browser',browserAct:true}).taskId;
 const session=b.call('session_open',{...parent,taskId:id,kind:'browser',backend:'playwright',grant:{act:true}});
 b.call('submit',{...parent,taskId:id,sessionId:session.id,tool:'browser_run',arguments:{actions:[{type:'new_tab',url:'https://example.com'}]}});
 assert.equal(b.worker('claim',{worker:'paired'}),null);
 const op=b.worker('claim',{worker:'vm-browser',workerRole:'vm'});assert.equal(op.route,'vm');
 assert.throws(()=>b.worker('result',{worker:'paired',id:op.id,hash:op.hash,result:{state:'succeeded'}}),/wrong worker/);
 b.worker('result',{worker:'vm-browser',workerRole:'vm',id:op.id,hash:op.hash,result:{state:'succeeded',sessionTarget:'page-1'}});
 assert.equal(b.call('session_status',{...parent,sessionId:session.id}).target,'page-1');
});

test('browser calls reject arbitrary execution and personal messaging destinations',()=>{
 assert.equal(personalSendSurface('https://mail.google.com/mail/u/0'),true);
 assert.throws(()=>validateBrowserCall({tool:'browser_run',sessionTarget:'',args:{actions:[{type:'navigate',url:'https://example.com'}]}}),/new_tab/);
 assert.throws(()=>validateBrowserCall({tool:'browser_run',sessionTarget:'x',args:{actions:[{type:'navigate',url:'https://discord.com/channels'}]}}),/personal-message/);
 assert.throws(()=>validateBrowserCall({tool:'browser_run',sessionTarget:'x',args:{actions:[{type:'script',code:'alert(1)'}]}}),/Unsupported/);
});
