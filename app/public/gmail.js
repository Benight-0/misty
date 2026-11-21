// Loaded by app.js's explicit script tag; shares the local app's API and dialog.
async function composeEmail(replyTo='',prefill=null) {
  try {
    const status=await api('gmail'),accounts=status.accounts.filter(a=>a.linked&&a.canSend);
    if(!accounts.length){modal('<h2>Enable Gmail sending</h2><p>In Google Auth platform → Data Access, add gmail.send alongside gmail.readonly. Then use Add Gmail account in Sync & storage to reconnect each mailbox and approve sending.</p><button class="primary" id="gmail-enable-send">Open Gmail connections</button>');$('#gmail-enable-send').onclick=()=>{$('#modal').close();navigate('sync');};return;}
    let draft=prefill||{account:accounts[0].id,to:'',cc:'',bcc:'',subject:'',body:'',replyTo:''};
    if(replyTo&&!prefill)draft={...draft,...await api('gmail/reply?'+new URLSearchParams({id:replyTo}))};
    if(!accounts.some(a=>a.id===draft.account))throw new Error('Reconnect the mailbox for this reply with sending permission first.');
    modal(`<h2>${draft.replyTo?'Reply to email':'Compose email'}</h2><form id="gmail-compose-form"><label>From<select id="mail-account" ${draft.replyTo?'disabled':''}>${accounts.map(a=>`<option value="${esc(a.id)}">${esc(a.email)}</option>`).join('')}</select></label><label>To<input id="mail-to" value="${esc(draft.to)}" placeholder="name@example.com, another@example.com" maxlength="5000"></label><div class="mail-recipient-grid"><label>Cc<input id="mail-cc" value="${esc(draft.cc)}" maxlength="5000"></label><label>Bcc<input id="mail-bcc" value="${esc(draft.bcc)}" maxlength="5000"></label></div><label>Subject<input id="mail-subject" value="${esc(draft.subject)}" maxlength="500" ${draft.replyTo?'readonly':''}></label><label>Message<textarea id="mail-body" required maxlength="20000" placeholder="Write your email…">${esc(draft.body)}</textarea></label><p class="muted">Plain-text email. Sending attachments is not available yet. Reviewing saves this email locally; it does not send it.</p><p id="mail-error" class="warning" role="status"></p><button class="primary" id="mail-review">Review email</button></form>`);
    $('#mail-account').value=draft.account;
    $('#gmail-compose-form').onsubmit=async event=>{
      event.preventDefault();const button=$('#mail-review');if(button.disabled)return;button.disabled=true;$('#mail-error').textContent='';
      const input={account:$('#mail-account').value,to:$('#mail-to').value,cc:$('#mail-cc').value,bcc:$('#mail-bcc').value,subject:$('#mail-subject').value,body:$('#mail-body').value,replyTo:draft.replyTo||''};
      try{const prepared=await api('gmail/prepare',input);showEmailReview(prepared,input);}catch(e){$('#mail-error').textContent=e.message;button.disabled=false;}
    };
  }catch(error){toast(error.message);}
}
function emailPreview(row) {
  return `<div class="mail-preview"><dl><dt>From</dt><dd>${esc(row.from)}</dd>${[['To',row.to],['Cc',row.cc],['Bcc',row.bcc]].filter(([,values])=>values.length).map(([label,values])=>`<dt>${label}</dt><dd>${esc(values.join(', '))}</dd>`).join('')}<dt>Subject</dt><dd>${esc(row.subject||'(No subject)')}</dd></dl><div class="message-body">${esc(row.body)}</div></div>`;
}
function showEmailReview(row,input) {
  modal(`<h2>Review your email</h2>${emailPreview(row)}<p class="muted">${row.replyTo?'This reply will use the original Gmail account and thread.':'This will start a new email conversation.'}</p><p id="send-status" role="status"></p><div class="mail-send-actions"><button class="secondary" id="mail-edit">Edit</button><button class="primary" id="mail-send">Send email</button></div>`);
  $('#mail-edit').onclick=()=>composeEmail('',input);
  $('#mail-send').onclick=async()=>{
    const button=$('#mail-send');if(button.disabled)return;button.disabled=true;$('#mail-edit').disabled=true;$('#close-modal').disabled=true;$('#send-status').textContent='Sending…';
    let result;
    try{result=await api('gmail/send',{id:row.id});}
    catch(error){
      // The HTTP response may have been lost after Google accepted the email.
      try{result=(await api('gmail/outgoing?'+new URLSearchParams({id:row.id})))[0];}catch{}
      if(!result||['ready','sending'].includes(result.status)){result={...row,status:'unknown',error:'Delivery is not confirmed. Check Gmail Sent and Send history before composing another copy.'};}
    }finally{$('#close-modal').disabled=false;}
    showEmailResult(result,input);
  };
}
function showEmailResult(row,input=null) {
  const title={sent:'Email sent',unknown:'Delivery not confirmed',failed:'Email was not sent',ready:'Email ready to review',sending:'Sending email…'}[row.status]||'Email status';
  modal(`<h2>${title}</h2>${emailPreview(row)}<p class="${row.status==='sent'?'muted':'warning'}" role="status">${esc(row.status==='sent'?'Google accepted your email. It will appear in the archive when this thread is being tracked.':row.error||'Check Gmail Sent before sending another copy.')}</p>${row.status==='failed'&&input?'<button class="primary" id="mail-revise">Edit and review again</button>':''}<button class="secondary" id="mail-history">Send history</button>`);
  if($('#mail-revise'))$('#mail-revise').onclick=()=>composeEmail('',input);
  $('#mail-history').onclick=showSendHistory;
  if(row.status==='sent'){toast('Email sent.');refreshStats().catch(()=>{});}
}
async function showSendHistory() {
  try{
    const rows=await api('gmail/outgoing');
    modal(`<h2>Email send history</h2><p class="muted">Last 50 emails prepared here. Ready means reviewed locally, not sent. Unconfirmed delivery is never retried automatically; check Gmail Sent first.</p><div class="mail-history">${rows.map(row=>`<button class="mail-history-row" data-outgoing="${esc(row.id)}"><strong>${esc(row.subject||'(No subject)')}</strong><span>${esc(row.from)} → ${esc([...row.to,...row.cc,...row.bcc].join(', '))}</span><small>${esc(row.status==='unknown'?'Delivery unconfirmed':row.status)} · ${date(row.updated_at)}</small></button>`).join('')||'<p>No emails prepared yet.</p>'}</div><button class="secondary" id="mail-history-refresh">Refresh history</button>`);
    $('#mail-history-refresh').onclick=showSendHistory;
    for(const button of document.querySelectorAll('[data-outgoing]'))button.onclick=()=>{const row=rows.find(r=>r.id===button.dataset.outgoing);const input={account:row.account_id,to:row.to.join(', '),cc:row.cc.join(', '),bcc:row.bcc.join(', '),subject:row.subject,body:row.body,replyTo:row.replyTo};if(row.status==='ready')showEmailReview(row,input);else showEmailResult(row,input);};
  }catch(error){toast(error.message);}
}
document.addEventListener('click',event=>{
  const reply=event.target.closest('[data-mail-reply]');if(reply)composeEmail(reply.dataset.mailReply);
});
