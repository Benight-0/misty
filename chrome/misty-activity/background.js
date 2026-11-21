const HOST='com.misty.laptop_activity';
let running=false;
function boundedURL(value){try{const u=new URL(value);u.username='';u.password='';u.search='';u.hash='';return u.href.slice(0,600);}catch{return '';}}
export async function captureChrome(api=chrome,now=Date.now()){
 const settings=await api.storage.local.get('profileId');let profile=settings.profileId;
 if(!profile){profile=crypto.randomUUID();await api.storage.local.set({profileId:profile});}
 const windows=(await api.windows.getAll({populate:true,windowTypes:['normal','popup']})).filter(w=>!w.incognito);
 const all=windows.flatMap(w=>(w.tabs||[]).filter(t=>!t.incognito).map(t=>({id:t.id,windowId:w.id,title:(t.title||'').slice(0,160),url:boundedURL(t.url||''),activeInWindow:!!t.active,windowFocused:!!w.focused,discarded:!!t.discarded})));
 if(all.length>150)all.sort((a,b)=>Number(b.activeInWindow)+Number(b.windowFocused)-Number(a.activeInWindow)-Number(a.windowFocused));
 const tabs=all.slice(0,150);let truncated=all.length>150;
 if(new TextEncoder().encode(JSON.stringify(tabs)).length>65000){
  tabs.sort((a,b)=>Number(b.activeInWindow)+Number(b.windowFocused)-Number(a.activeInWindow)-Number(a.windowFocused));
  while(tabs.length&&new TextEncoder().encode(JSON.stringify(tabs)).length>65000)tabs.pop();
  truncated=true;
 }
 return {profile,capturedAt:now,tabs,truncated};
}
export async function tick(api=chrome){
 if(running)return;running=true;
 try{
  const status=await api.runtime.sendNativeMessage(HOST,{op:'status'});
  if(status.paused)return;
  const sample=await captureChrome(api);await api.runtime.sendNativeMessage(HOST,{op:'sample',sample});
 }catch{/* Explicitly unavailable in the laptop collector until native delivery succeeds. */}
 finally{running=false;}
}
if(typeof chrome!=='undefined'&&chrome.alarms){
 chrome.alarms.create('misty-activity',{periodInMinutes:0.5});
 chrome.alarms.onAlarm.addListener(a=>{if(a.name==='misty-activity')tick();});
 chrome.runtime.onInstalled.addListener(()=>tick());chrome.runtime.onStartup.addListener(()=>tick());
 for(const event of [chrome.tabs.onActivated,chrome.tabs.onUpdated,chrome.tabs.onRemoved,chrome.windows.onFocusChanged])event.addListener(()=>tick());
 tick();
}
