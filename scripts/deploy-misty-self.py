"""Upgrade Misty's owner-DM self controls and Gateway without touching collectors."""
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

ROOT=Path('/opt/misty-bot')
STAGE=Path('/tmp/archival-migration/misty-self')
CANDIDATE=STAGE/'candidate'
BOT={'app/discord-bot.mjs','app/misty-relay.mjs','app/misty-persona.mjs','app/misty-dialogue.mjs','app/misty-rephraser.mjs','app/misty-self.mjs','scripts/misty-discord-bot.mjs'}
TESTS={'app/tests/'+name+'.test.mjs' for name in ['misty-self','misty-rephraser','misty-peer','misty-relay','misty-interactions','misty-associate','misty-conversation','discord-bot','misty-ui','misty-sources']}
SUPPORT={'app/misty-knowledge-sync.mjs','app/codex-relay-client.mjs','scripts/misty-archive-query.py'}
GO={'collector/cmd/misty-bot-gateway/'+n for n in ['go.mod','go.sum','main.go','main_test.go']}
FILES=BOT|TESTS|SUPPORT|GO
node=str(ROOT/'bin/node')

def run(*args,**kwargs):return subprocess.run(args,check=True,**kwargs)
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None
def targets():return [(ROOT/name,CANDIDATE/name,name) for name in BOT]+[(ROOT/'bin/gateway',STAGE/'gateway','bin/gateway')]

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
    for name in BOT:
        run(node,'--check',str(CANDIDATE/name),stdout=subprocess.DEVNULL)
    run(node,'--disable-warning=ExperimentalWarning','--test',*sorted(TESTS),cwd=CANDIDATE)
    go='/opt/archival/build/go/bin/go'
    gateway=CANDIDATE/'collector/cmd/misty-bot-gateway'
    run('/opt/archival/build/go/bin/gofmt','-w',str(gateway/'main.go'),str(gateway/'main_test.go'))
    env=dict(os.environ,PATH='/opt/archival/build/go/bin:'+os.environ['PATH'],GOMAXPROCS='1',GOFLAGS='-p=1',GOMEMLIMIT='250MiB',GOCACHE='/home/ubuntu/.cache/go-build',GOMODCACHE='/home/ubuntu/go/pkg/mod')
    run(go,'test','.',cwd=gateway,env=env,timeout=300)
    run(go,'build','-trimpath','-ldflags=-s','-o',str(STAGE/'gateway'),'.',cwd=gateway,env=env,timeout=300)
    (STAGE/'baseline.json').write_text(json.dumps({str(p):digest(p) for p,_,_ in targets()}))
    print('Self-management candidate passed; production unchanged.',flush=True)
    sys.exit(0)

assert sys.argv[1]=='install'
assert all(digest(Path(name))==value for name,value in json.loads((STAGE/'baseline.json').read_text()).items()),'Production source drifted'
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup=Path('/var/lib/misty-bot')/('self-before-'+stamp);backup.mkdir(mode=0o700)
existing={str(p):p.exists() for p,_,_ in targets()}
for target,_,name in targets():
    if target.exists():
        p=backup/name;p.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(target,p)
run('systemctl','stop','misty-bot')
try:
    with sqlite3.connect('/var/lib/misty-bot/chat.sqlite') as src,sqlite3.connect(backup/'chat.sqlite') as dst:src.backup(dst)
    for target,source,name in targets():
        target.parent.mkdir(parents=True,exist_ok=True)
        temp=target.with_name(target.name+'.misty-self-new')
        shutil.copyfile(source,temp);temp.chmod(0o755 if name=='bin/gateway' else 0o644);temp.replace(target)
    run('systemctl','start','misty-bot')
    for attempt in range(40):
        time.sleep(1)
        status=json.loads(Path('/var/lib/misty-bot/status.json').read_text())
        receipt=status.get('presence') or {}
        if status.get('state')=='online' and status.get('at',0)>time.time()*1000-5000 and receipt.get('state')=='gateway_sent' and receipt.get('at',0)>time.time()*1000-10000:break
    else:raise RuntimeError('Bot did not reconnect with presence receipt')
    assert all(digest(target)==digest(source) for target,source,_ in targets()),'Installed bytes mismatch'
    print(json.dumps({'installed':True,'backup':str(backup),'bot':status['state'],'presence':receipt}))
except Exception:
    run('systemctl','stop','misty-bot')
    for target,_,name in targets():
        if existing[str(target)]:
            temp=target.with_name(target.name+'.misty-self-rollback');shutil.copy2(backup/name,temp);temp.replace(target)
        else:target.unlink(missing_ok=True)
    run('systemctl','start','misty-bot')
    raise
