import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {generateKeyPairSync,sign} from 'node:crypto';
import {request} from 'node:http';
import {ArchiveStore} from '../store.mjs';
import {nativeSchema,nativePlans,applyNativeEvent} from '../native-ingest.mjs';
import {OpenAIAnalysis} from '../openai-analysis.mjs';
import {cloudflareAccess} from '../cloudflare-access.mjs';
import {createApplication,secureRequest} from '../server.mjs';

function fixture(t){const s=new ArchiveStore(':memory:');nativeSchema(s);t.after(()=>s.close());return s;}
const channel='100000000000000005',first='100000000000000008',second='100000000000000009';
function dm(s){applyNativeEvent(s,{kind:'discord_channel',channel:{id:channel,type:1,name:'Test'}});}
function discord(s,id){applyNativeEvent(s,{kind:'discord_message',message:{id,channel_id:channel,content:'Test text',author:{id:'100000000000000023',username:'Owner'},timestamp:'2026-10-21T00:00:00Z'}});}
test('persisted Discord baseline survives live arrivals before gap recovery',t=>{
 const s=fixture(t);dm(s);discord(s,first);assert.equal(nativePlans(s)[0].after,'');
 applyNativeEvent(s,{kind:'discord_cursor',channel,after:first});assert.equal(nativePlans(s)[0].after,first);
 discord(s,second);assert.equal(nativePlans(s)[0].after,first);
 applyNativeEvent(s,{kind:'discord_cursor',channel,after:second});assert.equal(nativePlans(s)[0].after,second);
 assert.equal(s.statement('SELECT sum(is_me) n FROM messages').get().n,2);
 assert.throws(()=>applyNativeEvent(s,{kind:'discord_message',message:{guild_id:'123'}}),/disabled/);
 assert.throws(()=>applyNativeEvent(s,{kind:'discord_identity',id:'wrong'}),/owner/);
});
test('WhatsApp aliases share a canonical message, preserve owner, edits and deletion',t=>{
 const s=fixture(t),event={kind:'whatsapp_message',chat:'123@lid',aliases:['555@s.whatsapp.net'],id:'ABC123',sender:'123@lid',is_me:false,name:'Contact',at:Date.now(),body:'Original',type:'m.text',raw:{conversation:'Original'}};
 applyNativeEvent(s,event);applyNativeEvent(s,{...event,chat:'555@s.whatsapp.net',aliases:['123@lid'],body:'Edited',edited:true});
 assert.equal(s.statement('SELECT count(*) n FROM messages').get().n,1);
 assert.equal(s.statement('SELECT sender FROM messages').get().sender,'@whatsapp_lid-123:localhost');
 applyNativeEvent(s,{...event,id:'ME',sender:'110000000000005@s.whatsapp.net',is_me:true});
 assert.equal(s.statement("SELECT is_me FROM messages WHERE sender='@owner:localhost'").get().is_me,1);
 applyNativeEvent(s,{kind:'whatsapp_delete',chat:event.chat,aliases:event.aliases,id:event.id});
 applyNativeEvent(s,event);assert.equal(s.statement('SELECT count(*) n FROM messages').get().n,1);
 assert.equal(s.statement('SELECT count(*) n FROM native_whatsapp_raw').get().n,1);
 applyNativeEvent(s,{...event,chat:'123@g.us',aliases:[]});assert.equal(s.statement('SELECT count(*) n FROM conversations').get().n,1);
});

