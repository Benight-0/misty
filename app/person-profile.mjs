// Read saved interpretations through Briefings so removed/edited evidence stays filtered.
export function roomMembers(store,id,{offset=0,limit=50}={}){
  if(!store.room(id))throw new Error('Conversation not found.');
  const total=store.statement('SELECT count(DISTINCT sender) n FROM messages WHERE room_id=?').get(id).n;
  const rows=store.statement(`SELECT i.*,count(*) message_count,max(m.ts) last_ts FROM messages m
    JOIN identities i ON i.id=m.sender WHERE m.room_id=? GROUP BY i.id
    ORDER BY i.is_me DESC,message_count DESC,i.id LIMIT ? OFFSET ?`).all(id,Math.min(100,limit),offset);
  return {rows,total,offset,limit:Math.min(100,limit)};
}

export function personProfile(store,briefings,id,{room='',offset=0,limit=5}={}){
  const identity=store.statement('SELECT * FROM identities WHERE id=?').get(id);
  if(!identity)throw new Error('Person not found.');
  limit=Math.max(1,Math.min(5,limit));
  const count=store.statement('SELECT count(*) messages,count(DISTINCT room_id) chats,min(ts) first,max(ts) last FROM messages WHERE sender=?').get(id);
  const chats=store.statement(`SELECT c.*,count(*) person_messages FROM messages m JOIN conversations c ON c.id=m.room_id
    WHERE m.sender=? GROUP BY c.id ORDER BY (c.id=?) DESC,c.last_ts DESC,c.id LIMIT ? OFFSET ?`).all(id,room,limit,offset);
  return {identity,coverage:count,total:count.chats,offset,limit,chats:chats.map(chat=>{
    const data=briefings.room(chat.id),p=data.payload;
    const person=p?.people.find(p=>p.id===id||p.senders?.includes(id)||(identity.is_me&&p.is_me));
    return {room:{id:chat.id,name:chat.alias||chat.name,platform:chat.platform,kind:chat.kind,message_count:chat.message_count,
      person_messages:chat.person_messages,last_ts:chat.last_ts,connected:chat.connected},
      person:person||null,summary:p?.overview||[],recent:p?.recent||[],followups:p?.followups||[],
      events:data.events?.filter(e=>person&&e.people?.includes(person.id))||[],
      generatedAt:data.generatedAt||null,stale:!!data.stale,model:data.model||'',history:data.history||null,
      coverage:p?.coverage||null,reason:data.eligible?'':data.reason};
  })};
}
