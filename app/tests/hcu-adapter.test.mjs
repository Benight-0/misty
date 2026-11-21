import test from 'node:test';
import assert from 'node:assert/strict';
import {HcuAdapter} from '../hcu-adapter.mjs';

class FakeHcu extends HcuAdapter{
 constructor(){super();this.calls=[];}
 async call(name,args){this.calls.push({name,args});
  if(args.mode==='apps')return {content:[{type:'text',text:'{"ok":true,"input_emitted":false}'},
   {type:'text',text:'w1 "Spotify" app=Spotify active\nw2 "Chrome" app=chrome'}],isError:false};
  return {content:[{type:'text',text:'{"ok":true,"input_emitted":true,"completed":1}'}],isError:false};
 }
}

test('HCU mutation verifies the app/window and strips broker-only app before MCP',async()=>{
 const h=new FakeHcu();
 const r=await h.execute({tool:'desktop_ax',args:{mode:'act',app:'Spotify',window_ref:'w1',actions:[{type:'click',ref:'r1'}]},sessionGrant:{apps:['Spotify']}});
 assert.equal(r.state,'succeeded');assert.equal(r.evidence.inputEmitted,true);
 assert.deepEqual(h.calls[1],{name:'AX',args:{mode:'act',window_ref:'w1',actions:[{type:'click',ref:'r1'}]}});
 await assert.rejects(h.execute({tool:'desktop_ax',args:{mode:'act',app:'Spotify',window_ref:'w2',actions:[{type:'click',ref:'r1'}]}}),/does not belong/);
 await assert.rejects(h.execute({tool:'desktop_ax',args:{mode:'act',app:'chrome',window_ref:'w2',actions:[{type:'click',ref:'r1'}]}}),/native Chrome remote-debugging Allow button/);
});

test('GUI input is limited to its active granted non-browser app',async()=>{
 const h=new FakeHcu();
 const r=await h.execute({tool:'desktop_gui',args:{actions:[{type:'screenshot'}]},sessionGrant:{apps:['Spotify']}});
 assert.equal(r.state,'succeeded');
 const input=await h.execute({tool:'desktop_gui',args:{actions:[{type:'click',x:1,y:2}]},sessionGrant:{apps:['Spotify']}});
 assert.equal(input.state,'succeeded');
 await assert.rejects(h.execute({tool:'desktop_gui',args:{actions:[{type:'click',x:1,y:2}]},sessionGrant:{apps:['Other']}}),/outside/);
});
