// Bounded Browser Harness adapter. The worker serializes calls to its one local Chrome daemon.
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';

const blockedHosts=['mail.google.com','discord.com','web.whatsapp.com','messages.google.com','outlook.live.com','outlook.office.com'];
export function discordAdminSurface(u){
 if(u.protocol!=='https:'||u.hostname!=='discord.com'||u.username||u.password||u.port||u.hash)return false;
 if(/^\/developers\/applications(?:\/[0-9]{16,22}(?:\/(?:information|bot|oauth2|installation))?)?\/?$/.test(u.pathname))return !u.search;
 if(u.pathname!=='/oauth2/authorize')return false;
 const allowed=new Set(['client_id','scope','permissions','guild_id','disable_guild_select']);
 return [...u.searchParams.keys()].every(k=>allowed.has(k)&&u.searchParams.getAll(k).length===1)&&
  /^[0-9]{16,22}$/.test(u.searchParams.get('client_id')||'')&&u.searchParams.get('scope')==='bot'&&
  /^(0|68608)$/.test(u.searchParams.get('permissions')||'0')&&
  (!u.searchParams.has('guild_id')||/^[0-9]{16,22}$/.test(u.searchParams.get('guild_id')));
}
export function personalSendSurface(url){
 try{const u=new URL(url),host=u.hostname.toLowerCase();return !discordAdminSurface(u)&&blockedHosts.some(h=>host===h||host.endsWith('.'+h));}
 catch{return false;}
}
export function validateBrowserCall(op){
 const {tool,args,sessionTarget}=op;
 if(tool==='browser_inspect'){
  if(!['tabs','page','ax','screenshot'].includes(args.view))throw Error('Unknown browser inspection view.');
 }else if(tool==='browser_run'){
  if(!Array.isArray(args.actions)||!args.actions.length||args.actions.length>8)throw Error('Use 1 to 8 browser actions.');
  for(const action of args.actions){
   if(!['new_tab','navigate','click','type','key','scroll','wait'].includes(action.type))throw Error('Unsupported browser action.');
   if(['new_tab','navigate'].includes(action.type)){
    const url=new URL(action.url);if(!['http:','https:'].includes(url.protocol)||personalSendSurface(url.href))throw Error('This browser destination needs the personal-message approval route.');
   }
   if(action.type==='click'&&!(Number.isFinite(action.x)&&Number.isFinite(action.y)||Number.isInteger(action.backendNodeId)))throw Error('Click needs coordinates or an accessibility node.');
   if(action.type==='type'&&(typeof action.text!=='string'||action.text.length>10000))throw Error('Invalid browser text.');
   if(action.type==='key'&&(typeof action.key!=='string'||action.key.length>30))throw Error('Invalid browser key.');
   if(action.type==='wait'&&(!Number.isInteger(action.ms)||action.ms<0||action.ms>3000))throw Error('Invalid wait.');
  }
  if(!sessionTarget&&args.actions[0].type!=='new_tab')throw Error('Start an unbound browser session with new_tab.');
 }else throw Error('Unsupported Browser Harness operation.');
}

