import {spawn,execFile} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// A project-specific local service leaves the user's normal Ollama service/configuration alone.
async function terminateOwned(child){
  if(child.exitCode!==null)return;
  if(process.platform==='win32')await new Promise(resolve=>execFile('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:1000},error=>{if(error&&child.exitCode===null)child.kill();resolve();}));
  else child.kill();
}
export class LocalOllama{
  constructor({directory,concurrency=3,port=11435,fetchImpl=fetch,spawnImpl=spawn,terminateImpl=terminateOwned}={}){
    if(!directory||!Number.isInteger(concurrency)||concurrency<1||concurrency>4||!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid local analysis runtime settings.');
    this.directory=directory;this.concurrency=concurrency;this.port=port;this.base='http://127.0.0.1:'+port;this.endpoint=this.base+'/api/chat';this.fetch=fetchImpl;this.spawn=spawnImpl;this.terminate=terminateImpl;this.child=null;this.stream=null;
  }
  async available(){try{const r=await this.fetch(this.base+'/api/version',{signal:AbortSignal.timeout(1000)});return r.ok&&typeof(await r.json()).version==='string';}catch{return false;}}
  async start(){
    if(await this.available()){
      try{const settings=JSON.parse(fs.readFileSync(path.join(this.directory,'ollama-runtime.json'),'utf8'));this.concurrency=settings.port===this.port&&Number.isInteger(settings.concurrency)&&settings.concurrency>=1&&settings.concurrency<=4?settings.concurrency:1;}catch{this.concurrency=1;}
      return this;
    }
    fs.mkdirSync(this.directory,{recursive:true});
    const executable=process.platform==='win32'?path.join(process.env.LOCALAPPDATA||'', 'Programs','Ollama','ollama.exe'):'ollama';
    if(process.platform==='win32'&&!fs.existsSync(executable))throw new Error('The installed local Ollama executable was not found.');
    this.stream=fs.createWriteStream(path.join(this.directory,'ollama-runtime.log'),{flags:'a'});
    this.child=this.spawn(executable,['serve'],{cwd:this.directory,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,
      OLLAMA_HOST:'127.0.0.1:'+this.port,OLLAMA_NUM_PARALLEL:String(this.concurrency),OLLAMA_CONTEXT_LENGTH:'32768',
      OLLAMA_FLASH_ATTENTION:'1',OLLAMA_KV_CACHE_TYPE:'f16',OLLAMA_MAX_LOADED_MODELS:'1',OLLAMA_NO_CLOUD:'1',
      OLLAMA_DEBUG_LOG_REQUESTS:'false',OLLAMA_KEEP_ALIVE:'30m',OLLAMA_NOHISTORY:'true',OLLAMA_NOPRUNE:'true',HTTP_PROXY:'',HTTPS_PROXY:'',ALL_PROXY:'',NO_PROXY:'127.0.0.1,localhost,::1'}});
    let launchError=null;this.child.on('error',error=>{launchError=error;});
    this.child.stdout?.pipe(this.stream,{end:false});this.child.stderr?.pipe(this.stream,{end:false});
    // GPU discovery can exceed 30 seconds immediately after a laptop restart.
    const deadline=Date.now()+90000;
    while(Date.now()<deadline){if(launchError||this.child.exitCode!==null)break;if(await this.available()){
      fs.writeFileSync(path.join(this.directory,'ollama-runtime.json'),JSON.stringify({pid:this.child.pid,port:this.port,concurrency:this.concurrency,flashAttention:true,kvCache:'f16',localOnly:true,startedAt:new Date().toISOString()},null,2)+'\n');return this;
    }await new Promise(r=>setTimeout(r,250));}
    await this.close();throw launchError||new Error('The local parallel analysis runtime did not start.');
  }
  async close(){
    if(this.child){try{await this.fetch(this.base+'/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'gemma4:e4b',keep_alive:0}),signal:AbortSignal.timeout(3000)});}catch{}
      const child=this.child;this.child=null;
      await new Promise(resolve=>{const timeout=setTimeout(resolve,1500);child.once('exit',()=>{clearTimeout(timeout);resolve();});this.terminate(child).catch(()=>{child.kill();});});}
    this.stream?.end();this.stream=null;
  }
}
