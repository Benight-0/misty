"""Stage/install the actual upstream fork. Archive collectors are not restarted."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import time
import urllib.request

STAGE=Path('/tmp/archival-migration/misty-prominence')
CANDIDATE=STAGE/'candidate'
BOT=Path('/opt/misty-bot')
FORK=Path('/opt/misty-prominence')
STATE=Path('/var/lib/misty-prominence')
NODE=str(BOT/'bin/node')
BRIDGE={'app/misty-prominence-bridge.mjs','scripts/misty-discord-bot.mjs'}

def run(*args,**kwargs):return subprocess.run(args,check=True,**kwargs)
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None
def owner(path):
    user=pwd.getpwnam('misty-bot');os.chown(path,user.pw_uid,user.pw_gid)

if sys.argv[1]=='stage':
    CANDIDATE.mkdir(parents=True,exist_ok=True)
    shutil.copytree('/opt/archival/app',CANDIDATE/'app',dirs_exist_ok=True)
    shutil.copytree(BOT/'app',CANDIDATE/'app',dirs_exist_ok=True)
    (CANDIDATE/'scripts').mkdir(exist_ok=True)
    shutil.copy2('/opt/archival/scripts/misty-archive-query.py',CANDIDATE/'scripts/misty-archive-query.py')
    with tarfile.open(STAGE/'bundle.tar.gz') as bundle:
        for m in bundle.getmembers():
            assert m.isfile() and not Path(m.name).is_absolute() and '..' not in Path(m.name).parts
            assert m.name.startswith(('prominence/','app/tests/')) or m.name in BRIDGE|{'app/misty-knowledge-sync.mjs','app/codex-relay-client.mjs'}
            target=CANDIDATE/m.name;target.parent.mkdir(parents=True,exist_ok=True)
            target.write_bytes(bundle.extractfile(m).read());target.chmod(0o644)
    for name in BRIDGE:run(NODE,'--check',str(CANDIDATE/name))
    run(NODE,'--disable-warning=ExperimentalWarning','--test','--test-reporter=dot',
        'app/tests/misty-prominence.test.mjs','app/tests/misty-relay.test.mjs',
        'app/tests/misty-interactions.test.mjs','app/tests/misty-associate.test.mjs',cwd=CANDIDATE)
    python=str(STAGE/'venv/bin/python')
    run(python,'-m','unittest','discover','-s','prominence','-p','test_fork.py',cwd=CANDIDATE)
    run(python,'-m','compileall','-q',str(CANDIDATE/'prominence'))
    env={**os.environ,'PROMINENCE_DATA_DIR':str(STAGE/'check-data')}
    run(python,str(CANDIDATE/'prominence/selfupdate.py'),'check',env=env)
    (STAGE/'baseline.json').write_text(json.dumps({n:digest(BOT/n) for n in BRIDGE}))
    print('Fork staged and tested; production unchanged.',flush=True)
    sys.exit(0)

assert sys.argv[1]=='install'
verification=json.loads((STAGE/'backend-verification.json').read_text())
assert verification['realToolUse'] and verification['persistentContextResume'] and verification['cheapSocialBackend']
assert not FORK.exists(),'An installed fork already exists; use the recorded upgrade/rollback path.'
assert all(digest(BOT/n)==v for n,v in json.loads((STAGE/'baseline.json').read_text()).items()),'Production source drifted'
with sqlite3.connect('file:/var/lib/misty-bot/chat.sqlite?mode=ro',uri=True) as db:
    assert db.execute("SELECT count(*) FROM bot_turns WHERE status IN ('queued','generating')").fetchone()[0]==0,'Wait for the active owner reply before switching'
    previous_ids=[row[0] for row in db.execute('SELECT id FROM bot_turns') if row[0].isdigit()]
    initial_cursor=max(previous_ids,key=int) if previous_ids else '0'
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup=Path('/var/lib/misty-bot')/('prominence-before-'+stamp);backup.mkdir(mode=0o700)
for name in BRIDGE:
    p=BOT/name
    if p.exists():q=backup/name;q.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,q)

shutil.copytree(CANDIDATE/'prominence',FORK)
(FORK/'runtime').mkdir()
for name in ('bin','codex-resources','codex-path'):shutil.copytree(STAGE/'runtime'/name,FORK/'runtime'/name)
shutil.copytree(STAGE/'venv',FORK/'venv',symlinks=True)
for p in (FORK/'venv/bin').iterdir():
    if p.is_file() and not p.is_symlink() and p.stat().st_size<100000:
        body=p.read_bytes();old=str(STAGE/'venv').encode()
        if old in body:p.write_bytes(body.replace(old,str(FORK/'venv').encode()))
STATE.mkdir(mode=0o700);(STATE/'.codex').mkdir(mode=0o700);(STATE/'notes').mkdir(mode=0o700)
# Current laptop Codex profile is API-key mode. Use the already-authorized VM
# key privately; never transfer or print a laptop OAuth refresh token.
key=Path('/etc/archival/openai-key').read_text().strip()
auth=STATE/'.codex/auth.json';auth.write_text(json.dumps({'auth_mode':'apikey','OPENAI_API_KEY':key}));auth.chmod(0o600)
token=Path('/etc/misty-bot/prominence-token')
if not token.exists():token.write_text(os.urandom(32).hex());token.chmod(0o600)
settings=Path('/etc/misty-prominence');settings.mkdir(mode=0o700)
config={'owner_id':'100000000000000023','main_channel_id':'100000000000000046',
        'name':'Misty','anime_name':'Misty','dm_only':True,'owner_only':True,
        'agent_backend':'codex','agent_model':'gpt-6.1-sol','agent_effort':'high',
        'gate_model':'gpt-5.6-luna','social_model':'gpt-5.6-luna',
        'codex_bin':str(FORK/'runtime/bin/codex'),'data_dir':str(STATE),
        'token_file':'/run/credentials/misty-prominence.service/discord-token',
        'misty_bridge_token_file':'/run/credentials/misty-prominence.service/prominence-token',
        'doc_roots':[str(FORK),str(STATE/'notes')],'project_roots':[str(FORK)]}
(settings/'config.json').write_text(json.dumps(config,indent=2));(settings/'config.json').chmod(0o600)
with sqlite3.connect(STATE/'inbox.sqlite') as db:
    db.execute('CREATE TABLE cursor(channel TEXT PRIMARY KEY,id TEXT)')
    db.execute('INSERT INTO cursor VALUES(?,?)',(config['main_channel_id'],initial_cursor))
for root in (FORK,STATE,settings):
    owner(root)
    for p in root.rglob('*'):
        if not p.is_symlink():owner(p)

unit='''[Unit]
Description=Misty Prominence fork with Codex agent
After=network-online.target misty-bot.service
Wants=network-online.target misty-bot.service
StartLimitIntervalSec=600
StartLimitBurst=4

[Service]
Type=simple
User=misty-bot
Group=misty-bot
WorkingDirectory=/opt/misty-prominence
ExecStart=/opt/misty-prominence/venv/bin/python /opt/misty-prominence/supervise.py
Environment=HOME=/var/lib/misty-prominence
Environment=CODEX_HOME=/var/lib/misty-prominence/.codex
Environment=PROMINENCE_CONFIG=/etc/misty-prominence/config.json
Environment=QUIET_BOOT=1
Environment=PYTHONUNBUFFERED=1
Environment=TZ=Asia/Kolkata
Environment=TOKIO_WORKER_THREADS=2
Environment=PATH=/opt/misty-prominence/venv/bin:/opt/misty-prominence/runtime/bin:/opt/misty-prominence/runtime/codex-path:/usr/local/bin:/usr/bin:/bin
LoadCredential=discord-token:/etc/misty-bot/discord-token
LoadCredential=prominence-token:/etc/misty-bot/prominence-token
UMask=0077
Restart=on-failure
RestartSec=30
KillMode=control-group
TimeoutStopSec=30
MemoryHigh=300M
MemoryMax=430M
CPUQuota=60%
TasksMax=128
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/misty-prominence /var/lib/misty-prominence
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
InaccessiblePaths=/etc/archival /var/lib/archival /etc/misty-bot

[Install]
WantedBy=multi-user.target
'''
unitpath=Path('/etc/systemd/system/misty-prominence.service');unitpath.write_text(unit)
drop=Path('/etc/systemd/system/misty-bot.service.d/prominence-bridge.conf')
drop.write_text('[Service]\nEnvironment=MISTY_BRIDGE_ONLY=1\nLoadCredential=prominence-token:/etc/misty-bot/prominence-token\n')
run('systemctl','stop','misty-bot')
try:
    with sqlite3.connect('/var/lib/misty-bot/chat.sqlite') as src,sqlite3.connect(backup/'chat.sqlite') as dst:src.backup(dst)
    # Freeze the handoff AFTER the old responder has stopped. Seed prior IDs as
    # imported so a queued request survives without re-running a handled turn.
    with sqlite3.connect('file:/var/lib/misty-bot/chat.sqlite?mode=ro',uri=True) as src:
        rows=src.execute('SELECT id,status FROM bot_turns').fetchall()
    ids=[message_id for message_id,_ in rows if message_id.isdigit()]
    pending=[message_id for message_id,status in rows if message_id.isdigit() and status in ('queued','generating')]
    cursor=str(int(min(pending,key=int))-1) if pending else max(ids,key=int) if ids else '0'
    with sqlite3.connect(STATE/'inbox.sqlite') as db:
        db.execute('CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY,channel TEXT,body TEXT,state TEXT,reply TEXT DEFAULT "",updated REAL)')
        for message_id,status in rows:
            if message_id.isdigit() and status not in ('queued','generating'):
                db.execute('INSERT OR IGNORE INTO inbox(id,channel,body,state,updated) VALUES(?,?,?,"imported",?)',(message_id,config['main_channel_id'],'{}',time.time()))
        db.execute('UPDATE cursor SET id=? WHERE channel=?',(cursor,config['main_channel_id']))
    owner(STATE/'inbox.sqlite')
    for name in BRIDGE:
        dest=BOT/name;temp=dest.with_name(dest.name+'.fork-new');shutil.copy2(CANDIDATE/name,temp);temp.replace(dest)
    run('systemctl','daemon-reload');run('systemctl','start','misty-bot')
    for _ in range(45):
        try:
            req=urllib.request.Request('http://127.0.0.1:8792/call',data=b'{"op":"status"}',headers={'Authorization':'Bearer '+token.read_text().strip(),'Content-Type':'application/json'})
            with urllib.request.urlopen(req,timeout=2) as response:json.load(response)
            break
        except Exception:time.sleep(1)
    else:raise RuntimeError('Bridge did not become ready')
    run('systemctl','enable','--now','misty-prominence')
    time.sleep(5);run('systemctl','is-active','misty-prominence','misty-bot','archival')
    (STAGE/'installed.json').write_text(json.dumps({'backup':str(backup),'at':stamp,'fork':str(FORK)}))
    print(json.dumps({'installed':True,'backup':str(backup),'fork':str(FORK)}),flush=True)
except Exception:
    subprocess.run(['systemctl','disable','--now','misty-prominence'])
    subprocess.run(['systemctl','stop','misty-bot'])
    known={}
    if (STATE/'inbox.sqlite').exists():
        with sqlite3.connect('file:'+str(STATE/'inbox.sqlite')+'?mode=ro',uri=True) as db:
            if db.execute("SELECT 1 FROM sqlite_master WHERE name='inbox'").fetchone():known=dict(db.execute('SELECT id,state FROM inbox'))
    with sqlite3.connect('/var/lib/misty-bot/chat.sqlite') as db:
        for (message_id,) in db.execute("SELECT id FROM bot_turns WHERE status='external'").fetchall():
            state='queued' if known.get(message_id,'queued')=='queued' else 'unknown'
            db.execute('UPDATE bot_turns SET status=? WHERE id=?',(state,message_id))
        db.execute("UPDATE bot_turns SET status='sent' WHERE status='external_sent'")
    drop.unlink(missing_ok=True)
    for name in BRIDGE:
        dest=BOT/name;saved=backup/name
        if saved.exists():shutil.copy2(saved,dest)
        else:dest.unlink(missing_ok=True)
    run('systemctl','daemon-reload');run('systemctl','start','misty-bot')
    raise
