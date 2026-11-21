// One persistent HCU MCP process in the logged-in Windows worker keeps AX refs valid.
import {spawn} from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';

const blockedApp=/\b(?:discord|whatsapp|telegram|signal|outlook|mail|messages|chrome|edge|firefox|brave|misty)\b/i;
const mutating=op=>op.tool==='desktop_ax'?op.args.mode==='act':op.args.actions.some(a=>!['screenshot','zoom'].includes(a.type));
const statusLine=content=>{try{return JSON.parse(content.find(x=>x.type==='text')?.text||'{}');}catch{return {};}};

export function chromeDebugConsent(args, observed){
 if(args.app!=='chrome'||args.actions?.length!==1)return false;
 const action=args.actions[0];
 if(action.type!=='click'||!/^r[0-9]+$/.test(action.ref||''))return false;
 const marker='\n - generic "Allow remote debugging?"';
 const start=observed.indexOf(marker);
 if(start<0)return false;
 const dialog=observed.slice(start);
 return dialog.includes('\n  - window "Allow remote debugging?"')&&
  dialog.includes('An external app wants full control over this Chrome session to debug it.')&&
  dialog.split('\n').some(line=>line.startsWith('      - button "Allow" ')&&line.includes('[ref='+action.ref+']'));
}

async function jpegImage(base64){
 const source=`import sys,base64,io\nfrom PIL import Image\nim=Image.open(io.BytesIO(base64.b64decode(sys.stdin.buffer.read()))).convert('RGB')\nim.thumbnail((960,960))\nout=io.BytesIO(); im.save(out,'JPEG',quality=55,optimize=True)\nsys.stdout.write(base64.b64encode(out.getvalue()).decode())`;
 return await new Promise((resolve,reject)=>{
  const child=spawn(process.env.MISTY_IMAGE_PYTHON||'python',['-c',source],{windowsHide:true});
  let out='';child.stdout.on('data',part=>{out+=part;if(out.length>300000)child.kill();});
  child.on('error',reject);child.on('close',code=>code===0&&out.length<300000?resolve(out):reject(Error('Screenshot compression failed')));
  child.stdin.end(base64);
 });
}

export class HcuAdapter {
 constructor({executable=process.env.MISTY_HCU_EXE||path.resolve('data/deployment/hcu-build/windows/computer-use.exe')}={}){
  this.executable=executable;this.child=null;this.pending=new Map();this.nextId=1;
 }
 async start(){
  if(this.child&&!this.child.killed)return;
  const child=spawn(this.executable,['mcp'],{windowsHide:true,stdio:['pipe','pipe','pipe']});this.child=child;
  readline.createInterface({input:child.stdout}).on('line',line=>{
   let response;try{response=JSON.parse(line);}catch{return;}
   const entry=this.pending.get(response.id);if(entry){this.pending.delete(response.id);clearTimeout(entry.timer);
    response.error?entry.reject(Error(response.error.message||'HCU MCP error')):entry.resolve(response.result);}
  });
  child.on('error',error=>this.fail(error));child.on('exit',()=>this.fail(Error('HCU MCP exited')));
  await this.request('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'misty-shared-tools',version:'1.0'}},10000);
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
 }
 fail(error){this.child=null;for(const entry of this.pending.values()){clearTimeout(entry.timer);entry.reject(error);}this.pending.clear();}
 request(method,params,timeoutMs=70000){
  if(!this.child)throw Error('HCU MCP is offline.');
  const id=this.nextId++;return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('HCU call timed out; action effect is unknown.'));},timeoutMs);
   this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  });
 }
 async call(name,args){await this.start();return await this.request('tools/call',{name,arguments:args});}
 async execute(op){
  const write=mutating(op);
  let argumentsForHcu=op.args;
  if(write&&op.tool==='desktop_ax'){
   if(!op.args.app||!op.args.window_ref)throw Error('Specify a permitted app and its current window reference.');
   const inventory=await this.call('AX',{mode:'apps'});
   const window=inventory.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n').split('\n')
    .find(x=>x.startsWith(op.args.window_ref+' '));
   if(!window||!window.includes('app='+op.args.app))throw Error('Window reference does not belong to the granted app.');
   if(blockedApp.test(op.args.app)){
    if(op.args.app!=='chrome')throw Error('Browser or messaging input requires its dedicated route.');
    const observed=await this.call('AX',{mode:'observe',window_ref:op.args.window_ref});
    const tree=observed.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n')||'';
    if(!chromeDebugConsent(op.args,tree))throw Error('Only the native Chrome remote-debugging Allow button is permitted here.');
    argumentsForHcu={...op.args,actions:[{type:'click',ref:op.args.actions[0].ref}]};
   }
   const {app,...rest}=argumentsForHcu;argumentsForHcu=rest;
  }
  if(write&&op.tool==='desktop_gui'){
   const inventory=await this.call('AX',{mode:'apps'});
   const active=inventory.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n').split('\n').find(x=>/\bactive\b/.test(x));
   if(!active||blockedApp.test(active))throw Error('Desktop focus is unknown or is a browser/messaging app; use its dedicated route.');
   if(op.sessionGrant?.apps?.length&&!op.sessionGrant.apps.some(app=>active.includes('app='+app)))
    throw Error('Focused app is outside the session grant.');
  }
  const result=await this.call(op.tool==='desktop_ax'?'AX':'GUI',argumentsForHcu);
  const status=statusLine(result.content||[]),content=[];
  for(const item of result.content||[]){
   if(item.type==='image'){
    try{content.push({type:'image',mimeType:'image/jpeg',data:await jpegImage(item.data)});}
    catch{content.push({type:'text',text:'Screenshot could not fit the receipt. Inspect again with a smaller region.'});}
   }else if(item.type==='text')content.push({type:'text',text:String(item.text).slice(0,50000)});
  }
  const state=result.isError?(write&&status.input_emitted!==false?'unknown':'failed'):'succeeded';
  return {state,output:content,evidence:{inputEmitted:status.input_emitted??null,completed:status.completed??null},at:Date.now()};
 }
 close(){this.child?.kill();this.fail(Error('HCU MCP closed'));}
}
