const $=s=>document.querySelector(s);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=n=>Number(n||0).toLocaleString();
const day=ts=>ts?new Date(ts).toLocaleDateString(undefined,{month:'short',day:'numeric'}):'—';
const date=ts=>ts?new Date(ts).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}):'—';
const state={token:'',page:'inbox',stats:{},rooms:[],room:null,offset:0,roomTotal:0,messageOffset:0,view:'',kind:'',platform:'',q:'',messageQuery:'',own:false,peopleOffset:0};
let modalVersion=0,navigationEpoch=0;
let messageRows=[],messageHasOlder=true,messageScope='',messageRendered=false;
let toastTimer,roomEpoch=0,messageEpoch=0,selectionEpoch=0,messageBusy=false,polling=false,lastInboxRevision='';
async function renderVmSync(){
 const s=await refreshStats();if(state.page!=='sync')return;
 $('#content').innerHTML=heading('Always online','Your private VM archive.','Discord, WhatsApp, and Gmail in one persistent archive.')+statStrip()+`<div class="sync-grid"><section class="card"><h2>Live connections</h2>${['discord','whatsapp'].map(platform=>`<div class="sync-detail"><span>${esc(platform)}</span><strong>${esc(s.sync?.[platform]?.state||'starting')}</strong></div>`).join('')}<p>New messages arrive through persistent connections. Discord also checks each private chat for gaps after a disconnect. WhatsApp can recover only history available to its linked device.</p><p>Selected WhatsApp G groups import past history for summaries. Live group collection and server collection are paused. Existing archived data is preserved.</p><button id="vm-sync" class="primary">Check collectors</button> <button id="vm-pair" class="secondary">Link WhatsApp</button></section><section class="card"><h2>Storage and privacy</h2><p>Your archive is stored on the VM, including complete private-chat text. It continues collecting while your laptop is off.</p><p>Eligible private-chat text is sent to OpenAI for summaries, people profiles and suggested follow-ups. Summaries use GPT-5.6 Luna, one request at a time. Completed analysis batches survive restarts.</p><p>Website access is restricted through Cloudflare Access. The VM administrator and services processing these chats can access data; this is not a zero-access encrypted archive.</p><p>Gmail is archived here. Misty can save drafts and send only after separate Google permission and an exact preview with your fresh yes.</p></section></div>`;
 $('#vm-sync').onclick=async()=>{const result=await api('sync',{});toast(result.message);};$('#vm-pair').onclick=pairVmWhatsApp;updateHistoryCard();await updateGmailCard();
}
function toast(text){$('#toast').textContent=text;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,5000);}
async function pairVmWhatsApp(){
 try{
  await api('whatsapp/pair',{});
  modal('<h2>Link WhatsApp to your VM</h2><p>On your phone, open WhatsApp → Linked devices → Link a device → Link with phone number instead.</p><p id="wa-pair-code">Preparing your code…</p><p>Use the code promptly; it expires in about two minutes. Your existing archive is preserved.</p>');
  const until=Date.now()+160000;
  async function update(){
   if(!$('#modal').open||!$('#wa-pair-code')||Date.now()>until)return;
   try{const value=await api('whatsapp/pair');$('#wa-pair-code').textContent=value.code?'Pairing code: '+value.code:'Waiting for a code or connection confirmation…';const stats=await api('stats');if(stats.sync?.whatsapp?.connected){$('#wa-pair-code').textContent='WhatsApp connected. Available history is syncing.';return;}}catch{}
   setTimeout(update,2000);
  }update();
 }catch(error){toast(error.message);}
}
async function api(path,body){const res=await fetch('/api/'+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-Archival-Token':state.token},body:JSON.stringify(body)});const data=await res.json();if(!res.ok)throw new Error(data.error);return data;}
function debounce(fn,ms=230){let t;return(...args)=>{clearTimeout(t);t=setTimeout(()=>fn(...args),ms);};}
function modal(html){++modalVersion;$('#modal-content').innerHTML=html;if(!$('#modal').open)$('#modal').showModal();}
$('#close-modal').onclick=()=>{++modalVersion;$('#modal').close();};
$('#modal').addEventListener?.('cancel',()=>{++modalVersion;});
document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-page]');if(button){if(button.classList.contains('brand')){state.platform='';state.kind='';state.q='';state.view='';}await navigate(button.dataset.page);}
});
$('#refresh').onclick=async()=>{try{await api('sync',{});toast(state.runtime==='vm'?'Checking live collectors.':'Refreshing your messaging archive.');await refreshStats();}catch(e){toast(e.message);}};
function heading(eyebrow,title,subtitle,actions=''){return `<div class="page-heading"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p class="subtitle">${subtitle}</p></div><div>${actions}</div></div>`;}
function statStrip(){const s=state.stats;return `<div class="stats-strip"><div class="stat"><small>CONVERSATIONS</small><strong>${fmt(s.rooms?.total)}</strong><em>in your archive</em></div><div class="stat"><small>MESSAGES STORED</small><strong>${fmt(s.messages?.total)}</strong><em>searchable locally</em></div><div class="stat"><small>YOUR MESSAGES</small><strong>${fmt(s.messages?.own)}</strong><em>identity verified</em></div><div class="stat"><small>CHATS YOU JOIN IN</small><strong>${fmt(s.rooms?.participated)}</strong><em>with your messages</em></div></div>`;}
function roomSummary(r){return `${r.server_name||r.platform} · ${fmt(r.message_count)} messages · ${fmt(r.own_count)} from you`+(r.history?r.history.complete?' · Lifetime history archived':r.history.error?' · Older history incomplete; retrying':' · Importing lifetime history':'');}
function historySummary(){const h=state.stats.history||{};return `<h2>Discord lifetime history</h2><p>${fmt(h.complete)} of ${fmt(h.chats)} connected DMs and group DMs fully archived.</p><p>${fmt(h.fetched)} historical messages checked.${h.errors?' '+fmt(h.errors)+' chats have a history access error; the importer will retry.':''}</p><p>Older messages import in resumable batches while live sync continues. “Fully archived” means the beginning of the history available to your Discord account was reached. Deleted messages and inaccessible conversations cannot be recovered.</p>`;}
function updateHistoryCard(){if(state.page!=='sync')return;const grid=$('.sync-grid');if(!grid)return;let card=$('#history-progress');if(!card){grid.insertAdjacentHTML('beforeend','<section class="card" id="history-progress"></section>');card=$('#history-progress');}card.innerHTML=historySummary();}
let gmailBusy=false;
async function updateGmailCard(){
  if(state.page!=='sync'||gmailBusy||!$('.sync-grid'))return;
  const status=await api('gmail');
  if(state.page!=='sync'||gmailBusy||!$('.sync-grid'))return;
  let card=$('#gmail-accounts');if(!card){$('.sync-grid').insertAdjacentHTML('beforeend','<section class="card" id="gmail-accounts"></section>');card=$('#gmail-accounts');}
  card.innerHTML=`<div class="category">EMAIL</div><h2>Gmail accounts</h2><p>${state.runtime==='vm'?status.desktopClientOnVM?'Your original Desktop OAuth authorization is being used on the VM. Reconnect through the laptop helper if Google revokes it.':'Archive Gmail on your VM, including while your laptop is off. Add each account separately. Google sign-in opens in your browser.':'Read and send mail from your Gmail accounts. Your archive stays on this laptop. Add each account separately. Google sign-in opens in your browser.'}</p><p><a href="/api/gmail/setup" target="_blank" rel="noreferrer">Step-by-step Google setup guide ↗</a></p><label class="gmail-upload">${status.desktopClientOnVM?'Original Desktop OAuth client linked from your laptop':status.configured?'OAuth client configured · replace JSON if needed':state.runtime==='vm'?'First, upload your Web application OAuth client JSON':'First, upload your Desktop app OAuth client JSON'}<input id="gmail-client-file" type="file" accept="application/json,.json" ${status.desktopClientOnVM?'disabled':''}></label>${status.configured&&!status.desktopClientOnVM?'<button class="primary" id="gmail-add">Add / reconnect Gmail account</button>':''}${status.configured?'<button class="secondary" id="gmail-sync">Check mail now</button>':''}${status.configured&&state.runtime!=='vm'?'<button class="secondary" id="gmail-compose">Compose email</button> <button class="secondary" id="gmail-send-history">Send history</button>':''}${status.authorizing?'<p class="muted">Waiting for Google sign-in. An unfinished sign-in expires after 10 minutes.</p>':''}<div class="gmail-account-list">${status.accounts.map(a=>`<div class="gmail-account"><h3>${esc(a.email)}</h3><p>${fmt(a.stored)} emails archived · ${!a.linked?'Login removed':!a.enabled?'Paused':['full','drafts'].includes(a.phase)?'Importing history · '+fmt(a.checked)+' message IDs checked':a.page_token?'Catching up':'History scanned; watching for updates'}</p><p class="muted">${state.runtime==='vm'?a.canDraft?'Misty can save Gmail drafts and send after your exact preview and fresh yes':a.canSend?'Misty can send after your exact preview and fresh yes':'Read-only archive · reconnect with Gmail compose permission to draft or send':a.canSend?"Sending enabled":"Receive-only connection · reconnect this account to enable sending."}</p><small>Last successful page: ${date(a.last_sync)}</small>${a.error?`<p class="warning">${esc(a.error)}</p>`:''}<div class="actions">${a.linked?`<button class="text-button" data-gmail-id="${esc(a.id)}" data-gmail-action="${a.enabled?'pause':'resume'}">${a.enabled?'Pause':'Resume'}</button><button class="text-button" data-gmail-id="${esc(a.id)}" data-gmail-action="rescan">Rescan history</button><button class="text-button" data-gmail-id="${esc(a.id)}" data-gmail-action="disconnect">Remove local login</button>`:status.desktopClientOnVM?'<span class="muted">Reconnect through the laptop helper.</span>':'<span class="muted">Use Add Gmail account to reconnect.</span>'}</div></div>`).join('')}</div>${status.attachments?`<p class="muted">${fmt(status.attachments.stored)} attachment files stored · ${fmt(Math.round(status.attachments.bytes/1048576))} MB · ${fmt(status.attachments.pending)} pending backfill${status.attachments.unavailable?` ? ${fmt(status.attachments.unavailable)} unavailable from Gmail`:``}</p>`:""}<p class="muted">Includes inbox, sent, archived, Drafts, Spam and Trash. Attachment files are stored and downloadable. Previously archived emails remain here if deleted in Gmail.</p><p class="muted">Gmail threads start excluded from personality analysis. Enable individual threads in Conversation settings. Removing a local login preserves the archive; revoke Google's grant separately in your Google Account if desired.</p>`;
  const perform=async fn=>{gmailBusy=true;try{await fn();}catch(e){toast(e.message);}finally{gmailBusy=false;await updateGmailCard();}};
  $('#gmail-client-file').onchange=event=>{const file=event.target.files[0];if(!file)return;perform(async()=>{if(file.size>30000)throw new Error(`Choose the small ${state.runtime==='vm'?'Web application':'Desktop app'} OAuth JSON file.`);await api('gmail/client',{client:JSON.parse(await file.text())});toast('OAuth client stored locally. You can now add your Gmail accounts.');});};
  if($('#gmail-add'))$('#gmail-add').onclick=()=>perform(async()=>{const result=await api('gmail/authorize',{});modal(`<h2>Sign in with Google</h2><p>Choose the Gmail account to archive and approve ${state.runtime==='vm'?'reading and managing drafts/sending':'reading and sending'} access. Your password goes to Google.</p><p><a class="primary" href="${esc(result.url)}" target="_blank" rel="noreferrer">Continue to Google ↗</a></p><p class="muted">After Google confirms the connection, close its tab and this dialog. The import starts automatically.</p>`);});
  if($('#gmail-compose'))$('#gmail-compose').onclick=()=>composeEmail();
  if($('#gmail-send-history'))$('#gmail-send-history').onclick=showSendHistory;
  if($('#gmail-sync'))$('#gmail-sync').onclick=()=>perform(async()=>{await api('gmail/sync',{});toast('Gmail update requested.');});
  for(const button of card.querySelectorAll('[data-gmail-action]'))button.onclick=()=>perform(async()=>{await api('gmail/account',{id:button.dataset.gmailId,action:button.dataset.gmailAction});toast('Gmail connection updated. Existing mail stays in your archive.');});
}
async function refreshStats(){const s=await api('stats');state.stats=s;const status=$('#live-status');status.className='status'+(!s.sync?.ok?' error':'');status.textContent=s.syncing?'↻ Updating archive':s.sync?.ok?'● Local sync active':'● Stack unavailable';if(s.history?.chats&&s.history.complete<s.history.chats)status.textContent+=` · Lifetime DMs ${fmt(s.history.complete)}/${fmt(s.history.chats)}`;status.title=s.sync?.ok?'Last snapshot: '+date(s.sync.at):s.sync?.error || 'Waiting for first snapshot';if(state.runtime==='vm'){status.textContent=s.sync?.ok?'Live collectors connected':'Collectors reconnecting';status.title='Discord: '+(s.sync?.discord?.state||'starting')+'; WhatsApp: '+(s.sync?.whatsapp?.state||'starting');}updateHistoryCard();updateGmailCard().catch(()=>{});return s;}
async function navigate(page){
 const epoch=++navigationEpoch;state.page=page;
 if(typeof syncSettingsShell==='function')syncSettingsShell(page);
 if(document.body)document.body.dataset.screen=page;
 for(const b of document.querySelectorAll('[data-page]'))b.classList.toggle('active',b.dataset.page===page);
 $('#breadcrumb').textContent={inbox:'Conversations',briefings:'Summaries & events',profile:'My profile & interests',people:'People & identities',sync:'Connections & storage'}[page]||'Misty';
 $('#content').innerHTML=loadingMarkup('Loading '+$('#breadcrumb').textContent.toLowerCase()+'…');
 try{await refreshStats();if(epoch!==navigationEpoch)return;await({inbox:renderInbox,briefings:renderBriefings,profile:renderProfile,people:renderPeople,sync:renderSync}[page])();if(epoch!==navigationEpoch)return;updateHistoryCard();await updateGmailCard();}
 catch(error){if(epoch!==navigationEpoch)return;$('#content').innerHTML='<div class="empty"><strong>Could not load this view</strong><p>'+esc(error.message)+'</p><button class="secondary" id="retry-view">Try again</button></div>';$('#retry-view').onclick=()=>navigate(page);}
}
function loadingMarkup(label='Loading…'){return `<div class="loading-state" role="status"><span class="spinner" aria-hidden="true"></span>${esc(label)}</div>`;}
function platformBadge(platform){const label={discord:'DC',whatsapp:'WA',gmail:'MAIL',telegram:'TG',instagram:'IG',slack:'SL'}[platform]||String(platform||'ARCHIVE').toUpperCase();return `<span class="platform-badge ${esc(platform)}" title="${esc(platform)}" aria-label="${esc(platform)}">${esc(label)}</span>`;}
function avatarMarkup(name,platform='',extra=''){return `<span class="avatar ${esc(platform)} ${extra}" aria-hidden="true">${esc(String(name||'?').trim().slice(0,1).toUpperCase())}</span>`;}

