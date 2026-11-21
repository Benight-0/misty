import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {normalizeActivity,FRESH_MS} from './laptop-activity.mjs';
// Temporary laptop caches stay at two hours; VM history retention is independent.
const RAW_MS=2*3600000;

export class WindowsActivityCollector {
 constructor(root){this.root=root;this.child=null;this.waiter=null;}
 async collect(){
  if(this.waiter)throw Error('An activity collection is already running.');
  if(!this.child){
   const runtime=JSON.parse(fs.readFileSync(path.join(this.root,'data/deployment/laptop-activity/native-runtime.json'),'utf8').replace(/^\uFEFF/,''));
   // A GUI-subsystem helper cannot open a PowerShell/console window. No console fallback.
   this.child=spawn(runtime.desktop,[],{windowsHide:true,stdio:['pipe','pipe','pipe']});
   this.child.stderr.on('data',()=>{});this.child.stdin.on('error',()=>{});
   const lines=createInterface({input:this.child.stdout});lines.on('line',line=>{if(!this.waiter)return;try{if(Buffer.byteLength(line)>200000)throw Error();const value=JSON.parse(line);this.waiter.resolve(value);}catch{this.waiter.reject(Error('Activity collection unavailable.'));}finally{this.waiter=null;}});
   this.child.on('error',()=>this.failed());this.child.on('close',()=>{lines.close();this.failed();});
  }
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.waiter=null;this.close();reject(Error('Activity collection timed out.'));},15000);this.waiter={resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}};this.child.stdin.write('sample\n');});
 }
 failed(){this.waiter?.reject(Error('Activity collection stopped.'));this.waiter=null;this.child=null;}
 close(){this.child?.kill();this.child=null;}
}

export function pruneChrome(directory,now=Date.now()){
 if(!fs.existsSync(directory))return;
 for(const name of fs.readdirSync(directory).filter(n=>/^[a-f0-9-]{36}\.json$/i.test(n)))try{
  const filename=path.join(directory,name);if(now-fs.statSync(filename).mtimeMs>RAW_MS)fs.unlinkSync(filename);
 }catch{}
}
export function readChrome(directory,now=Date.now()){
 if(!fs.existsSync(directory))return null;
 const profiles=[],names=fs.readdirSync(directory).filter(n=>/^[a-f0-9-]{36}\.json$/i.test(n)).slice(0,8);for(const name of names){
  const filename=path.join(directory,name);try{
   const stat=fs.statSync(filename);if(stat.size>100000)continue;
   if(now-stat.mtimeMs>RAW_MS){fs.unlinkSync(filename);continue;}
   const data=JSON.parse(fs.readFileSync(filename,'utf8'));if(data.capturedAt<=now+30000&&now-data.capturedAt<=FRESH_MS)profiles.push(data);
  }catch{}
 }
 if(!profiles.length)return names.length?{state:'unavailable',reason:'extension_sample_stale'}:null;
 const all=profiles.flatMap(p=>p.tabs.map(t=>({...t,profile:p.profile})));
 if(all.length>150)all.sort((a,b)=>Number(b.activeInWindow)+Number(b.windowFocused)-Number(a.activeInWindow)-Number(a.windowFocused));
 const tabs=all.slice(0,150);
 let truncated=profiles.some(p=>p.truncated)||all.length>150;
 if(Buffer.byteLength(JSON.stringify(tabs))>55000){
  tabs.sort((a,b)=>Number(b.activeInWindow)+Number(b.windowFocused)-Number(a.activeInWindow)-Number(a.windowFocused));
  while(tabs.length&&Buffer.byteLength(JSON.stringify(tabs))>55000)tabs.pop();
  truncated=true;
 }
 return {capturedAt:Math.min(...profiles.map(p=>p.capturedAt)),profiles:profiles.map(p=>p.profile),tabs,truncated};
}
export class ActivityOutbox {
 constructor(db,{clock=Date.now}={}){this.db=db;this.clock=clock;db.exec('PRAGMA journal_mode=WAL;PRAGMA busy_timeout=5000;CREATE TABLE IF NOT EXISTS activity_outbox(id TEXT PRIMARY KEY,captured INTEGER NOT NULL,body TEXT NOT NULL)');}
 add(raw){const sample=normalizeActivity({...raw,id:raw.id||randomUUID()},this.clock());this.db.prepare('INSERT OR IGNORE INTO activity_outbox VALUES(?,?,?)').run(sample.id,sample.capturedAt,JSON.stringify(sample));this.prune();return sample;}
 prune(){this.db.prepare('DELETE FROM activity_outbox WHERE captured<?').run(this.clock()-RAW_MS);this.db.exec('DELETE FROM activity_outbox WHERE id IN (SELECT id FROM activity_outbox ORDER BY captured DESC LIMIT -1 OFFSET 240)');}
 async flush(vm,worker){
  this.prune();const rows=this.db.prepare('SELECT * FROM activity_outbox ORDER BY captured DESC LIMIT 8').all();if(!rows.length)return null;
  const result=await vm.request('activity_publish',{worker,samples:rows.map(r=>JSON.parse(r.body))},20000);
  if(!Array.isArray(result.accepted)||result.accepted.some(id=>!rows.some(r=>r.id===id)))throw Error('Unexpected activity receipt.');
  for(const id of result.accepted)this.db.prepare('DELETE FROM activity_outbox WHERE id=?').run(id);
  return result;
 }
}
