import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ArchiveStore} from '../store.mjs';
import {nativeSchema,applyNativeEvent,nativePlans} from '../native-ingest.mjs';
import {configureDiscordServers,nativeDiscordServerPlans} from '../discord-server-policies.mjs';
import {ingestDiscord} from '../discord-history-store.mjs';
import {MistyServerSummaries,activateWhatsAppServers} from '../misty-server-summaries.mjs';
import {PRIVATE_SCOPE,insightEligible} from '../briefing-store.mjs';

const ids=['100000000000000005','100000000000000011','100000000000000014'],channels=['100000000000000006','100000000000000012','100000000000000015'];
function fixture(t,now=Date.now()){
 const store=new ArchiveStore(':memory:');nativeSchema(store);t.after(()=>store.close());
 store.db.prepare("INSERT INTO conversations(id,name,platform,kind,remote_id,tracked,connected) VALUES('private','Private','discord','dm','100000000000000017',1,1)").run();
 const manifest={choices:ids.map((id,i)=>({id,name:'Server '+i,treatment:['SP','GP','I'][i]})),counts:{SP:1,GP:1,I:1},source:'test'};
 const inventory={complete:true,at:now,servers:ids.slice(0,2).map((id,i)=>({id,channels:[{id:channels[i],guild_id:id,name:'channel',type:0}]}))};
 configureDiscordServers(store,manifest,inventory,now);return {store,manifest,inventory,now};
}
const raw=(index,ts,body='hello')=>({id:((BigInt(ts)-1420070400000n)<<22n).toString(),channel_id:channels[index],guild_id:ids[index],timestamp:new Date(ts).toISOString(),content:body,author:{id:'100000000000000007',username:'Person'}});
test('classification preserves private chats, excludes old S messages, and retains G history',t=>{
 const {store,manifest,inventory,now}=fixture(t),plans=nativeDiscordServerPlans(store);
 assert.equal(nativePlans(store).length,1);assert.equal(plans.length,2);assert.equal(plans.find(p=>p.treatment==='SP').complete,true);assert.equal(plans.find(p=>p.treatment==='GP').complete,false);
 for(const [i,ts] of [[0,now-1],[0,now+1],[1,now-86400000]])applyNativeEvent(store,{kind:'discord_message',message:raw(i,ts)});
 assert.equal(store.db.prepare('SELECT count(*) n FROM messages').get().n,2);
 assert.equal(store.db.prepare('SELECT count(*) n FROM misty_server_pending').get().n,1);
 const group=store.room('discord:channel:'+channels[1]);assert.equal(insightEligible(group),true);
 assert.equal(store.db.prepare('SELECT count(*) n FROM conversations WHERE connected=1 AND '+PRIVATE_SCOPE).get().n,2);
 configureDiscordServers(store,manifest,inventory,now+10000);
 assert.equal(store.room('private').tracked,1);assert.equal(store.db.prepare('SELECT from_ts FROM discord_server_policies WHERE treatment=\'SP\'').get().from_ts,now);
 applyNativeEvent(store,{kind:'discord_server_channel',channel:{id:channels[2],guild_id:ids[2],type:0,name:'ignored'}});
 assert.equal(store.room('discord:channel:'+channels[2]),undefined);
});
test('WhatsApp activation cannot disable Discord summaries; retention erases covered raw data and cannot erase GP',t=>{
 const now=Date.now()-2*86400000,{store}=fixture(t,now);
 store.set('misty_live_servers',true);activateWhatsAppServers(store);
 assert.equal(store.db.prepare('SELECT enabled FROM misty_server_channels').get().enabled,1);
 const message=raw(0,now+1);applyNativeEvent(store,{kind:'discord_message',message});
 applyNativeEvent(store,{kind:'discord_message',message:raw(1,now+2)});
 const mid='discord:'+channels[0]+':'+message.id;
 store.db.prepare('DELETE FROM misty_server_pending').run();
 store.db.prepare('INSERT INTO misty_server_covered VALUES(?,?,?,?)').run(mid,'discord:channel:'+channels[0],createHash('sha256').update('hello').digest('hex'),'batch');
 new MistyServerSummaries(store,{},{}).retain();
 assert.equal(store.db.prepare('SELECT count(*) n FROM discord_remote WHERE message_id=?').get(mid).n,0);
 assert.equal(store.db.prepare('SELECT count(*) n FROM messages').get().n,1);
 ingestDiscord(store,'discord:channel:'+channels[0],message);
 assert.equal(store.db.prepare('SELECT count(*) n FROM messages').get().n,1,'covered replay must not restore expired text');
});
test('an invalid metadata guild rolls back the entire selection change',t=>{
 const {store,manifest,inventory,now}=fixture(t);inventory.servers[0].channels[0].guild_id=ids[2];
 assert.throws(()=>configureDiscordServers(store,manifest,inventory,now+1000),/mismatch/);
 assert.equal(store.room('private').tracked,1);assert.equal(store.db.prepare('SELECT count(*) n FROM conversations WHERE platform=\'discord\' AND connected=1').get().n,3);
});
