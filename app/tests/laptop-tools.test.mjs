import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import http from 'node:http';
import {LaptopExecutor,hash,fingerprint,verifiedPath,configuredRoots} from '../laptop-tools-local.mjs';
import {LaptopToolsBroker,serveLaptopTools} from '../laptop-tools-broker.mjs';

function fixture(t,{fullAccess=false}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'misty-tool-test-')),db=new DatabaseSync(':memory:');
 const executor=new LaptopExecutor({roots:[root],fullAccess,db,backupDir:path.join(root,'backups')});
 t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});return {root,db,executor};
}
function operation(root,tool,args,flags={}){const op={id:randomUUID(),task:{workspace:root,commands:true,write:true,expires:Date.now()+60000,...flags},tool,args,expires:Date.now()+60000};op.hash=hash({task:op.task,tool:op.tool,args:op.args});return op;}
function broker(db,extra={}){return new LaptopToolsBroker(db,{pairedWorker:()=> 'paired',ownerAllowed:id=>id==='actual-owner',...extra});}
const owner={ownerMessageId:'actual-owner',source:'owner'};
function start(b,workspace){b.worker('heartbeat',{worker:'paired',roots:[workspace]});return b.call('start',{...owner,workspace,objective:'synthetic owner work',commands:true,write:true}).taskId;}

