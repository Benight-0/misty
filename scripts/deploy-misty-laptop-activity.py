"""Scoped activity upgrade; never restarts the active Windows/VM Codex relay."""
from datetime import datetime,timezone
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import sqlite3
import subprocess
import time
import urllib.error
import urllib.request

STAGE=Path('/tmp/archival-migration/misty-laptop-activity')
CANDIDATE=STAGE/'candidate'
FORK=Path('/opt/misty-prominence')
STATE=Path('/var/lib/misty-prominence')
def run(*args,**kwargs):return subprocess.run(args,check=True,text=True,**kwargs)
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None
def fork(*args):return run('runuser','-u','misty-bot','--','env','PROMINENCE_CONFIG=/etc/misty-prominence/config.json',str(FORK/'venv/bin/python'),*args,capture_output=True)
baseline=json.loads((STAGE/'baseline.json').read_text())
for path,value in baseline.items():assert digest(Path(path))==value,'Live file changed; merge first: '+path
assert not (STATE/'restart_request.json').exists(),'Another self-update is pending.'
targets={}
for p in ['app/laptop-activity.mjs','app/laptop-activity-server.mjs','scripts/misty-activity-ingest.mjs','scripts/misty-relay-agent.mjs']:targets[Path('/opt/misty-bot')/p]=CANDIDATE/p
for p in ['laptop_activity.py','bot.py','misty.py','misty_context.py']:targets[FORK/p]=CANDIDATE/'prominence'/p
unit=Path('/etc/systemd/system/misty-activity.service');targets[unit]=CANDIDATE/'deploy/misty-activity.service'
assert all(str(path) in baseline for path in targets)
backup=STATE/('laptop-activity-before-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'));backup.mkdir(mode=0o700)
for path in targets:
 if path.exists():saved=backup/str(path).lstrip('/');saved.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(path,saved)
# Keep evidence of reminders without restoring an old complete workflow file on rollback.
shutil.copy2(STATE/'workflows.json',backup/'workflows-before.json')
snapshot=fork(str(FORK/'selfupdate.py'),'snapshot','Private Windows activity and a bounded 15-minute owner-only check').stdout.strip()
try:
 for dest,src in targets.items():
  temp=dest.with_name(dest.name+'.candidate');shutil.copy2(src,temp);temp.chmod(0o644)
  if dest.is_relative_to(FORK):
   user=pwd.getpwnam('misty-bot');os.chown(temp,user.pw_uid,user.pw_gid)
  os.replace(temp,dest)
 for path in targets:
  if path.suffix=='.mjs':run('/opt/misty-bot/bin/node','--check',str(path),capture_output=True)
 assert fork(str(FORK/'selfupdate.py'),'check').stdout.strip()=='ok'
 run('systemctl','daemon-reload');run('systemctl','enable','--now','misty-activity')
 token=Path('/etc/misty-bot/prominence-token').read_text().strip()
 for attempt in range(15):
  try:
   req=urllib.request.Request('http://127.0.0.1:8797/status',data=b'{}',headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
   with urllib.request.urlopen(req,timeout=5) as response:status=json.load(response)
   break
  except OSError:
   if attempt==14:raise
   time.sleep(1)
 assert status['sampleCadenceSeconds']==30
except Exception:
 subprocess.run(['systemctl','disable','--now','misty-activity'],check=False,capture_output=True,text=True)
 for path in targets:
  if baseline[str(path)] is None:path.unlink(missing_ok=True)
  else:shutil.copy2(backup/str(path).lstrip('/'),path)
 run('systemctl','daemon-reload')
 raise
fork(str(FORK/'selfupdate.py'),'log','Private sampled laptop foreground/window and optional Chrome tabs over paired SSH. Separate ingestion service; current Codex relay remains running. Tool-free 15-minute owner-only dry commentary, pause/resume, stale/idle/no-change suppression and current-focus context. No personal-message confirmation changes.')
started=time.time();restart=fork(str(FORK/'selfupdate.py'),'restart','Private laptop activity and 15-minute checks')
print(json.dumps({'backup':str(backup),'snapshot':snapshot,'restart':restart.stdout.strip()}),flush=True)
for attempt in range(60):
 trial=STATE/'restart_trial.json'
 if trial.exists() and trial.stat().st_mtime>=started and not (STATE/'restart_request.json').exists():break
 if attempt%15==0:print('Waiting for supported Misty restart; active work is preserved.',flush=True)
 time.sleep(2)
else:raise RuntimeError('Graceful Misty restart is pending; do not kill active work.')
run('systemctl','is-active','misty-activity','misty-prominence','misty-bot','apollo-bot','archival')
report={'backup':str(backup),'snapshot':snapshot,'existingRelayRestarted':False,'hashes':{str(path):digest(path) for path in targets}}
(STAGE/'deployment.json').write_text(json.dumps(report,indent=2));(STAGE/'deployment.json').chmod(0o644)
print(json.dumps(report),flush=True)
