// The archive and analysis APIs remain the source of truth; UI state is ephemeral.
let membersEpoch=0,memberRows=[],memberRoom='',personView=null;
function syncSettingsShell(page){
 const dialog=$('#user-settings'),content=$('#content'),settings=['profile','people','sync'].includes(page);
 if(settings){$('#settings-slot').append(content);if(!dialog.open)dialog.showModal();}
 else {$('#workspace-main').append(content);if(dialog.open)dialog.close();}
 for(const b of document.querySelectorAll('.settings-tab'))b.classList.toggle('active',b.dataset.page===page);
}
function closeUserSettings(){if($('#modal').open){++modalVersion;$('#modal').close();}navigate('inbox');}
$('#settings-close').onclick=closeUserSettings;$('#settings-return').onclick=closeUserSettings;
$('#user-settings').addEventListener('cancel',event=>{event.preventDefault();closeUserSettings();});
document.addEventListener('click',event=>{
 const platform=event.target.closest('[data-platform-filter]');
 if(platform){state.platform=platform.dataset.platformFilter;state.q='';state.view='';state.kind='';state.room=null;navigate('inbox');}
 const person=event.target.closest('[data-open-person]');
 if(person)showPersonProfile(person.dataset.openPerson,person.dataset.personRoom||'');
});

