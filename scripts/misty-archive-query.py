"""Bounded archive reads. No credentials, settings, raw platform payloads or write SQL."""
import hashlib
import json
import re
import sqlite3
import sys
import time
from pathlib import Path
from urllib.parse import quote

VIEWS = {
 'chats': "SELECT c.id,c.name,c.alias,c.platform,c.kind,c.server_name,c.message_count,c.own_count,c.first_ts,c.last_ts,CASE WHEN c.platform='discord' THEN coalesce(d.treatment,'') ELSE coalesce(g.treatment,'') END treatment FROM conversations c LEFT JOIN discord_server_policies d ON d.server_id=c.server_id LEFT JOIN whatsapp_group_policies g ON g.room_id=c.id WHERE c.connected=1 AND c.platform IN ('discord','whatsapp','gmail')",
 'chat_messages': "SELECT m.id,m.room_id,m.sender,m.ts,m.body,m.is_me,m.type FROM messages m JOIN conversations c ON c.id=m.room_id WHERE c.connected=1 AND c.platform IN ('discord','whatsapp','gmail')",
 'people': "SELECT i.id,i.name,i.alias,i.platform,i.is_me FROM identities i WHERE EXISTS(SELECT 1 FROM messages m JOIN conversations c ON c.id=m.room_id WHERE m.sender=i.id AND c.connected=1 AND c.platform IN ('discord','whatsapp','gmail'))",
 'briefings': "SELECT b.room_id,b.generated_at,b.model,b.revision,j.revision current_revision,json_extract(b.payload,'$.coverage') coverage FROM chat_briefings b JOIN conversations c ON c.id=b.room_id LEFT JOIN briefing_jobs j ON j.room_id=b.room_id WHERE c.connected=1 AND c.platform IN ('discord','whatsapp','gmail')",
 'interests': "SELECT id,title,category,summary,confidence,status,source,tags,evidence_ids,updated_at FROM profile_findings WHERE status<>'dismissed'"
}

def connect(filename):
    db=sqlite3.connect(Path(filename).resolve().as_uri()+'?mode=ro',uri=True,timeout=1)
    db.row_factory=sqlite3.Row
    db.execute('PRAGMA cache_size=-2048')
    db.execute('PRAGMA temp_store=MEMORY')
    for name,sql in VIEWS.items(): db.execute(f'CREATE TEMP VIEW {name} AS {sql}')
    return db

def bounded(rows,limit=100,bytes_limit=100000):
    out=[];size=0;truncated=False
    for row in rows:
        item=dict(row)
        for k,v in item.items():
            if isinstance(v,str) and len(v)>6000:item[k]=v[:6000];truncated=True
        n=len(json.dumps(item).encode())
        if len(out)>=limit or size+n>bytes_limit:truncated=True;break
        out.append(item);size+=n
    return {'rows':out,'truncated':truncated}

def query(db,sql,params):
    # CTE names can imitate authorizer view-source labels. Reject WITH entirely;
    # ordinary joins/subqueries/aggregates over the fixed views remain available.
    if not isinstance(sql,str) or len(sql)>8000 or not re.match(r'^\s*SELECT\b',sql,re.I) or re.search(r'\bWITH\b',sql,re.I):raise ValueError('Use SELECT over the documented views; CTEs are not supported.')
    if not isinstance(params,list) or len(params)>30 or any(type(v) not in (str,int,float,type(None)) for v in params):raise ValueError('Invalid parameters.')
    allowed_functions={'count','sum','avg','min','max','coalesce','nullif','lower','upper','length','substr','substring','abs','round','strftime','date','datetime','unixepoch','json_extract','json_array_length','like','glob','ifnull','total','group_concat'}
    def authorize(action,a,b,database,source):
        if action==sqlite3.SQLITE_SELECT:return sqlite3.SQLITE_OK
        if action==sqlite3.SQLITE_READ:
            return sqlite3.SQLITE_OK if (database=='temp' and a in VIEWS) or source in VIEWS else sqlite3.SQLITE_DENY
        if action==sqlite3.SQLITE_FUNCTION:return sqlite3.SQLITE_OK if (b or a or '').lower() in allowed_functions else sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_DENY
    db.set_authorizer(authorize)
    old_length=db.setlimit(sqlite3.SQLITE_LIMIT_LENGTH,131072)
    old_depth=db.setlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH,40)
    deadline=time.monotonic()+1.5
    db.set_progress_handler(lambda:int(time.monotonic()>deadline),1000)
    try:return bounded(db.execute(sql,params))
    finally:db.set_authorizer(None);db.set_progress_handler(None,0);db.setlimit(sqlite3.SQLITE_LIMIT_LENGTH,old_length);db.setlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH,old_depth)