function rawBrowserScript(op){
 const payload=Buffer.from(JSON.stringify({tool:op.tool,args:op.args,target:op.sessionTarget||'',grant:op.sessionGrant||{}})).toString('base64');
 return `import base64, json, time, io\nfrom PIL import Image\np=json.loads(base64.b64decode('${payload}'))\nblocked=('mail.google.com','discord.com','web.whatsapp.com','messages.google.com','outlook.live.com','outlook.office.com')\ndef safe():\n u=page_info().get('url','')\n from urllib.parse import urlparse\n h=(urlparse(u).hostname or '').lower()\n if any(h==x or h.endswith('.'+x) for x in blocked): raise RuntimeError('Personal messaging surface is not controlled through browser tools')\n if p['grant'].get('hosts') and h not in p['grant']['hosts']: raise RuntimeError('Tab is outside the session host grant')\ndef bounded_image():\n path=capture_screenshot(max_dim=960)\n im=Image.open(path).convert('RGB'); out=io.BytesIO(); im.save(out,'JPEG',quality=55,optimize=True)\n data=base64.b64encode(out.getvalue()).decode()\n return data if len(data)<280000 else None\ntry:\n if p['target']:\n  ids={t['targetId'] for t in list_tabs()}\n  if p['target'] not in ids: raise RuntimeError('Assigned tab is no longer open')\n  switch_tab(p['target'])\n if p['tool']=='browser_inspect':\n  view=p['args']['view']\n  if view=='tabs': value={'tabs':list_tabs()}\n  elif view=='page': value={'page':page_info()}\n  elif view=='ax':\n   nodes=cdp('Accessibility.getFullAXTree').get('nodes',[])\n   value={'page':page_info(),'nodes':[{'id':n.get('backendDOMNodeId'),'role':n.get('role',{}).get('value'),'name':str(n.get('name',{}).get('value',''))[:180]} for n in nodes if n.get('role',{}).get('value') and (n.get('name',{}).get('value') or n.get('role',{}).get('value') in ('textbox','button'))][:120]}\n  else: value={'page':page_info(),'image':bounded_image(),'mimeType':'image/jpeg'}\n else:\n  done=[]\n  for a in p['args']['actions']:\n   if a['type']=='new_tab':\n    if p['target']: raise RuntimeError('Session already owns a tab')\n    new_tab(a['url']); wait_for_load(); p['target']=current_tab()['targetId']\n   else:\n    safe()\n    if a['type']=='navigate': goto_url(a['url']); wait_for_load()\n    elif a['type']=='click':\n     if 'backendNodeId' in a:\n      q=cdp('DOM.getBoxModel',backendNodeId=a['backendNodeId'])['model']['content']; x=sum(q[0::2])/4; y=sum(q[1::2])/4\n     else: x=a['x']; y=a['y']\n     click_at_xy(x,y)\n    elif a['type']=='type': type_text(a['text'])\n    elif a['type']=='key': press_key(a['key'])\n    elif a['type']=='scroll': scroll(a.get('x',400),a.get('y',400),a.get('dy',-300),a.get('dx',0))\n    elif a['type']=='wait': time.sleep(a['ms']/1000)\n   done.append(a['type'])\n  value={'actionsCompleted':done,'page':page_info()}\n result={'state':'succeeded','output':value,'sessionTarget':p['target']}\nexcept Exception as e:\n result={'state':'unknown' if p['tool']=='browser_run' else 'failed','error':str(e)[:500]}\nprint('MISTY_RESULT:'+json.dumps(result,ensure_ascii=False))\n`;
}

export function browserScript(op){
 const before=" if any(h==x or h.endswith('.'+x) for x in blocked): raise RuntimeError('Personal messaging surface is not controlled through browser tools')";
 const after=" import re\n from urllib.parse import parse_qs\n parsed=urlparse(u)\n query=parse_qs(parsed.query,keep_blank_values=True)\n admin=(parsed.scheme=='https' and h=='discord.com' and not parsed.username and not parsed.password and not parsed.port and not parsed.fragment and ((not parsed.query and re.fullmatch(r'/developers/applications(?:/[0-9]{16,22}(?:/(?:information|bot|oauth2|installation))?)?/?',parsed.path)) or (parsed.path=='/oauth2/authorize' and set(query)<=set(('client_id','scope','permissions','guild_id','disable_guild_select')) and all(len(v)==1 for v in query.values()) and re.fullmatch(r'[0-9]{16,22}',query.get('client_id',[''])[0]) and query.get('scope')==['bot'] and query.get('permissions',['0'])[0] in ('0','68608') and ('guild_id' not in query or re.fullmatch(r'[0-9]{16,22}',query['guild_id'][0])))))\n if any(h==x or h.endswith('.'+x) for x in blocked) and not admin: raise RuntimeError('Personal messaging surface is not controlled through browser tools')";
 const raw=rawBrowserScript(op);
 if(!raw.includes(before))throw Error('Browser safety preimage mismatch');
 return raw.replace(before,after);
}

export async function runBrowserHarness(op,{executable=process.env.MISTY_BROWSER_HARNESS||'browser-harness.exe',timeoutMs=60000}={}){
 validateBrowserCall(op);
 const script=browserScript(op),id=randomUUID();
 return await new Promise((resolve,reject)=>{
  const child=spawn(executable,[],{windowsHide:true,env:{...process.env,BH_TAB_MARKER:'0',BH_RECORD:'0'}});
  let stdout='',stderr='';const timer=setTimeout(()=>{child.kill();reject(Error('Browser Harness timed out; inspect the operation receipt before any retry.'));},timeoutMs);
  child.stdout.on('data',part=>{stdout+=part;if(stdout.length>500000)child.kill();});
  child.stderr.on('data',part=>{stderr+=part;if(stderr.length>3000)stderr=stderr.slice(-3000);});
  child.on('error',error=>{clearTimeout(timer);reject(error);});
  child.on('close',code=>{
   clearTimeout(timer);const line=stdout.split(/\r?\n/).findLast(x=>x.startsWith('MISTY_RESULT:'));
   if(!line){reject(Error('Browser Harness returned no receipt ('+id+', exit '+code+'): '+stderr.slice(-300)));return;}
   try{resolve(JSON.parse(line.slice('MISTY_RESULT:'.length)));}catch(error){reject(error);}
  });
  child.stdin.end(script);
 });
}