async function loadChatMembers(id,more=false){
 const epoch=++membersEpoch,offset=more&&memberRoom===id?memberRows.length:0;
 try{
  const data=await api('room/people?'+new URLSearchParams({id,offset,limit:50}));
  if(epoch!==membersEpoch||state.page!=='inbox'||state.room?.id!==id||!$('#members-pane'))return;
  memberRows=more?[...memberRows,...data.rows]:data.rows;memberRoom=id;
  $('#members-pane').innerHTML=`<h3>PEOPLE — ${fmt(data.total)}</h3><p class="members-note">Profiles from your saved conversations</p>${memberRows.map(p=>`<button class="member-row" data-open-person="${esc(p.id)}" data-person-room="${esc(id)}">${avatarMarkup(p.alias||p.name,p.is_me?'owner':p.platform)}<span><strong>${esc(p.alias||p.name||p.id)}</strong><small>${p.is_me?'You · ':''}${fmt(p.message_count)} messages</small></span></button>`).join('')||'<p class="muted">No archived authors yet.</p>'}${memberRows.length<data.total?'<button id="more-members" class="load">Load more people</button>':''}<div class="member-help"><span class="online-dot"></span>Activity comes from your archive; this is not live presence.</div>`;
  if($('#more-members'))$('#more-members').onclick=()=>loadChatMembers(id,true);
 }catch(error){if(epoch!==membersEpoch||state.room?.id!==id||!$('#members-pane'))return;$('#members-pane').innerHTML='<p class="warning">'+esc(error.message)+'</p><button id="retry-members" class="secondary">Retry people</button>';$('#retry-members').onclick=()=>loadChatMembers(id);}
}
function personChatMarkup(chat){
 const p=chat.person,r=chat.room,h=chat.history,c=chat.coverage;
 return `<section class="person-chat-card"><header><div><h3>${esc(r.name)} ${platformBadge(r.platform)}</h3><small>${fmt(r.person_messages)} messages by this account · ${fmt(r.message_count)} in this chat</small></div><button class="text-button" data-profile-chat="${esc(r.id)}">Open chat ↗</button></header><p class="analysis-state">${chat.generatedAt?'Saved '+date(chat.generatedAt):'Analysis preparing'}${chat.stale?' · New messages await analysis':''}${c?.complete?' · Available history analyzed':h?' · '+fmt(h.completed_batches)+' / '+fmt(h.total_batches)+' history batches':''}</p>${p?`
 ${p.customNote?`<h4>Your notes</h4><p class="person-note">${esc(p.customNote)}</p>`:''}
 <h4>Personality & communication</h4>${briefingClaims(p.observations,'No supported observations saved yet.')}
 <h4>Stated preferences & interests</h4>${briefingClaims(p.preferences,'No explicit preferences saved yet.')}
 <h4>Topics discussed</h4><p class="muted">Mentions describe conversation topics, not necessarily preferences.</p>${(p.topics||[]).map(t=>`<div class="person-topic">${esc(t.title)} <small>· ${fmt(t.count)} mentions</small> ${briefingSources(t.evidence)}</div>`).join('')||'<p class="muted">No topic counts saved.</p>'}
 <button class="text-button" data-profile-note-room="${esc(r.id)}" data-profile-note-person="${esc(p.id)}">Edit name / private notes for this chat</button>`:'<p class="muted">'+esc(chat.reason||'This author has no saved interpretation yet. Your messages remain available in the chat.')+'</p>'}
 <details class="profile-context"><summary>Conversation summary & details</summary><h4>Conversation summary</h4>${briefingClaims(chat.summary,'No summary saved yet.')}<h4>Latest exchange</h4>${briefingClaims(chat.recent,'No recent-exchange summary saved.')}<h4>Possible follow-ups</h4>${briefingClaims(chat.followups,'No follow-up saved.')}${chat.events?.length?'<h4>Events involving this person</h4>'+chat.events.map(eventMarkup).join(''):''}<button class="secondary" data-profile-briefing="${esc(r.id)}">Full chat briefing & history findings</button></details></section>`;
}
async function showPersonProfile(id,room='',more=false){
 const previous=personView;
 if(more&&(!previous||previous.id!==id||previous.loading))return;
 if(!more){modal(`<div class="profile-banner"></div>${loadingMarkup('Loading profile and saved insights…')}`);personView={id,room,chats:[],offset:0,loading:true};}
 else {previous.loading=true;const button=$('#person-more');if(button){button.disabled=true;button.textContent='Loading conversations…';}}
 const version=modalVersion,offset=more?previous.chats.length:0;
 try{
  const data=await api('person?'+new URLSearchParams({id,room,offset,limit:5}));
  if(version!==modalVersion||!$('#modal').open||personView?.id!==id)return;
  personView={id,room,chats:more?[...previous.chats,...data.chats]:data.chats,offset,loading:false};
  const p=data.identity,c=data.coverage;
  $('#modal-content').innerHTML=`<div class="profile-banner"></div><div class="person-profile"><div class="person-profile-header">${avatarMarkup(p.alias||p.name,p.is_me?'owner':p.platform,'profile-avatar')}<div><h2>${esc(p.alias||p.name||p.id)} ${platformBadge(p.platform)} ${p.is_me?'<span class="self-label">YOU</span>':''}</h2><p>${esc(p.name||'')} · ${fmt(c.messages)} messages · ${fmt(c.chats)} conversations</p></div></div><div class="profile-tabs" role="tablist" aria-label="Person profile"><button class="active" role="tab" aria-selected="true" aria-controls="person-insights" id="person-insights-tab" data-person-tab="person-insights">Profile & insights</button><button role="tab" aria-selected="false" aria-controls="person-account" id="person-account-tab" data-person-tab="person-account">Identity & name</button></div><section id="person-insights" role="tabpanel" aria-labelledby="person-insights-tab"><p class="profile-explainer">Observed patterns and explicit preferences, grouped by conversation. Interpretations can be mistaken; open a source to see the original words.</p><div id="person-chats">${personView.chats.map(personChatMarkup).join('')||'<p>No conversations archived for this account.</p>'}</div>${personView.chats.length<data.total?`<button class="load" id="person-more">Load more conversations · ${fmt(personView.chats.length)} / ${fmt(data.total)}</button>`:''}<button class="text-button" id="person-refresh">Refresh saved insights</button></section><section id="person-account" role="tabpanel" aria-labelledby="person-account-tab" hidden><h3>Account details</h3><dl class="identity-details"><dt>Platform</dt><dd>${esc(p.platform)}</dd><dt>Account ID</dt><dd>${esc(p.remote_id||p.id)}</dd><dt>First archived message</dt><dd>${date(c.first)}</dd><dt>Latest archived message</dt><dd>${date(c.last)}</dd></dl><form id="person-form"><label>Display name<input id="person-alias" maxlength="160" value="${esc(p.alias)}" placeholder="${esc(p.name)}"></label><label class="check-label"><input id="person-me" type="checkbox" ${p.is_me?'checked':''}> This account belongs to me</label><p class="muted">Authorship uses account IDs. Renaming does not merge people or accounts.</p><button class="primary" id="person-save">Save identity</button></form></section></div>`;
  bindEvents();
  for(const button of document.querySelectorAll('[data-person-tab]'))button.onclick=()=>{for(const tab of document.querySelectorAll('[data-person-tab]')){const active=tab===button;tab.classList.toggle('active',active);tab.setAttribute('aria-selected',String(active));$('#'+tab.dataset.personTab).hidden=!active;}};
  for(const button of document.querySelectorAll('[data-profile-chat]'))button.onclick=async()=>{++modalVersion;$('#modal').close();state.room={id:button.dataset.profileChat};await navigate('inbox');};
  for(const button of document.querySelectorAll('[data-profile-briefing]'))button.onclick=()=>showChatBriefing(button.dataset.profileBriefing);
  for(const button of document.querySelectorAll('[data-profile-note-person]'))button.onclick=()=>editBriefingPerson(button.dataset.profileNoteRoom,button.dataset.profileNotePerson);
  if($('#person-more'))$('#person-more').onclick=()=>showPersonProfile(id,room,true);
  $('#person-refresh').onclick=()=>showPersonProfile(id,room);
  $('#person-form').onsubmit=async event=>{
   event.preventDefault();const button=$('#person-save');button.disabled=true;button.textContent='Saving…';
   try{await api('identity',{id,patch:{alias:$('#person-alias').value,is_me:$('#person-me').checked}});lastInboxRevision='';if(state.page==='inbox'&&state.room)loadChatMembers(state.room.id);if(version!==modalVersion||!$('#modal').open)return;await showPersonProfile(id,room);toast('Identity saved.');}
   catch(error){toast(error.message);if(version===modalVersion){button.disabled=false;button.textContent='Save identity';}}
  };
 }catch(error){
  if(version!==modalVersion||!$('#modal').open)return;
  personView.loading=false;
  if(more){toast(error.message);const button=$('#person-more');if(button){button.disabled=false;button.textContent='Retry loading conversations';}}
  else{$('#modal-content').innerHTML='<div class="empty"><strong>Could not load this profile</strong><p>'+esc(error.message)+'</p><button class="secondary" id="person-retry">Try again</button></div>';$('#person-retry').onclick=()=>showPersonProfile(id,room);}
 }
}
