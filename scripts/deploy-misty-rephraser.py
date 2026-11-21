"""Stage the bot, read-only source reader and static source links. Collector stays online."""
import datetime
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import time

ROOT=Path('/opt/misty-bot')
STAGE=Path('/tmp/archival-migration/misty-rephraser')
CANDIDATE=STAGE/'candidate'
RUNTIME={'app/discord-bot.mjs','app/misty-self.mjs','app/misty-dialogue.mjs','app/misty-rephraser.mjs','app/misty-relay.mjs','app/misty-style.mjs','app/misty-persona.mjs','app/misty-knowledge.mjs','app/misty-work.mjs','app/misty-notifications.mjs','app/misty-archive.mjs','scripts/misty-discord-bot.mjs','scripts/build-misty-voice.mjs'}
ARCHIVE={'scripts/misty-archive-query.py','app/public/app.js'}
TESTS={'app/tests/'+name+'.test.mjs' for name in ['misty-rephraser','misty-peer','misty-relay','misty-interactions','misty-associate','misty-conversation','discord-bot','misty-ui','misty-sources']}
SUPPORT={'app/misty-knowledge-sync.mjs','app/codex-relay-client.mjs'}
FILES=RUNTIME|ARCHIVE|TESTS|SUPPORT
node=str(ROOT/'bin/node')
def run(*args,**kwargs):return subprocess.run(args,check=True,**kwargs)
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None
def targets():return [(ROOT/name,name,'bot') for name in RUNTIME]+[(Path('/opt/archival')/name,name,'archive') for name in ARCHIVE]

if sys.argv[1]=='stage':
    CANDIDATE.mkdir(parents=True,exist_ok=True)
    shutil.copytree('/opt/archival/app',CANDIDATE/'app',dirs_exist_ok=True)
    shutil.copytree(ROOT/'app',CANDIDATE/'app',dirs_exist_ok=True)
    (CANDIDATE/'scripts').mkdir(exist_ok=True)
    shutil.copyfile('/opt/archival/scripts/misty-archive-query.py',CANDIDATE/'scripts/misty-archive-query.py')
    shutil.copyfile('/opt/archival/scripts/discord-server-ids.txt',CANDIDATE/'scripts/discord-server-ids.txt')
    with tarfile.open(STAGE/'bundle.tar.gz','r:gz') as bundle:
        assert {m.name for m in bundle.getmembers()}==FILES
        for m in bundle.getmembers():
            assert m.isfile() and m.name in FILES
            p=CANDIDATE/m.name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(bundle.extractfile(m).read());p.chmod(0o644)
    for name in FILES:
        if name.endswith(('.mjs','.js')):run(node,'--check',str(CANDIDATE/name),stdout=subprocess.DEVNULL)
        elif name.endswith('.py'):compile((CANDIDATE/name).read_text(),name,'exec')
    run(node,'--disable-warning=ExperimentalWarning','--test',*sorted(TESTS),cwd=CANDIDATE)
    (STAGE/'baseline.json').write_text(json.dumps({str(p):digest(p) for p,_,_ in targets()}))
    print('Rephraser candidate passed; production unchanged.',flush=True)
    sys.exit(0)

assert sys.argv[1]=='install'
assert all(digest(Path(name))==value for name,value in json.loads((STAGE/'baseline.json').read_text()).items()),'Production source drifted'
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup=Path('/var/lib/misty-bot')/('rephraser-before-'+stamp);backup.mkdir(mode=0o700)
existing={str(p):p.exists() for p,_,_ in targets()}
for target,name,group in targets():
    if existing[str(target)]:
        p=backup/group/name;p.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(target,p)
run('systemctl','stop','misty-bot')
try:
    with sqlite3.connect('/var/lib/misty-bot/chat.sqlite') as src,sqlite3.connect(backup/'chat.sqlite') as dst:src.backup(dst)
    for p,name,group in targets():
        p.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(CANDIDATE/name,p);p.chmod(0o644)
    profile=json.loads((STAGE/'owner-voice.json').read_text())
    assert profile.get('version')==2 and profile.get('count',0)>=10
    with sqlite3.connect('/var/lib/misty-bot/chat.sqlite') as db:
        db.execute('INSERT INTO bot_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',('owner_voice',json.dumps(profile)))
    run('systemctl','start','misty-bot')
    for attempt in range(40):
        time.sleep(1)
        status=json.loads(Path('/var/lib/misty-bot/status.json').read_text())
        if status.get('state')=='online' and status.get('at',0)>time.time()*1000-5000:break
    else:raise RuntimeError('Bot did not reconnect')
    print(json.dumps({'installed':True,'backup':str(backup),'bot':status['state']}))
except Exception:
    run('systemctl','stop','misty-bot')
    for p,name,group in targets():
        if existing[str(p)]:shutil.copyfile(backup/group/name,p)
        else:p.unlink(missing_ok=True)
    run('systemctl','start','misty-bot')
    raise
