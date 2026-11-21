import fs from 'node:fs';
export class CodexReader {
 constructor({tokenFile,url='http://127.0.0.1:8794/call'}={}){this.tokenFile=tokenFile;this.url=url;}
 async call(op,args={}){
  const response=await fetch(this.url,{method:'POST',headers:{Authorization:'Bearer '+fs.readFileSync(this.tokenFile,'utf8').trim(),'Content-Type':'application/json'},body:JSON.stringify({op,args}),signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw Error('Codex history currently unavailable.');return response.json();
 }
 definitions(){const tool=(name,description,properties)=>({type:'function',name,description,strict:true,parameters:{type:'object',properties,required:Object.keys(properties),additionalProperties:false}});return [
  tool('codex_chats','Find real laptop Codex chats by title/workspace/preview; empty query lists recent chats. Read-only; no execution.',{query:{type:'string'}}),
  tool('codex_search','Search full synced visible Codex chat history. Read hits with codex_read; check freshness/coverage.',{query:{type:'string'}}),
  tool('codex_read','Read full visible user/assistant transcript chunks; paginate nextOffset. document is codex:CHAT_ID. No hidden reasoning.',{document:{type:'string'},offset:{type:'integer'}}),
  tool('codex_status','Read laptop connectivity and latest task status. Cannot submit/approve tasks.',{})];}
 execute(name,args){if(name==='codex_chats')return this.call('chats',args);if(name==='codex_search')return this.call('knowledge_find',{query:args.query,kind:'codex'});if(name==='codex_read')return this.call('knowledge_read',args);if(name==='codex_status')return this.call('status');throw Error('Unknown Codex reader operation.');}
}

export async function pumpCodexNotices(apollo,reader){
 if(apollo.store.get('misty_notifications_paused',false))return;
 const after=apollo.store.get('codex_event_cursor',0),page=await reader.call('events',{after});
 for(const e of page.events){
  const original=String(e.text||''),limit=e.kind==='message'?900:1800,text=original.slice(0,limit)+(original.length>limit?'\n… (excerpt; ask me for details)':''),title=String(e.title||'Codex chat').replace(/[\r\n]/g,' ');
  const body=(e.kind==='message'?'Codex update':e.kind==='completed'?'Codex finished':`Codex ${e.kind}`)+' — '+title+(text?'\n\n'+text:'')+'\n\nOpen in VS Code: vscode://openai.chatgpt/local/'+e.thread_id;
  apollo.transaction(()=>{if(apollo.saveCodex)apollo.saveCodex(e,body);else apollo.notice('codex:'+e.id,body);apollo.store.set('codex_event_cursor',e.seq);});
 }
 if(page.events.length)apollo.onNotice();
}