async function renderInbox(){
 $('#content').innerHTML=`<section class="inbox"><div class="conversation-pane"><div class="pane-title"><strong>Misty</strong><button class="icon-button" id="search-archive" title="Search entire archive" aria-label="Search entire archive">⌕</button></div><div class="pane-controls"><input id="room-search" type="search" aria-label="Find a conversation" placeholder="Find a conversation" value="${esc(state.q)}"><div class="filters"><select id="platform" aria-label="Platform"><option value="">All platforms</option><option value="discord">Discord</option><option value="whatsapp">WhatsApp</option><option value="instagram">Instagram</option><option value="telegram">Telegram</option><option value="gmail">Gmail</option></select><select id="kind" aria-label="Conversation type"><option value="">All chats</option><option value="dm">Direct messages</option><option value="groups">Groups & channels</option><option value="email">Email threads</option></select></div><div class="tabs"><button class="tab" data-view="">All</button><button class="tab" data-view="followed">Following</button><button class="tab" data-view="participated">With me</button><button class="tab" data-view="disconnected">Paused</button></div></div><div class="list-label"><span>RECENT CONVERSATIONS</span><span id="room-count"></span></div><div class="room-list" id="room-list">${loadingMarkup('Loading chats…')}</div><button class="load" id="more-rooms">Load more conversations</button><div class="source-actions">${state.runtime==='vm'?'':'<button class="text-button" id="compose-email">Compose email</button>'}<button class="text-button" id="connect">＋ Connect a chat</button></div><div class="user-dock"><button data-page="profile" class="user-profile-button" aria-label="Open my profile and settings">${avatarMarkup('Owner','owner')}<span><strong>Owner</strong><small>My profile & interests</small></span><span class="online-dot"></span></button><button data-page="sync" class="icon-button" title="Connections and storage" aria-label="Connections and storage">⚙</button></div></div><div class="detail" id="detail"><div class="empty"><div class="empty-icon">@</div><h2>Your conversations live here.</h2><p>Choose a chat to read its history, explore people, and see what matters.</p><div class="platform-legend">${platformBadge('discord')} Discord ${platformBadge('whatsapp')} WhatsApp ${platformBadge('gmail')} Gmail</div></div></div></section>`;
 $('#platform').value=state.platform;$('#kind').value=state.kind;
 $('#room-search').oninput=debounce(()=>{state.q=$('#room-search').value;loadRooms().catch(e=>toast(e.message));});
 $('#platform').onchange=()=>{state.platform=$('#platform').value;loadRooms().catch(e=>toast(e.message));};
 $('#kind').onchange=()=>{state.kind=$('#kind').value;loadRooms().catch(e=>toast(e.message));};
 for(const b of document.querySelectorAll('[data-view]')){b.classList.toggle('active',b.dataset.view===state.view);b.onclick=()=>{state.view=b.dataset.view;for(const a of document.querySelectorAll('[data-view]'))a.classList.toggle('active',a===b);loadRooms().catch(e=>toast(e.message));};}
 if($('#compose-email'))$('#compose-email').onclick=()=>composeEmail();$('#more-rooms').onclick=()=>loadRooms(true).catch(e=>toast(e.message));$('#connect').onclick=connectModal;$('#search-archive').onclick=archiveSearch;
  if(state.runtime==='vm'){$('#connect').hidden=true;}
 await loadRooms();if(state.room)await selectRoom(state.room.id);
}

