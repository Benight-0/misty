import http from 'node:http';
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ArchiveStore } from './store.mjs';
import { archivePath,importArchive } from './import.mjs';
import { LiveSource } from './source.mjs';
import { refreshProfile,profile,conversationFit } from './analysis.mjs';
import { MatrixController } from './matrix.mjs';
import {DiscordHistory} from './discord-history.mjs';
import {Gmail,GMAIL_SCOPE,GMAIL_COMPOSE_SCOPE,GMAIL_MODIFY_SCOPE} from './gmail.mjs';
import {replyDefaults} from './gmail-compose.mjs';
import {ChatSender} from './chat.mjs';
import {NativeChat} from './native-chat.mjs';
import {draftChat} from './chat-ai.mjs';
import {Briefings} from './briefings.mjs';
import {saveChatEvent,savePersonNote} from './briefing-store.mjs';
import {personProfile,roomMembers} from './person-profile.mjs';
import {Worker} from 'node:worker_threads';

export function secureRequest(req,port,token,publicOrigin='') {
  const origins=['http://127.0.0.1:'+port,'http://localhost:'+port];
  if(publicOrigin){const u=new URL(publicOrigin);if(u.protocol!=='https:'||u.origin!==publicOrigin)throw new Error('Invalid public origin.');origins.push(publicOrigin);}
  if(!origins.some(o=>new URL(o).host===req.headers.host))return false;
  if(req.headers.origin && !origins.includes(req.headers.origin))return false;
  if(!['GET','HEAD'].includes(req.method) && req.headers['x-archival-token']!==token)return false;
  return true;
}

export function connectionCommand(platform,target) {
  if(platform==='matrix') {
    let id=target.trim();
    if(id.startsWith('https://matrix.to/#/'))id=decodeURIComponent(id.slice(20).split('?')[0]);
    if(!/^![A-Za-z0-9_-]+:localhost$/.test(id))throw new Error('Use a local Matrix room ID (!…:localhost) or its matrix.to link.');
    return {room:id};
  }
  if(platform==='discord') {
    const match=target.trim().match(/^(?:https:\/\/(?:www\.)?discord\.com\/channels\/\d+\/)?(\d{16,22})(?:\/\d+)?\/?$/);
    if(!match)throw new Error('Enter a Discord channel ID or channel link.');
    return {command:'create-portal '+match[1]};
  }
  throw new Error('Import an existing bridged room using its local Matrix room ID. Link other accounts through Element first.');
}