test('Cline file reader: ranged output and real preimage hash',async t=>{
 const {root,executor}=fixture(t);fs.writeFileSync(path.join(root,'example.txt'),'one\ntwo\nthree\n');
 const r=await executor.execute(operation(root,'read_files',{files:[{path:'example.txt',start_line:2,end_line:2}]}));
 assert.equal(r.state,'succeeded');assert.match(r.output[0].result,/two/);assert.doesNotMatch(r.output[0].result,/three/);assert.equal(r.evidence[path.join(root,'example.txt')],fingerprint(path.join(root,'example.txt')));
});
test('Cline search works and excludes protected files',async t=>{
 const {root,executor}=fixture(t);fs.writeFileSync(path.join(root,'sample.txt'),'needle_fixture');fs.mkdirSync(path.join(root,'data'));fs.writeFileSync(path.join(root,'data','hidden.txt'),'needle_private');
 const r=await executor.execute(operation(root,'search_codebase',{queries:['needle_']}));assert.equal(r.state,'succeeded');assert.match(r.output[0].result,/needle_fixture/);assert.doesNotMatch(r.output[0].result,/needle_private/);
});
test('Cline patch/edit, null new preimage, conflict refusal and rollback copy',async t=>{
 const {root,executor}=fixture(t),file=path.join(root,'created.txt');
 const added=await executor.execute(operation(root,'apply_patch',{input:'*** Begin Patch\n*** Add File: created.txt\n+before\n*** End Patch',expectedHashes:{'created.txt':null}}));assert.equal(added.state,'succeeded');
 const expected=fingerprint(file);const edited=await executor.execute(operation(root,'editor',{path:'created.txt',old_text:'before',new_text:'after',expectedHashes:{'created.txt':expected}}));assert.equal(edited.state,'succeeded');assert.match(fs.readFileSync(file,'utf8'),/after/);
 await assert.rejects(executor.execute(operation(root,'editor',{path:'created.txt',old_text:'after',new_text:'oops',expectedHashes:{'created.txt':expected}})),/changed/);
});
test('file tools can reach other folders and hidden files with preimage checks',async t=>{
 const {root,executor}=fixture(t,{fullAccess:true}),external=fs.mkdtempSync(path.join(os.tmpdir(),'misty-outside-'));t.after(()=>fs.rmSync(external,{recursive:true,force:true}));
 const hidden=path.join(external,'.env');fs.writeFileSync(hidden,'visible to owner');
 assert.throws(()=>verifiedPath(root,hidden),/outside/);assert.throws(()=>verifiedPath(root,'.env'),/protected/);
 assert.equal(verifiedPath(root,hidden,true),hidden);assert.equal(verifiedPath(root,path.join('..',path.basename(external),'.env'),true),hidden);
 const read=await executor.execute(operation(root,'read_files',{files:[{path:hidden}]}));assert.equal(read.state,'succeeded');assert.match(read.output[0].result,/visible to owner/);
 fs.mkdirSync(path.join(root,'data'));fs.writeFileSync(path.join(root,'data','.env'),'whole_laptop_search_fixture');
 const search=await executor.execute(operation(root,'search_codebase',{queries:['whole_laptop_search_fixture']}));assert.equal(search.state,'succeeded');assert.match(search.output[0].result,/data[\\/]\.env/);
 const expected=fingerprint(hidden),edited=await executor.execute(operation(root,'editor',{path:hidden,old_text:'visible to owner',new_text:'updated by owner',expectedHashes:{[hidden]:expected}}));
 assert.equal(edited.state,'succeeded');assert.equal(fs.readFileSync(hidden,'utf8'),'updated by owner');
 assert.throws(()=>verifiedPath(root,'cline://private'),/Invalid/);
});
test('all-drives configuration discovers mounted filesystem drives',()=>{
 assert.deepEqual(configuredRoots(['C:\\fixture']),['C:\\fixture']);
 assert.throws(()=>configuredRoots({scope:'unknown'}),/Invalid/);
 assert.ok(configuredRoots({scope:'all-drives'}).includes(path.parse(process.cwd()).root));
});
test('direct argv commands use Cline executor and replay returns receipt only',async t=>{
 const {root,executor}=fixture(t);const op=operation(root,'run_commands',{commands:[{command:process.execPath,args:['-e','console.log("direct-argv-fixture")']}]});
 const r=await executor.execute(op);assert.equal(r.state,'succeeded');assert.match(r.output[0].result,/direct-argv-fixture/);assert.deepEqual(await executor.execute(op),r);
 const modified=structuredClone(op);modified.args.commands=['echo changed'];modified.hash=hash({task:modified.task,tool:modified.tool,args:modified.args});await assert.rejects(executor.execute(modified),/changed/);
});
test('read-only task cannot execute commands or write',async t=>{
 const {root,executor}=fixture(t);await assert.rejects(executor.execute(operation(root,'run_commands',{commands:['echo test']},{commands:false})),/not enabled/);
 await assert.rejects(executor.execute(operation(root,'editor',{path:'new.txt',new_text:'x',expectedHashes:{'new.txt':null}},{write:false})),/not enabled/);
});
test('Cline HTTP fetch returns content without another analysis/model call',async t=>{
 const {root,executor}=fixture(t);const server=http.createServer((req,res)=>res.writeHead(200,{'Content-Type':'text/html'}).end('<p>local-fetch-fixture</p>'));server.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());
 const result=await executor.execute(operation(root,'fetch_web_content',{requests:[{url:'http://127.0.0.1:'+server.address().port,prompt:'extract fixture'}]}));assert.equal(result.state,'succeeded');assert.match(result.output[0].result,/local-fetch-fixture/);assert.match(result.output[0].result,/Analysis Request/);
});
test('Cline command abort stops waiting and reports failure without replay',async t=>{
 const {root,executor}=fixture(t),abort=new AbortController(),op=operation(root,'run_commands',{commands:[{command:process.execPath,args:['-e','setTimeout(()=>console.log("too-late"),10000)']}]});setTimeout(()=>abort.abort(),150);
 const result=await executor.execute(op,abort.signal);assert.equal(result.state,'failed');assert.equal((await executor.execute(op)).state,'failed');
});
test('local restart marks started operations unknown without replaying',t=>{
 const {root,db}=fixture(t);db.prepare("INSERT INTO laptop_operations(id,hash,state,at) VALUES('x','h','executing',0)").run();
 new LaptopExecutor({roots:[root],db,backupDir:path.join(root,'backups')});const row=db.prepare("SELECT * FROM laptop_operations WHERE id='x'").get();assert.equal(row.state,'unknown');assert.match(row.result,/Not retried/);
});
test('broker enforces owner identity/source, paired worker, workspace and write flags',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const b=broker(db),task=start(b,'C:\\fixture');
 assert.throws(()=>b.call('submit',{...owner,source:'workflow',taskId:task,tool:'read_files',arguments:{files:[]}}),/current recorded/);
 assert.throws(()=>b.call('start',{...owner,ownerMessageId:'forged',workspace:'C:\\fixture',objective:'bad'}),/current recorded/);
 assert.throws(()=>b.worker('claim',{worker:'apollo'}),/Wrong paired/);
 assert.throws(()=>b.call('start',{...owner,workspace:'C:\\other',objective:'bad'}),/available laptop drive/);
 b.worker('heartbeat',{worker:'paired',roots:['C:\\']});
 assert.ok(b.call('start',{...owner,workspace:'C:\\anywhere\\project',objective:'nested'}).taskId);
 assert.throws(()=>b.call('start',{...owner,workspace:'D:\\other',objective:'wrong drive'}),/available laptop drive/);
 assert.throws(()=>b.call('submit',{...owner,taskId:task,tool:'message_confirm',arguments:{}}),/Invalid tool/);
});
test('delegated laptop calls stay bound to one active task',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 const allowed=args=>args.agentTaskId==='a'.repeat(32)&&args.source==='specialist'&&args.ownerMessageId==='original';
 const b=broker(db,{taskAllowed:allowed});b.worker('heartbeat',{worker:'paired',roots:['C:\\']});
 const identity={source:'specialist',agentTaskId:'a'.repeat(32),ownerMessageId:'original'};
 const task=b.call('start',{...identity,workspace:'C:\\fixture',objective:'Inspect',write:false,commands:false}).taskId;
 assert.throws(()=>b.call('start',{...identity,agentTaskId:'b'.repeat(32),workspace:'C:\\fixture',objective:'Forged'}),/active delegated/);
 assert.throws(()=>b.call('submit',{...identity,agentTaskId:'b'.repeat(32),taskId:task,tool:'read_files',arguments:{files:[]}}),/active delegated/);
 assert.throws(()=>b.call('control',{...identity,agentTaskId:'b'.repeat(32),taskId:task,action:'cancel'}),/active delegated/);
 assert.equal(b.call('submit',{...identity,taskId:task,tool:'read_files',arguments:{files:[]}}).state,'queued');
});
test('broker receipt journal survives reinitialization; no unknown-operation retry',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());let now=Date.now();let b=broker(db,{clock:()=>now});const task=start(b,'C:\\fixture');
 const args={...owner,taskId:task,tool:'read_files',arguments:{files:[]},operationId:randomUUID()};const sub=b.call('submit',args),op=b.worker('claim',{worker:'paired'});assert.equal(op.id,sub.id);
 b=broker(db,{clock:()=>now});assert.equal(b.worker('claim',{worker:'paired'}),null);now+=190000;assert.equal(b.worker('claim',{worker:'paired'}),null);assert.equal(b.call('result',{id:op.id}).state,'unknown');
 const result={state:'succeeded',output:'actual receipt'};assert.equal(b.worker('result',{worker:'paired',id:op.id,hash:op.hash,result}).received,true);assert.equal(b.call('submit',args).reused,true);assert.equal(b.worker('claim',{worker:'paired'}),null);
 assert.throws(()=>b.worker('result',{worker:'paired',id:op.id,hash:op.hash,result:{state:'failed'}}),/different|not awaiting/);
});
test('pause/cancel and expiry do not replay or affect unrelated monitoring',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const b=broker(db),task=start(b,'C:\\fixture');const s=b.call('submit',{...owner,taskId:task,tool:'read_files',arguments:{files:[]}});
 b.call('control',{...owner,action:'pause'});assert.equal(b.worker('claim',{worker:'paired'}),null);assert.equal(b.call('result',{id:s.id}).state,'cancelled');b.call('control',{...owner,action:'resume'});assert.equal(b.worker('claim',{worker:'paired'}),null);
});
test('HTTP ingestion is loopback-only, credential-separated, authenticated and bounded',async t=>{
 const db=new DatabaseSync(':memory:');const b=broker(db),server=serveLaptopTools(b,{relayToken:'worker-credential',readerToken:'owner-credential',port:0});t.after(()=>{server.close();db.close();});await new Promise(r=>server.once('listening',r));
 assert.equal(server.address().address,'127.0.0.1');const url='http://127.0.0.1:'+server.address().port;
 assert.equal((await fetch(url+'/call',{method:'POST',body:'{}'})).status,401);
 assert.equal((await fetch(url+'/worker',{method:'POST',headers:{Authorization:'Bearer owner-credential'},body:'{}'})).status,400);
 const r=await fetch(url+'/call',{method:'POST',headers:{Authorization:'Bearer owner-credential'},body:JSON.stringify({action:'status'})});assert.equal(r.status,200);assert.equal((await r.json()).tools.length,10);
});
