// Durable grants and exclusive resources for the existing laptop tool broker.
import {randomUUID} from 'node:crypto';

const kinds={browser:['chrome','playwright'],desktop:['hcu']};
const operations={browser_inspect:['browser',false],browser_run:['browser',true],
  desktop_ax:['desktop',null],desktop_gui:['desktop',null]};
const bounded=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max;
const subset=(child,parent)=>child.every(value=>parent.includes(value));

function grant(value,parent=null){
 const input=value&&typeof value==='object'&&!Array.isArray(value)?value:{};
 const result={inspect:true,act:input.act===true,maxActions:Math.min(8,Math.max(1,Number(input.maxActions)||4)),
  hosts:Array.isArray(input.hosts)?input.hosts.map(String):[],apps:Array.isArray(input.apps)?input.apps.map(String):[]};
 if(result.hosts.length>20||result.apps.length>20||
    result.hosts.some(x=>!bounded(x,200))||result.apps.some(x=>!bounded(x,200)))throw Error('Invalid session grant.');
 if(parent&&(!parent.inspect||result.act&&!parent.act||result.maxActions>parent.maxActions||
   parent.hosts.length>0&&(!result.hosts.length||!subset(result.hosts,parent.hosts))||
   parent.apps.length>0&&(!result.apps.length||!subset(result.apps,parent.apps))))throw Error('Child grant must be narrower than its parent.');
 return result;
}

