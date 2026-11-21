"""Stage and install conversational Misty, knowledge reads and WhatsApp S summaries."""
import datetime
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
import urllib.error
import urllib.request

STAGE=Path('/tmp/archival-migration/misty-peer')
BOT=Path('/opt/misty-bot');ARCH=Path('/opt/archival')
BOT_FILES={
 'app/misty-relay.mjs','app/discord-bot.mjs','app/misty-self.mjs','app/misty-dialogue.mjs','app/misty-rephraser.mjs','app/misty-style.mjs','app/misty-knowledge.mjs','app/misty-persona.mjs',
 'app/misty-components.mjs','app/misty-interactions.mjs','app/misty-work.mjs',
 'app/misty-archive.mjs','scripts/misty-discord-bot.mjs','scripts/misty-relay-agent.mjs'}
ARCH_FILES={
 'app/misty-server-summaries.mjs','app/misty-archive.mjs','scripts/misty-archive-query.py',
 'app/native-ingest.mjs','app/native-runtime.mjs','app/vm-server.mjs','app/vm-analysis-worker.mjs'}
TESTS={'app/tests/'+s+'.test.mjs' for s in ['misty-peer','misty-relay','misty-interactions','misty-associate','misty-conversation','discord-bot','native-chat','whatsapp-groups','codex-live-session']}
LOCAL_ONLY={'app/misty-knowledge-sync.mjs','app/codex-relay-client.mjs'}
FILES=BOT_FILES|ARCH_FILES|TESTS|LOCAL_ONLY
CANDIDATE=STAGE/'candidate'
DROPIN=Path('/etc/systemd/system/misty-bot.service.d/misty-peer.conf')

def run(*args,**kwargs):return subprocess.run(args,check=True,**kwargs)
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None
def targets():return [(BOT/n,n,'bot') for n in BOT_FILES]+[(ARCH/n,n,'archive') for n in ARCH_FILES]
def summaries(db):return {r:hashlib.sha256(p.encode()).hexdigest() for r,p in db.execute('SELECT room_id,payload FROM chat_briefings')}
def ready():
    try:urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8787/',headers={'Host':'archival.example.com'}),timeout=3);return True
    except urllib.error.HTTPError as e:return e.code==401
    except (OSError,TimeoutError):return False

if sys.argv[1]=='stage':
    CANDIDATE.mkdir(parents=True,exist_ok=True)
    shutil.copytree(ARCH/'app',CANDIDATE/'app',dirs_exist_ok=True)
    shutil.copytree(BOT/'app',CANDIDATE/'app',dirs_exist_ok=True)
    (CANDIDATE/'scripts').mkdir(exist_ok=True)
    shutil.copy2(ARCH/'scripts/discord-server-ids.txt',CANDIDATE/'scripts/discord-server-ids.txt')
    with tarfile.open(STAGE/'bundle.tar.gz','r:gz') as bundle:
        assert {m.name for m in bundle.getmembers()}==FILES
        for m in bundle.getmembers():
            assert m.isfile() and m.name in FILES
            p=CANDIDATE/m.name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(bundle.extractfile(m).read());p.chmod(0o644)
    node=str(ARCH/'bin/node')
    for n in FILES:
        if n.endswith('.mjs'):run(node,'--check',str(CANDIDATE/n),stdout=subprocess.DEVNULL)
        if n.endswith('.py'):compile((CANDIDATE/n).read_text(),n,'exec')
    run(node,'--disable-warning=ExperimentalWarning','--test',*sorted(TESTS),cwd=CANDIDATE)
    (STAGE/'baseline.json').write_text(json.dumps({str(p):digest(p) for p,_,_ in targets()}))
    print('Peer candidate passed; production unchanged.',flush=True);sys.exit(0)

