"""Guarded incremental Codex delegation/history/activity upgrade; run as root on VM."""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import sqlite3
import subprocess
import time
import urllib.request

STAGE=Path('/tmp/archival-migration/misty-codex-associate')
CANDIDATE=STAGE/'candidate'
FORK=Path('/opt/misty-prominence')
STATE=Path('/var/lib/misty-prominence')
NODE='/opt/misty-bot/bin/node'
MISTY=['app/misty-prominence-bridge.mjs','app/misty-direct.mjs','app/codex-events.mjs','app/misty-redact.mjs','app/misty-relay.mjs','scripts/misty-discord-bot.mjs','scripts/misty-relay-agent.mjs']
APOLLO=['app/apollo.mjs','app/codex-reader.mjs','scripts/apollo-discord-bot.mjs']
PYTHON=['bot.py','agent.py','misty.py','misty_context.py','activity.py','test_activity.py']

def run(*args,**kwargs):return subprocess.run(args,check=True,text=True,**kwargs)
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None
def read_db(p):return sqlite3.connect('file:'+str(p)+'?mode=ro',uri=True)
def fork(*args):return run('runuser','-u','misty-bot','--','env','PROMINENCE_CONFIG=/etc/misty-prominence/config.json',str(FORK/'venv/bin/python'),*args,capture_output=True)
def authenticated(port,token,op,args=None):
 req=urllib.request.Request('http://127.0.0.1:'+str(port)+'/call',data=json.dumps({'op':op,'args':args or {}}).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
 with urllib.request.urlopen(req,timeout=10) as r:return json.load(r)

baseline=json.loads((STAGE/'baseline.json').read_text())
for name,expected in baseline.items():assert digest(Path(name))==expected,'Source changed; merge first: '+name
assert not (STATE/'restart_request.json').exists(),'A self-update is pending.'
with read_db(STATE/'inbox.sqlite') as db:assert not db.execute("SELECT 1 FROM inbox WHERE state IN ('running','delivering') LIMIT 1").fetchone(),'An owner turn is active.'
with read_db('/var/lib/misty-bot/chat.sqlite') as db:assert not db.execute("SELECT 1 FROM relay_jobs WHERE status IN ('claimed','submitting','running') LIMIT 1").fetchone(),'Laptop task active.'
with read_db('/var/lib/apollo-bot/chat.sqlite') as db:assert not db.execute("SELECT 1 FROM bot_turns WHERE status='generating' LIMIT 1").fetchone(),'Apollo owner answer active.'

targets={Path('/opt/misty-bot')/r:CANDIDATE/r for r in MISTY}
targets.update({Path('/opt/apollo-bot')/r:CANDIDATE/r for r in APOLLO})
targets.update({FORK/r:CANDIDATE/'prominence'/r for r in PYTHON})
for dest,src in targets.items():
 assert src.exists(),str(src)
 if str(dest) not in baseline and dest.exists():assert digest(dest)==digest(src),'Unexpected existing file: '+str(dest)
backup=STATE/('codex-associate-before-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'));backup.mkdir(mode=0o700)
previous={}
for dest in targets:
 previous[str(dest)]=dest.exists()
 if dest.exists():
  saved=backup/str(dest).lstrip('/');saved.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(dest,saved)
snapshot=fork(str(FORK/'selfupdate.py'),'snapshot','Direct scoped Codex dispatch, activity status and Apollo Codex history notifications').stdout.strip()
credential=Path('/etc/misty-bot/apollo-reader-token')
assert not credential.exists(),'Reader credential already exists; inspect deployment first.'
credential.write_text(os.urandom(32).hex());credential.chmod(0o600)
drops={Path('/etc/systemd/system/misty-bot.service.d/codex-reader.conf'):'[Service]\nLoadCredential=apollo-reader-token:/etc/misty-bot/apollo-reader-token\n',Path('/etc/systemd/system/apollo-bot.service.d/codex-reader.conf'):'[Service]\nLoadCredential=codex-token:/etc/misty-bot/apollo-reader-token\n'}
assert all(not p.exists() for p in drops),'Drop-in already exists.'
try:
 for dest,src in targets.items():
  temp=dest.with_name(dest.name+'.candidate');shutil.copy2(src,temp);temp.chmod(0o644)
  if dest.is_relative_to(FORK):
   account=pwd.getpwnam('misty-bot');os.chown(temp,account.pw_uid,account.pw_gid)
  os.replace(temp,dest)
 for p,body in drops.items():p.parent.mkdir(parents=True,exist_ok=True);p.write_text(body);p.chmod(0o644)
 for dest in targets:
  if dest.suffix=='.mjs':run(NODE,'--check',str(dest),capture_output=True)
 checked=fork(str(FORK/'selfupdate.py'),'check');assert checked.stdout.strip()=='ok',checked.stdout
 run('systemctl','daemon-reload')
 run('systemctl','restart','misty-bot','apollo-bot')
 token=credential.read_text().strip()
 for attempt in range(25):
  try:
   status=authenticated(8794,token,'status');break
  except OSError:
   if attempt==24:raise
   time.sleep(1)
 assert authenticated(8794,token,'knowledge_find',{'query':'','kind':'codex'})['status']
 for op in ('send','draft','control'):
  try:authenticated(8794,token,op)
  except urllib.error.HTTPError as error:assert error.code==400
  else:raise AssertionError('Reader accepted write operation.')
except Exception:
 for dest in targets:
  if previous[str(dest)]:shutil.copy2(backup/str(dest).lstrip('/'),dest)
  else:dest.unlink(missing_ok=True)
 for p in drops:p.unlink(missing_ok=True)
 credential.unlink(missing_ok=True)
 run('systemctl','daemon-reload');run('systemctl','restart','misty-bot','apollo-bot')
 raise

fork(str(FORK/'selfupdate.py'),'log','Direct owner-scoped Codex sending with idempotent receipts, factual activity and shared read-only Codex history for Apollo. Laptop emits visible progress/completion notifications to Apollo.')
started=time.time();restart=fork(str(FORK/'selfupdate.py'),'restart','Codex delegation, factual activity and Apollo history')
print(json.dumps({'backup':str(backup),'snapshot':snapshot,'restart':restart.stdout.strip()}),flush=True)
for attempt in range(25):
 trial=STATE/'restart_trial.json'
 if trial.exists() and trial.stat().st_mtime>=started and not (STATE/'restart_request.json').exists():break
 time.sleep(2)
else:raise RuntimeError('Graceful restart pending; do not interrupt an owner turn.')
run('systemctl','is-active','misty-prominence','misty-bot','apollo-bot','archival','cloudflared','misty-metrics','misty-metrics-collect.timer')
report={'backup':str(backup),'snapshot':snapshot,'hashes':{str(p):digest(p) for p in targets},'codexDocuments':next((r['documents'] for r in authenticated(8794,token,'knowledge_find',{'query':'','kind':'codex'})['status'] if r['kind']=='codex'),0),'readerWriteOperationsRejected':True}
(STAGE/'deployment.json').write_text(json.dumps(report,indent=2));(STAGE/'deployment.json').chmod(0o644)
print(json.dumps(report),flush=True)