async function loadRooms(more=false,refresh=false){
  const epoch=++roomEpoch;const offset=more?state.rooms.length:0;
  const count=refresh?Math.max(60,state.rooms.length):60;
  const pages=await Promise.all(Array.from({length:Math.ceil(count/200)},(_,i)=>api('rooms?'+new URLSearchParams({q:state.q,kind:state.kind,platform:state.platform,view:state.view,offset:offset+i*200,limit:Math.min(200,count-i*200)}))));
  const result={total:pages[0].total,rows:pages.flatMap(p=>p.rows)};
  if(epoch!==roomEpoch||state.page!=='inbox')return;
  const scroll=$('#room-list').scrollTop;
  state.rooms=more?[...state.rooms,...result.rows]:result.rows;state.roomTotal=result.total;
  $('#room-list').innerHTML=state.rooms.map(room=>`<button class="room-row ${room.id===state.room?.id?'active':''}" data-room="${esc(room.id)}" aria-label="${esc(room.alias||room.name)} · ${esc(room.platform)}">${avatarMarkup(room.alias||room.name,room.platform)}<span class="room-info"><span class="room-name"><strong>${esc(room.alias||room.name)}</strong>${platformBadge(room.platform)}</span><small>${room.kind==='group'?'Group DM · ':room.kind==='channel'?'# ':''}${room.followed?'★ ':''}${esc(room.last_preview||'No messages imported yet')}</small>${!room.connected||!room.tracked?'<span class="count-label">Collection paused</span>':''}</span><span class="room-date">${day(room.last_ts)}</span></button>`).join('')||'<div class="empty"><strong>No matching conversations.</strong><p>Try another filter.</p></div>';
  const countLabel=$('#room-count');if(countLabel)countLabel.textContent=fmt(result.total);
  for(const b of document.querySelectorAll('[data-room]'))b.onclick=()=>selectRoom(b.dataset.room).catch(e=>toast(e.message));
  $('#more-rooms').hidden=state.rooms.length>=result.total;$('#more-rooms').textContent=`Load more · ${fmt(state.rooms.length)} of ${fmt(result.total)}`;
  if(refresh)$('#room-list').scrollTop=scroll;
}
async function selectRoom(id){
  const epoch=++selectionEpoch;++messageEpoch;messageBusy=false;messageScope='';messageRows=[];messageRendered=false;
  $('#detail').innerHTML=loadingMarkup('Opening conversation…');
  let result;try{result=await api('room?'+new URLSearchParams({id,messages:'true'}));}catch(error){if(epoch===selectionEpoch&&state.page==='inbox'){$('#detail').innerHTML='<div class="empty"><strong>Could not open this chat</strong><p>'+esc(error.message)+'</p><button id="retry-room" class="secondary">Try again</button></div>';$('#retry-room').onclick=()=>selectRoom(id);}return;}
  if(epoch!==selectionEpoch||state.page!=='inbox')return;if(!result.room)return toast('Conversation unavailable.');
  state.room=result.room;state.fit=result.fit;state.messageOffset=0;state.messageQuery='';state.own=false;
  const r=state.room;$('#detail').innerHTML=`<div class="detail-header"><div class="detail-title"><div class="chat-heading"><button id="back-chats" class="icon-button mobile-back" aria-label="Back to conversations">‹</button>${avatarMarkup(r.alias||r.name,r.platform)}<div><h2>${esc(r.alias||r.name)} ${platformBadge(r.platform)}</h2><small>${esc(roomSummary(r))}</small></div></div><div class="chat-header-actions">${((r.platform==='discord'&&['dm','group'].includes(r.kind))||(r.platform==='whatsapp'&&(r.kind==='dm'||r.groupPolicy?.treatment==='G')))?'<button class="secondary" id="open-chat-briefing">Summary</button> ':''}<button class="follow-button ${r.followed?'on':''}" id="follow" title="Follow conversation">${r.followed?'★':'☆'}</button><button class="icon-button" id="toggle-members" title="Toggle people panel" aria-label="Toggle people panel" aria-expanded="true">♧</button><button class="icon-button" id="settings" title="Conversation settings" aria-label="Conversation settings">⚙</button></div></div><div class="detail-tools"><span class="message-order">LATEST AT BOTTOM</span><input id="message-search" type="search" placeholder="Search this conversation" aria-label="Search this conversation"><label><input type="checkbox" id="own-only"> Only me</label></div></div><div class="chat-body"><div class="message-column"><div class="messages" id="messages" tabindex="0" aria-label="Messages, oldest to newest">${loadingMarkup('Loading messages…')}</div><section id="chat-composer" class="chat-composer"></section><div class="conversation-footer"><span>${r.encrypted?'Encrypted events may be unavailable':(state.runtime==='vm'?'VM archive':'Local archive')+' · '+(r.connected&&r.tracked?'Live collection':'Collection paused')}</span><button class="text-button" id="jump-latest">Jump to latest ↓</button></div></div><aside class="members-pane" id="members-pane" aria-label="People in this chat">${loadingMarkup('Loading people…')}</aside></div>`;
  $('.inbox').classList.add('chat-open');$('#back-chats').onclick=()=>$('.inbox').classList.remove('chat-open');
  $('#toggle-members').onclick=()=>{const panel=$('#members-pane');panel.hidden=!panel.hidden;$('#toggle-members').setAttribute('aria-expanded',String(!panel.hidden));};
  if(typeof matchMedia==='function'&&matchMedia('(max-width:1200px)').matches){$('#members-pane').hidden=true;$('#toggle-members').setAttribute('aria-expanded','false');}
  $('#follow').onclick=async()=>{await api('room',{id:r.id,patch:{followed:!state.room.followed}});await selectRoom(r.id);await loadRooms();};
  $('#settings').onclick=roomSettings;
  if($('#open-chat-briefing'))$('#open-chat-briefing').onclick=()=>showChatBriefing(r.id);
  $('#message-search').oninput=debounce(()=>{state.messageQuery=$('#message-search').value;loadMessages();});
  $('#own-only').onchange=()=>{state.own=$('#own-only').checked;loadMessages();};$('#jump-latest').onclick=()=>{const pane=$('#messages');pane.scrollTop=pane.scrollHeight;};
  for(const b of document.querySelectorAll('[data-room]'))b.classList.toggle('active',b.dataset.room===id);
  await loadMessages(false,false,result.messages);
  if(epoch!==selectionEpoch||state.page!=='inbox')return;
  bindMessageScroll();
  if(typeof loadChatMembers==='function')loadChatMembers(id).catch(e=>toast(e.message));
  if(epoch===selectionEpoch&&typeof renderChatComposer==='function'){
    const pane=$('#messages'),scroll=pane.scrollTop,pinned=pane.scrollHeight-scroll-pane.clientHeight<70;
    await renderChatComposer(r);
    if(epoch===selectionEpoch&&pinned&&Math.abs(pane.scrollTop-scroll)<2)pane.scrollTop=pane.scrollHeight;
  }
}
function gmailAttachments(m){let items=[],keys=[];try{items=JSON.parse(m.attachments_json||'[]');keys=JSON.parse(m.stored_attachment_keys||'[]');}catch{}return items.length?`<div class="message-attachments">${items.map(a=>keys.includes(a.key)?`<a href="/api/gmail/attachment?${new URLSearchParams({id:m.id,key:a.key})}" download>${esc(a.name)} · ${fmt(a.size)} bytes ↓</a>`:`<span>${esc(a.name)} · archiving file</span>`).join('')}</div>`:'';}
function messageMarkup(m,source=false){const person=m.sender?`data-open-person="${esc(m.sender)}" data-person-room="${esc(m.room_id||'')}"`:'';return `<article data-message="${esc(m.id)}" class="message ${m.is_me?'me':''}"><button class="message-avatar" ${person} aria-label="Open profile for ${esc(m.author||'Unknown author')}">${avatarMarkup(m.author,m.is_me?'owner':m.platform)}</button><div class="message-content"><div class="message-head"><button class="author-name" ${person}><b>${m.is_me?'You · ':''}${esc(m.author)}</b></button>${m.is_me?'<span class="self-label">YOU</span>':''}<time datetime="${m.ts?new Date(m.ts).toISOString():''}">${date(m.ts)}${m.edited?' · edited':''}</time></div><div class="message-body">${esc(m.body)}</div>${m.platform==='gmail'?gmailAttachments(m):''}${m.platform==='gmail'&&state.runtime!=='vm'?`<button class="message-link" data-mail-reply="${esc(m.id)}">Reply</button>`:''}${source?`<button class="message-link" data-evidence="${esc(m.id)}">${esc(m.conversation||'View context')} ↗</button>`:''}</div></article>`;}

