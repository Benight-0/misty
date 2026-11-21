import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ensureHistoryJobs,historyPlans,applyHistoryPage} from './discord-history-store.mjs';
const workspace=fileURLToPath(new URL('../',import.meta.url));
const scripts=fileURLToPath(new URL('../scripts/',import.meta.url)).replace(/[\\/]$/,'');

export class DiscordHistory {
  constructor(store,serial){this.store=store;this.serial=serial;this.child=null;this.closed=false;this.lastAttempt=0;}
  async start(){
    if(this.closed||this.child||Date.now()-this.lastAttempt<60000)return;
    this.lastAttempt=Date.now();
    const plans=await this.serial(()=>{ensureHistoryJobs(this.store);return historyPlans(this.store);});
    if(!plans.length||this.closed||this.child)return;
    const child=spawn('docker',['run','--rm','-i','--pull=never','--read-only','--volumes-from','misty-discord-1:ro','-v',scripts+':/tools:ro','--entrypoint','python','matrixdotorg/synapse:v1.162.0','-B','/tools/fetch-discord-history.py'],{cwd:workspace,windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.child=child;this.store.set('discord_history_worker',{running:true,at:Date.now()});
    let buffer='',queue=Promise.resolve();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{
      buffer+=chunk;
      if(buffer.length>32*1024*1024){child.kill();return;}
      let n;
      while((n=buffer.indexOf('\n'))>=0){
        const line=buffer.slice(0,n);buffer=buffer.slice(n+1);
        queue=queue.then(async()=>{
          try{const page=JSON.parse(line);const ok=await this.serial(()=>applyHistoryPage(this.store,page));if(!child.stdin.destroyed)child.stdin.write(ok?'ok\n':'skip\n');}
          catch{child.kill();}
        });
      }
    });
    child.stderr.on('data',()=>{});
    child.stdin.on('error',()=>{});
    const finish=()=>{queue.finally(()=>{if(this.child===child){this.child=null;if(!this.closed)this.serial(()=>this.store.set('discord_history_worker',{running:false,at:Date.now()})).catch(()=>{});}});};
    child.on('error',finish);child.on('close',finish);
    child.stdin.write(JSON.stringify(plans)+'\n');
  }
  close(){this.closed=true;this.child?.kill();this.child=null;}
}
