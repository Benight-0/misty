import {nativeDiscordServers,nativeDiscordServerPlans} from './discord-server-policies.mjs';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {nativeSchema,nativePlans,applyNativeEvent} from './native-ingest.mjs';
import {whatsappGroupPlans} from './whatsapp-groups.mjs';

export class NativeRuntime{
 constructor(store,{binary='/opt/archival/bin/archival-collector',tokenFile='/etc/archival/discord-token',whatsappDB='/var/lib/archival/whatsapp.sqlite',onChange=()=>{}}={}){
  this.store=store;this.options={binary,tokenFile,whatsappDB};this.onChange=onChange;this.stopped=false;this.child=null;this.timer=null;nativeSchema(store);
 }
 start(){
  if(this.stopped||this.child)return;
  for(const platform of ['discord','whatsapp'])this.store.set('native_'+platform,{connected:false,state:'starting',at:Date.now()});
  const {binary,tokenFile,whatsappDB}=this.options;
  const child=spawn(binary,[],{stdio:['pipe','pipe','pipe'],env:{...process.env,GOMEMLIMIT:'160MiB',GOMAXPROCS:'1'}});this.child=child;
  // Never persist upstream stderr: authentication failures can include private data.
  child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
  const liveGroups=this.store.statement("SELECT p.chat_id FROM whatsapp_group_policies p JOIN conversations c ON c.id=p.room_id WHERE c.connected=1 AND c.tracked=1 AND ((p.treatment='G' AND ?=1) OR (p.treatment='S' AND ?=1))").all(+this.store.get('misty_live_groups',false),+this.store.get('misty_live_servers',false)).map(p=>p.chat_id);
  child.stdin.write(JSON.stringify({discord_token_file:tokenFile,whatsapp_db:whatsappDB,pair_whatsapp:!!this.pairMode,channels:[...nativePlans(this.store),...nativeDiscordServerPlans(this.store)],discord_servers:nativeDiscordServers(this.store),whatsapp_groups:whatsappGroupPlans(this.store),live_whatsapp_groups:liveGroups})+'\n');this.pairMode=false;
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{
   let event;
   try{
    if(Buffer.byteLength(line)>8*1024*1024)throw new Error('Collector event too large');
    event=JSON.parse(line);applyNativeEvent(this.store,event);child.stdin.write('ok\n');
    if(['discord_message','discord_delete','whatsapp_message','whatsapp_delete'].includes(event.kind))this.onChange();
   }catch(error){const detail=/^(NOT NULL constraint failed:|UNIQUE constraint failed:|FOREIGN KEY constraint failed|database is locked|no such table:|no such column:)/.test(error.message)?error.message:'';this.store.set('native_collector_error',{at:Date.now(),kind:event?.kind||'invalid-json',code:error.code||'validation',detail,error:'Collector event could not be stored. Restarting without acknowledging it.'});
    child.kill('SIGTERM');
    // Go may be waiting for the acknowledgement deliberately withheld after a failed
    // commit. Bound shutdown so that gap recovery can restart instead of hanging.
    const killTimer=setTimeout(()=>{if(this.child===child)child.kill('SIGKILL');},2000);killTimer.unref();child.once('close',()=>clearTimeout(killTimer));
   }
  });
  child.once('error',()=>this.store.set('native_collector_error',{at:Date.now(),error:'Collector process could not start.'}));
  child.once('close',()=>{lines.close();this.child=null;for(const platform of ['discord','whatsapp'])this.store.set('native_'+platform,{connected:false,state:'restarting',at:Date.now()});if(!this.stopped)this.timer=setTimeout(()=>this.start(),10000);});
 }
 sync(){if(!this.child)this.start();return {ok:true,message:'Live collectors are running. Discord checks for gaps automatically; WhatsApp receives available linked-device updates.'};}
 pairing(){const value=this.store.get('whatsapp_pairing');return value?.expires>Date.now()?value:{code:'',expires:0};}
 async pairWhatsApp(){
  const state=this.store.get('native_whatsapp',{});if(state.connected)throw new Error('WhatsApp is already connected.');
  if(this.pairing().code)return {ok:true};
  await this.close();this.store.set('whatsapp_pairing',null);this.stopped=false;this.pairMode=true;this.start();return {ok:true};
 }
 async close(){this.stopped=true;clearTimeout(this.timer);if(this.child){const child=this.child;await new Promise(resolve=>{const timeout=setTimeout(()=>child.kill('SIGKILL'),5000);child.once('close',()=>{clearTimeout(timeout);resolve();});child.kill('SIGTERM');});}}
}
