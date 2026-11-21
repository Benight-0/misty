import {randomUUID} from 'node:crypto';
import {addresses,decodeHeader,replyDefaults} from './gmail-compose.mjs';

const builtins=[
  ['college','College',{from:['.edu','.ac.in','unsw','college','university','campus'],subject:['college','university','course','semester','campus']}],
  ['promotional','Promotional',{labels:['CATEGORY_PROMOTIONS'],subject:['sale','discount','offer','promotion','deal']}],
  ['informatics','Informatics',{from:['codeforces','atcoder','icpc','olympiad','informatics'],subject:['informatics','programming contest','icpc','olympiad']}],
  ['direct-message','Direct message',{labels:['CATEGORY_PERSONAL'],subject:['sent you a message','new message from','replied to you']}],
  ['internship','Internship',{subject:['internship','intern','application','recruiter','career','interview'],from:['careers','recruiting','jobs']}],
  ['log-in','Log-in',{subject:['sign in','sign-in','log in','login','verification code','security alert','one-time','otp']}]
];
const folders=[['primary','Primary'],['inbox','All inbox'],['unread','Unread'],['starred','Starred'],['drafts','Drafts'],['sent','Sent'],['all','All mail'],['spam','Spam'],['trash','Trash']];
const fields=['from','subject','body','labels'];
const like=value=>'%'+value.replace(/[\\%_]/g,'\\$&')+'%';
const json=value=>{try{return JSON.parse(value||'[]');}catch{return [];}};
const tokens=value=>[...new Set((Array.isArray(value)?value:String(value||'').split(/[\n,]/))
  .map(term=>String(term).trim().toLowerCase()).filter(Boolean))].slice(0,20);
function rules(input){
  const output=Object.fromEntries(fields.map(key=>[key,tokens(input?.[key])]));
  if(!fields.some(key=>output[key].length))throw new Error('Add at least one sender, subject, body, or Gmail label term.');
  if(fields.some(key=>output[key].some(term=>term.length>100)))throw new Error('Category terms must be at most 100 characters.');
  return output;
}
function textBody(row,attachments){
  if(row.body_text!==null)return row.body_text;
  let body=String(row.body||'');const divider=body.indexOf('\n\n');
  if(divider>=0)body=body.slice(divider+2);
  for(const item of [...attachments].reverse()){
    const suffix=`\n[Attachment: ${item.name}; ${item.size} bytes]`;
    if(body.endsWith(suffix))body=body.slice(0,-suffix.length);
  }
  return body==='[No text body]'?'':body;
}
function selector(folder,category){
  if(category){
    const parts=[];
    for(const term of category.rules.from)parts.push(['lower(coalesce(json_extract(g.headers_json,\'$.from\'),\'\')) LIKE ? ESCAPE \'\\\'',[like(term)]]);
    for(const term of category.rules.subject)parts.push(['lower(coalesce(json_extract(g.headers_json,\'$.subject\'),\'\')) LIKE ? ESCAPE \'\\\'',[like(term)]]);
    for(const term of category.rules.body)parts.push(['lower(g.authored_text) LIKE ? ESCAPE \'\\\'',[like(term)]]);
    for(const term of category.rules.labels)parts.push(['EXISTS(SELECT 1 FROM json_each(g.labels_json) WHERE lower(value)=?)',[term]]);
    return {sql:'('+parts.map(part=>part[0]).join(' OR ')+')',params:parts.flatMap(part=>part[1])};
  }
  if(folder==='all')return {sql:"NOT EXISTS(SELECT 1 FROM json_each(g.labels_json) WHERE value IN ('SPAM','TRASH'))",params:[]};
  if(folder==='primary')return {sql:"EXISTS(SELECT 1 FROM json_each(g.labels_json) WHERE value='INBOX') AND (EXISTS(SELECT 1 FROM json_each(g.labels_json) WHERE value='CATEGORY_PERSONAL') OR NOT EXISTS(SELECT 1 FROM json_each(g.labels_json) WHERE value LIKE 'CATEGORY_%'))",params:[]};
  const labels={inbox:'INBOX',unread:'UNREAD',starred:'STARRED',drafts:'DRAFT',sent:'SENT',spam:'SPAM',trash:'TRASH'};
  if(!labels[folder])throw new Error('Unknown Gmail folder.');
  return {sql:'EXISTS(SELECT 1 FROM json_each(g.labels_json) WHERE value=?)',params:[labels[folder]]};
}