async function jsonBody(req) {
  if(!req.headers['content-type']?.startsWith('application/json'))throw new Error('Expected JSON');
  const chunks=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>131072)throw new Error('Request too large');chunks.push(chunk);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export function createApplication({store,source=new LiveSource(),port=8787,poll=true,gmailOptions={},matrixController=null,briefingOptions={},runtime=null,publicOrigin='',authorizeRequest=null}={}) {
  if(publicOrigin&&!authorizeRequest)throw new Error('Public access requires authentication.');
  const token=randomBytes(32).toString('hex');
  const matrix=matrixController||new MatrixController(store);
  let syncPromise=null,queue=Promise.resolve(),lastMetadata=0,stopped=false,timer;
  let running=false,requestedFull=false,requestedMetadata=false;
  const serial=fn=>{const task=queue.then(fn);queue=task.catch(()=>{});return task;};
  const history=new DiscordHistory(store,serial);
  const gmail=new Gmail(store,serial,{...gmailOptions,...(runtime?{publicOrigin,readOnly:!gmailOptions.agentCompose,
    requestedScopes:gmailOptions.agentCompose?[GMAIL_SCOPE,GMAIL_COMPOSE_SCOPE,GMAIL_MODIFY_SCOPE]:[GMAIL_SCOPE]}:{})});
  const chat=new ChatSender(store,serial,matrix,{native:runtime?new NativeChat(store):null});
  const briefings=new Briefings(store,{...briefingOptions,poll:false});
  const briefingWorker=poll&&store.filename!==':memory:'&&briefingOptions.worker!==false?new Worker(new URL('./briefing-worker.mjs',import.meta.url),{workerData:{filename:store.filename,concurrency:briefingOptions.concurrency||store.get('analysis_parallel_requests',3)}}):null;
  let briefingWorkerExited=false;briefingWorker?.once('exit',()=>{briefingWorkerExited=true;});
  briefingWorker?.on('error',()=>{store.set('briefing_worker_error','Local analysis worker stopped. Restart Archival to resume.');});
  function sync({full=false,metadata=false}={}) {
    if(runtime)return Promise.resolve(runtime.sync());
    if(syncPromise){requestedFull ||= full;requestedMetadata ||= metadata;return syncPromise;}
    running=true;
    syncPromise=serial(async()=>{
      try {
        const includeMetadata=metadata || Date.now()-lastMetadata>60000;
        const previous=new Set(store.statement('SELECT id FROM conversations').all().map(r=>r.id));
        let result=await importArchive(store,{full,metadata:includeMetadata,reader:source.read.bind(source)});
        if(includeMetadata) {
          lastMetadata=Date.now();
          const newRooms=store.statement('SELECT id FROM conversations').all().some(r=>!previous.has(r.id));
          if(newRooms && !full && previous.size)result=await importArchive(store,{full:true,metadata:false,reader:source.read.bind(source)});
        }
        if(!store.get('profile_generated_at') || Date.now()-store.get('profile_generated_at')>300000)refreshProfile(store);
        return result;
      } finally {
        running=false;syncPromise=null;
        if(!stopped && (requestedFull || requestedMetadata)) {
          const next={full:requestedFull,metadata:requestedMetadata};requestedFull=false;requestedMetadata=false;
          setTimeout(()=>sync(next).catch(()=>{}),0);
        }
      }
    });
    return syncPromise;
  }
  const publicPath=fileURLToPath(new URL('./public/',import.meta.url));
  const send=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if(!secureRequest(req,port,token,publicOrigin))return send(res,403,{error:'Request origin rejected'});
    if(authorizeRequest&&!await authorizeRequest(req))return send(res,401,{error:'Sign in through Cloudflare Access.'});
    const url=new URL(req.url,'http://127.0.0.1:'+port);
    const p=url.pathname;
    try {
      if(p==='/oauth/gmail/callback' && runtime && req.method==='GET') {
        res.setHeader('Content-Type','text/plain; charset=utf-8');
        res.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'");
        try{await gmail.finishAuthorization({code:url.searchParams.get('code')||'',state:url.searchParams.get('state')||'',error:url.searchParams.get('error')||''});res.writeHead(200);return res.end('Gmail connected to your Misty VM archive. The import will run in the background. Close this tab.');}
        catch(error){res.writeHead(400);return res.end(error.message||'Gmail sign-in failed. Start again in Misty.');}
      }
      if(!p.startsWith('/api/')) {
        const paths={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/misty.js':['misty.js','text/javascript'],'/gmail.js':['gmail.js','text/javascript'],'/chat.js':['chat.js','text/javascript'],'/briefings.js':['briefings.js','text/javascript'],'/misty.css':['misty.css','text/css'],'/style.css':['style.css','text/css']};
        if(req.method!=='GET'||!paths[p])return send(res,404,{error:'Not found'});
        const [file,type]=paths[p];let content=await fs.readFile(publicPath+file);
        if(runtime&&file==='index.html')content=content.toString().replace('>LOCAL<','>PRIVATE VM<').replace('At home on your computer.','Always online on your VM.').replace('Your archive and profile stay here. Bridges still communicate with Discord and WhatsApp.','Your VM stores the archive. Selected chat text is sent to OpenAI for summaries.').replace(/<a class="element-link"[^]*?<\/a>/,'');
        res.writeHead(200,{'Content-Type':type+'; charset=utf-8'});return res.end(content);
      }
      const params=Object.fromEntries(url.searchParams);
      for(const field of ['limit','offset'])if(field in params)params[field]=Math.max(0,Math.min(field==='limit'?200:100000,Number(params[field])||0));
      if(req.method==='GET') {
        if(runtime&&p==='/api/whatsapp/pair')return send(res,200,runtime.pairing());
        if(p==='/api/briefings')return send(res,200,{status:briefings.status(),rooms:briefings.list(params),workerError:store.get('briefing_worker_error','')});
        if(p==='/api/briefings/room')return send(res,200,briefings.room(String(params.id||'')));
        if(p==='/api/briefings/history')return send(res,200,briefings.chapters(String(params.id||''),params));
        if(p==='/api/briefings/events')return send(res,200,briefings.events());
        if(p==='/api/chat/capability')return send(res,200,chat.capability(store.room(String(params.room||''))));
        if(p==='/api/chat/outgoing')return send(res,200,chat.outgoing(String(params.room||''),String(params.id||'')));
        if(p==='/api/gmail')return send(res,200,await gmail.status());
        if(p==='/api/gmail/attachment'){
          const item=gmail.attachment(params.id,params.key);
          if(!item)return send(res,404,{error:'Attachment not stored or conversation unavailable.'});
          const safeName=String(item.name||'attachment').replace(/[\x00-\x1f\x7f"\\/]/g,'_').slice(0,180)||'attachment';
          res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':item.content.length,
            'Content-Disposition':`attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`});
          return res.end(item.content);
        }
        if(p==='/api/gmail/reply') {const {parent,...defaults}=replyDefaults(store,String(params.id||''));return send(res,200,defaults);}
        if(p==='/api/gmail/outgoing')return send(res,200,gmail.outgoing(String(params.id||'')));
        if(p==='/api/gmail/setup') {
          res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'});
          return res.end(await fs.readFile(fileURLToPath(new URL(runtime?'../docs/misty-gmail.md':'../docs/gmail-setup.md',import.meta.url)),'utf8'));
        }
        if(p==='/api/bootstrap')return send(res,200,{token,stats:store.stats(),syncing:running,runtime:runtime?'vm':'local'});
        if(p==='/api/stats')return send(res,200,{...store.stats(),syncing:running});
        if(p==='/api/rooms')return send(res,200,store.listRooms(params));
        if(p==='/api/room')return send(res,200,{room:store.room(params.id),fit:params.fit==='true'?conversationFit(store,params.id):null,
          ...(params.messages==='true'?{messages:store.messages({room:params.id,limit:80})}:{})});
        if(p==='/api/messages')return send(res,200,store.messages({...params,own:params.own==='true'}));
        if(p==='/api/people')return send(res,200,store.people(params.q,params.offset,params.limit));
        if(p==='/api/room/people')return send(res,200,roomMembers(store,String(params.id||''),params));
        if(p==='/api/person')return send(res,200,personProfile(store,briefings,String(params.id||''),params));
        if(p==='/api/profile')return send(res,200,profile(store));
        if(p==='/api/evidence')return send(res,200,store.evidence(params.id));
        if(p==='/api/export') {
          res.setHeader('Content-Disposition','attachment; filename="misty-profile.json"');return send(res,200,profile(store));
        }
      }
      if(req.method==='POST'||req.method==='PATCH') {
        if(runtime&&(p==='/api/gmail/prepare'||p==='/api/gmail/send'||p==='/api/connect'))throw new Error('This action is not enabled in the VM archive.');
        const body=await jsonBody(req);
        if(runtime&&p==='/api/whatsapp/pair')return send(res,202,await runtime.pairWhatsApp());
        if(p==='/api/briefings/configure')return send(res,200,await serial(()=>briefings.configure(String(body.id||''),{enabled:body.enabled,refresh:!!body.refresh})));
        if(p==='/api/briefings/event')return send(res,200,await serial(()=>saveChatEvent(store,body)));
        if(p==='/api/briefings/person')return send(res,200,await serial(()=>savePersonNote(store,body)));
        if(p==='/api/chat/send')return send(res,202,await chat.send(body));
        if(p==='/api/chat/draft')return send(res,200,await draftChat(store,chat,briefingOptions.analysisClient,{room:String(body.room||''),instruction:body.instruction,model:briefingOptions.model}));
        if(p==='/api/gmail/client')return send(res,200,await gmail.configure(body.client));
        if(p==='/api/gmail/prepare')return send(res,200,await gmail.prepare(body));
        if(p==='/api/gmail/send')return send(res,200,await gmail.send(String(body.id||'')));
        if(p==='/api/gmail/authorize')return send(res,200,await gmail.authorize());
        if(p==='/api/gmail/account')return send(res,200,await gmail.accountAction(String(body.id||''),String(body.action||'')));
        if(p==='/api/gmail/sync'){gmail.retry.clear();gmail.wake();return send(res,202,{ok:true});}
        if(p==='/api/sync'){sync({full:!!body.full,metadata:true}).catch(()=>{});return send(res,202,{ok:true});}
        if(p==='/api/room') {
          const result=await serial(()=>store.updateRoom(body.id,body.patch || {}));
          if(body.patch?.connected || body.patch?.tracked) {
            if(result.platform==='gmail')await gmail.restoreThread(result);
            else sync({full:true,metadata:true}).catch(()=>{});
          }
          return send(res,200,result);
        }
        if(p==='/api/identity')return send(res,200,await serial(()=>{const result=store.updateIdentity(body.id,body.patch || {});refreshProfile(store);return result;}));
        if(p==='/api/finding')return send(res,200,await serial(()=>store.updateFinding(body.id,body.patch || {})));
        if(p==='/api/profile/refresh')return send(res,200,await serial(()=>refreshProfile(store)));
        if(p==='/api/connect') {
          const action=connectionCommand(String(body.platform),String(body.target || ''));
          const result=action.room?await matrix.join(action.room):await matrix.submit(body.platform,action.command);
          sync({full:true,metadata:true}).catch(()=>{});
          return send(res,202,result);
        }
      }
      send(res,404,{error:'Not found'});
    } catch(error) {send(res,400,{error:error.message || 'Request failed'});}
  });
  async function tick(){if(stopped)return;try{await sync();history.start().catch(()=>{});}catch{}finally{if(!stopped)timer=setTimeout(tick,store.get('sync_status',{}).ok?1500:10000);}}
  refreshProfile(store);
  if(poll)timer=setTimeout(tick,20);
  if(poll||runtime)gmail.wake();
  return {server,sync,chat,gmail,close:async()=>{stopped=true;clearTimeout(timer);history.close();source.close();await Promise.all([gmail.close(),chat.close(),briefings.close()]);
    if(briefingWorker&&!briefingWorkerExited){await new Promise(resolve=>{const timeout=setTimeout(()=>{briefingWorker.terminate().finally(resolve);},5000);briefingWorker.once('exit',()=>{clearTimeout(timeout);resolve();});briefingWorker.postMessage('stop');});}
    await queue;server.close();store.close();}};
}

if(process.argv[1] && fileURLToPath(import.meta.url)===process.argv[1]) {
  const store=new ArchiveStore(archivePath);
  const noAnalysis=process.argv.includes('--no-analysis');
  if(noAnalysis){store.set('briefing_worker_notice','Analysis temporarily paused for local GPU benchmarking. Message sync continues.');store.statement("UPDATE briefing_jobs SET status='queued' WHERE status='running'").run();}
  const app=createApplication({store,briefingOptions:{worker:!noAnalysis}});
  app.server.listen(8787,'127.0.0.1',()=>console.log('Archival: http://127.0.0.1:8787 — local archive ready'));
  app.server.on('error',err=>{console.error(err.code==='EADDRINUSE'?'Archival is already running on port 8787.':err.message);app.close().finally(()=>process.exit(1));});
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>app.close().finally(()=>process.exit(0)));
}