function bindEvidence(){for(const b of document.querySelectorAll('[data-evidence]'))b.onclick=()=>showEvidence(b.dataset.evidence);}
function messageViewKey(){return JSON.stringify([state.room?.id,state.messageQuery,state.own]);}
function messageAnchor(pane){const top=pane.getBoundingClientRect().top;const element=Array.from(pane.querySelectorAll('[data-message]')).find(el=>el.getBoundingClientRect().bottom>top);return element?{id:element.dataset.message,top:element.getBoundingClientRect().top}:null;}
function restoreMessageAnchor(pane,anchor,fallback){
 const element=anchor&&Array.from(pane.querySelectorAll('[data-message]')).find(el=>el.dataset.message===anchor.id);
 if(element)pane.scrollTop+=element.getBoundingClientRect().top-anchor.top;else pane.scrollTop=Math.max(0,fallback);
}
function updateOlderControl(loading=false,failed=false){
 const button=$('#older');if(!button)return;button.hidden=!messageHasOlder;button.disabled=loading;
 button.textContent=loading?'Loading older messages…':failed?'Retry older messages ↑':'Load older messages ↑';
 button.onclick=()=>loadMessages(true);
}
function bindMessageScroll(){
 const pane=$('#messages');if(!pane)return;let previous=pane.scrollTop;
 const older=()=>{if(pane.scrollTop<180&&messageHasOlder&&!messageBusy&&state.page==='inbox')loadMessages(true);};
 pane.onscroll=()=>{const top=pane.scrollTop;if(top<previous)older();previous=top;};
 pane.addEventListener?.('wheel',event=>{if(event.deltaY<0)older();},{passive:true});
 pane.addEventListener?.('keydown',event=>{if(['ArrowUp','PageUp','Home'].includes(event.key))older();});
}
async function loadMessages(more=false,refresh=false,initialRows){
 if((more||refresh)&&messageBusy)return false;
 const key=messageViewKey();if(more&&(!messageHasOlder||messageScope!==key))return false;
 const epoch=++messageEpoch,id=state.room.id,query=state.messageQuery,own=state.own;
 const reset=!more&&!refresh;
 if(reset){messageScope=key;messageRows=[];messageHasOlder=true;messageRendered=false;}
 messageBusy=true;updateOlderControl(more);
 let failed=false;
 try{
  let rows;
  if(initialRows!==undefined)rows=initialRows;
  else if(more){
   const oldest=messageRows.at(-1);if(!oldest)return false;
   rows=await api('messages?'+new URLSearchParams({room:id,q:query,own,limit:80,before:oldest.ts,before_id:oldest.id}));
  }else{
   const count=refresh?Math.max(80,messageRows.length):80;
   let size=Math.min(200,count),page=await api('messages?'+new URLSearchParams({room:id,q:query,own,limit:size}));rows=[...page];
   while(rows.length<count&&page.length===size){
    if(epoch!==messageEpoch||key!==messageViewKey()||state.page!=='inbox')return;
    const oldest=rows.at(-1);size=Math.min(200,count-rows.length);
    page=await api('messages?'+new URLSearchParams({room:id,q:query,own,limit:size,before:oldest.ts,before_id:oldest.id}));
    if(page.length&&(page.at(-1).ts>oldest.ts||(page.at(-1).ts===oldest.ts&&page.at(-1).id>=oldest.id)))throw new Error('History pagination did not advance. Please retry.');
    rows.push(...page);
   }
   // After a long disconnect, fill the gap before joining the new tail to loaded history.
   const previousNewest=messageRows[0];
   while(refresh&&previousNewest&&rows.length>=count&&!rows.some(m=>m.id===previousNewest.id)&&rows.at(-1).ts>=previousNewest.ts){
    if(epoch!==messageEpoch||key!==messageViewKey()||state.page!=='inbox')return;
    const oldest=rows.at(-1),page=await api('messages?'+new URLSearchParams({room:id,q:query,own,limit:200,before:oldest.ts,before_id:oldest.id}));
    if(page.length&&(page.at(-1).ts>oldest.ts||(page.at(-1).ts===oldest.ts&&page.at(-1).id>=oldest.id)))throw new Error('History pagination did not advance. Please retry.');
    rows.push(...page);if(page.length<200)break;
   }
  }
  if(epoch!==messageEpoch||state.room?.id!==id||state.page!=='inbox'||key!==messageViewKey())return;
  const pane=$('#messages'),scroll=pane.scrollTop,height=pane.scrollHeight||0;
  const nearBottom=height-scroll-(pane.clientHeight||0)<70,anchor=messageAnchor(pane);
  if(more){
   const existing=new Set(messageRows.map(m=>m.id));messageRows.push(...rows.filter(m=>!existing.has(m.id)));messageHasOlder=rows.length===80;
  }else if(refresh&&messageRendered&&rows.length){
   // Retain history already loaded above a shifted latest window.
   const ids=new Set(rows.map(m=>m.id)),oldest=rows.at(-1);
   messageRows=[...rows,...messageRows.filter(m=>!ids.has(m.id)&&(m.ts<oldest.ts||(m.ts===oldest.ts&&m.id<oldest.id)))];
  }else {messageRows=rows;messageHasOlder=rows.length===80;}
  state.messageOffset=Math.max(0,messageRows.length-80);
  const markup='<div class="history-edge"><button class="text-button" id="older">Load older messages ↑</button><span class="muted">'+(messageHasOlder?'Scroll up for earlier messages':'Beginning of available history')+'</span></div>'+
   [...messageRows].reverse().map(m=>messageMarkup(m)).join('');
  const empty='<div class="empty"><strong>No messages here yet.</strong><p>Try another search, or refresh the archive.</p></div>';
  const html=messageRows.length?markup:empty;
  if(pane.innerHTML!==html)pane.innerHTML=html;
  if(reset||(!more&&nearBottom))pane.scrollTop=Math.max(0,(pane.scrollHeight||0)-(pane.clientHeight||0));
  else restoreMessageAnchor(pane,anchor,more?scroll+(pane.scrollHeight||0)-height:scroll);
  messageRendered=true;
  return true;
 }catch(error){
  failed=true;if(epoch!==messageEpoch||state.room?.id!==id||state.page!=='inbox'||key!==messageViewKey())return;
  if(more||refresh)toast(error.message);else{$('#messages').innerHTML='<div class="empty"><strong>Messages could not load</strong><p>'+esc(error.message)+'</p><button class="secondary" id="retry-messages">Try again</button></div>';$('#retry-messages').onclick=()=>loadMessages();}
 }finally{if(epoch===messageEpoch){messageBusy=false;updateOlderControl(false,failed);}}
}

