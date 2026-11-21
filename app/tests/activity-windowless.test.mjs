import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {WindowsActivityCollector} from '../laptop-activity-local.mjs';

const windows=process.platform==='win32'&&process.env.MISTY_LIVE_LAPTOP_TESTS==='1';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function alive(pid){try{process.kill(pid,0);return true;}catch{return false;}}
function guiSubsystem(file){const b=fs.readFileSync(file),pe=b.readUInt32LE(0x3c);assert.equal(b.toString('ascii',pe,pe+2),'PE');return b.readUInt16LE(pe+24+68);}
const runtime=windows?JSON.parse(fs.readFileSync('data/deployment/laptop-activity/native-runtime.json','utf8').replace(/^\uFEFF/,'')):null;

test('installed sampler and task launcher are GUI executables; repeated real samples have no helper window', {skip:!windows,timeout:20000},async()=>{
 assert.equal(guiSubsystem(runtime.desktop),2);assert.equal(guiSubsystem(runtime.launcher),2);
 const collector=new WindowsActivityCollector(process.cwd());
 try{
  const first=await collector.collect(),pid=collector.child.pid;
  assert.equal(collector.child.spawnfile,runtime.desktop);
  await sleep(50);const second=await collector.collect();
  assert.equal(collector.child.pid,pid);assert(second.capturedAt>=first.capturedAt);
  assert(Array.isArray(second.windows));assert.equal(typeof second.sessionState,'string');
  assert(!second.windows.some(w=>w.pid===pid));
 }finally{collector.close();}
});

test('windowless task launcher owns and stops its complete child tree', {skip:!windows,timeout:15000},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'misty-windowless-'));
 fs.mkdirSync(path.join(root,'scripts'));fs.mkdirSync(path.join(root,'data/deployment/laptop-activity'),{recursive:true});
 fs.writeFileSync(path.join(root,'scripts/misty-activity-agent.mjs'),`import fs from 'node:fs';import {spawn} from 'node:child_process';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});fs.writeFileSync('pids.json',JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`);
 // No hide flag: the executable itself must never allocate a console.
 const launcher=spawn(runtime.launcher,[process.execPath,root],{windowsHide:false,stdio:'ignore'});
 let pids=[];
 try{
  for(let n=0;n<100&&!fs.existsSync(path.join(root,'pids.json'));n++)await sleep(50);
  pids=JSON.parse(fs.readFileSync(path.join(root,'pids.json'),'utf8'));assert(pids.every(alive));
  const closed=once(launcher,'close');launcher.kill();await closed;
  for(let n=0;n<100&&pids.some(alive);n++)await sleep(50);
  assert(pids.every(pid=>!alive(pid)),'Stopping the GUI task must close its job and all descendants');
 }finally{
  if(launcher.exitCode===null)launcher.kill();
  for(const pid of pids)if(alive(pid))try{process.kill(pid);}catch{}
  fs.rmSync(root,{recursive:true,force:true});
 }
});
