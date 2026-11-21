// Private Windows executor host. Cline primitives run here, never another LLM.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {makeTools,computePatchChanges} from '../tooling/cline/dist/executors.mjs';
import {runBrowserHarness,validateBrowserCall} from './browser-harness-adapter.mjs';
import {HcuAdapter} from './hcu-adapter.mjs';

export const TOOL_NAMES=['read_files','search_codebase','run_commands','fetch_web_content','apply_patch','editor','browser_inspect','browser_run','desktop_ax','desktop_gui'];
export const hash=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
export function fingerprint(filename){return fs.existsSync(filename)?hash(fs.readFileSync(filename)):null;}
export function configuredRoots(spec){
 if(Array.isArray(spec))return spec;
 if(spec?.scope!=='all-drives')throw Error('Invalid laptop drive configuration.');
 return Array.from({length:26},(_,i)=>String.fromCharCode(65+i)+':\\').filter(p=>{try{return fs.statSync(p).isDirectory();}catch{return false;}});
}
const protectedPart=p=>/^(?:data|\.git|node_modules|\.codex|\.ssh|\.env.*|config\.json|auth\.json|.*\.(?:key|pem)|.*(?:token|secret|credential).*)$/i.test(p);
export function within(root,p){const rel=path.relative(root,p);return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));}
export function verifiedPath(workspace,input,fullAccess=false){
 if(typeof input!=='string'||!input||input.includes('\0')||input.startsWith('cline://'))throw Error('Invalid laptop file path.');
 const absolute=path.resolve(workspace,input),relative=path.relative(workspace,absolute);
 if(!fullAccess&&(!within(workspace,absolute)||relative.split(/[\\/]/).some(protectedPart)))throw Error('Path is outside this task or protected.');
 if(/:(?![\\/])/.test(absolute.slice(2)))throw Error('Alternate data stream paths are unsupported.');
 let existing=absolute;while(!fs.existsSync(existing)){const parent=path.dirname(existing);if(parent===existing)throw Error('No existing parent.');existing=parent;}
 if(!fullAccess&&!within(workspace,fs.realpathSync.native(existing)))throw Error('Symlink/junction escapes task workspace.');
 return absolute;
}
export class LaptopExecutor {
 constructor({roots,db,backupDir,fullAccess=false,browserRunner=runBrowserHarness,hcuAdapter=null}) {
  this.fullAccess=fullAccess;this.setRoots(roots);this.db=db;this.backupDir=backupDir;fs.mkdirSync(backupDir,{recursive:true});
  this.browserRunner=browserRunner;this.hcuAdapter=hcuAdapter;
  db.exec(`PRAGMA journal_mode=WAL;PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS laptop_operations(id TEXT PRIMARY KEY,hash TEXT NOT NULL,state TEXT NOT NULL,result TEXT,at INTEGER NOT NULL,delivered INTEGER NOT NULL DEFAULT 0);
   UPDATE laptop_operations SET state='unknown' WHERE state='executing';`);
  for(const r of db.prepare("SELECT id FROM laptop_operations WHERE state='unknown' AND result IS NULL").all())db.prepare('UPDATE laptop_operations SET result=? WHERE id=?').run(JSON.stringify({state:'unknown',error:'Laptop worker restarted after execution began. Not retried.'}),r.id);
 }
 setRoots(roots){this.roots=roots.map(p=>fs.realpathSync.native(p));}
 workspace(input){const p=fs.realpathSync.native(input);if(!fs.statSync(p).isDirectory()||!this.roots.some(r=>within(r,p)))throw Error('Workspace is not enabled on this laptop.');return p;}
 async execute(op,signal){
  const scoped=!!op.sessionId;
  const expected=scoped?hash({task:op.task,tool:op.tool,args:op.args,sessionId:op.sessionId,sessionTarget:op.sessionTarget,sessionGrant:op.sessionGrant,backend:op.backend,route:op.route}):hash({task:op.task,tool:op.tool,args:op.args});
  if(!TOOL_NAMES.includes(op.tool)||!op.id||!/^[a-f0-9-]{36}$/i.test(op.id)||op.hash!==expected||
     (scoped&&op.route!=='laptop'))throw Error('Invalid immutable operation.');
  const previous=this.db.prepare('SELECT * FROM laptop_operations WHERE id=?').get(op.id);
  if(previous){if(previous.hash!==op.hash)throw Error('Operation ID changed.');return previous.result?JSON.parse(previous.result):{state:'unknown',error:'Execution was interrupted. Never replay automatically.'};}
  if(op.expires<Date.now()||op.task.paused)throw Error('Task expired or paused.');
  const cwd=this.workspace(op.task.workspace),args=structuredClone(op.args),evidence={};
  const ui=['browser_inspect','browser_run','desktop_ax','desktop_gui'].includes(op.tool);
  if(ui&&(!scoped||op.backend!==(op.tool.startsWith('browser_')?'chrome':'hcu')))throw Error('UI operation has no matching session.');
  if(op.tool.startsWith('browser_'))validateBrowserCall(op);
  if(op.tool==='read_files'){
   if(!Array.isArray(args.files)||args.files.length>8)throw Error('Read 1–8 files at a time.');
   args.files=args.files.map(f=>{const p=verifiedPath(cwd,f.path,this.fullAccess);evidence[p]=fingerprint(p);return {...f,path:p};});
  }
  if(op.tool==='run_commands'){
   if(!Array.isArray(args.commands)||!args.commands.length||args.commands.length>4||JSON.stringify(args.commands).length>12000)throw Error('Use 1–4 bounded commands.');
   if(!op.task.commands)throw Error('Commands were not enabled for this work task.');
  }
  const writes=op.tool==='editor'||op.tool==='apply_patch';let paths=[];
  if(writes){
   if(!op.task.write)throw Error('Writes were not enabled for this work task.');
   if(op.tool==='editor'){args.path=verifiedPath(cwd,args.path,this.fullAccess);paths=[args.path];}
   else {
    // Validate every patch path before the upstream preimage computation reads it.
    for(const line of String(args.input||'').split(/\r?\n/)){
     const m=line.match(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/);if(m)paths.push(verifiedPath(cwd,m[1],this.fullAccess));
    }
    if(!paths.length||paths.length>20)throw Error('Patch needs 1–20 verified paths.');
    await computePatchChanges(args.input,cwd);
   }
   for(const p of new Set(paths)){
    const expected=Object.hasOwn(args.expectedHashes||{},p)?args.expectedHashes[p]:args.expectedHashes?.[path.relative(cwd,p)];
    const exists=fs.existsSync(p);
    if(!(p in (args.expectedHashes||{}))&&!(path.relative(cwd,p) in (args.expectedHashes||{})))throw Error('Provide expectedHashes for every write path; null means a new file.');
    if(expected!==fingerprint(p))throw Error('File changed since it was read; get a fresh preimage.');
    evidence[p]=expected;
    if(exists){const dir=path.join(this.backupDir,op.id);fs.mkdirSync(dir,{recursive:true});fs.copyFileSync(p,path.join(dir,hash(p)+'.before'));fs.writeFileSync(path.join(dir,hash(p)+'.json'),JSON.stringify({path:p,hash:expected}));}
   }
  }
  delete args.expectedHashes;
  const tools=ui?[]:makeTools(cwd,this.fullAccess),tool=tools.find(t=>t.name===op.tool);
  this.db.prepare("INSERT INTO laptop_operations(id,hash,state,result,at) VALUES(?,?,'executing',NULL,?)").run(op.id,op.hash,Date.now());
  let result;
  try{
   if(op.tool.startsWith('browser_'))result=await this.browserRunner(op);
   else if(op.tool.startsWith('desktop_')){
    this.hcuAdapter ||= new HcuAdapter();result=await this.hcuAdapter.execute(op);
   }else{
    const output=await tool.execute(args,{agentId:'misty-owner',iteration:0,toolCallId:op.id,signal,metadata:{modelSupportsImages:false}});
    const failed=Array.isArray(output)?output.some(r=>r?.success===false):output?.success===false;
    result={state:failed?'failed':'succeeded',output,evidence,postimages:Object.fromEntries(paths.map(p=>[p,fingerprint(p)])),at:Date.now()};
   }
  }catch(e){result={state:writes||ui&&op.tool!=='browser_inspect'?'unknown':'failed',error:String(e.message).slice(0,1000),evidence,at:Date.now()};}
  if(Buffer.byteLength(JSON.stringify(result))>350000)result={state:result.state,error:'Result exceeds transport cap; narrow the operation.',evidence,at:Date.now()};
  this.db.prepare('UPDATE laptop_operations SET state=?,result=?,at=? WHERE id=?').run(result.state,JSON.stringify(result),Date.now(),op.id);
  // Bounded private result retention; never remove unresolved receipts automatically.
  this.db.prepare("DELETE FROM laptop_operations WHERE at<? AND delivered=1 AND state IN ('succeeded','failed')").run(Date.now()-7*86400000);
  for(const e of fs.readdirSync(this.backupDir,{withFileTypes:true}))if(e.isDirectory()&&/^[a-f0-9-]{36}$/i.test(e.name)){
   const p=path.join(this.backupDir,e.name);if(Date.now()-fs.statSync(p).mtimeMs>7*86400000)fs.rmSync(p,{recursive:true});
  }
  return result;
 }
}
