"""Read-only import/analysis audit. Prints counts and dates, never chat text or secrets."""
import datetime
import json
import sqlite3
import subprocess

def iso(value):
    return datetime.datetime.fromtimestamp(value/1000,datetime.timezone.utc).isoformat() if value else None

db=sqlite3.connect('file:/var/lib/archival/data/archive.sqlite?mode=ro',uri=True,timeout=10)
db.row_factory=sqlite3.Row
try:
    rows=[]
    for row in db.execute("""SELECT p.*,c.message_count,c.own_count,c.tracked,j.status,j.revision,j.completed_revision,
        b.payload,b.generated_at FROM whatsapp_group_policies p LEFT JOIN conversations c ON c.id=p.room_id
        LEFT JOIN briefing_jobs j ON j.room_id=p.room_id LEFT JOIN chat_briefings b ON b.room_id=p.room_id
        WHERE p.treatment='G' ORDER BY p.name"""):
        first,last=db.execute('SELECT min(ts),max(ts) FROM messages WHERE room_id=?',(row['room_id'],)).fetchone()
        result={k:row[k] for k in ['name','message_count','own_count','import_state','phase','pages','recent_gap','status']}
        result.update(first=iso(first),last=iso(last),summaryUpdated=iso(row['generated_at']),analysisCurrent=row['revision'] is not None and row['revision']==row['completed_revision'],liveTracking=bool(row['tracked']))
        payload=json.loads(row['payload']) if row['payload'] else {}
        people=payload.get('people',[])
        result.update(profiledPeople=sum(bool(p.get('observations') or p.get('preferences')) for p in people),observations=sum(len(p.get('observations',[])) for p in people),preferences=sum(len(p.get('preferences',[])) for p in people),events=len(payload.get('suggestedEvents',[])))
        missing=wrong=0
        for person in people:
            for claim in person.get('observations',[])+person.get('preferences',[]):
                for evidence in claim.get('evidence',[]):
                    source=db.execute('SELECT sender,is_me FROM messages WHERE id=? AND room_id=?',(evidence,row['room_id'])).fetchone()
                    if not source:missing+=1
                    elif ('self' if source['is_me'] else source['sender'])!=person['id']:wrong+=1
        result.update(missingProfileSources=missing,wrongProfileAuthors=wrong)
        rows.append(result)
    states={key:json.loads(value) for key,value in db.execute("SELECT key,value FROM settings WHERE key IN ('native_discord','native_whatsapp','briefing_worker_error','briefing_worker_runtime')")}
    result={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'messages':sum(r['message_count'] or 0 for r in rows),'groups':rows,'states':states}
    print(json.dumps(result,ensure_ascii=False),flush=True)
finally:db.close()
subprocess.run(['systemctl','show','archival','-p','ActiveState','-p','SubState','-p','MemoryCurrent','-p','NRestarts'],check=True)
