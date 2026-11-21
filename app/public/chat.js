const chatDrafts=new Map();
let chatRenderEpoch=0;
function chatDraft(id){if(!chatDrafts.has(id))chatDrafts.set(id,{body:'',attempt:null,busy:false,note:''});return chatDrafts.get(id);}
function chatStatus(row){return {sending:state.runtime==='vm'?'Sending from your account':'Submitting locally',pending:'Queued locally · awaiting bridge confirmation',sent:'Sent to '+(row.platform==='discord'?'Discord':'WhatsApp'),failed:'Send failed',unknown:'Submission unconfirmed · check the native app'}[row.status]||'Awaiting confirmation';}
function chatVisible(id){return state.page==='inbox'&&state.room?.id===id&&!!$('#chat-composer');}
function applyChatOutcome(draft,row){
  if(!draft.attempt||draft.attempt.id!==row.id)return;
  if(['sending','pending','sent'].includes(row.status)){
    if(draft.body===draft.attempt.body)draft.body='';draft.attempt=null;draft.note='';
  }else if(row.status==='failed'){draft.attempt=null;draft.note=row.error||'The message could not be sent.';}
  else if(row.status==='unknown'){draft.attempt={...draft.attempt,unknown:true};draft.note=row.error;}
}
function updateChatControls(room,cap){
  if(!chatVisible(room.id)||!cap.allowed)return;
  const draft=chatDraft(room.id),input=$('#chat-body'),button=$('#chat-send');
  input.disabled=draft.busy||!!draft.attempt;
  button.disabled=draft.busy||!!draft.attempt?.unknown||!draft.body.trim()||draft.body.length>cap.maxLength;
  button.textContent=draft.busy?'Submitting…':draft.attempt?'Retry same submission':'Send';
  $('#chat-count').textContent=draft.body.length.toLocaleString()+' / '+cap.maxLength.toLocaleString();
  $('#chat-note').textContent=draft.note||'Sends from your connected account. Enter adds a new line.';
  $('#chat-unlock').hidden=!draft.attempt?.unknown;
}
function chatHistory(rows){
  const latest=rows[0];
  $('#chat-status').textContent=latest?chatStatus(latest)+(latest.error?' · '+latest.error:''):'';
  $('#chat-send-history').innerHTML=rows.map(row=>`<article class="chat-attempt"><strong>${esc(chatStatus(row))}</strong><small>${date(row.created_at)}</small><p>${esc(row.body)}</p>${row.error?`<p class="warning">${esc(row.error)}</p>`:''}</article>`).join('')||'<p class="muted">No messages sent from Misty in this conversation yet.</p>';
}
async function renderChatComposer(room){
  const epoch=++chatRenderEpoch,container=$('#chat-composer');if(!container)return;
  if(!['discord','whatsapp'].includes(room.platform)){container.innerHTML='';return;}
  const cap=await api('chat/capability?'+new URLSearchParams({room:room.id}));
  if(epoch!==chatRenderEpoch||!chatVisible(room.id))return;
  container.dataset.allowed=String(cap.allowed);
  const draft=chatDraft(room.id);
  container.innerHTML=(cap.allowed?`<form id="chat-send-form"><label for="chat-body">Message ${esc(room.alias||room.name)} on ${room.platform==='discord'?'Discord':'WhatsApp'}</label><textarea id="chat-body" rows="2" maxlength="${cap.maxLength}" placeholder="Write a message…"></textarea><div class="chat-actions"><small id="chat-count"></small><button class="primary" id="chat-send" type="submit">Send</button></div><p id="chat-note" class="muted"></p><button class="text-button" id="chat-unlock" type="button" hidden>I checked the native app; unlock the composer</button></form>`:`<p class="muted">${esc(cap.reason)}</p>`)+`<p id="chat-status" class="chat-status" role="status" aria-live="polite"></p><details class="chat-history"><summary>Send history for this chat</summary><div id="chat-send-history"></div></details>`;
  if(cap.allowed){
    $('#chat-body').value=draft.body;
    $('#chat-body').oninput=()=>{draft.body=$('#chat-body').value;draft.note='';updateChatControls(room,cap);};
    $('#chat-unlock').onclick=()=>{draft.attempt=null;draft.note='Check that the previous message was not sent before sending another copy.';updateChatControls(room,cap);};
    $('#chat-send-form').onsubmit=async event=>{
      event.preventDefault();if(draft.busy||draft.attempt?.unknown||!draft.body.trim()||draft.body.length>cap.maxLength)return;
      const attempt=draft.attempt||{id:'chat-'+crypto.randomUUID(),room:room.id,body:draft.body};
      draft.attempt=attempt;draft.busy=true;draft.note='';updateChatControls(room,cap);
      try{const row=await api('chat/send',attempt);applyChatOutcome(draft,row);}
      catch(error){draft.note='Local response unavailable. Retry uses the same submission ID to avoid duplicates. '+error.message;}
      finally{
        draft.busy=false;
        if(chatVisible(room.id)){$('#chat-body').value=draft.body;updateChatControls(room,cap);await refreshChatComposer().catch(()=>{});}
      }
    };
    updateChatControls(room,cap);
  }
  await refreshChatComposer();
}
async function refreshChatComposer(){
  const room=state.room,epoch=chatRenderEpoch;
  if(!room||!chatVisible(room.id)||!['discord','whatsapp'].includes(room.platform)||!$('#chat-status'))return;
  const [cap,rows]=await Promise.all([api('chat/capability?'+new URLSearchParams({room:room.id})),api('chat/outgoing?'+new URLSearchParams({room:room.id}))]);
  if(epoch!==chatRenderEpoch||!chatVisible(room.id))return;
  if($('#chat-composer').dataset.allowed!==String(cap.allowed)){await renderChatComposer(room);return;}
  const draft=chatDraft(room.id),row=draft.attempt&&rows.find(r=>r.id===draft.attempt.id);
  if(row&&!draft.busy){applyChatOutcome(draft,row);if(cap.allowed)$('#chat-body').value=draft.body;}
  if(cap.allowed)updateChatControls(room,cap);
  chatHistory(rows);
}
