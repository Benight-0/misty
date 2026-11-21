import {ArchiveStore} from './store.mjs';
import {createApplication} from './server.mjs';
import {NativeRuntime} from './native-runtime.mjs';
import {OpenAIAnalysis} from './openai-analysis.mjs';
import {startVMAnalysis} from './vm-analysis-worker.mjs';
import {cloudflareAccess} from './cloudflare-access.mjs';
import {serveArchiveTools} from './misty-archive.mjs';
import {serveMessageBackend} from './message-backend.mjs';
import {activateWhatsAppServers} from './misty-server-summaries.mjs';

const store=new ArchiveStore(process.env.ARCHIVAL_DB||'/var/lib/archival/data/archive.sqlite');
store.db.exec('PRAGMA cache_size=-8192; PRAGMA wal_autocheckpoint=500;');
activateWhatsAppServers(store);
const runtime=new NativeRuntime(store);
const analysisClient=new OpenAIAnalysis({keyFile:'/etc/archival/openai-key',onUsage:u=>{
 store.statement('INSERT OR IGNORE INTO openai_usage VALUES(?,?,?,?,?,?,?,?)').run(u.requestId,u.room,u.model,u.inputTokens,u.outputTokens,u.cachedTokens,u.at,u.status);
}});
const concurrency=Number(process.env.ARCHIVAL_ANALYSIS_CONCURRENCY||3);
const briefingOptions={analysisClient,model:process.env.ARCHIVAL_MODEL||'gpt-5.6-luna',concurrency,planCacheLimit:1};
const publicOrigin=process.env.ARCHIVAL_PUBLIC_ORIGIN||'';
const authorizeRequest=publicOrigin?cloudflareAccess({issuer:process.env.CF_ACCESS_ISSUER,audience:process.env.CF_ACCESS_AUD}):null;
const app=createApplication({store,poll:false,runtime,publicOrigin,authorizeRequest,briefingOptions,gmailOptions:{directory:'/var/lib/archival/gmail',agentCompose:true}});
const messageBackend=process.env.ARCHIVAL_MESSAGE_TOKEN_FILE?serveMessageBackend(store,app.chat,{tokenFile:process.env.ARCHIVAL_MESSAGE_TOKEN_FILE,gmail:app.gmail}):null;
const archiveTools=process.env.MISTY_ARCHIVE_TOKEN_FILE?serveArchiveTools(store,{tokenFile:process.env.MISTY_ARCHIVE_TOKEN_FILE}):null;
const analysis=process.env.ARCHIVAL_ANALYSIS==='off'?null:startVMAnalysis({filename:store.filename,model:briefingOptions.model,concurrency,onError:message=>store.set('briefing_worker_error',message)});
app.server.listen(8787,'127.0.0.1',()=>{console.log('Archival VM ready on localhost:8787');runtime.start();});
let closing=false;
async function close(){if(closing)return;closing=true;archiveTools?.close();messageBackend?.close();await runtime.close();await analysis?.close();await app.close();}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>close().finally(()=>process.exit(0)));
app.server.on('error',()=>close().finally(()=>process.exit(1)));