assert sys.argv[1]=='install'
assert all(digest(Path(p))==h for p,h in json.loads((STAGE/'baseline.json').read_text()).items()),'Production source drifted'
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup=Path('/var/lib/misty-bot')/('peer-before-'+stamp);backup.mkdir(mode=0o700)
old_dropin=DROPIN.read_text() if DROPIN.exists() else None
for p,n,g in targets():
    if p.exists():dst=backup/g/n;dst.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,dst)
(backup/'dropin.json').write_text(json.dumps(old_dropin))
run('systemctl','stop','misty-bot');run('systemctl','stop','archival')
dbfile='/var/lib/archival/data/archive.sqlite'
with sqlite3.connect(dbfile) as src,sqlite3.connect(backup/'archive.sqlite') as dst:src.backup(dst)
with sqlite3.connect('/var/lib/misty-bot/chat.sqlite') as src,sqlite3.connect(backup/'chat.sqlite') as dst:src.backup(dst)
with sqlite3.connect(dbfile) as db:
    before=summaries(db)
    flags=list(db.execute('SELECT id,connected,tracked,include_profile FROM conversations'))
    policies=list(db.execute('SELECT chat_id,room_id FROM whatsapp_group_policies'))
    old_setting=db.execute("SELECT value FROM settings WHERE key='misty_live_servers'").fetchone()
    db.execute("INSERT INTO settings VALUES('misty_live_servers','true') ON CONFLICT(key) DO UPDATE SET value='true'")
(backup/'state.json').write_text(json.dumps({'flags':flags,'policies':policies,'setting':old_setting}))
try:
    for p,n,g in targets():p.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(CANDIDATE/n,p);p.chmod(0o644)
    DROPIN.parent.mkdir(parents=True,exist_ok=True)
    DROPIN.write_text('[Service]\nEnvironment=MISTY_BOT_MODEL=gpt-6.1-sol\nEnvironment=MISTY_BOT_REASONING=high\n')
    with sqlite3.connect(dbfile) as db:assert summaries(db)==before
    run('systemctl','daemon-reload');started=time.time()*1000;run('systemctl','start','archival');run('systemctl','start','misty-bot')
    for _ in range(210):
        try:status=json.loads(Path('/var/lib/misty-bot/status.json').read_text());online=status.get('state')=='online' and status['at']>=started
        except (OSError,ValueError):online=False
        if ready() and online:break
        time.sleep(1)
    else:raise RuntimeError('Service health check timed out')
    with sqlite3.connect(dbfile) as db:enabled=db.execute('SELECT count(*) FROM misty_server_channels WHERE enabled=1').fetchone()[0]
    print(json.dumps({'installed':True,'backup':str(backup),'preserved_private_summaries':len(before),'whatsapp_server_channels':enabled,'model':'gpt-6.1-sol'}),flush=True)
except Exception:
    run('systemctl','stop','misty-bot');run('systemctl','stop','archival')
    for p,n,g in targets():
        saved=backup/g/n
        if saved.exists():shutil.copyfile(saved,p)
        elif p.exists():p.unlink()
    if old_dropin is None:DROPIN.unlink(missing_ok=True)
    else:DROPIN.write_text(old_dropin)
    with sqlite3.connect(dbfile) as db:
        for row in flags:db.execute('UPDATE conversations SET connected=?,tracked=?,include_profile=? WHERE id=?',(row[1],row[2],row[3],row[0]))
        for chat,room in policies:db.execute('UPDATE whatsapp_group_policies SET room_id=? WHERE chat_id=?',(room,chat))
        if old_setting:db.execute("UPDATE settings SET value=? WHERE key='misty_live_servers'",old_setting)
        else:db.execute("DELETE FROM settings WHERE key='misty_live_servers'")
        if db.execute("SELECT 1 FROM sqlite_master WHERE name='misty_server_channels'").fetchone():db.execute('UPDATE misty_server_channels SET enabled=0')
    run('systemctl','daemon-reload');run('systemctl','start','archival');run('systemctl','start','misty-bot')
    raise
