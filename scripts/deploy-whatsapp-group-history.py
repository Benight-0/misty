"""Install the reviewed, finite WhatsApp group-history import; preserve runtime secrets."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import time

ROOT=Path('/opt/archival')
STAGE=Path('/tmp/archival-migration')
CANDIDATE=STAGE/'group-history-candidate'
FILES={
 'app/'+name for name in ['native-ingest.mjs','native-runtime.mjs','briefing-store.mjs','briefings.mjs','store.mjs','whatsapp-groups.mjs','public/app.js','public/briefings.js','public/misty.js']
}|{'collector/main.go','collector/whatsapp-history.go','scripts/configure-whatsapp-groups.mjs'}
BIN=ROOT/'bin/archival-collector'
DB=Path('/var/lib/archival/data/archive.sqlite')

def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def live_path(name):return ROOT/('collector-src/'+name[10:] if name.startswith('collector/') else name)
def snapshot(db):
    return {
        'messages':db.execute('SELECT count(*) FROM messages').fetchone()[0],
        'nodes':{room+':'+key:digest_text(payload) for room,key,payload in db.execute('SELECT room_id,hash,payload FROM briefing_history_nodes')},
        'summaries':{room:digest_text(payload) for room,payload in db.execute('SELECT room_id,payload FROM chat_briefings')},
        'flags':{row[0]:list(row[1:]) for row in db.execute("SELECT id,connected,tracked,followed,include_profile FROM conversations WHERE NOT(platform='whatsapp' AND kind='group')")},
    }
def digest_text(text):return hashlib.sha256(text.encode()).hexdigest()

mode=sys.argv[1]
if mode=='stage':
    CANDIDATE.mkdir(exist_ok=True)
    shutil.copytree(ROOT/'app',CANDIDATE/'app',dirs_exist_ok=True)
    baseline={name:digest(live_path(name)) if live_path(name).exists() else None for name in FILES}
    with tarfile.open(STAGE/'whatsapp-group-history.tar.gz','r:gz') as bundle:
        members=bundle.getmembers()
        if {m.name for m in members}!=FILES or any(not m.isfile() for m in members):raise RuntimeError('Unexpected bundle contents')
        for member in members:
            target=CANDIDATE/member.name
            target.parent.mkdir(parents=True,exist_ok=True)
            target.write_bytes(bundle.extractfile(member).read());target.chmod(0o644)
            if target.suffix in ('.mjs','.js'):subprocess.run(['/opt/archival/bin/node','--check',str(target)],check=True)
    for name in ('go.mod','go.sum'):shutil.copy2(ROOT/'collector-src'/name,CANDIDATE/'collector'/name)
    env=dict(os.environ,PATH='/opt/archival/build/go/bin:'+os.environ['PATH'],GOMAXPROCS='1',GOFLAGS='-p=1',GOMEMLIMIT='350MiB',GOCACHE='/home/ubuntu/.cache/go-build',GOMODCACHE='/home/ubuntu/go/pkg/mod')
    subprocess.run(['go','build','-trimpath','-ldflags=-s','-o',str(CANDIDATE/'collector-binary'),'.'],cwd=CANDIDATE/'collector',env=env,check=True)
    (CANDIDATE/'baseline.json').write_text(json.dumps(baseline))
    print('Syntax checks and Go build passed.',flush=True)
elif mode=='install':
    baseline=json.loads((CANDIDATE/'baseline.json').read_text())
    for name,expected in baseline.items():
        actual=digest(live_path(name)) if live_path(name).exists() else None
        if actual!=expected:raise RuntimeError('Live code changed since staging: '+name)
    backup=Path('/var/lib/archival')/time.strftime('group-history-before-%Y%m%dT%H%M%SZ',time.gmtime())
    backup.mkdir(mode=0o700)
    runtime_hash=digest(Path('/etc/archival/runtime.env'))
    subprocess.run(['systemctl','stop','archival'],check=True,timeout=40)
    try:
        with sqlite3.connect(DB) as db:
            before=snapshot(db)
            copied=sqlite3.connect(backup/'archive.sqlite')
            try:db.backup(copied)
            finally:copied.close()
        (backup/'before.json').write_text(json.dumps(before))
        shutil.copy2(BIN,backup/'collector-binary')
        for name in FILES:
            dest=live_path(name)
            if dest.exists():
                old=backup/name;old.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(dest,old)
            dest.parent.mkdir(parents=True,exist_ok=True)
            temp=dest.with_name(dest.name+'.group-history-new')
            shutil.copyfile(CANDIDATE/name,temp);temp.chmod(0o644);shutil.chown(temp,user='archival',group='archival');temp.replace(dest)
        temp=BIN.with_name(BIN.name+'.group-history-new')
        shutil.copyfile(CANDIDATE/'collector-binary',temp);temp.chmod(0o755);temp.replace(BIN)
        manifest=Path('/var/lib/archival/whatsapp-group-choices.json')
        shutil.copyfile(STAGE/'whatsapp-group-choices.json',manifest)
        manifest.chmod(0o600);shutil.chown(manifest,user='archival',group='archival')
        subprocess.run(['runuser','-u','archival','--','/opt/archival/bin/node','--disable-warning=ExperimentalWarning',str(ROOT/'scripts/configure-whatsapp-groups.mjs'),str(manifest)],check=True,timeout=45)
        # This owner-requested recovery pass retries unavailable chats and closes
        # newer gaps after the phone has been brought online. Keep older cursors,
        # completed output, classifications and the original cutoff intact.
        with sqlite3.connect(DB,timeout=10) as db:
            db.execute("""UPDATE whatsapp_group_policies SET
                phase=CASE WHEN import_state='available_exhausted' AND recent_gap=1 THEN 'recent' ELSE phase END,
                before_id=CASE WHEN import_state='available_exhausted' AND recent_gap=1 THEN '' ELSE before_id END,
                before_ts=CASE WHEN import_state='available_exhausted' AND recent_gap=1 THEN cutoff ELSE before_ts END,
                before_me=CASE WHEN import_state='available_exhausted' AND recent_gap=1 THEN 0 ELSE before_me END,
                import_state='queued',error='',updated_at=?
                WHERE treatment='G' AND (import_state IN ('phone_unavailable','request_failed')
                  OR (import_state='available_exhausted' AND recent_gap=1))""",(int(time.time()*1000),))
        with sqlite3.connect('file:'+str(DB)+'?mode=ro',uri=True) as db:after=snapshot(db)
        assert before==after,'Existing messages, published summaries, checkpoint payloads or unrelated flags changed'
        assert runtime_hash==digest(Path('/etc/archival/runtime.env')),'Runtime settings changed'
        print(json.dumps({'preservedMessages':before['messages'],'preservedSummaries':len(before['summaries']),'preservedCheckpoints':len(before['nodes']),'unrelatedFlagsPreserved':True,'backup':str(backup)}),flush=True)
    except BaseException:
        for name,expected in baseline.items():
            dest=live_path(name)
            if expected is not None and (backup/name).exists():shutil.copy2(backup/name,dest)
            elif expected is None and dest.exists():dest.unlink()
        if (backup/'collector-binary').exists():shutil.copy2(backup/'collector-binary',BIN)
        if (backup/'archive.sqlite').exists():
            # The service is stopped: restore a consistent pre-install snapshot.
            for suffix in ('-wal','-shm'):
                wal=Path(str(DB)+suffix)
                if wal.exists():wal.unlink()
            shutil.copyfile(backup/'archive.sqlite',DB)
        subprocess.run(['systemctl','start','archival'],timeout=40)
        raise
    subprocess.run(['systemctl','start','archival'],check=True,timeout=40)
    print('Historical import and summary jobs started.',flush=True)
elif mode=='status':
    with sqlite3.connect('file:'+str(DB)+'?mode=ro',uri=True,timeout=10) as db:
        db.row_factory=sqlite3.Row
        rows=[dict(row) for row in db.execute("""SELECT p.name,p.treatment,p.import_state,p.phase,p.pages,p.recent_gap,p.error,
            c.message_count,c.own_count,j.status AS summary_status,j.enabled,h.completed_batches,h.total_batches,
            b.generated_at,coalesce(json_extract(b.payload,'$.coverage.complete'),0) AS archived_history_analyzed
            FROM whatsapp_group_policies p LEFT JOIN conversations c ON c.id=p.room_id
            LEFT JOIN briefing_jobs j ON j.room_id=p.room_id LEFT JOIN briefing_history_progress h ON h.room_id=p.room_id
            LEFT JOIN chat_briefings b ON b.room_id=p.room_id WHERE p.treatment='G' ORDER BY p.name""")]
        states={key:json.loads(value) for key,value in db.execute("SELECT key,value FROM settings WHERE key IN ('native_discord','native_whatsapp','native_collector_error','briefing_worker_error','briefing_worker_runtime','whatsapp_group_classification')")}
        print(json.dumps({'groups':rows,'states':states},ensure_ascii=False))
else:raise SystemExit('Expected stage, install or status')
