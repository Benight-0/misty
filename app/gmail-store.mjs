// Gmail message IDs are only unique within one mailbox. Keep accounts separate.
import {createHash} from 'node:crypto';
export function gmailSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS gmail_accounts(
    id TEXT PRIMARY KEY,email TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,
    phase TEXT NOT NULL DEFAULT 'full',page_token TEXT NOT NULL DEFAULT '',
    cursor TEXT NOT NULL DEFAULT '',baseline TEXT NOT NULL DEFAULT '',
    checked INTEGER NOT NULL DEFAULT 0,last_sync INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '',generation INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS gmail_messages(
    message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL,remote_id TEXT NOT NULL,thread_id TEXT NOT NULL,
    headers_json TEXT NOT NULL,labels_json TEXT NOT NULL,attachments_json TEXT NOT NULL,
    authored_text TEXT NOT NULL,unavailable INTEGER NOT NULL DEFAULT 0,
    UNIQUE(account_id,remote_id));
    CREATE TABLE IF NOT EXISTS gmail_thread_jobs(room_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE);`);
  db.exec(`CREATE TABLE IF NOT EXISTS gmail_attachment_blobs(
    message_id TEXT NOT NULL REFERENCES gmail_messages(message_id) ON DELETE CASCADE,
    part_key TEXT NOT NULL,name TEXT NOT NULL,mime TEXT NOT NULL,
    size INTEGER NOT NULL,sha256 TEXT NOT NULL,content BLOB NOT NULL,
    PRIMARY KEY(message_id,part_key));
    CREATE INDEX IF NOT EXISTS gmail_attachment_message ON gmail_attachment_blobs(message_id);
    CREATE TABLE IF NOT EXISTS gmail_attachment_failures(
    message_id TEXT NOT NULL REFERENCES gmail_messages(message_id) ON DELETE CASCADE,
    part_key TEXT NOT NULL,reason TEXT NOT NULL,at INTEGER NOT NULL,
    PRIMARY KEY(message_id,part_key));`);
  if(!db.prepare('PRAGMA table_info(gmail_messages)').all().some(c=>c.name==='body_text'))
    db.exec('ALTER TABLE gmail_messages ADD COLUMN body_text TEXT');
  db.exec(`CREATE TABLE IF NOT EXISTS gmail_outgoing(
    id TEXT PRIMARY KEY,account_id TEXT NOT NULL,draft_json TEXT NOT NULL,raw TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ready',remote_id TEXT NOT NULL DEFAULT '',thread_id TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);`);
  if(!db.prepare('PRAGMA table_info(gmail_accounts)').all().some(c=>c.name==='generation'))
    db.exec('ALTER TABLE gmail_accounts ADD COLUMN generation INTEGER NOT NULL DEFAULT 0');
  if(!db.prepare('PRAGMA table_info(gmail_accounts)').all().some(c=>c.name==='coverage_version'))
    db.exec('ALTER TABLE gmail_accounts ADD COLUMN coverage_version INTEGER NOT NULL DEFAULT 0');
}

const idFor=(account,id)=>`gmail:${account.id}:${id}`;
function decode(data,charset='utf-8') {
  const bytes=Buffer.from(data||'','base64url');
  try{return new TextDecoder(charset).decode(bytes);}catch{return bytes.toString('utf8');}
}
function entities(text) {
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(all,c)=>{
    if(c[0]==='#'){const n=c[1].toLowerCase()==='x'?parseInt(c.slice(2),16):Number(c.slice(1));return n>0&&n<=0x10ffff?String.fromCodePoint(n):all;}
    return {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '}[c.toLowerCase()];
  });
}
function htmlText(html) {
  return entities(html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'')
    .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi,'\n').replace(/<[^>]*>/g,''))
    .replace(/\r/g,'').replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