def summary(db,room,person=''):
    row=db.execute('SELECT b.*,j.revision current_revision FROM chat_briefings b JOIN conversations c ON c.id=b.room_id LEFT JOIN briefing_jobs j ON j.room_id=b.room_id WHERE b.room_id=? AND c.connected=1',(room,)).fetchone()
    if not row:return {'available':False}
    data=json.loads(row['payload']);versions=data.get('sourceVersions',{});checked={}
    def current(mid):
        if mid not in checked:
            msg=db.execute("SELECT CASE WHEN d.raw_json IS NOT NULL THEN coalesce(json_extract(d.raw_json,'$.content'),'') ELSE m.body END body FROM messages m LEFT JOIN discord_remote d ON d.message_id=m.id WHERE m.id=? AND m.room_id=?",(mid,room)).fetchone()
            body=re.sub(r'^(?:>[^\n]*\n)+\n','',msg['body'] or '').strip() if msg else ''
            checked[mid]=bool(msg) and (not versions.get(mid) or hashlib.sha256(body.encode()).hexdigest()==versions[mid])
        return checked[mid]
    def clean(items):return [c for c in items if c.get('evidence') and all(current(x) for x in c['evidence'])][:15]
    people=[]
    selected=[p for p in data.get('people',[]) if not person or p.get('id')==person or person in p.get('senders',[])]
    for p in selected[:35]:
        people.append({k:p.get(k) for k in ('id','name','is_me','messages')}|{'observations':clean(p.get('observations',[]))[:4],'preferences':clean(p.get('preferences',[]))[:4]})
    return {'available':True,'room':room,'generatedAt':row['generated_at'],'stale':row['revision']!=row['current_revision'],'model':row['model'],'coverage':data.get('coverage'),
      'overview':clean(data.get('overview',[])),'recent':clean(data.get('recent',[])),'followups':clean(data.get('followups',[])),'people':people,
      'events':clean(data.get('suggestedEvents',[])),'detailLimit':'Up to 15 claims per section and 35 people, 4 observations/preferences each. Select a person ID to focus; use message search for more evidence.'}

