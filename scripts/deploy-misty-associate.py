"""Stage, verify and install the associate tools; preserve all archive data and rollback code."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request

STAGE=Path('/tmp/archival-migration/misty-associate')
ARCHIVE=Path('/opt/archival');BOTROOT=Path('/opt/misty-bot')
BOT={'app/discord-bot.mjs','app/misty-self.mjs','app/misty-dialogue.mjs','app/misty-rephraser.mjs','app/misty-style.mjs','app/misty-knowledge.mjs','app/misty-archive.mjs','app/misty-notifications.mjs','app/misty-work.mjs','app/misty-relay.mjs','app/misty-persona.mjs','app/misty-components.mjs','app/misty-interactions.mjs','app/openai-analysis.mjs','app/codex-live-session.mjs','app/codex-relay-client.mjs','scripts/misty-discord-bot.mjs'}
ARCH={'app/misty-server-summaries.mjs','app/vm-analysis-worker.mjs','app/misty-archive.mjs','scripts/misty-archive-query.py','app/native-ingest.mjs','app/native-runtime.mjs','app/vm-server.mjs','app/openai-analysis.mjs'}
TESTS={'app/tests/'+name+'.test.mjs' for name in ['codex-live-session','discord-bot','misty-relay','misty-conversation','misty-interactions','misty-associate','whatsapp-groups','native-chat']}
GO={'collector/main.go','collector/whatsapp-history.go','collector/go.mod','collector/go.sum'}
FILES=BOT|ARCH|TESTS|GO
CANDIDATE=STAGE/'candidate'
def run(*args,**kw):return subprocess.run(args,check=True,**kw)
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None
def paths():
    return [(BOTROOT/n,n,'bot') for n in BOT]+[(ARCHIVE/n,n,'archive') for n in ARCH]+[(ARCHIVE/'collector-src'/n[10:],n,'archive') for n in GO]+[(ARCHIVE/'bin/archival-collector','bin/archival-collector','archive')]
def summaries(db):
    return {room:hashlib.sha256(payload.encode()).hexdigest() for room,payload in db.execute('SELECT room_id,payload FROM chat_briefings')}
def ready():
    try:urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8787/',headers={'Host':'archival.example.com'}),timeout=3);return True
    except urllib.error.HTTPError as e:return e.code==401
    except (OSError,TimeoutError):return False

mode=sys.argv[1]
if mode=='stage':
    CANDIDATE.mkdir(parents=True,exist_ok=True)
    shutil.copytree(ARCHIVE/'app',CANDIDATE/'app',dirs_exist_ok=True)
    shutil.copytree(BOTROOT/'app',CANDIDATE/'app',dirs_exist_ok=True)
    (CANDIDATE/'scripts').mkdir(exist_ok=True)
    shutil.copy2(ARCHIVE/'scripts/discord-server-ids.txt',CANDIDATE/'scripts/discord-server-ids.txt')
    with tarfile.open(STAGE/'bundle.tar.gz','r:gz') as bundle:
        members=bundle.getmembers()
        assert {m.name for m in members}==FILES and all(m.isfile() for m in members),'Unexpected bundle'
        for member in members:
            target=CANDIDATE/member.name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(bundle.extractfile(member).read());target.chmod(0o644)
    node=str(ARCHIVE/'bin/node')
    for name in BOT|ARCH:
        if name.endswith('.mjs'):run(node,'--check',str(CANDIDATE/name),stdout=subprocess.DEVNULL)
    compile((CANDIDATE/'scripts/misty-archive-query.py').read_text(),'misty-archive-query.py','exec')
    run(node,'--disable-warning=ExperimentalWarning','--test',*sorted(TESTS),cwd=CANDIDATE)
    env=dict(os.environ,PATH='/opt/archival/build/go/bin:'+os.environ['PATH'],GOMAXPROCS='1',GOFLAGS='-p=1',GOMEMLIMIT='250MiB',GOCACHE='/home/ubuntu/.cache/go-build',GOMODCACHE='/home/ubuntu/go/pkg/mod')
    run('/opt/archival/build/go/bin/gofmt','-w',str(CANDIDATE/'collector/main.go'))
    run('/opt/archival/build/go/bin/go','test','.',cwd=CANDIDATE/'collector',env=env,timeout=300)
    run('/opt/archival/build/go/bin/go','build','-trimpath','-ldflags=-s','-o',str(CANDIDATE/'collector-binary'),'.',cwd=CANDIDATE/'collector',env=env,timeout=300)
    (STAGE/'baseline.json').write_text(json.dumps({str(p):digest(p) for p,_,_ in paths()}))
    print('Candidate checks passed; production unchanged.',flush=True)
    sys.exit(0)

assert mode=='install'
baseline=json.loads((STAGE/'baseline.json').read_text())
assert all(digest(Path(p))==value for p,value in baseline.items()),'Production source changed since staging'
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup=Path('/var/lib/misty-bot')/('associate-before-'+stamp);backup.mkdir(mode=0o700)
for p,name,group in paths():
    if p.exists():
        dst=backup/group/name;dst.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,dst)
dropins=[Path('/etc/systemd/system/archival.service.d/misty-associate.conf'),Path('/etc/systemd/system/misty-bot.service.d/misty-associate.conf')]
previous_dropins={str(p):p.read_text() if p.exists() else None for p in dropins}
(backup/'dropins.json').write_text(json.dumps(previous_dropins))
run('systemctl','stop','misty-bot');run('systemctl','stop','archival')
dbfile='/var/lib/archival/data/archive.sqlite'
old_flags=[];old_setting=None
try:
    for source,name in [(dbfile,'archive.sqlite'),('/var/lib/misty-bot/chat.sqlite','chat.sqlite')]:
        with sqlite3.connect(source) as src,sqlite3.connect(backup/name) as dst:src.backup(dst)
    with sqlite3.connect(dbfile) as db:
        before=summaries(db);old_flags=list(db.execute("SELECT id,tracked FROM conversations WHERE id IN (SELECT room_id FROM whatsapp_group_policies WHERE treatment='G')"))
        old_setting=db.execute("SELECT value FROM settings WHERE key='misty_live_groups'").fetchone()
        (backup/'group-state.json').write_text(json.dumps({'flags':old_flags,'setting':old_setting}))
        db.execute("INSERT INTO settings VALUES('misty_live_groups','true') ON CONFLICT(key) DO UPDATE SET value='true'")
        db.execute("UPDATE conversations SET tracked=1 WHERE connected=1 AND id IN (SELECT room_id FROM whatsapp_group_policies WHERE treatment='G')")
    for p,name,group in paths():
        source=CANDIDATE/('collector-binary' if name=='bin/archival-collector' else name)
        p.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,p);p.chmod(0o755 if name=='bin/archival-collector' else 0o644)
    token=Path('/etc/archival/misty-archive-token')
    if not token.exists():token.write_text(secrets.token_hex(32)+'\n')
    token.chmod(0o640);shutil.chown(token,user='root',group='archival')
    dropins[0].parent.mkdir(parents=True,exist_ok=True);dropins[0].write_text('[Service]\nEnvironment=MISTY_ARCHIVE_TOKEN_FILE=/etc/archival/misty-archive-token\n')
    dropins[1].parent.mkdir(parents=True,exist_ok=True);dropins[1].write_text('[Service]\nLoadCredential=archive-token:/etc/archival/misty-archive-token\nEnvironment=MISTY_DECISION_MODEL=gpt-5.6-luna\nTimeoutStopSec=180\n')
    with sqlite3.connect(dbfile) as db:assert summaries(db)==before,'Saved summaries changed during install'
    run('systemctl','daemon-reload');started_at=time.time()*1000;run('systemctl','start','archival');run('systemctl','start','misty-bot')
    for attempt in range(240):
        try:state=json.loads(Path('/var/lib/misty-bot/status.json').read_text());online=state.get('state')=='online' and state['at']>=started_at
        except (OSError,ValueError):online=False
        if online and ready():break
        time.sleep(1)
    else:raise RuntimeError('Services did not become healthy')
    print(json.dumps({'installed':True,'backup':str(backup),'preserved_summaries':len(before),'live_whatsapp_G_groups':len(old_flags),'bot':state['state']}),flush=True)
except BaseException:
    run('systemctl','stop','misty-bot');run('systemctl','stop','archival')
    for p,name,group in paths():
        original=backup/group/name
        if original.exists():shutil.copy2(original,p)
        elif p.exists():p.unlink()
    for p in dropins:
        old=previous_dropins[str(p)]
        if old is None:p.unlink(missing_ok=True)
        else:p.write_text(old)
    with sqlite3.connect(dbfile) as db:
        for room,tracked in old_flags:db.execute('UPDATE conversations SET tracked=? WHERE id=?',(tracked,room))
        if old_setting:db.execute("UPDATE settings SET value=? WHERE key='misty_live_groups'",old_setting)
        else:db.execute("DELETE FROM settings WHERE key='misty_live_groups'")
        # Old writers must not depend on the new notification schema after source rollback.
        db.execute('DROP TRIGGER IF EXISTS misty_message_arrived')
    run('systemctl','daemon-reload');run('systemctl','start','archival');run('systemctl','start','misty-bot')
    raise
