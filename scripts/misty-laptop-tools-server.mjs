import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {LaptopToolsBroker,serveLaptopTools} from '../app/laptop-tools-broker.mjs';
const credentials=process.env.CREDENTIALS_DIRECTORY;
const bot=new DatabaseSync('/var/lib/misty-bot/chat.sqlite',{readOnly:true});bot.exec('PRAGMA busy_timeout=5000');
const pairedWorker=()=>JSON.parse(bot.prepare("SELECT value FROM bot_settings WHERE key='relay_catalog'").get()?.value||'{}').worker;
const ownerAllowed=id=>{
 if(!/^\d{16,22}$/.test(id||''))return false;
 const rows=bot.prepare('SELECT id,body,ts,status FROM bot_turns ORDER BY ts DESC,id DESC LIMIT 30').all();
 const row=rows.find(r=>!/^(?:approve|reject) laptop [a-f0-9]{10}$/i.test(r.body));
 return row?.id===id&&['external','external_sent'].includes(row.status)&&Date.now()-row.ts<1800000&&row.ts<Date.now()+5000;
};
const taskAllowed=(args,action)=>{
 if(!/^[a-f0-9]{32}$/.test(args.agentTaskId||''))return false;
 try{
  const tasks=new DatabaseSync('/var/lib/misty-prominence/agent_tasks.sqlite',{readOnly:true});
  try{
   const task=tasks.prepare('SELECT * FROM tasks WHERE id=?').get(args.agentTaskId);
   if(!task||task.state!=='running'||task.lease_until<Date.now()/1000||
      (args.source==='supervisor')!==(task.role==='supervisor'||task.role==='misty')||
      (task.origin==='owner'&&task.owner_message!==args.ownerMessageId)||
      (task.origin==='supervisor'&&args.ownerMessageId))return false;
   if(task.origin==='supervisor'&&action==='start'&&(args.write||args.commands)){
    const project=tasks.prepare('SELECT root FROM project_registry WHERE root=?').get(task.project);
    if(!project||!args.workspace||args.workspace.toLowerCase()!==project.root.toLowerCase())return false;
   }
   return true;
  }finally{tasks.close();}
 }catch{return false;}
};
const readAgentTask=id=>{
 if(!/^[a-f0-9]{32}$/.test(id||''))return null;
 const tasks=new DatabaseSync('/var/lib/misty-prominence/agent_tasks.sqlite',{readOnly:true});
 try{return tasks.prepare('SELECT id,task_key,role,origin,owner_message,state FROM tasks WHERE id=?').get(id)||null;}
 finally{tasks.close();}
};
const canHandoff=(args,row)=>{
 const child=readAgentTask(args.childAgentTaskId);
 if(!child||!['coding','analysis'].includes(child.role)||!['queued','running'].includes(child.state))return false;
 if(row.owner_source==='owner')return child.origin==='owner'&&child.owner_message===args.ownerMessageId;
 if(row.owner_source==='supervisor')return child.origin==='supervisor'&&child.task_key.startsWith('supervisor:'+row.owner_agent_task+':');
 return false;
};
const canReclaim=(args,row)=>{
 const child=readAgentTask(row.owner_agent_task);
 return !!child&&['completed','failed','cancelled','interrupted','waiting'].includes(child.state);
};
const db=new DatabaseSync('/var/lib/misty-bot/laptop-tools.sqlite'),broker=new LaptopToolsBroker(db,{pairedWorker,ownerAllowed,taskAllowed,canHandoff,canReclaim,reviewRequired:process.env.MISTY_LAPTOP_REVIEW==='on'});
const vmTokenFile=credentials+'/vm-browser-token';
const server=serveLaptopTools(broker,{relayToken:fs.readFileSync(credentials+'/relay-token','utf8').trim(),readerToken:fs.readFileSync(credentials+'/prominence-token','utf8').trim(),vmToken:fs.existsSync(vmTokenFile)?fs.readFileSync(vmTokenFile,'utf8').trim():undefined});
const timer=setInterval(()=>broker.prune(),60000);timer.unref();
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{server.close(()=>{db.close();bot.close();process.exit(0);});});