test('live WhatsApp group inventory replaces membership metadata without enabling collection or analysis',t=>{
 const s=fixture(t),at=Date.now();
 s.statement("INSERT INTO conversations(id,name,platform,kind,remote_id,connected,tracked) VALUES('group-old','Archived group','whatsapp','group','123-456@g.us',0,0)").run();
 const before=s.statement('SELECT * FROM conversations').all();
 applyNativeEvent(s,{kind:'whatsapp_group_inventory',at,groups:[{id:'123-456@g.us',name:'Renamed group',community:false,announcement:false,parent:''},{id:'789@g.us',name:'New group',community:false,announcement:true,parent:'987@g.us'},{id:'987@g.us',name:'Community',community:true,announcement:false,parent:''}]});
 assert.equal(s.get('whatsapp_group_inventory').groups.length,3);assert.deepEqual(s.statement('SELECT * FROM conversations').all(),before);
 assert.equal(s.statement('SELECT count(*) n FROM messages').get().n,0);assert.equal(s.statement('SELECT count(*) n FROM briefing_jobs').get().n,0);
 applyNativeEvent(s,{kind:'whatsapp_group_inventory',at:at+1,groups:[{id:'789@g.us',name:'New group',community:false,announcement:false,parent:''}]});
 assert.equal(s.get('whatsapp_group_inventory').groups.length,1,'Left groups disappear from the live snapshot without deleting the archive');
 assert.throws(()=>applyNativeEvent(s,{kind:'whatsapp_group_inventory',at,groups:[{id:'status@broadcast',name:'Status',community:false,announcement:false,parent:''}]}),/Invalid WhatsApp group/);
 applyNativeEvent(s,{kind:'whatsapp_group_inventory_error',at});assert.equal(s.get('whatsapp_group_inventory').groups.length,1,'Failure preserves the last successful inventory');
});
test('OpenAI requests use strict schema, no response storage, and record real usage',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'archival-api-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const keyFile=path.join(dir,'key');fs.writeFileSync(keyFile,'sk-test-placeholder');let usage;
 const client=new OpenAIAnalysis({keyFile,onUsage:u=>usage=u,fetchImpl:async(url,options)=>{
  assert.equal(url,'https://api.openai.com/v1/responses');const body=JSON.parse(options.body);assert.equal(body.store,false);assert.equal(body.text.format.schema.additionalProperties,false);assert.deepEqual(body.text.format.schema.required,['value']);
  return Response.json({id:'resp_test',status:'completed',usage:{input_tokens:123,output_tokens:20},output:[{type:'message',content:[{type:'output_text',text:'{"value":"ok"}'}]}]});
 }});
 const result=await client.generate({model:'test',messages:[],schema:{type:'object',properties:{value:{type:'string'}}},outputBudget:100,room:'test'});
 assert.equal(JSON.parse(result.message.content).value,'ok');assert.equal(usage.inputTokens,123);
 client.fetch=async()=>Response.json({status:'incomplete',output:[]});await assert.rejects(client.generate({schema:{}}),/incomplete/);
 client.fetch=async()=>new Response('secret upstream body',{status:401});await assert.rejects(client.generate({schema:{}}),e=>e.message.includes('401')&&!e.message.includes('secret upstream'));
});
test('Cloudflare authentication verifies signature, audience, expiry and owner email',async()=>{
 const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048}),issuer='https://test.cloudflareaccess.com',now=1700000000000;
 const jwk={...publicKey.export({format:'jwk'}),kid:'test'};
 const authorize=cloudflareAccess({issuer,audience:'app',clock:()=>now,fetchImpl:async()=>Response.json({keys:[jwk]})});
 const claims={iss:issuer,aud:['app'],iat:now/1000-10,exp:now/1000+100,type:'app',email:'user-17@example.com'};
 function request(payload){const data=[{alg:'RS256',kid:'test'},payload].map(v=>Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');return {headers:{'cf-access-jwt-assertion':data+'.'+sign('RSA-SHA256',Buffer.from(data),privateKey).toString('base64url')}};}
 assert.equal(await authorize(request(claims)),true);
 for(const patch of [{email:'someone@example.com'},{aud:['other']},{exp:now/1000-1},{iss:'https://other.cloudflareaccess.com'}])assert.equal(await authorize(request({...claims,...patch})),false);
 assert.equal(await authorize({headers:{'cf-access-authenticated-user-email':'user-17@example.com'}}),false);
});
test('public application requires authentication even for bootstrap and static files',async t=>{
 const s=new ArchiveStore(':memory:');assert.throws(()=>createApplication({store:s,poll:false,publicOrigin:'https://example.com'}),/authentication/);
 const app=createApplication({store:s,poll:false,publicOrigin:'https://example.com',authorizeRequest:async()=>false});t.after(()=>app.close());await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 for(const route of ['/','/api/bootstrap']){const status=await new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port:app.server.address().port,path:route,headers:{Host:'example.com'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();});assert.equal(status,401);}
 assert.equal(secureRequest({method:'POST',headers:{host:'example.com',origin:'https://evil.com','x-archival-token':'token'}},8787,'token','https://example.com'),false);
});
