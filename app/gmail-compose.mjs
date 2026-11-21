import {randomUUID} from 'node:crypto';

function header(value,label,max=500) {
  if(typeof value!=='string'||value.length>max||/[\x00-\x1f\x7f]/.test(value))throw new Error(`Invalid ${label}. Keep it on one line.`);
  return value.trim();
}
export function addresses(value,label='recipient') {
  const text=header(value??'',label,5000);if(!text)return [];
  const parts=[];let start=0,quoted=false,angle=false;
  for(let i=0;i<text.length;i++){
    const char=text[i];if(char==='\\'&&quoted){i++;continue;}
    if(char==='"')quoted=!quoted;
    if(!quoted){if(char==='<')angle=true;if(char==='>')angle=false;
      if((char===','||char===';')&&!angle){parts.push(text.slice(start,i));start=i+1;}}
  }
  if(quoted||angle)throw new Error(`Invalid ${label} address.`);
  parts.push(text.slice(start));
  const result=parts.map(part=>{
    const input=part.trim(),email=input.match(/^[^<>]*<([^<>]+)>$/)?.[1]||input;
    const [local,domain,...extra]=email.split('@');
    if(extra.length||!local||!domain||email.length>254||local.length>64||! /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)
      ||local.startsWith('.')||local.endsWith('.')||local.includes('..')||!domain.includes('.')
      ||!domain.split('.').every(label=>label.length<=63&&/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label)))
      throw new Error(`Invalid ${label} address. Use email addresses separated by commas.`);
    return local+'@'+domain.toLowerCase();
  });
  if(result.length>50)throw new Error('Use no more than 50 recipients per field.');
  return [...new Set(result)];
}
export function decodeHeader(value) {
  return String(value||'').replace(/(\?=)\s+(=\?)/g,'$1$2').replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi,(all,charset,encoding,text)=>{
    try{
      const bytes=encoding.toLowerCase()==='b'?Buffer.from(text,'base64'):Buffer.from(text.replace(/_/g,' ').replace(/=([\da-f]{2})/gi,(_,hex)=>String.fromCharCode(parseInt(hex,16))),'latin1');
      return new TextDecoder(charset).decode(bytes);
    }catch{return all;}
  });
}
function encodedSubject(subject) {
  const chunks=[];let chunk='';
  for(const char of subject){if(Buffer.byteLength(chunk+char)>42){chunks.push(chunk);chunk='';}chunk+=char;}
  chunks.push(chunk);return chunks.map(s=>'=?UTF-8?B?'+Buffer.from(s).toString('base64')+'?=').join('\r\n ');
}
const messageIds=value=>String(value||'').match(/<[^\s<>\x00-\x1f\x7f]+@[^\s<>\x00-\x1f\x7f]+>/g)||[];
export function prepareEmail(account,input,parent=null,{now=Date.now(),uuid=randomUUID()}={}) {
  const from=addresses(account.email,'sender');if(from.length!==1)throw new Error('Invalid connected mailbox.');
  const to=addresses(input.to,'To'),cc=addresses(input.cc,'Cc'),bcc=addresses(input.bcc,'Bcc');
  if(!to.length&&!cc.length&&!bcc.length)throw new Error('Add at least one recipient.');
  if(to.length+cc.length+bcc.length>100)throw new Error('Use no more than 100 recipients.');
  if(typeof input.body!=='string'||!input.body.trim()||input.body.length>20000||input.body.includes('\0'))throw new Error('Write an email body of up to 20,000 characters.');
  let subject=header(input.subject??'','subject');
  let threadId='',inReplyTo='',references=[];
  if(parent){
    if(parent.account_id!==account.id)throw new Error('Replies must use the mailbox that received the original email.');
    if(!/^[a-zA-Z0-9_-]+$/.test(parent.thread_id))throw new Error('Invalid reply thread.');
    const headers=JSON.parse(parent.headers_json);
    inReplyTo=messageIds(headers['message-id'])[0]||'';
    if(!inReplyTo)throw new Error('This archived email has no valid Message-ID. Compose a new email instead.');
    const original=header(decodeHeader(headers.subject||''),'original subject');
    // A reply keeps the original subject and Gmail thread ID.
    subject=/^re:/i.test(original)?original:'Re: '+original;
    references=[...new Set([...messageIds(headers.references),inReplyTo])].slice(-20);
    threadId=parent.thread_id;
  }
  const body=input.body.replace(/\r\n|\r|\n/g,'\r\n');
  const messageId=`<${uuid}@${from[0].split('@')[1]}>`;
  const lines=['From: '+from[0]];
  for(const [name,list]of [['To',to],['Cc',cc],['Bcc',bcc]])if(list.length)lines.push(name+': '+list.join(',\r\n '));
  lines.push('Subject: '+encodedSubject(subject),'Date: '+new Date(now).toUTCString(),'Message-ID: '+messageId);
  if(inReplyTo)lines.push('In-Reply-To: '+inReplyTo,'References: '+references.join('\r\n '));
  lines.push('MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',Buffer.from(body).toString('base64').match(/.{1,76}/g)?.join('\r\n')||'','');
  return {from:from[0],to,cc,bcc,subject,body:input.body,replyTo:parent?.message_id||'',threadId,messageId,
    raw:Buffer.from(lines.join('\r\n'),'utf8').toString('base64url')};
}

export function replyDefaults(store,messageId) {
  const parent=store.statement(`SELECT g.*,a.email,m.is_me FROM gmail_messages g JOIN gmail_accounts a ON a.id=g.account_id
    JOIN messages m ON m.id=g.message_id WHERE g.message_id=?`).get(messageId);
  if(!parent)throw new Error('Gmail email not found.');
  const headers=JSON.parse(parent.headers_json);
  const recipients=addresses(parent.is_me?(headers.to||''):(headers['reply-to']||headers.from||''),'reply recipient');
  return {account:parent.account_id,replyTo:messageId,to:recipients.join(', '),cc:'',bcc:'',
    subject:/^re:/i.test(decodeHeader(headers.subject))?decodeHeader(headers.subject):'Re: '+decodeHeader(headers.subject),parent};
}
