// Isolated headless browser on the VM. Cookies and page URL stay in a protected per-session state file.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {personalSendSurface,validateBrowserCall} from './browser-harness-adapter.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const allowedUrl=(url,grant)=>{
 const parsed=new URL(url);
 if(!['https:','http:'].includes(parsed.protocol)||personalSendSurface(url)||
    grant?.hosts?.length&&!grant.hosts.includes(parsed.hostname))throw Error('Browser destination is outside the session grant or requires the personal-message route.');
 return parsed.href;
};

export class VmBrowserExecutor{
 constructor({db,stateDir,chromiumPath=process.env.MISTY_VM_CHROMIUM||'',playwrightLoader=()=>import('playwright-core')}={}){
  Object.assign(this,{db,stateDir,chromiumPath,playwrightLoader});this.browser=null;this.sessions=new Map();
  fs.mkdirSync(stateDir,{recursive:true,mode:0o700});
  db.exec(`PRAGMA journal_mode=WAL;PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS vm_browser_operations(id TEXT PRIMARY KEY,hash TEXT NOT NULL,state TEXT NOT NULL,result TEXT,at INTEGER NOT NULL,delivered INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS vm_browser_sessions(id TEXT PRIMARY KEY,target TEXT NOT NULL,url TEXT NOT NULL,state_file TEXT NOT NULL,updated INTEGER NOT NULL);
   UPDATE vm_browser_operations SET state='unknown' WHERE state='executing';`);
  db.prepare("UPDATE vm_browser_operations SET result=? WHERE state='unknown' AND result IS NULL")
   .run(JSON.stringify({state:'unknown',error:'VM browser worker restarted after execution began. Inspect before acting again.'}));
 }
 async start(){if(this.browser)return;const {chromium}=await this.playwrightLoader();
  this.browser=await chromium.launch({headless:true,...(this.chromiumPath?{executablePath:this.chromiumPath}:{})});}
 async session(op){
  await this.start();if(this.sessions.has(op.sessionId))return this.sessions.get(op.sessionId);
  const row=this.db.prepare('SELECT * FROM vm_browser_sessions WHERE id=?').get(op.sessionId);
  const context=await this.browser.newContext(row&&fs.existsSync(row.state_file)?{storageState:row.state_file}:{});
  const page=await context.newPage();
  if(row?.url&&row.url!=='about:blank')await page.goto(allowedUrl(row.url,op.sessionGrant),{waitUntil:'domcontentloaded'});
  const value={context,page,target:row?.target||''};this.sessions.set(op.sessionId,value);return value;
 }
 async save(op,session){
  const file=path.join(this.stateDir,op.sessionId+'.json');
  await session.context.storageState({path:file});
  this.db.prepare('INSERT OR REPLACE INTO vm_browser_sessions VALUES(?,?,?,?,?)').run(
   op.sessionId,session.target,session.page.url(),file,Date.now());
 }
 async execute(op){
  const expected=hash({task:op.task,tool:op.tool,args:op.args,sessionId:op.sessionId,sessionTarget:op.sessionTarget,sessionGrant:op.sessionGrant,backend:op.backend,route:op.route});
  if(op.hash!==expected||op.route!=='vm'||op.backend!=='playwright'||!op.sessionId||
     !['browser_inspect','browser_run'].includes(op.tool))throw Error('Invalid VM browser operation.');
  validateBrowserCall(op);
  const old=this.db.prepare('SELECT * FROM vm_browser_operations WHERE id=?').get(op.id);
  if(old){if(old.hash!==op.hash)throw Error('VM browser operation changed.');return old.result?JSON.parse(old.result):{state:'unknown',error:'Unresolved prior execution; no automatic replay.'};}
  if(op.expires<Date.now())throw Error('VM browser operation expired.');
  this.db.prepare("INSERT INTO vm_browser_operations VALUES(?,?,'executing',NULL,?,0)").run(op.id,op.hash,Date.now());
  let result;
  try{
   const s=await this.session(op),page=s.page;
   if(s.target&&op.sessionTarget&&s.target!==op.sessionTarget)throw Error('VM browser session target changed.');
   if(op.tool==='browser_inspect'){
    const info={url:page.url(),title:await page.title()};let output;
    if(op.args.view==='tabs')output={tabs:[{targetId:s.target,url:info.url,title:info.title}]};
    else if(op.args.view==='page')output={page:info,text:(await page.locator('body').innerText().catch(()=>'' )).slice(0,14000)};
    else if(op.args.view==='ax')output={page:info,nodes:await page.locator('body').evaluate(body=>
     [...body.querySelectorAll('a,button,input,textarea,select,[role]')].slice(0,120).map((el,i)=>({backendNodeId:i,tag:el.tagName.toLowerCase(),role:el.getAttribute('role'),name:(el.getAttribute('aria-label')||el.textContent||'').trim().slice(0,160)})))};
    else output={page:info,image:(await page.screenshot({type:'jpeg',quality:55,scale:'css'})).toString('base64'),mimeType:'image/jpeg'};
    result={state:'succeeded',output,sessionTarget:s.target};
   }else{
    const completed=[];
    for(const action of op.args.actions){
     if(action.type==='new_tab'){
      if(s.target)throw Error('Session already owns a page.');
      await page.goto(allowedUrl(action.url,op.sessionGrant),{waitUntil:'domcontentloaded'});s.target=randomUUID();
     }else{
      allowedUrl(page.url(),op.sessionGrant);
      if(action.type==='navigate')await page.goto(allowedUrl(action.url,op.sessionGrant),{waitUntil:'domcontentloaded'});
      else if(action.type==='click'){
       if(Number.isInteger(action.backendNodeId))await page.locator('a,button,input,textarea,select,[role]').nth(action.backendNodeId).click();
       else await page.mouse.click(action.x,action.y);
      }
      else if(action.type==='type')await page.keyboard.insertText(action.text);
      else if(action.type==='key')await page.keyboard.press(action.key);
      else if(action.type==='scroll')await page.mouse.wheel(action.dx||0,action.dy||-300);
      else if(action.type==='wait')await page.waitForTimeout(action.ms);
     }
     completed.push(action.type);
    }
    result={state:'succeeded',output:{actionsCompleted:completed,page:{url:page.url(),title:await page.title()}},sessionTarget:s.target};
   }
   await this.save(op,s);
  }catch(error){result={state:op.tool==='browser_run'?'unknown':'failed',error:String(error.message).slice(0,500)};}
  if(Buffer.byteLength(JSON.stringify(result))>350000)result={state:result.state,error:'Result exceeds transport cap; narrow the inspection.'};
  this.db.prepare('UPDATE vm_browser_operations SET state=?,result=?,at=? WHERE id=?').run(result.state,JSON.stringify(result),Date.now(),op.id);
  return result;
 }
 async close(){for(const s of this.sessions.values())await s.context.close().catch(()=>{});await this.browser?.close().catch(()=>{});this.browser=null;}
}