async function pollInbox(){
  if(polling)return;polling=true;
  try{
    const s=await refreshStats(),revision=JSON.stringify([s.cursor,s.messages,s.rooms,s.historyRevision,s.gmailRevision]);
    if(state.page==='inbox'&&revision!==lastInboxRevision){
      const id=state.room?.id,selected=selectionEpoch;
      await loadRooms(false,true);
      if(state.page!=='inbox')return;
      if(id&&selected===selectionEpoch&&$('#messages')){
        const result=await api('room?'+new URLSearchParams({id}));
        if(selected!==selectionEpoch||state.room?.id!==id||state.page!=='inbox')return;
        if(result.room){state.room=result.room;state.fit=result.fit;$('#detail .detail-title small').textContent=roomSummary(state.room);if(await loadMessages(false,true)===false)return;}
      }
      lastInboxRevision=revision;
    }
    if(typeof refreshChatComposer==='function')await refreshChatComposer();
    if(typeof refreshBriefingsPage==='function'&&state.page==='briefings')await refreshBriefingsPage();
    if(typeof refreshBriefingDialog==='function')await refreshBriefingDialog();
  }catch(e){$('#live-status').textContent='● App disconnected';}finally{polling=false;}
}
async function roomSettings(){const r=state.room;modal(loadingMarkup('Loading conversation preferences…'));const version=modalVersion;
try{const result=await api('room?'+new URLSearchParams({id:r.id,fit:'true'}));if(version!==modalVersion||!$('#modal').open)return;state.fit=result.fit||{label:'Conversation preferences',explanation:'',matches:[]};modal(`<h2>Make this thread yours</h2><p class="muted">${esc(r.name)} · ${esc(r.platform)}</p><div class="settings"><h3>Conversation name</h3><input id="room-alias" type="text" aria-label="Conversation nickname" placeholder="A name that makes sense to you" value="${esc(r.alias)}">${[['connected','Connect to this app','Import this conversation into Misty. For bridged chats, the upstream bridge may remain active in Element.'],['tracked','Archive new messages','Pause future imports without deleting the history already here.'],['followed','Follow this conversation','Show this chat in the Following filter. Chats stay sorted by latest activity.'],['include_profile','Include in your profile','Use your messages here as evidence for interests and preferences.']].map(([key,title,note])=>`<label><span>${title}<small>${note}</small></span><input type="checkbox" data-setting="${key}" ${r[key]?'checked':''}></label>`).join('')}<p class="muted">Disconnecting or pausing preserves the existing archive. Reconnecting runs a history rescan.</p></div><div class="fit-box"><strong>${esc(state.fit.label)}</strong><p>${esc(state.fit.explanation)}</p><p>${esc(state.fit.matches.join(' · '))}</p></div><p class="muted">Local room ID: ${esc(r.id)}</p><button class="primary" id="save-room">Save preferences</button>`);$('#save-room').onclick=async()=>{try{const patch={alias:$('#room-alias').value};for(const input of document.querySelectorAll('[data-setting]'))patch[input.dataset.setting]=input.checked;await api('room',{id:r.id,patch});await api('profile/refresh',{});$('#modal').close();await selectRoom(r.id);await loadRooms();toast('Conversation preferences saved.');}catch(e){toast(e.message);}};}catch(error){if(version===modalVersion&&$('#modal').open)modal('<h2>Could not load preferences</h2><p>'+esc(error.message)+'</p>');}}
function connectModal(){modal(`<h2>Connect a conversation</h2><p class="muted">Add an existing local bridge room, or request a Discord channel portal. Reconnect archived chats from their settings.</p><form id="connect-form"><label>Source<select id="connect-platform"><option value="matrix">Existing bridged room (any platform)</option><option value="discord">Discord channel</option></select></label><label>Room ID or channel link<input id="connect-target" required placeholder="!room:localhost or a Discord channel link"></label><p class="muted">Link new accounts in Element first. A bridge invitation may need to be accepted there. This action does not send a message to the contact.</p><button class="primary">Connect to archive</button></form><hr><p>To link a Gmail account, open Sync & storage → Gmail accounts.</p><button class="secondary" id="connect-gmail">Open Gmail connections</button>`);$('#connect-gmail').onclick=()=>{$('#modal').close();navigate('sync');};$('#connect-form').onsubmit=async e=>{e.preventDefault();try{const result=await api('connect',{platform:$('#connect-platform').value,target:$('#connect-target').value});$('#modal').close();toast(result.message||'Room joined. Its available history is being imported.');}catch(e){toast(e.message);}};}
function archiveSearch(){modal('<h2>Search your archive</h2><p class="muted">Search all stored conversations. Results are newest first.</p><form id="global-search-form"><input type="search" id="global-query" required placeholder="A topic, idea, or phrase…" aria-label="Search all messages"><label><input id="global-own" type="checkbox"> Only my messages</label><button class="primary">Search</button></form><div id="global-results"></div>');$('#global-search-form').onsubmit=async e=>{e.preventDefault();const rows=await api('messages?'+new URLSearchParams({q:$('#global-query').value,own:$('#global-own').checked,limit:100}));$('#global-results').innerHTML='<p class="muted">'+fmt(rows.length)+' results'+(rows.length===100?' · showing first 100':'')+'</p>'+rows.map(m=>messageMarkup(m,true)).join('');bindEvidence();};}
async function showEvidence(id){modal(loadingMarkup('Loading original message…'));const version=modalVersion;try{const data=await api('evidence?'+new URLSearchParams({id}));if(version!==modalVersion||!$('#modal').open)return;if(!data){modal('<h2>Source unavailable</h2><p>This message is no longer in your archive.</p>');return;}modal(`<h2>Original message</h2><p class="muted">${esc(data.event.conversation)}${data.event.server_name?' · '+esc(data.event.server_name):''} · ${esc(data.event.platform)}</p>${messageMarkup(data.event)}<h3>Nearby context</h3>${data.context.filter(m=>m.id!==data.event.id).map(m=>messageMarkup(m)).join('')}<p class="muted">Source message: ${esc(id)}</p>`);}catch(error){if(version===modalVersion&&$('#modal').open)modal('<h2>Could not load source</h2><p>'+esc(error.message)+'</p>');}}
async function renderProfile(){const p=await api('profile');if(state.page!=='profile')return;const curated=p.findings.filter(f=>f.source!=='local-topic-scan');$('#content').innerHTML=heading('A portrait, with receipts','The things that make you, you.','Interests, working style, and preferences drawn from your own conversations.','<a class="secondary" href="/api/export" download>Export profile ↓</a> <button class="primary" id="profile-refresh">↻ Update profile</button>')+`<div class="profile-hero"><div><div class="eyebrow">YOUR CONVERSATION PORTRAIT</div><h2>Your interests, habits, and ways of connecting.</h2><p>${esc(p.note)}</p><p>${fmt(p.coverage.messages)} available messages by you · ${fmt(p.coverage.conversations)} conversations · ${day(p.coverage.first)} ${p.coverage.first?new Date(p.coverage.first).getFullYear():''} – ${day(p.coverage.last)} ${p.coverage.last?new Date(p.coverage.last).getFullYear():''}</p><p>Corpus searched: ${fmt(p.coverage.review.scannedMessages||p.coverage.review.messages||0)} own-message entries ? ${fmt(p.coverage.review.reviewedExcerpts||p.coverage.review.messages||0)} selected excerpts examined across ${fmt(p.coverage.review.conversations||0)} conversations.</p><details class="review-method"><summary>Review method and limits</summary><p>${esc(p.coverage.review.method||"Review of an available-history snapshot.")}</p><p>Reviewed ${esc(p.coverage.review.reviewedAt||"earlier")}. New messages update topic counts; detailed interpretations require another review.</p></details></div><div><div class="profile-number">${fmt(curated.length)}</div><span class="muted">reviewable findings</span></div></div><div class="section-label">TOPICS YOU DISCUSS · mentions are not endorsements</div><div class="topic-chips">${p.topics.map(t=>`<span class="topic-chip">${esc(t.title)}<b>${fmt(t.count)}</b></span>`).join('')}</div><div class="section-label">INTERPRETATIONS & EXPLICIT PREFERENCES · confirm what fits, edit what doesn’t</div><div class="page-tools"><label>Show findings <select id="profile-category"><option value="">All areas</option>${[...new Set(curated.map(f=>f.category))].map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('')}</select></label></div><div class="grid profile-grid">${curated.map(f=>`<article class="card finding" data-profile-category="${esc(f.category)}"><div class="category">${esc(f.category)}</div><h3>${esc(f.title)}</h3><span class="badge ${f.status==='confirmed'?'confirmed':''}">${esc(f.status==='confirmed'?'Confirmed by you':f.confidence)}</span>${f.summary.split(/\n\s*\n/).map(text=>`<p>${esc(text)}</p>`).join('')}<div class="actions"><button class="text-button" data-sources="${esc(f.id)}">${f.evidence_count} source messages ↗</button><button class="text-button" data-confirm="${esc(f.id)}">${f.status==='confirmed'?'Unconfirm':'Confirm'}</button><button class="text-button" data-edit="${esc(f.id)}">Edit</button><button class="text-button" data-dismiss="${esc(f.id)}">Dismiss</button></div></article>`).join('')||'<div class="card">Your profile review is being prepared. Topic counts above are already available.</div>'}</div><p class="muted">No personality test scores or clinical labels are inferred. Forwarded material, pasted notes, and jokes do not establish personal beliefs.</p>`;
  const category=$('#profile-category');category.value=state.profileCategory||'';category.onchange=()=>{state.profileCategory=category.value;for(const card of document.querySelectorAll('[data-profile-category]'))card.hidden=!!category.value&&card.dataset.profileCategory!==category.value;};category.onchange();
  $('#profile-refresh').onclick=async()=>{await api('profile/refresh',{});await renderProfile();toast('Topic counts and saved profile refreshed.');};
  for(const b of document.querySelectorAll('[data-sources]'))b.onclick=async()=>{const f=curated.find(f=>f.id===b.dataset.sources);const rows=await Promise.all(f.evidence_ids.map(id=>api('evidence?'+new URLSearchParams({id}))));modal(`<h2>${esc(f.title)}</h2><p class="muted">Your original messages · click a conversation to see nearby context.</p>${rows.filter(Boolean).map(x=>messageMarkup(x.event,true)).join('')}`);bindEvidence();};
  for(const b of document.querySelectorAll('[data-confirm]'))b.onclick=async()=>{const f=curated.find(f=>f.id===b.dataset.confirm);await api('finding',{id:f.id,patch:{status:f.status==='confirmed'?'suggested':'confirmed'}});renderProfile();};
  for(const b of document.querySelectorAll('[data-dismiss]'))b.onclick=async()=>{await api('finding',{id:b.dataset.dismiss,patch:{status:'dismissed'}});renderProfile();};
  for(const b of document.querySelectorAll('[data-edit]'))b.onclick=()=>{const f=curated.find(f=>f.id===b.dataset.edit);modal(`<h2>Edit your profile</h2><h3>${esc(f.title)}</h3><textarea id="finding-summary" aria-label="Profile finding">${esc(f.summary)}</textarea><button class="primary" id="save-finding">Save your wording</button>`);$('#save-finding').onclick=async()=>{await api('finding',{id:f.id,patch:{summary:$('#finding-summary').value}});$('#modal').close();renderProfile();};};
}
async function renderPeople(){state.peopleOffset=0;$('#content').innerHTML=heading('Names, not just IDs','Know who’s who.','Your accounts are matched by stable IDs. Give everyone else a name you recognize.')+'<div class="page-tools"><input type="search" id="people-search" aria-label="Find a person" placeholder="Search a name or ID…"></div><div class="card"><table class="people-table"><thead><tr><th>PERSON / ACCOUNT</th><th>IDENTITY</th><th>MESSAGES</th><th></th></tr></thead><tbody id="people-rows"></tbody></table><button class="load" id="more-people">Load more people</button></div>';$('#people-search').oninput=debounce(()=>loadPeople());$('#more-people').onclick=()=>loadPeople(true);await loadPeople();}
async function loadPeople(more=false){
 const input=$('#people-search');if(!input||state.page!=='people')return;const q=input.value,epoch=++peopleEpoch,offset=more?state.peopleOffset+60:0;
 const people=await api('people?'+new URLSearchParams({q,offset,limit:60}));if(epoch!==peopleEpoch||state.page!=='people'||$('#people-search').value!==q)return;
 state.peopleOffset=offset;const markup=people.map(i=>`<tr><td><button class="person-table-button" data-open-person="${esc(i.id)}">${avatarMarkup(i.alias||i.name,i.platform)}<span><strong>${esc(i.alias||i.name||i.id)}</strong><small>${esc(i.id)}</small></span></button></td><td>${platformBadge(i.platform)} ${i.is_me?'<span class="badge confirmed">You</span>':''}</td><td>${fmt(i.message_count)}</td><td><button class="text-button" data-open-person="${esc(i.id)}">View profile →</button></td></tr>`).join('');
 if(more)$('#people-rows').insertAdjacentHTML('beforeend',markup);else $('#people-rows').innerHTML=markup||'<tr><td colspan="4">No people found.</td></tr>';$('#more-people').hidden=people.length<60;
}
let peopleEpoch=0;