def run(db,request):
    op=request.get('op');p=request.get('args') or {}
    discord_policies={}
    if op in ('watch_context','events') and db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='discord_server_policies'").fetchone():
        discord_policies={r['server_id']:dict(r) for r in db.execute('SELECT server_id,treatment,from_ts FROM discord_server_policies')}
    if op=='watch_context':
        # One snapshot for a notification job, with the current selection checked
        # again at delivery. This internal read never opens an ignored room.
        room=str(p.get('room',''));ids=p.get('ids',[])
        if not isinstance(ids,list) or not 1<=len(ids)<=50 or any(not isinstance(x,str) or len(x)>600 for x in ids):raise ValueError('Invalid watch sources.')
        chat=db.execute("SELECT c.id,c.name,c.server_name,c.platform,c.kind,c.server_id,coalesce(g.treatment,'') treatment FROM conversations c LEFT JOIN whatsapp_group_policies g ON g.room_id=c.id WHERE c.id=? AND c.connected=1 AND c.tracked=1 AND ((c.platform='discord' AND c.kind IN ('dm','group','channel')) OR (c.platform='whatsapp' AND (c.kind='dm' OR g.treatment IN ('G','S'))))",(room,)).fetchone()
        if not chat:return {'eligible':False,'reason':'Chat is disconnected, untracked or ignored.'}
        chat=dict(chat)
        if chat['platform']=='discord' and chat['server_id']:
            policy=discord_policies.get(chat['server_id'],{})
            chat['treatment']=policy.get('treatment','')
            chat['from_ts']=policy.get('from_ts',0)
            if chat['treatment'] not in ('S','SP','G','GP'):return {'eligible':False,'reason':'Server is ignored.'}
        kind='group' if chat['treatment'] in ('G','GP') else 'server' if chat['kind']=='channel' or chat['treatment'] in ('S','SP') else 'dm' if chat['kind']=='dm' else 'group'
        if p.get('kind')!=kind:return {'eligible':False,'reason':'Chat classification changed.'}
        marks=','.join('?' for _ in ids)
        rows=db.execute('SELECT * FROM chat_messages WHERE room_id=? AND ts>=? AND id IN ('+marks+') ORDER BY ts,id',[room,chat.get('from_ts',0),*ids]).fetchall()
        hashes={r['id']:hashlib.sha256(r['body'].encode()).hexdigest() for r in rows}
        if 'hashes' in p:
            expected=p['hashes']
            valid=isinstance(expected,dict) and bool(expected) and all(mid in hashes and hashes[mid]==digest for mid,digest in expected.items())
            links=[{'id':mid,'url':run(db,{'op':'source','args':{'id':mid}})['url']} for mid in list(expected)[:3]] if valid else []
            return {'eligible':True,'valid':valid,'sources':links}
        before=int(time.time()*1000)+60000  # Include replies that already resolved the trigger.
        since=max(before-86400000,chat.get('from_ts',0)) if kind=='server' else 0
        context=bounded(db.execute('SELECT * FROM chat_messages WHERE room_id=? AND ts BETWEEN ? AND ? ORDER BY ts DESC,id DESC LIMIT ?',(room,since,before,201 if kind=='server' else 36)),200 if kind=='server' else 35,40000 if kind=='server' else 18000)
        context['rows'].reverse()
        context['rows']=[r for r in context['rows'] if r['id'] not in ids]
        triggers=bounded(rows,50,100000)
        brief=summary(db,room) if kind!='server' else None
        if brief and brief.get('available'):
            authors={r['sender'] for r in rows}
            brief={**brief,'overview':brief['overview'][:10],'recent':brief['recent'][:5],'followups':brief['followups'][:8],'events':brief['events'][:8],'people':[x for x in brief['people'] if x.get('is_me') or x.get('id') in authors][:5],'decisionContextLimited':True}
            # Keep this combined read below the service's output cap; long
            # originals remain available through the paged source operation.
            while len(json.dumps(brief).encode())>20000:
                key=max(('overview','recent','followups','events','people'),key=lambda k:len(json.dumps(brief[k])))
                if not brief[key]:break
                brief[key].pop()
        return {'eligible':True,'chat':dict(chat),'kind':kind,'newMessages':triggers['rows'],'hashes':{r['id']:hashes[r['id']] for r in triggers['rows']},'recent':context,'summary':brief,'coverage':{'requested':len(ids),'available':len(rows),'included':len(triggers['rows']),'truncated':triggers['truncated']}}
    if op=='source':
        mid=str(p.get('id',''))[:600]
        alias=db.execute('SELECT message_id FROM discord_matrix_links WHERE event_id=?',(mid,)).fetchone()
        if alias:mid=alias['message_id']
        row=db.execute("SELECT m.id,m.room_id,m.sender,m.ts,m.body,m.edited,coalesce(nullif(c.alias,''),c.name) conversation,c.platform,c.remote_id,c.server_id,coalesce(nullif(i.alias,''),i.name) author FROM messages m JOIN conversations c ON c.id=m.room_id LEFT JOIN identities i ON i.id=m.sender WHERE m.id=? AND c.connected=1 AND c.platform IN ('discord','whatsapp','gmail')",(mid,)).fetchone()
        if not row:return {'available':False}
        item=dict(row);body=item['body'];offset=max(0,min(int(p.get('offset',0)),1000000))
        item['body']=body[offset:offset+6000];item['offset']=offset;item['totalCharacters']=len(body)
        item['bodyHash']=hashlib.sha256(body.encode()).hexdigest()
        item['nextOffset']=offset+len(item['body']) if offset+len(item['body'])<len(body) else None
        item['truncated']=offset>0 or item['nextOffset'] is not None
        archive_url='https://archival.example.com/?source='+quote(item['id'],safe='')
        item['url']=archive_url;item['archiveUrl']=archive_url
        if item['platform']=='discord':
            remote=db.execute('SELECT channel_id,remote_id FROM discord_remote WHERE message_id=?',(mid,)).fetchone()
            if remote and all(re.fullmatch(r'\d{16,22}',remote[k]) for k in ('channel_id','remote_id')):
                guild=item['server_id'] if re.fullmatch(r'\d{16,22}',item['server_id']) else '@me'
                item['url']='https://discord.com/channels/'+guild+'/'+remote['channel_id']+'/'+remote['remote_id']
        for key in ('remote_id','server_id'):item.pop(key,None)
        return {'available':True,**item}
    if op=='servers':
        q='%'+str(p.get('query',''))[:200]+'%'
        return bounded(db.execute("SELECT s.*,c.name,c.platform,coalesce(d.treatment,'S') treatment,c.message_count,b.generated_at,b.messages summarized_messages,(SELECT count(*) FROM misty_server_pending p WHERE p.room_id=s.room_id) pending FROM misty_server_channels s JOIN conversations c ON c.id=s.room_id LEFT JOIN misty_channel_summaries b ON b.room_id=s.room_id LEFT JOIN discord_server_policies d ON d.server_id=c.server_id WHERE s.enabled=1 AND c.connected=1 AND c.tracked=1 AND (s.server_name LIKE ? OR s.channel_name LIKE ?) ORDER BY s.server_name,s.channel_name",(q,q)),80,60000)
    if op=='server_summary':
        server=str(p.get('server',''));room=str(p.get('room',''))
        rows=[]
        for r in db.execute("SELECT s.*,b.payload,b.generated_at,b.model,b.messages FROM misty_server_channels s JOIN conversations c ON c.id=s.room_id LEFT JOIN misty_channel_summaries b ON b.room_id=s.room_id WHERE s.enabled=1 AND c.connected=1 AND c.tracked=1 AND (?='' OR s.server_id=?) AND (?='' OR s.room_id=?) ORDER BY b.generated_at DESC LIMIT 31",(server,server,room,room)):
            item=dict(r);item['payload']=json.loads(item['payload']) if item['payload'] else None;rows.append(item)
        parents=[]
        for sid in dict.fromkeys(r['server_id'] for r in rows):
            row=db.execute('SELECT * FROM misty_server_summaries WHERE server_id=?',(sid,)).fetchone()
            if row:parents.append(dict(row)|{'payload':json.loads(row['payload'])})
        original_count=len(rows)
        # Keep the reader's response bounded even for community-wide requests.
        while len(json.dumps({'channels':rows,'servers':parents}).encode())>140000 and len(rows)>1:rows.pop()
        keep={r['server_id'] for r in rows};parents=[r for r in parents if r['server_id'] in keep]
        return {'channels':rows,'servers':parents,'truncated':original_count==31 or len(rows)<original_count,'coverage':'Collection since from_ts only. 50-message batches, quiet rooms flush hourly. Raw text expires after 24h only after a successful summary; originals from before activation are preserved and excluded.'}
    if op=='server_history':
        room=str(p.get('room',''));before=int(p.get('before') or time.time()*1000+1);rows=[];size=0;truncated=False
        for r in db.execute("SELECT b.id,b.room_id,b.first_ts,b.last_ts,b.generated_at,b.payload FROM misty_server_batches b JOIN misty_server_channels s ON s.room_id=b.room_id JOIN conversations c ON c.id=s.room_id WHERE b.room_id=? AND b.generated_at<? AND s.enabled=1 AND c.connected=1 AND c.tracked=1 ORDER BY b.generated_at DESC LIMIT 21",(room,before)):
            item=dict(r);item['payload']=json.loads(item['payload']);n=len(json.dumps(item).encode())
            if rows and (len(rows)>=20 or size+n>130000):truncated=True;break
            rows.append(item);size+=n
        return {'rows':rows,'nextBefore':rows[-1]['generated_at'] if rows and truncated else None,'truncated':truncated,'coverage':'Saved summary snapshots and provenance only; source messages are not necessarily retained. Collection begins at channel activation.'}
    if op=='schema':return {'views':VIEWS,'limits':{'rows':100,'seconds':1.5,'bytes':100000},'timestamps':'Unix milliseconds. Read-only SELECT only; no WITH/CTEs. Summaries available via summary tool; no credential tables.'}
    if op=='sql':return query(db,p.get('sql'),p.get('params',[]))
    if op=='chats':
        q=str(p.get('query',''))[:200]
        return bounded(db.execute("SELECT * FROM chats WHERE name LIKE ? OR alias LIKE ? OR server_name LIKE ? ORDER BY last_ts DESC LIMIT 101",('%'+q+'%','%'+q+'%','%'+q+'%')))
    if op=='search':
        words=re.findall(r'[^\W_]+',str(p.get('query','')),re.UNICODE)[:12]
        if not words:return {'rows':[],'truncated':False}
        fts=' AND '.join('"'+w+'"*' for w in words)
        where='';params=[fts]
        if p.get('room'):where=' AND m.room_id=?';params.append(str(p['room']))
        sql="SELECT m.id,m.room_id,m.sender,m.ts,substr(m.body,1,3000) body,m.is_me,c.name conversation,c.platform,bm25(messages_fts) score FROM messages_fts JOIN messages m ON m.rowid=messages_fts.rowid JOIN conversations c ON c.id=m.room_id WHERE messages_fts MATCH ? AND c.connected=1 AND c.platform IN ('discord','whatsapp','gmail')"+where+' ORDER BY score LIMIT 31'
        return bounded(db.execute(sql,params),30,60000)
    if op=='summary':return summary(db,str(p.get('room','')),str(p.get('person','')))
    if op=='profile':
        if p.get('compact'):
            # Project after validating evidence, before byte limiting. Large raw
            # evidence arrays used to crowd the interests out of the watch context.
            kept=[]
            for row in db.execute("SELECT * FROM interests ORDER BY status='confirmed' DESC,updated_at DESC LIMIT 81"):
                finding=dict(row);evidence=json.loads(finding.get('evidence_ids') or '[]')
                valid=[mid for mid in evidence if db.execute('SELECT 1 FROM messages m JOIN conversations c ON c.id=m.room_id WHERE m.id=? AND m.is_me=1 AND c.connected=1 AND c.include_profile=1',(mid,)).fetchone()]
                if not valid and finding['source']!='user':continue
                item={key:finding[key] for key in ('id','title','category','confidence','status','source')}
                item['summary']=finding['summary'][:450]
                item['current_evidence_ids']=valid[:2]
                item['total_current_evidence']=len(valid)
                kept.append(item)
            result=bounded(kept,80,60000)
            result['eligibleFindings']=len(kept)
            return result
        result=bounded(db.execute("SELECT * FROM interests ORDER BY status='confirmed' DESC,updated_at DESC LIMIT 81"),80,18000)
        kept=[]
        for finding in result['rows']:
            evidence=json.loads(finding.get('evidence_ids') or '[]')
            valid=[mid for mid in evidence if db.execute('SELECT 1 FROM messages m JOIN conversations c ON c.id=m.room_id WHERE m.id=? AND m.is_me=1 AND c.connected=1 AND c.include_profile=1',(mid,)).fetchone()]
            if valid or finding['source']=='user':finding['current_evidence_ids']=valid[:8];finding['total_current_evidence']=len(valid);kept.append(finding)
        result['rows']=kept;return result
    if op=='context':
        room=str(p.get('room',''));before=int(p.get('before') or time.time()*1000);since=int(p.get('since') or 0)
        limit=max(1,min(200,int(p.get('limit') or 200)))
        rows=bounded(db.execute('SELECT * FROM chat_messages WHERE room_id=? AND ts BETWEEN ? AND ? ORDER BY ts DESC,id DESC LIMIT ?',(room,since,before,limit+1)),limit,65000 if limit>35 else 18000)
        rows['rows'].reverse();rows['window']={'since':since,'before':before};return rows
    if op=='events':
        after=max(0,int(p.get('after',0)))
        result=bounded(db.execute("SELECT e.seq,e.message_id,e.room_id,e.at,m.ts,m.is_me,c.name,c.server_name,c.platform,c.kind,c.remote_id,c.server_id,coalesce(g.treatment,'') treatment FROM misty_message_events e JOIN messages m ON m.id=e.message_id JOIN conversations c ON c.id=e.room_id LEFT JOIN whatsapp_group_policies g ON g.room_id=c.id WHERE e.seq>? AND c.connected=1 AND ((c.platform='discord' AND c.tracked=1) OR (c.platform='whatsapp' AND (c.kind='dm' AND c.tracked=1 OR g.treatment='G' AND c.tracked=1 OR g.treatment='S' AND c.tracked=1))) ORDER BY e.seq LIMIT 101",(after,)))
        for item in result['rows']:
            if item['platform']=='discord' and item['server_id']:
                policy=discord_policies.get(item['server_id'],{})
                item['treatment']=policy.get('treatment','I');item['from_ts']=policy.get('from_ts',0)
        return result
    if op=='supervisor_events':
        after=max(0,int(p.get('after',0)))
        # The journal records only newly arriving messages, not an old import's
        # historical timestamps. Keep Gmail (including Drafts/Spam/Trash) in the
        # supervisor feed without changing Apollo's personal-chat watcher.
        result=bounded(db.execute("SELECT e.seq,e.message_id,e.room_id,e.at,m.ts,m.is_me,substr(m.body,1,1200) body,c.name,c.platform,c.kind FROM misty_message_events e JOIN messages m ON m.id=e.message_id JOIN conversations c ON c.id=e.room_id WHERE e.seq>? AND c.connected=1 AND ((c.platform='gmail') OR (c.platform='discord' AND c.tracked=1) OR (c.platform='whatsapp' AND c.tracked=1)) ORDER BY e.seq LIMIT 101",(after,)),100,90000)
        result['highWater']=db.execute('SELECT coalesce(max(seq),0) FROM misty_message_events').fetchone()[0]
        return result
    raise ValueError('Unknown archive operation.')

def main():
    try:
        import resource
        resource.setrlimit(resource.RLIMIT_AS,(128*1024*1024,128*1024*1024))
    except ImportError:pass  # The production reader runs on Linux.
    request=json.loads(sys.stdin.read(32769))
    if len(json.dumps(request))>32768:raise ValueError('Request too large.')
    db=connect(sys.argv[1]);deadline=time.monotonic()+4
    db.set_progress_handler(lambda:int(time.monotonic()>deadline),5000)
    try:result=run(db,request);print(json.dumps(result,separators=(',',':')))
    finally:db.close()

if __name__=='__main__':
    try:main()
    except Exception:print(json.dumps({'error':'Archive query rejected or exceeded its read budget.'}));sys.exit(1)
