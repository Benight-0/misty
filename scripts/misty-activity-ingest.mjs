// Separate small service: adding telemetry must not interrupt an active Codex job.
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {LaptopActivityStore,RAW_MS} from '../app/laptop-activity.mjs';
import {serveLaptopActivity} from '../app/laptop-activity-server.mjs';

const credentials=process.env.CREDENTIALS_DIRECTORY;
const bot=new DatabaseSync('/var/lib/misty-bot/chat.sqlite',{readOnly:true});bot.exec('PRAGMA busy_timeout=5000');
const db=new DatabaseSync('/var/lib/misty-bot/laptop-activity.sqlite');
const catalog=()=>JSON.parse(bot.prepare("SELECT value FROM bot_settings WHERE key='relay_catalog'").get()?.value||'{}');
const activity=new LaptopActivityStore(db,{pairedWorker:()=>catalog().worker});
const ownerAllowed=id=>{
 const row=bot.prepare("SELECT id,ts,status FROM bot_turns ORDER BY ts DESC,id DESC LIMIT 1").get();
 return /^\d{16,22}$/.test(id||'')&&row?.id===id&&['external','external_sent'].includes(row.status)&&Date.now()-row.ts<=1800000&&row.ts<=Date.now()+5000;
};
const server=serveLaptopActivity(activity,{relayToken:fs.readFileSync(credentials+'/relay-token','utf8').trim(),readerToken:fs.readFileSync(credentials+'/prominence-token','utf8').trim(),ownerAllowed});
const prune=setInterval(()=>db.prepare('DELETE FROM laptop_activity_samples WHERE captured<?').run(Date.now()-RAW_MS),60000);prune.unref();
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{clearInterval(prune);server.close(()=>{bot.close();db.close();process.exit(0);});});