export class GmailOverlay {
  constructor(gmail){
    this.gmail=gmail;this.store=gmail.store;
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS gmail_view_categories(
      id TEXT PRIMARY KEY,name TEXT NOT NULL,rules_json TEXT NOT NULL,
      position INTEGER NOT NULL,created_at INTEGER NOT NULL);`);
    const insert=this.store.statement('INSERT OR IGNORE INTO gmail_view_categories(id,name,rules_json,position,created_at) VALUES(?,?,?,?,?)');
    builtins.forEach(([id,name,terms],index)=>insert.run(id,name,JSON.stringify(rules(terms)),index,Date.now()));
  }
  async account(id){
    await this.gmail.ready;
    const row=this.store.statement('SELECT id,email,enabled FROM gmail_accounts WHERE id=?').get(String(id||''));
    if(!row||!row.enabled||!this.gmail.vault.accounts[row.id])throw new Error('Choose a connected Gmail account.');
    return row;
  }
  categories(){
    return this.store.statement('SELECT * FROM gmail_view_categories ORDER BY position,name').all()
      .map(row=>({id:row.id,name:row.name,rules:json(row.rules_json)}));
  }
  async navigation(accountId){
    const account=await this.account(accountId),categories=this.categories();
    const base=`FROM gmail_messages g JOIN messages m ON m.id=g.message_id
      JOIN conversations c ON c.id=m.room_id WHERE g.account_id=? AND c.connected=1`;
    const count=chosen=>this.store.statement(`SELECT count(*) count ${base} AND ${chosen.sql}`).get(account.id,...chosen.params).count;
    const capability=(await this.gmail.status()).accounts.find(a=>a.id===account.id);
    return {account:{id:account.id,email:account.email,canDraft:capability.canDraft,canSend:capability.canSend,canManage:capability.canManage},
      folders:folders.map(([id,name])=>({id,name,count:count(selector(id))})),
      categories:categories.map(category=>({...category,count:count(selector('',category))}))};
  }
  async list({account,folder='primary',category='',query='',beforeTs=null,beforeId='',limit=40}={}){
    const chosen=await this.account(account),saved=category?this.categories().find(row=>row.id===category):null;
    if(category&&!saved)throw new Error('Gmail category not found.');
    const filter=selector(folder,saved),args=[chosen.id,...filter.params];
    let where=`g.account_id=? AND c.connected=1 AND ${filter.sql}`;
    if(query){
      if(typeof query!=='string'||query.length>150)throw new Error('Gmail search is too long.');
      where+=' AND (lower(coalesce(json_extract(g.headers_json,\'$.subject\'),\'\')) LIKE ? ESCAPE \'\\\' OR lower(coalesce(json_extract(g.headers_json,\'$.from\'),\'\')) LIKE ? ESCAPE \'\\\' OR lower(g.authored_text) LIKE ? ESCAPE \'\\\')';
      args.push(...Array(3).fill(like(query.trim().toLowerCase())));
    }
    if(beforeTs!==null){
      const stamp=Number(beforeTs);if(!Number.isSafeInteger(stamp)||typeof beforeId!=='string')throw new Error('Invalid Gmail page cursor.');
      where+=' AND (m.ts<? OR (m.ts=? AND m.id<?))';args.push(stamp,stamp,beforeId);
    }
    const size=Math.max(1,Math.min(60,Number(limit)||40));
    const rows=this.store.statement(`SELECT g.message_id,g.headers_json,g.labels_json,g.authored_text,m.ts,m.is_me,
      (SELECT count(*) FROM json_each(g.attachments_json)) attachments
      FROM gmail_messages g JOIN messages m ON m.id=g.message_id
      JOIN conversations c ON c.id=m.room_id WHERE ${where}
      ORDER BY m.ts DESC,m.id DESC LIMIT ?`).all(...args,size+1);
    const page=rows.slice(0,size).map(row=>{
      const headers=json(row.headers_json),labels=json(row.labels_json);
      return {id:row.message_id,from:decodeHeader(headers.from||''),to:decodeHeader(headers.to||''),
        subject:decodeHeader(headers.subject||'(No subject)'),snippet:row.authored_text.slice(0,230),
        at:row.ts,unread:labels.includes('UNREAD'),starred:labels.includes('STARRED'),draft:labels.includes('DRAFT'),
        attachments:row.attachments,labels};
    });
    const last=page.at(-1);
    return {messages:page,older:rows.length>size,before:last?{ts:last.at,id:last.id}:null};
  }
  async open(id){
    const row=this.store.statement(`SELECT g.*,m.body,m.ts,m.is_me,a.email,c.connected FROM gmail_messages g
      JOIN messages m ON m.id=g.message_id JOIN gmail_accounts a ON a.id=g.account_id
      JOIN conversations c ON c.id=m.room_id WHERE g.message_id=?`).get(String(id||''));
    if(!row||!row.connected)throw new Error('Gmail email not found.');
    await this.account(row.account_id);
    const headers=json(row.headers_json),labels=json(row.labels_json),attachments=json(row.attachments_json);
    const stored=new Set(this.store.statement('SELECT part_key FROM gmail_attachment_blobs WHERE message_id=?').all(row.message_id).map(item=>item.part_key));
    const failed=new Set(this.store.statement('SELECT part_key FROM gmail_attachment_failures WHERE message_id=?').all(row.message_id).map(item=>item.part_key));
    let reply=null;try{const {parent,...rest}=replyDefaults(this.store,row.message_id);reply=rest;}catch{}
    let all=[];
    try{all=[...addresses(reply?.to||headers.from||''),...addresses(headers.to||''),...addresses(headers.cc||'')];}catch{all=reply?.to?[reply.to]:[];}
    const to=[...new Map(all.filter(address=>address.toLowerCase()!==row.email.toLowerCase())
      .map(address=>[address.toLowerCase(),address])).values()];
    return {id:row.message_id,account:row.account_id,remoteId:row.remote_id,threadId:row.thread_id,
      from:decodeHeader(headers.from||''),to:decodeHeader(headers.to||''),cc:decodeHeader(headers.cc||''),
      subject:decodeHeader(headers.subject||'(No subject)'),at:row.ts,body:textBody(row,attachments),labels,
      unavailable:!!row.unavailable,reply,replyAll:reply?{...reply,to:to.join(', ')}:null,
      attachments:attachments.map(item=>({key:item.key,name:item.name,mime:item.mime,size:item.size,stored:stored.has(item.key),unavailable:failed.has(item.key)}))};
  }
  saveCategory({id='',name='',rules:input}={}){
    if(typeof name!=='string'||!name.trim()||name.length>45||/[\x00-\x1f]/.test(name))throw new Error('Enter a category name of at most 45 characters.');
    const normalized=rules(input),key=id||'custom:'+randomUUID();
    if(id&&!this.store.statement('SELECT 1 FROM gmail_view_categories WHERE id=?').get(id))throw new Error('Category not found.');
    const position=id?this.store.statement('SELECT position FROM gmail_view_categories WHERE id=?').get(id).position:
      this.store.statement('SELECT coalesce(max(position),0)+1 position FROM gmail_view_categories').get().position;
    this.store.statement(`INSERT INTO gmail_view_categories(id,name,rules_json,position,created_at) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,rules_json=excluded.rules_json`).run(key,name.trim(),JSON.stringify(normalized),position,Date.now());
    return {id:key,name:name.trim(),rules:normalized};
  }
  deleteCategory(id){
    if(builtins.some(row=>row[0]===id))throw new Error('Built-in categories can be edited but not removed.');
    const result=this.store.statement('DELETE FROM gmail_view_categories WHERE id=?').run(String(id||''));
    if(!result.changes)throw new Error('Category not found.');
    return {ok:true};
  }
}
