import fs from 'node:fs';
import path from 'node:path';

const input=process.argv[2];
if(!input)throw new Error('Usage: node scripts/export-whatsapp-group-list.mjs SNAPSHOT.json');
const snapshot=JSON.parse(fs.readFileSync(input,'utf8').replace(/^\uFEFF/,''));
if(snapshot.source!=='whatsapp_joined_groups'||!Array.isArray(snapshot.groups)||!Number.isSafeInteger(snapshot.at))throw new Error('Expected a live joined-group snapshot.');
const byId=new Map(snapshot.groups.map(g=>[g.id,g]));
const chats=snapshot.groups.filter(g=>!g.community).sort((a,b)=>a.name.localeCompare(b.name,'en')||a.id.localeCompare(b.id));
const communities=snapshot.groups.filter(g=>g.community).sort((a,b)=>a.name.localeCompare(b.name,'en')||a.id.localeCompare(b.id));
const time=new Intl.DateTimeFormat('en-IN',{timeZone:'Asia/Kolkata',dateStyle:'long',timeStyle:'long'}).format(new Date(snapshot.at));
const escape=text=>text.replace(/[\\`*_[\]<>]/g,'\\$&').replace(/[\r\n]+/g,' ');
const lines=[
 '# Current WhatsApp memberships', '', `Fetched directly from the linked WhatsApp account: **${time}**.`, '',
 `**${chats.length} group chats** and **${communities.length} community containers** (${snapshot.groups.length} entries total).`, '',
 'Community containers organize groups; they are listed separately from their chat groups. Archived groups you have left and Status broadcasts are not included.', '',
 'Replace `[ ]` before each entry with `[server]`, `[group DM]`, or `[ignore]` to classify it. All treatment choices are unassigned. Existing collection and analysis selections were preserved.', '',
 '## Group chats', '',
];
const plain=[`Current WhatsApp memberships — ${time}`,`${chats.length} group chats; ${communities.length} community containers.`, 'Choose: server / group DM / ignore. All choices remain unassigned.', ''];
const review=[];
for(const [section,groups] of [['chats',chats],['communities',communities]]){
 if(section==='communities'){lines.push('', '## Community containers', '');plain.push('', 'Community containers');}
 for(const group of groups){
  const number=review.length+1;
  const name=group.name||`Name unavailable (${group.id})`;
  const parent=byId.get(group.parent)?.name||group.parent;
  const labels=[];
  if(group.announcement&&!group.community)labels.push('admins-only posting');
  if(parent)labels.push(`community: ${parent}`);
  const suffix=labels.length?' — '+labels.join('; '):'';
  lines.push(`${number}. [ ] **${escape(name)}**${escape(suffix)}`);
  plain.push(`${number}. ${name}${suffix}`);
  review.push({number,name:group.name,id:group.id,type:group.community?'community':'group',community:parent||'',treatment:''});
 }
}
const unnamed=chats.filter(g=>!g.name);
if(unnamed.length)lines.push('', `WhatsApp returned no name for ${unnamed.length} group(s), even after individual metadata lookups. Their IDs are retained above; no name was guessed.`);
const base=input.replace(/\.json$/i,'');
fs.writeFileSync(base+'.md',lines.join('\n')+'\n');
fs.writeFileSync(base+'.txt',plain.join('\n')+'\n');
fs.writeFileSync(base+'-review.json',JSON.stringify({fetchedAt:snapshot.at,source:snapshot.source,entries:review},null,2)+'\n');
console.log(JSON.stringify({time,groupChats:chats.length,communities:communities.length,total:review.length,unnamed:unnamed.length,files:[path.resolve(base+'.md'),path.resolve(base+'.txt'),path.resolve(base+'-review.json')]}));