export function textBodyPart(part) {
  const disposition=(part?.headers||[]).find(h=>h.name.toLowerCase()==='content-disposition')?.value||'';
  return ['text/plain','text/html'].includes(part?.mimeType) && !part.filename && !/^\s*attachment\b/i.test(disposition);
}
export function authoredEmail(text) {
  // Conservative evidence text: keep the archive intact but exclude common quoted replies/forwards.
  return text.split(/\r?\n/).filter(line=>!/^\s*>/.test(line)).join('\n')
    .split(/(?:^|\n)(?:On .{1,500}wrote:|[-_]{2,}\s*(?:Original Message|Forwarded message)[\s\S]*|Begin forwarded message:|From:\s[^\n]+\nSent:)/i)[0].trim();
}
export function parseEmail(raw) {
  const headers=Object.fromEntries((raw.payload?.headers||[]).map(h=>[h.name.toLowerCase(),h.value]));
  const plain=[],html=[],attachments=[];
  function visit(part,key='0') {
    if(!part)return;
    const contentType=(part.headers||[]).find(h=>h.name.toLowerCase()==='content-type')?.value||'';
    const charset=contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1]||'utf-8';
    if(!textBodyPart(part) && (part.filename || part.body?.attachmentId || part.mimeType==='message/rfc822')){attachments.push({key,name:part.filename||'Unnamed attachment',mime:part.mimeType||'application/octet-stream',size:part.body?.size||0,id:part.body?.attachmentId||''});return;}
    if(part.mimeType==='text/plain' && part.body?.data)plain.push(decode(part.body.data,charset));
    else if(part.mimeType==='text/html' && part.body?.data)html.push(decode(part.body.data,charset));
    (part.parts||[]).forEach((child,index)=>visit(child,key+'.'+index));
  }
  visit(raw.payload);
  const text=(plain.length?plain.join('\n'):htmlText(html.join('\n'))).trim();
  const subject=headers.subject||'(No subject)';
  const folders=(raw.labelIds||[]).filter(label=>['DRAFT','SPAM','TRASH'].includes(label));
  const body=[subject,headers.from?'From: '+headers.from:'',headers.to?'To: '+headers.to:'',headers.cc?'Cc: '+headers.cc:'',...(folders.length?['Folder: '+folders.join(', ')]:[]),'',text||'[No text body]',...attachments.map(a=>`[Attachment: ${a.name}; ${a.size} bytes]`)].join('\n');
  const from=headers.from||'Unknown sender';
  const address=(from.match(/<([^<>\s]+@[^<>\s]+)>/)?.[1]||from.match(/[^\s<>"(),;]+@[^\s<>"(),;]+/)?.[0]||'').toLowerCase();
  const ownText=plain.length?text:htmlText(html.join('\n').split(/<blockquote\b|<[^>]+\bclass=["'][^"']*gmail_(?:quote|attr)/i)[0]);
  return {headers,attachments,body,text,authored:authoredEmail(ownText),subject,from,address};
}

export function ingestEmail(store,account,raw) {
  const labels=raw.labelIds||[];
  if(!/^[a-zA-Z0-9_-]+$/.test(raw.id||'')||!/^[a-zA-Z0-9_-]+$/.test(raw.threadId||''))throw new Error('Invalid Gmail message IDs');
  const id=idFor(account,raw.id),roomId=idFor(account,raw.threadId);
  const previous=store.room(roomId);
  if(previous && (!previous.connected || !previous.tracked))return false;
  const mail=parseEmail(raw);
  // A From header can be spoofed. Only Gmail's SENT classification establishes own authorship.
  const own=labels.includes('SENT')||labels.includes('DRAFT');
  const sender=own?'gmail:self:'+account.id:'gmail:'+(mail.address||account.id+':unknown');
  store.statement(`INSERT INTO identities(id,platform,remote_id,name,is_me,verified,source) VALUES(?,'gmail',?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name WHERE identities.name=''`)
    .run(sender,own?account.email:mail.address,own?account.email:mail.from,+own,+own,own?'Connected Gmail mailbox / sent-mail label':'Gmail From header');
  store.statement(`INSERT INTO conversations(id,name,platform,kind,remote_id,server_name,include_profile,updated_at)
    VALUES(?,?,'gmail','email',?,?,0,?) ON CONFLICT(id) DO NOTHING`).run(roomId,mail.subject,raw.threadId,account.email,Date.now());
  store.statement(`INSERT INTO messages(id,room_id,sender,ts,body,original_body,type,is_me,source_received)
    VALUES(?,?,?,?,?,?,'email',?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,original_body=excluded.original_body`)
    .run(id,roomId,sender,Number(raw.internalDate)||0,mail.body,mail.body,+own,Date.now());
  store.statement(`INSERT INTO gmail_messages(message_id,account_id,remote_id,thread_id,headers_json,labels_json,attachments_json,authored_text,body_text)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET headers_json=excluded.headers_json,labels_json=excluded.labels_json,attachments_json=excluded.attachments_json,authored_text=excluded.authored_text,body_text=excluded.body_text,unavailable=0`)
    .run(id,account.id,raw.id,raw.threadId,JSON.stringify(mail.headers),JSON.stringify(labels),JSON.stringify(mail.attachments),mail.authored,mail.text);
  for(const attachment of raw.attachmentContents||[]){
    const content=attachment.content;
    if(!Buffer.isBuffer(content)||!mail.attachments.some(item=>item.key===attachment.key))throw new Error('Invalid Gmail attachment data.');
    store.statement(`INSERT INTO gmail_attachment_blobs(message_id,part_key,name,mime,size,sha256,content)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(message_id,part_key) DO UPDATE SET
      name=excluded.name,mime=excluded.mime,size=excluded.size,sha256=excluded.sha256,content=excluded.content`)
      .run(id,attachment.key,attachment.name,attachment.mime,content.length,createHash('sha256').update(content).digest('hex'),content);
    store.statement('DELETE FROM gmail_attachment_failures WHERE message_id=? AND part_key=?').run(id,attachment.key);
  }
  for(const failure of raw.attachmentFailures||[]){
    if(!mail.attachments.some(item=>item.key===failure.key))throw new Error('Invalid Gmail attachment failure.');
    store.statement(`INSERT INTO gmail_attachment_failures(message_id,part_key,reason,at) VALUES(?,?,?,?)
      ON CONFLICT(message_id,part_key) DO UPDATE SET reason=excluded.reason,at=excluded.at`)
      .run(id,failure.key,failure.reason,Date.now());
  }
  store.touched.add(roomId);
  return true;
}

export function applyGmailPage(store,accountId,messages,patch={},changes={},generation=null) {
  const account=store.statement('SELECT * FROM gmail_accounts WHERE id=? AND enabled=1').get(accountId);
  if(!account || (generation!==null && account.generation!==generation))return false;
  store.begin();
  try {
    for(const message of messages)ingestEmail(store,account,message);
    for(const [id,message] of changes.labels||[])if(message.labelIds)
      store.statement('UPDATE gmail_messages SET labels_json=? WHERE account_id=? AND remote_id=?').run(JSON.stringify(message.labelIds),accountId,id);
    // Gmail is an archive: deletion upstream marks metadata; already archived text is retained.
    for(const id of changes.deleted||[])
      store.statement('UPDATE gmail_messages SET unavailable=1 WHERE account_id=? AND remote_id=?').run(accountId,id);
    for(const key of ['phase','page_token','cursor','baseline','checked','last_sync','error'])if(key in patch)
      store.statement(`UPDATE gmail_accounts SET ${key}=? WHERE id=?`).run(patch[key],accountId);
    store.set('gmail_revision',store.get('gmail_revision',0)+1);
    store.commit();store.refreshSelfIds();return true;
  }catch(error){store.rollback();throw error;}
}