export class SharedToolSessions{
 constructor(db,{clock=Date.now,canHandoff=()=>false,canReclaim=()=>false}={}){
  Object.assign(this,{db,clock,canHandoff,canReclaim});
  db.exec(`CREATE TABLE IF NOT EXISTS work_sessions(
    id TEXT PRIMARY KEY,task_id TEXT NOT NULL,kind TEXT NOT NULL,backend TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '',resource TEXT NOT NULL DEFAULT '',grant_json TEXT NOT NULL,
    owner_source TEXT NOT NULL,owner_message TEXT NOT NULL DEFAULT '',owner_agent_task TEXT NOT NULL DEFAULT '',
    parent_source TEXT NOT NULL DEFAULT '',parent_agent_task TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL,expires INTEGER NOT NULL,updated INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS work_sessions_task ON work_sessions(task_id,state);
   CREATE UNIQUE INDEX IF NOT EXISTS work_sessions_resource ON work_sessions(resource)
    WHERE state='active' AND resource<>'';
   CREATE TABLE IF NOT EXISTS work_session_handoffs(
    session_id TEXT NOT NULL,child_task TEXT NOT NULL,grant_json TEXT NOT NULL,at INTEGER NOT NULL,
    PRIMARY KEY(session_id,child_task));`);
 }
 get(id){const row=this.db.prepare('SELECT * FROM work_sessions WHERE id=?').get(id);
  if(!row)throw Error('Unknown tool session.');return {...row,grant:JSON.parse(row.grant_json)};}
 public(row){return {id:row.id,taskId:row.task_id,kind:row.kind,backend:row.backend,target:row.target,
  grant:row.grant,state:row.state,expires:row.expires,ownerAgentTask:row.owner_agent_task};}
 owner(row,args){if(row.owner_source!==args.source||row.owner_agent_task!==(args.agentTaskId||'')||
   row.owner_source!=='owner'&&row.owner_message!==(args.ownerMessageId||''))
   throw Error('Session belongs to another agent or owner request.');}
 status(args){const row=this.get(args.sessionId);this.owner(row,args);return this.public(row);}
 assigned(args){
  if(!args.agentTaskId)return [];
  return this.db.prepare("SELECT * FROM work_sessions WHERE owner_agent_task=? AND owner_source=? AND state='active' AND expires>? ORDER BY updated DESC")
   .all(args.agentTaskId,args.source,this.clock()).filter(row=>row.owner_message===(args.ownerMessageId||''))
   .map(row=>this.public({...row,grant:JSON.parse(row.grant_json)}));
 }
 open(args,task){
  this.db.prepare("UPDATE work_sessions SET state='expired',updated=? WHERE state='active' AND expires<?").run(this.clock(),this.clock());
  if(!['owner','supervisor'].includes(args.source))throw Error('A specialist needs a parent session grant.');
  const kind=String(args.kind||''),backend=String(args.backend||'');
  if(!kinds[kind]?.includes(backend))throw Error('Unsupported session backend.');
  if(backend==='playwright'&&task.location!=='vm'||backend!=='playwright'&&task.location==='vm')
   throw Error('Session backend does not match its execution location.');
  if(kind==='desktop'&&task.desktopAct!==true&&args.grant?.act)throw Error('Desktop actions not enabled for this task.');
  if(kind==='browser'&&task.browserAct!==true&&args.grant?.act)throw Error('Browser actions not enabled for this task.');
  const target=String(args.target||'');if(target.length>160)throw Error('Session target too long.');
  const id=randomUUID(),resource=backend==='hcu'?'desktop:focus':backend==='chrome'&&target?'chrome:tab:'+target:'';
  const scope=grant(args.grant),expires=Math.min(task.expires,this.clock()+6*3600000);
  try{this.db.prepare('INSERT INTO work_sessions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    id,args.taskId,kind,backend,target,resource,JSON.stringify(scope),args.source,
    args.ownerMessageId||'',args.agentTaskId||'','','','active',expires,this.clock());}
  catch(error){if(String(error).includes('UNIQUE'))throw Error('This tab or desktop is owned by another active session.');throw error;}
  return this.public(this.get(id));
 }
 handoff(args){
  const row=this.get(args.sessionId);this.owner(row,args);
  if(row.state!=='active'||row.expires<this.clock())throw Error('Session is inactive or expired.');
  if(this.db.prepare("SELECT 1 FROM work_operations WHERE state IN ('queued','executing','unknown') AND json_extract(body,'$.sessionId')=? LIMIT 1").get(row.id))
   throw Error('Finish or resolve the current session operation before handoff.');
  if(!/^[a-f0-9]{32}$/.test(args.childAgentTaskId||'')||
     !this.canHandoff(args,row))throw Error('Child task is not a verified delegation of this owner or supervisor.');
  const narrower=grant(args.grant,row.grant);
  this.db.prepare('INSERT OR IGNORE INTO work_session_handoffs VALUES(?,?,?,?)').run(
   row.id,args.childAgentTaskId,row.grant_json,this.clock());
  this.db.prepare('UPDATE work_sessions SET grant_json=?,owner_source=?,owner_agent_task=?,owner_message=?,parent_source=?,parent_agent_task=?,updated=? WHERE id=?').run(
   JSON.stringify(narrower),'specialist',args.childAgentTaskId,args.ownerMessageId||'',row.owner_source,row.owner_agent_task,this.clock(),row.id);
  return this.public(this.get(row.id));
 }
 reclaim(args){
  const row=this.get(args.sessionId);
  if(!row.parent_source||args.source!==row.parent_source||
    (args.agentTaskId||'')!==row.parent_agent_task||
    row.parent_source!=='owner'&&(args.ownerMessageId||'')!==row.owner_message||!this.canReclaim(args,row))
    throw Error('Session handoff has not completed for this parent.');
  if(this.db.prepare("SELECT 1 FROM work_operations WHERE state IN ('queued','executing','unknown') AND json_extract(body,'$.sessionId')=? LIMIT 1").get(row.id))
   throw Error('Finish or resolve the child session operation before reclaim.');
  // Restoring the original grant requires its recorded value. Handoff retains it
  // in a separate immutable receipt instead of trusting a caller-supplied scope.
  const receipt=this.db.prepare('SELECT grant_json FROM work_session_handoffs WHERE session_id=? AND child_task=? ORDER BY at DESC LIMIT 1')
   .get(row.id,row.owner_agent_task);
  if(!receipt)throw Error('Missing parent grant receipt.');
  this.db.prepare("UPDATE work_sessions SET grant_json=?,owner_source=?,owner_agent_task=?,parent_source='',parent_agent_task='',updated=? WHERE id=?").run(
   receipt.grant_json,row.parent_source,row.parent_agent_task,this.clock(),row.id);
  return this.public(this.get(row.id));
 }
 cancel(args){const row=this.get(args.sessionId);this.owner(row,args);
  this.db.prepare("UPDATE work_sessions SET state='cancelled',updated=? WHERE id=?").run(this.clock(),row.id);
  this.db.prepare("UPDATE work_operations SET state='cancelled',updated=? WHERE state='queued' AND json_extract(body,'$.sessionId')=?").run(this.clock(),row.id);
  return this.public(this.get(row.id));}
 authorize(task,args,tool,details){
  const row=this.get(args.sessionId);this.owner(row,args);
  if(row.task_id!==args.taskId||row.state!=='active'||row.expires<this.clock())throw Error('Tool session is inactive or belongs to another task.');
  const [kind,mutates]=operations[tool]||[];if(row.kind!==kind)throw Error('Tool does not match session.');
  let write=mutates;
  if(tool==='desktop_ax'){
   if(!['apps','observe','find','act'].includes(details?.mode))throw Error('Invalid accessibility mode.');
   write=details.mode==='act';
  }
  if(tool==='desktop_gui'){
   if(!Array.isArray(details?.actions)||!details.actions.length)throw Error('GUI actions are required.');
   write=details.actions.some(a=>!['screenshot','zoom'].includes(a.type));
  }
  if(tool==='browser_run'&&(!Array.isArray(details?.actions)||!details.actions.length))throw Error('Browser actions are required.');
  if(write&&!row.grant.act)throw Error('Session grant does not allow actions.');
  if(write&&Array.isArray(details?.actions)&&details.actions.length>row.grant.maxActions)throw Error('Action batch exceeds session grant.');
  if(tool==='desktop_ax'&&write&&row.grant.apps.length&&
     !row.grant.apps.includes(String(details.app||'')))throw Error('Desktop app is outside the session grant.');
  if(tool==='browser_run'&&details.actions.some(a=>['navigate','new_tab'].includes(a.type)&&
     row.grant.hosts.length&&!row.grant.hosts.includes(new URL(a.url).hostname)))
   throw Error('Navigation is outside the session grant.');
  return this.public(row);
 }
 route(session){return session.backend==='playwright'?'vm':'laptop';}
 targetFromResult(sessionId,result){
  if(!result||result.state!=='succeeded'||!bounded(result.sessionTarget,160))return;
  const row=this.get(sessionId);if(row.target&&row.target!==result.sessionTarget)throw Error('Session target changed unexpectedly.');
  const resource=row.backend==='chrome'?'chrome:tab:'+result.sessionTarget:row.resource;
  try{this.db.prepare("UPDATE work_sessions SET target=?,resource=?,updated=? WHERE id=? AND state='active'").run(
   result.sessionTarget,resource,this.clock(),sessionId);}
  catch(error){
   if(!String(error).includes('UNIQUE'))throw error;
   this.db.prepare("UPDATE work_sessions SET state='conflicted',updated=? WHERE id=?").run(this.clock(),sessionId);
  }
 }
}