async function renderSync(){if(state.runtime==='vm')return renderVmSync();const s=await refreshStats();if(state.page!=='sync')return;$('#content').innerHTML=heading('Quietly keeping up','A local home for your history.','Durable storage, incremental updates, and a clear view of what has synced.')+statStrip()+`<div class="sync-grid"><section class="card"><h2>Archive sync</h2><p>One initial snapshot, then only new events. Your checkpoint survives app restarts. Search reads the local archive immediately.</p>${[['Status',s.syncing?'Updating':s.sync?.ok?'Connected to local stack':'Stack unavailable'],['Last snapshot',date(s.sync?.at)],['Last import duration',fmt(s.sync?.durationMs)+' ms'],['Durable stream checkpoint',fmt(s.cursor)],['Source message events',fmt(s.sourceMessageEvents)],['Stored archive messages',fmt(s.messages?.total)]].map(([a,b])=>`<div class="sync-detail"><span>${a}</span><strong>${esc(b)}</strong></div>`).join('')}${s.sync?.error?`<p class="warning">${esc(s.sync.error)}</p>`:''}<button class="primary" id="sync-now">Sync now</button><button class="secondary" id="rescan">Rescan available history</button><p class="muted">Source totals include management rooms, edits, and messages outside currently joined bridged rooms. These are not all stored as separate chat messages.</p></section><section class="card"><h2>Where your data lives</h2><p><strong>data/app/archive.sqlite</strong><br>Messages, aliases, conversation preferences, search index, and profile findings.</p><p><strong>data/app/reviewed-profile.json</strong><br>The chat review and its source references.</p><h3>While your laptop is off</h3><p>The archive stays on disk. Docker and Misty must be running for bridged chats to arrive here. Gmail requires Misty and an internet connection; it does not require Docker. After startup, this app catches up on what the bridges have fetched.</p><p>Discord channel backfill remains 20 messages. An upstream catch-up limit can leave gaps after a long shutdown; an archive rescan cannot retrieve messages the bridge never imported.</p><h3>Privacy boundaries</h3><p>The app listens on this computer only. Private chat briefings use your local Ollama model; no chat data is sent to an external AI service. Discord and WhatsApp receive bridge connections; linked Gmail accounts communicate directly with Google. Files are not additionally encrypted by Misty; someone with access to this Windows account or disk may read them.</p></section><section class="card"><h2>Connected sources</h2>${s.platforms.map(p=>`<div class="sync-detail"><span>${esc(p.platform)}</span><strong>${fmt(p.rooms)} chats · ${fmt(p.messages)} messages</strong></div>`).join('')}<p>Instagram and Telegram appear after their accounts are linked and rooms are joined. Gmail connects directly through the account controls below. Slack is not configured in this workspace.</p></section><section class="card"><h2>Profile updates</h2><p>Topic counts refresh locally as your own messages arrive. The detailed interpretation was reviewed from an available-history snapshot; new semantic findings require another review.</p><p>Use conversation settings to exclude a chat, and the profile page to confirm, edit, dismiss, or export findings. Excluding a chat removes its source messages from the visible profile.</p></section></div>`;$('#sync-now').onclick=async()=>{await api('sync',{});toast('Local sync requested.');};$('#rescan').onclick=async()=>{await api('sync',{full:true});toast('Rescanning available history. Existing messages are deduplicated.');};}
async function openSourceLink(search=globalThis.location?.search||''){const source=new URLSearchParams(search).get('source');if(source&&source.length<=600)await showEvidence(source);}
(async()=>{try{const b=await api('bootstrap');state.token=b.token;state.stats=b.stats;state.runtime=b.runtime;await navigate('inbox');await openSourceLink();setInterval(pollInbox,5000);}catch(e){$('#content').textContent='Could not open Misty: '+e.message;}})();
