"""Stage natural conversation/progress delivery; keep archive collectors online."""
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

ROOT=Path('/opt/misty-bot');STAGE=Path('/tmp/archival-migration/misty-dialogue');CANDIDATE=STAGE/'candidate'
BOT={'app/misty-dialogue.mjs','app/misty-rephraser.mjs','app/misty-relay.mjs','app/misty-persona.mjs','app/misty-style.mjs','app/misty-archive.mjs','scripts/misty-discord-bot.mjs'}
ARCHIVE={'scripts/misty-archive-query.py'}
TESTS={'app/tests/'+n+'.test.mjs' for n in ['misty-dialogue','misty-self','misty-rephraser','misty-peer','misty-relay','misty-interactions','misty-associate','misty-conversation','discord-bot','misty-ui','misty-sources']}
SUPPORT={'app/misty-knowledge-sync.mjs','app/codex-relay-client.mjs'}
FILES=BOT|ARCHIVE|TESTS|SUPPORT
node=str(ROOT/'bin/node')
def run(*args,**kwargs):return subprocess.run(args,check=True,**kwargs)
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None
def targets():return [(ROOT/n,CANDIDATE/n,'bot/'+n) for n in BOT]+[(Path('/opt/archival')/n,CANDIDATE/n,'archive/'+n) for n in ARCHIVE]

if sys.argv[1]=='stage':
    CANDIDATE.mkdir(parents=True,exist_ok=True)
    shutil.copytree('/opt/archival/app',CANDIDATE/'app',dirs_exist_ok=True)
    shutil.copytree(ROOT/'app',CANDIDATE/'app',dirs_exist_ok=True)
    (CANDIDATE/'scripts').mkdir(exist_ok=True)
    with tarfile.open(STAGE/'bundle.tar.gz','r:gz') as bundle:
        assert {m.name for m in bundle.getmembers()}==FILES
        for m in bundle.getmembers():
            assert m.isfile() and m.name in FILES
            p=CANDIDATE/m.name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(bundle.extractfile(m).read());p.chmod(0o644)
    for name in BOT:run(node,'--check',str(CANDIDATE/name),stdout=subprocess.DEVNULL)
    for name in ARCHIVE:compile((CANDIDATE/name).read_text(),name,'exec')
    run(node,'--disable-warning=ExperimentalWarning','--test',*sorted(TESTS),cwd=CANDIDATE)
    (STAGE/'baseline.json').write_text(json.dumps({str(p):digest(p) for p,_,_ in targets()}))
    print('Dialogue candidate passed; production unchanged.',flush=True)
    sys.exit(0)

assert sys.argv[1]=='install'
assert all(digest(Path(name))==value for name,value in json.loads((STAGE/'baseline.json').read_text()).items()),'Production source drifted'
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup=Path('/var/lib/misty-bot')/('dialogue-before-'+stamp);backup.mkdir(mode=0o700)
existing={str(p):p.exists() for p,_,_ in targets()}
for p,_,name in targets():
    if p.exists():target=backup/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,target)
run('systemctl','stop','misty-bot')
try:
    with sqlite3.connect('/var/lib/misty-bot/chat.sqlite') as src,sqlite3.connect(backup/'chat.sqlite') as dst:src.backup(dst)
    for target,source,_ in targets():
        target.parent.mkdir(parents=True,exist_ok=True);temp=target.with_name(target.name+'.dialogue-new');shutil.copyfile(source,temp);temp.chmod(0o644);temp.replace(target)
    run('systemctl','start','misty-bot')
    for _ in range(40):
        time.sleep(1);status=json.loads(Path('/var/lib/misty-bot/status.json').read_text())
        if status.get('state')=='online' and status.get('at',0)>time.time()*1000-5000:break
    else:raise RuntimeError('Bot did not reconnect')
    assert all(digest(p)==digest(source) for p,source,_ in targets())
    print(json.dumps({'installed':True,'backup':str(backup),'bot':status['state'],'runtimeTargets':len(targets())}))
except Exception:
    run('systemctl','stop','misty-bot')
    for target,_,name in targets():
        if existing[str(target)]:
            temp=target.with_name(target.name+'.dialogue-rollback');shutil.copy2(backup/name,temp);temp.replace(target)
        else:target.unlink(missing_ok=True)
    run('systemctl','start','misty-bot');raise
