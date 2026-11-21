import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const data=fileURLToPath(new URL('../data/',import.meta.url));
export class MatrixController {
  constructor(store,{fetchImpl=fetch}={}) {this.store=store;this.token=null;this.loginPromise=null;this.fetch=fetchImpl;}
  async request(endpoint,{method='GET',body,retry=0,maxRetries=5}={}) {
    const response=await this.fetch('http://127.0.0.1:8008'+endpoint,{method,
      headers:{...(this.token?{Authorization:'Bearer '+this.token}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{})},
      body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(45000)});
    const result=await response.json().catch(()=>({}));
    if (response.status===429 && retry<maxRetries) {await new Promise(r=>setTimeout(r,Math.min(30000,result.retry_after_ms || 5000)));return this.request(endpoint,{method,body,retry:retry+1,maxRetries});}
    if (!response.ok) {const error=new Error('Matrix returned '+response.status+' '+(result.errcode || ''));error.status=response.status;throw error;}
    return result;
  }
  async verifyChatRoom(room) {
    const state=await this.request('/_matrix/client/v3/rooms/'+encodeURIComponent(room.id)+'/state');
    const fail=message=>{const error=new Error(message);error.safe=true;throw error;};
    if(!Array.isArray(state))fail('The local room state is unavailable.');
    const content=(type,key='')=>state.find(e=>e.type===type&&e.state_key===key)?.content;
    if(content('m.room.member','@owner:localhost')?.membership!=='join')fail('Join this conversation in Element before sending.');
    if(state.some(e=>e.type==='m.room.encryption'))fail('This composer cannot send to encrypted Matrix rooms.');
    const bridge=state.find(e=>e.type==='m.bridge'&&e.content?.channel?.id===room.remote_id)?.content;
    const platform=bridge?.protocol?.id==='discordgo'?'discord':bridge?.protocol?.id;
    if(platform!==room.platform)fail('The room is no longer linked to the expected platform. Refresh its metadata.');
    if(room.platform==='discord'&&String(bridge.network?.id||'')!==room.server_id)fail('The Discord destination changed. Refresh before sending.');
    const power=content('m.room.power_levels')||{},level=power.users?.['@owner:localhost']??power.users_default??0;
    if(level<(power.events?.['m.room.message']??power.events_default??0))fail('Your Matrix account cannot send messages in this room.');
  }
  async sendChat(room,body,transaction) {
    return this.request('/_matrix/client/v3/rooms/'+encodeURIComponent(room)+'/send/m.room.message/'+encodeURIComponent(transaction),
      {method:'PUT',body:{msgtype:'m.text',body},maxRetries:0});
  }
  async login() {
    if (this.token) return;
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise=(async()=>{
      const filename=data+'app/matrix-session.json';
      try {const stored=JSON.parse(await fs.readFile(filename,'utf8'));this.token=stored.access_token;const me=await this.request('/_matrix/client/v3/account/whoami');if(me.user_id!=='@owner:localhost')throw new Error('Wrong account');return;}catch {this.token=null;}
      const password=(await fs.readFile(data+'owner-password.txt','utf8')).trim();
      const session=await this.request('/_matrix/client/v3/login',{method:'POST',body:{type:'m.login.password',identifier:{type:'m.id.user',user:'owner'},password,initial_device_display_name:'Archival local archive'}});
      if(session.user_id!=='@owner:localhost')throw new Error('Unexpected Matrix account');
      this.token=session.access_token;
      await fs.writeFile(filename,JSON.stringify({access_token:session.access_token,device_id:session.device_id}),{mode:0o600});
    })();
    try {await this.loginPromise;} finally {this.loginPromise=null;}
  }
  async command(platform,command,{timeout=30000,acceptReply=()=>true}={}) {
    await this.login();
    const room=this.store.get('bridge_room_'+platform);
    if(!room)throw new Error('Bridge management room is unavailable. Refresh the local archive first.');
    const filter=JSON.stringify({room:{rooms:[room],state:{types:[]},timeline:{limit:50}}});
    let cursor=(await this.request('/_matrix/client/v3/sync?'+new URLSearchParams({timeout:'0',filter}))).next_batch;
    const submitted=await this.request('/_matrix/client/v3/rooms/'+encodeURIComponent(room)+'/send/m.room.message/'+randomUUID(),{method:'PUT',body:{msgtype:'m.text',body:command}});
    let seenCommand=false;
    const bot='@'+platform+'bot:localhost';
    const start=Date.now();
    while(Date.now()-start<timeout) {
      const sync=await this.request('/_matrix/client/v3/sync?'+new URLSearchParams({timeout:'3000',filter,since:cursor}));cursor=sync.next_batch;
      for(const event of sync.rooms?.join?.[room]?.timeline?.events || []){
        if(event.event_id===submitted.event_id){seenCommand=true;continue;}
        if(seenCommand&&event.sender===bot&&event.type==='m.room.message'&&acceptReply(event.content))return event.content;
      }
    }
    return {body:'Command submitted. Check the bridge management room for the result.',pending:true};
  }
  async join(roomId) {await this.login();return this.request('/_matrix/client/v3/join/'+encodeURIComponent(roomId),{method:'POST',body:{}});}
  async submit(platform,command) {
    await this.login();
    const room=this.store.get('bridge_room_'+platform);
    if(!room)throw new Error('Bridge management room is unavailable. Refresh the archive first.');
    await this.request('/_matrix/client/v3/rooms/'+encodeURIComponent(room)+'/send/m.room.message/'+randomUUID(),{method:'PUT',body:{msgtype:'m.text',body:command}});
    return {pending:true,message:'Requested from the '+platform+' bridge. Accept its room invitation in Element, then refresh Archival. No chat message was sent to the contact.'};
  }
}
