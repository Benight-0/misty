import {createHash} from 'node:crypto';
import {TOPICS} from './analysis.mjs';
import {cleanBody} from './identity.mjs';
import {resolveDiscordId} from './discord-history-store.mjs';
import {whatsappGroupSchema} from './whatsapp-groups.mjs';
import {discordServerPolicySchema} from './discord-server-policies.mjs';

export const PRIVATE_SCOPE="((platform='discord' AND ((server_id='' AND kind IN ('dm','group')) OR (kind='channel' AND server_id IN (SELECT server_id FROM discord_server_policies WHERE treatment IN ('G','GP'))))) OR (platform='whatsapp' AND (kind='dm' OR (kind='group' AND message_count>0 AND id IN (SELECT room_id FROM whatsapp_group_policies WHERE treatment='G')))))";
export const BRIEFING_VERSION='2026-10-10.full-history.2';
export const insightEligible=room=>!!room&&!!room.connected&&((room.platform==='discord'&&(!room.server_id&&['dm','group'].includes(room.kind)||room.kind==='channel'&&['G','GP'].includes(room.discordPolicy?.treatment)))||(room.platform==='whatsapp'&&(room.kind==='dm'||(room.kind==='group'&&room.message_count>0&&room.groupPolicy?.treatment==='G'))));
export function briefingSchema(db){
  whatsappGroupSchema(db);discordServerPolicySchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS briefing_jobs(room_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL DEFAULT 1,completed_revision INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'queued',
    enabled INTEGER NOT NULL DEFAULT 1,force INTEGER NOT NULL DEFAULT 0,changed_at INTEGER NOT NULL DEFAULT 0,
    generated_at INTEGER NOT NULL DEFAULT 0,not_before INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS chat_briefings(room_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,generated_at INTEGER NOT NULL,model TEXT NOT NULL,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS private_chat_events(id TEXT PRIMARY KEY,room_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',date TEXT NOT NULL DEFAULT '',time TEXT NOT NULL DEFAULT '',
      timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',status TEXT NOT NULL DEFAULT 'proposed',origin TEXT NOT NULL DEFAULT 'user',
      people TEXT NOT NULL DEFAULT '[]',evidence TEXT NOT NULL DEFAULT '[]',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS private_chat_events_room ON private_chat_events(room_id,date);
    CREATE INDEX IF NOT EXISTS briefing_jobs_status ON briefing_jobs(status,not_before);
    CREATE TABLE IF NOT EXISTS private_person_notes(room_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      person_id TEXT NOT NULL,label TEXT NOT NULL DEFAULT '',note TEXT NOT NULL DEFAULT '',updated_at INTEGER NOT NULL,
      PRIMARY KEY(room_id,person_id));
    CREATE TABLE IF NOT EXISTS briefing_history_nodes(room_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      hash TEXT NOT NULL,stage TEXT NOT NULL,ordinal INTEGER NOT NULL,first_ts INTEGER,last_ts INTEGER,
      parts INTEGER NOT NULL,messages INTEGER NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL,
      PRIMARY KEY(room_id,hash));
    CREATE TABLE IF NOT EXISTS briefing_history_progress(room_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,total_messages INTEGER NOT NULL,texts INTEGER NOT NULL,excluded INTEGER NOT NULL,
      total_parts INTEGER NOT NULL,completed_parts INTEGER NOT NULL,total_batches INTEGER NOT NULL,
      completed_batches INTEGER NOT NULL,stage TEXT NOT NULL,updated_at INTEGER NOT NULL);
  `);
  if(!db.prepare('PRAGMA table_info(briefing_history_progress)').all().some(c=>c.name==='completed_texts'))db.exec('ALTER TABLE briefing_history_progress ADD COLUMN completed_texts INTEGER NOT NULL DEFAULT 0');
  const change=`INSERT INTO briefing_jobs(room_id,changed_at) SELECT NEW.room_id,CAST(unixepoch('subsec')*1000 AS INTEGER)
      FROM conversations WHERE id=NEW.room_id AND connected=1 AND ${PRIVATE_SCOPE}
      ON CONFLICT(room_id) DO UPDATE SET revision=revision+1,status=CASE WHEN enabled=1 THEN 'queued' ELSE 'paused' END,
        changed_at=excluded.changed_at,error='';`;
  const groupTriggerVersion='2026-10-23.discord-group-history.2';
  if(db.prepare("SELECT value FROM settings WHERE key='briefing_trigger_version'").get()?.value!==JSON.stringify(groupTriggerVersion)){
   db.exec('DROP TRIGGER IF EXISTS briefing_message_insert; DROP TRIGGER IF EXISTS briefing_message_update;');
   db.prepare("INSERT INTO settings VALUES('briefing_trigger_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(groupTriggerVersion));
  }
  db.exec(`CREATE TRIGGER IF NOT EXISTS briefing_message_insert AFTER INSERT ON messages BEGIN ${change} END;
    CREATE TRIGGER IF NOT EXISTS briefing_message_update AFTER UPDATE OF body,sender,is_me,ts ON messages
      WHEN OLD.body<>NEW.body OR OLD.sender<>NEW.sender OR OLD.is_me<>NEW.is_me OR OLD.ts<>NEW.ts BEGIN ${change} END;
    CREATE TRIGGER IF NOT EXISTS briefing_message_delete AFTER DELETE ON messages BEGIN
      UPDATE briefing_jobs SET revision=revision+1,status=CASE WHEN enabled=1 THEN 'queued' ELSE 'paused' END,
        changed_at=CAST(unixepoch('subsec')*1000 AS INTEGER),error='' WHERE room_id=OLD.room_id; END;`);
}

export function dayInIndia(ts){return new Date(ts+330*60000).toISOString().slice(0,10);}
export function validDay(day){return typeof day==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(day)&&!Number.isNaN(Date.parse(day))&&new Date(day+'T00:00:00Z').toISOString().slice(0,10)===day;}
function addDays(day,n){return new Date(Date.parse(day+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);}
export function dateCues(text,ts){
  const result=new Set(),base=dayInIndia(ts);
  for(const match of text.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)){const day=match[0];if(validDay(day))result.add(day);}
  for(const match of text.matchAll(/\b(\d{1,2})[/.](\d{1,2})[/.](20\d{2})\b/g)){const day=match[3]+'-'+match[2].padStart(2,'0')+'-'+match[1].padStart(2,'0');if(validDay(day))result.add(day);}
  if(/\bday after tomorrow\b/i.test(text))result.add(addDays(base,2));
  else if(/\btomorrow\b|\bkal\b/i.test(text)){
    // Hindi/Hinglish "kal" may mean yesterday as well; leave it unresolved.
    if(/\btomorrow\b/i.test(text))result.add(addDays(base,1));
  }
  if(/\btoday\b|\btonight\b/i.test(text))result.add(base);
  const weekdays=['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  for(const match of text.matchAll(/\b(next\s+|this\s+|on\s+)(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi)){
    const current=new Date(base+'T00:00:00Z').getUTCDay();let delta=(weekdays.indexOf(match[2].toLowerCase())-current+7)%7;
    if(match[1].trim().toLowerCase()==='next'&&delta===0)delta=7;
    result.add(addDays(base,delta));
  }
  const months=['january','february','march','april','may','june','july','august','september','october','november','december'];
  const monthPattern='('+months.map(x=>x+'|'+x.slice(0,3)).join('|')+')';
  const patterns=[new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+'+monthPattern+'(?:[ ,]+(20\\d{2}))?\\b','gi'),new RegExp('\\b'+monthPattern+'\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:[ ,]+(20\\d{2}))?\\b','gi')];
  for(let p=0;p<patterns.length;p++)for(const m of text.matchAll(patterns[p])){
    const month=months.findIndex(x=>x.startsWith(m[p===0?2:1].toLowerCase()))+1,day=Number(m[p===0?1:2]);
    // Missing years are deliberately unresolved: an old message may refer to a different year.
    if(!m[3])continue;const date=m[3]+'-'+String(month).padStart(2,'0')+'-'+String(day).padStart(2,'0');if(validDay(date))result.add(date);
  }
  return [...result];
}

const clips=s=>String(s).slice(0,650);
export function prepareBriefing(store,roomId,now=Date.now(),{full=false}={}){
  const room=store.room(roomId);if(!insightEligible(room))throw new Error('Briefings are limited to connected private chats and WhatsApp groups classified G with downloaded history.');
  const excluded=new Set(store.get('profile_excluded_messages',[]).map(id=>resolveDiscordId(store,id)));
  const all=store.statement(`SELECT m.id,m.sender,m.ts,m.is_me,m.type,coalesce(json_extract(d.raw_json,'$.author.bot'),0) AS is_bot,
    CASE WHEN d.raw_json IS NOT NULL THEN coalesce(json_extract(d.raw_json,'$.content'),'') ELSE m.body END AS body,
    coalesce(nullif(i.alias,''),nullif(i.name,''),i.id) AS author FROM messages m JOIN identities i ON i.id=m.sender
    LEFT JOIN discord_remote d ON d.message_id=m.id WHERE m.room_id=? ORDER BY m.ts,m.id`).all(roomId);
  const persons=new Map(),texts=[];const recentAfter=now-30*86400000,priorAfter=now-60*86400000;
  const trends=TOPICS.map(t=>({id:t.id,title:t.name,recent:0,previous:0,evidence:[]}));let recentTotal=0,priorTotal=0;
  for(const row of all){
    const key=row.is_me?'self':row.sender;
    if(!persons.has(key))persons.set(key,{id:key,name:row.is_me?'You':row.author,is_me:!!row.is_me,is_bot:!!row.is_bot,senders:[],messages:0,texts:0,first:row.ts,last:row.ts,topics:new Map(),examples:[]});
    const person=persons.get(key);if(!person.senders.includes(row.sender))person.senders.push(row.sender);person.messages++;person.last=row.ts;
    const body=cleanBody(row.body);
    if(row.is_bot||row.type==='m.notice'||!body||(!full&&(excluded.has(row.id)||body.length<3||/^(\[?(image|sticker|attachment|video|audio|file)\]?|https?:\/\/\S+)$/i.test(body)||/^forwarded\b/i.test(body))))continue;
    if(full&&row.type!=='m.text'&&row.type!=='m.emote'&&/^\[?(image|sticker|attachment|video|audio|file)\]?$/i.test(body))continue;
    const message={...row,body,person:key,profileEligible:!excluded.has(row.id)&&!/^forwarded\b/i.test(body),signature:createHash('sha256').update(body).digest('hex')};texts.push(message);person.texts++;
    const rec=row.ts>=recentAfter&&row.ts<=now,prev=row.ts>=priorAfter&&row.ts<recentAfter;if(rec)recentTotal++;if(prev)priorTotal++;
    for(let i=0;i<TOPICS.length;i++)if(TOPICS[i].pattern.test(body)){
      if(!person.topics.has(TOPICS[i].id))person.topics.set(TOPICS[i].id,{id:TOPICS[i].id,title:TOPICS[i].name,count:0,evidence:[]});
      const topic=person.topics.get(TOPICS[i].id);topic.count++;topic.evidence.push(row.id);if(topic.evidence.length>3)topic.evidence.shift();
      if(rec){trends[i].recent++;trends[i].evidence.push(row.id);if(trends[i].evidence.length>3)trends[i].evidence.shift();}else if(prev)trends[i].previous++;
    }
    person.examples.push(message);if(person.examples.length>5)person.examples.shift();
  }
  const people=[...persons.values()].sort((a,b)=>b.messages-a.messages);
  const selected=new Map(),pick=m=>{if(m&&!selected.has(m.id))selected.set(m.id,m);};
  // Recency, every author, lifetime span and concrete plans each get a share of the bounded sample.
  if(full)texts.forEach(pick);
  else texts.slice(-70).forEach(pick);
  for(const person of people)person.examples.slice(-3).forEach(pick);
  for(let i=0;i<32&&texts.length;i++)pick(texts[Math.floor(i*(texts.length-1)/31)]);
  texts.filter(m=>/\b(i (?:like|love|prefer|enjoy|study|work|want)|i'?m (?:working|studying|learning)|deadline|meet|tomorrow|submit|plan|cancel|decided|agreed)\b/i.test(m.body)).slice(-40).forEach(pick);
  const chosen=[];let bytes=0;for(const m of selected.values()){const text=full?m.body:clips(m.body);if(!full&&bytes+text.length>24000)continue;bytes+=text.length;chosen.push({...m,body:text});}
  chosen.sort((a,b)=>a.ts-b.ts||a.id.localeCompare(b.id));
  const refs=new Map(),personRefs=new Map(people.map((p,i)=>['p'+i,p]));
  const messages=chosen.map((m,i)=>{const ref='m'+i;refs.set(ref,m);return {ref,person:[...personRefs].find(([,p])=>p.id===m.person)[0],at:new Date(m.ts).toISOString(),text:m.body,allowed_dates:dateCues(m.body,m.ts)};});
  const topTopics=TOPICS.map(topic=>({id:topic.id,title:topic.name,count:people.reduce((sum,p)=>sum+(p.topics.get(topic.id)?.count||0),0),evidence:people.flatMap(p=>p.topics.get(topic.id)?.evidence||[]).slice(-4)})).filter(t=>t.count).sort((a,b)=>b.count-a.count).slice(0,8);
  const emerging=trends.filter(t=>t.recent>=3&&(priorTotal===0||t.recent/Math.max(1,recentTotal)>=1.5*t.previous/priorTotal)&&t.recent>t.previous)
    .sort((a,b)=>b.recent-a.recent).slice(0,6).map(t=>({...t,recentShare:t.recent/Math.max(1,recentTotal),previousShare:t.previous/Math.max(1,priorTotal),label:priorTotal?'Gaining attention':'Active recently · no comparison history'}));
  const baseline={analysisVersion:BRIEFING_VERSION,room:{id:room.id,name:room.alias||room.name,platform:room.platform,kind:room.kind},coverage:{messages:all.length,texts:texts.length,sampled:chosen.length,first:all[0]?.ts||null,last:all.at(-1)?.ts||null,recentTotal,priorTotal,generatedAt:now},topics:topTopics,trends:emerging,
    people:people.map(p=>({id:p.id,name:p.name,is_me:p.is_me,is_bot:p.is_bot,senders:p.senders,messages:p.messages,texts:p.texts,first:p.first,last:p.last,topics:[...p.topics.values()].sort((a,b)=>b.count-a.count).slice(0,5),observations:[],preferences:[]})),overview:[],recent:[],followups:[],suggestedEvents:[],sourceVersions:Object.fromEntries(chosen.map(m=>[m.id,m.signature]))};
  return {baseline,refs,personRefs,input:{today:dayInIndia(now),timezone:'Asia/Kolkata',room:baseline.room,coverage:baseline.coverage,people:[...personRefs].filter(([,p])=>!p.is_bot).map(([ref,p])=>({ref,name:p.name,is_me:p.is_me,text_messages:p.texts,topics:baseline.people.find(x=>x.id===p.id).topics.map(x=>x.title)})),messages}};
}

const plain=(value,max=1200)=>typeof value==='string'?value.trim().slice(0,max):'';
export function validateBriefing(output,snapshot){
  if(!output||typeof output!=='object'||Array.isArray(output))throw new Error('The local model returned an invalid briefing.');
  const {baseline,refs,personRefs}=snapshot;
  const byId=new Map(),dates=new WeakMap();
  for(const m of refs.values()){if(!byId.has(m.id))byId.set(m.id,[]);byId.get(m.id).push(m);}
  const supported=(id,predicate)=>byId.get(id)?.some(predicate);
  const allowed=m=>{if(!dates.has(m))dates.set(m,dateCues(m.body,m.ts));return dates.get(m);};
  const readable=value=>{
    let text=plain(value).replace(/\[\s*m\d+(?:\s*,\s*m\d+)*\s*\]|\(\s*m\d+(?:\s*,\s*m\d+)*\s*\)/g,'');
    for(const [ref,person] of personRefs)text=text.replace(new RegExp('\\b'+ref+'\\b','g'),person.name);
    return text.replace(/ +([.,])/g,'$1').replace(/ {2,}/g,' ').trim();
  };
  const claims=(values,person=null,max=5)=>Array.isArray(values)?values.slice(0,max).flatMap(item=>{
    if(!item||typeof item!=='object')return [];const text=readable(item.text);
    const sources=Array.isArray(item.sources)?[...new Set(item.sources)].filter(ref=>refs.has(ref)&&(!person||(refs.get(ref).person===person&&refs.get(ref).profileEligible!==false))):[];
    return text&&sources.length?[{text,evidence:sources.map(r=>refs.get(r).id)}]:[];
  }):[];
  const detailed=snapshot.stage==='map'||snapshot.stage==='reduce';
  baseline.overview=claims(output.overview,null,detailed?12:6);baseline.recent=claims(output.recent,null,4);baseline.followups=claims(output.followups,null,detailed?12:8);
  const latest=baseline.coverage.last||0;
  baseline.recent=baseline.recent.filter(c=>c.evidence.some(id=>supported(id,m=>m.ts>=latest-7*86400000)));
  baseline.followups=baseline.followups.filter(c=>c.evidence.some(id=>supported(id,m=>m.ts>=baseline.coverage.generatedAt-60*86400000||allowed(m).some(d=>d>=dayInIndia(baseline.coverage.generatedAt)))));
  for(const entry of Array.isArray(output.people)?output.people:[]){const p=personRefs.get(entry?.person);if(!p)continue;const person=baseline.people.find(x=>x.id===p.id);
    person.observations=claims(entry.observations,p.id,detailed?8:6);person.preferences=claims(entry.preferences,p.id,detailed?8:6).filter(c=>c.evidence.some(id=>supported(id,m=>/\b(i (?:like|love|prefer|enjoy|hate|dislike|want|need|avoid)|my favou?rite|i'?m (?:into|interested)|mujhe|mera|meri|mere|mai|main)\b|मुझे|पसंद/i.test(m.body))));
  }
  const seen=new Set();
  for(const event of Array.isArray(output.events)?output.events.slice(0,12):[]){
    const title=plain(event?.title,200),sources=Array.isArray(event?.sources)?[...new Set(event.sources)].filter(x=>refs.has(x)):[];if(!title||!sources.length)continue;
    // A single stable source key prevents re-generation from duplicating an event with revised wording/date.
    const primary=sources.find(ref=>allowed(refs.get(ref)).length)||sources[0];
    const id=suggestionId(baseline.room.id,refs.get(primary).id);if(seen.has(id))continue;seen.add(id);
    const allowedDays=sources.flatMap(ref=>allowed(refs.get(ref)));
    const date=validDay(event.date)&&allowedDays.includes(event.date)?event.date:'';
    baseline.suggestedEvents.push({id,room_id:baseline.room.id,title,description:plain(event.description,1800),date,time:'',timezone:'Asia/Kolkata',status:'proposed',origin:'model',needsDateReview:!date,
      people:(Array.isArray(event.people)?event.people:[]).filter(p=>personRefs.has(p)).map(p=>personRefs.get(p).id),evidence:sources.map(ref=>refs.get(ref).id)});
  }
  if(baseline.coverage.texts&&!baseline.overview.length)throw new Error('No grounded summary was returned. The archive and previous briefing are preserved.');
  return baseline;
}

function suggestionId(room,id){return 'suggestion-'+createHash('sha256').update(room+'\0'+id).digest('hex').slice(0,24);}
export function previewBriefing(snapshot){
  const {baseline,refs}=snapshot,messages=[...refs.values()];
  baseline.overview=messages.slice(-3).reverse().map(m=>({text:`${dayInIndia(m.ts)} · ${m.is_me?'You':m.author}: “${m.body.slice(0,240)}${m.body.length>240?'…':''}”`,evidence:[m.id]}));
  const today=dayInIndia(baseline.coverage.generatedAt);
  baseline.suggestedEvents=messages.filter(m=>/\b(meet|meeting|call|deadline|submit|submission|exam|interview|appointment|competition|contest|schedule|session)\b/i.test(m.body)&&dateCues(m.body,m.ts).some(d=>d>=today))
    .slice(-6).map(m=>({id:suggestionId(baseline.room.id,m.id),room_id:baseline.room.id,title:m.body.slice(0,160),description:'Extracted date mention; review the original message and any later changes before confirming.',date:dateCues(m.body,m.ts).find(d=>d>=today)||'',time:'',timezone:'Asia/Kolkata',status:'proposed',origin:'model',needsDateReview:true,people:[m.person],evidence:[m.id]}));
  return baseline;
}

export function storedEvents(store,roomId=''){
  return store.statement('SELECT * FROM private_chat_events'+(roomId?' WHERE room_id=?':'')+' ORDER BY date,time,created_at').all(...(roomId?[roomId]:[]))
    .filter(row=>insightEligible(store.room(row.room_id))).map(row=>({...row,people:JSON.parse(row.people),evidence:JSON.parse(row.evidence)}));
}
export function evidenceCurrent(store,roomId,id,signature){
  const row=store.statement(`SELECT CASE WHEN d.raw_json IS NOT NULL THEN coalesce(json_extract(d.raw_json,'$.content'),'') ELSE m.body END body
    FROM messages m LEFT JOIN discord_remote d ON d.message_id=m.id WHERE m.id=? AND m.room_id=?`).get(id,roomId);
  return !!row&&(!signature||createHash('sha256').update(cleanBody(row.body)).digest('hex')===signature);
}
export function savePersonNote(store,{room_id,person_id,label='',note=''},now=Date.now()){
  if(!insightEligible(store.room(room_id)))throw new Error('Choose a connected private chat.');
  const authors=new Set(store.statement('SELECT DISTINCT sender,is_me FROM messages WHERE room_id=?').all(room_id).map(x=>x.is_me?'self':x.sender));
  const saved=store.statement('SELECT person_id FROM private_person_notes WHERE room_id=? AND person_id=?').get(room_id,person_id);
  if((!authors.has(person_id)&&!saved)||typeof label!=='string'||typeof note!=='string'||label.length>150||note.length>4000)throw new Error('Choose an author in this chat and keep the note under 4,000 characters.');
  store.statement('INSERT INTO private_person_notes VALUES(?,?,?,?,?) ON CONFLICT(room_id,person_id) DO UPDATE SET label=excluded.label,note=excluded.note,updated_at=excluded.updated_at')
    .run(room_id,person_id,label.trim(),note.trim(),now);
  return {room_id,person_id,label:label.trim(),note:note.trim()};
}
export function saveChatEvent(store,input,now=Date.now()){
  const room=store.room(input.room_id);if(!insightEligible(room))throw new Error('Choose a connected private chat.');
  const old=input.id?store.statement('SELECT * FROM private_chat_events WHERE id=?').get(input.id):null;
  if(old&&old.room_id!==room.id)throw new Error('The event belongs to a different chat.');
  const title=plain(input.title,200),description=plain(input.description,3000),date=input.date||'',time=input.time||'',status=input.status||'proposed';
  if(!title||date&&!validDay(date)||time&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)||!['proposed','confirmed','done','dismissed','cancelled'].includes(status))throw new Error('Check the event title, date, time and status.');
  const people=Array.isArray(input.people)?[...new Set(input.people)].slice(0,80):[];
  const authors=new Set(store.statement('SELECT DISTINCT sender,is_me FROM messages WHERE room_id=?').all(room.id).map(x=>x.is_me?'self':x.sender));
  for(const p of old?JSON.parse(old.people):[])authors.add(p);
  if(people.some(p=>!authors.has(p)))throw new Error('Choose people from this chat.');
  const given=Array.isArray(input.evidence)?[...new Set(input.evidence)].slice(0,12):[];
  if(given.some(id=>typeof id!=='string'))throw new Error('Event evidence must belong to this chat.');
  const evidence=given.map(id=>resolveDiscordId(store,id)),previous=new Set(old?JSON.parse(old.evidence).map(id=>resolveDiscordId(store,id)):[]);
  if(evidence.some(id=>!store.statement('SELECT id FROM messages WHERE id=? AND room_id=?').get(id,room.id)&&!previous.has(id)))throw new Error('Event evidence must belong to this chat.');
  let id=old?.id;
  if(!id&&input.id?.startsWith('suggestion-')){
    const payload=store.statement('SELECT payload FROM chat_briefings WHERE room_id=?').get(room.id);
    if(!payload||!JSON.parse(payload.payload).suggestedEvents.some(x=>x.id===input.id))throw new Error('This event suggestion is no longer available. Refresh the briefing.');id=input.id;
  }
  if(!id)id='event-'+createHash('sha256').update(room.id+'\0'+now+'\0'+Math.random()).digest('hex').slice(0,24);
  store.statement(`INSERT INTO private_chat_events(id,room_id,title,description,date,time,status,origin,people,evidence,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,date=excluded.date,time=excluded.time,
      status=excluded.status,people=excluded.people,evidence=excluded.evidence,updated_at=excluded.updated_at`)
    .run(id,room.id,title,description,date,time,status,old?.origin|| (id.startsWith('suggestion-')?'model':'user'),JSON.stringify(people),JSON.stringify(evidence),old?.created_at||now,now);
  return storedEvents(store,room.id).find(x=>x.id===id);
}
