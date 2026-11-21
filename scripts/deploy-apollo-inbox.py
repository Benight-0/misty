"""Guarded in-place Apollo upgrade. Never hand off/reset a watcher or restore live DBs."""
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

STAGE=Path('/tmp/archival-migration/apollo-inbox')
CANDIDATE=STAGE/'candidate'
STATE=Path('/var/lib/misty-prominence')
NODE='/opt/misty-bot/bin/node'
def run(*args,**kwargs):return subprocess.run(args,check=True,text=True,**kwargs)
def digest(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest() if Path(p).exists() else None
def read_db(p):return sqlite3.connect('file:'+str(p)+'?mode=ro',uri=True)
def fork(*args):return run('runuser','-u','misty-bot','--','env','PROMINENCE_CONFIG=/etc/misty-prominence/config.json','/opt/misty-prominence/venv/bin/python','/opt/misty-prominence/selfupdate.py',*args,capture_output=True).stdout.strip()
baseline=json.loads((STAGE/'baseline.json').read_text())
for p,value in baseline['hashes'].items():assert digest(p)==value,'Live component changed; merge first: '+p
assert not Path('/opt/apollo-bot/app/apollo-inbox.mjs').exists(),'Already upgraded; inspect/repair without repeating migration.'
assert not (STATE/'restart_request.json').exists(),'Another fork update is pending'
targets={Path('/opt/apollo-bot')/p:CANDIDATE/p for p in ['app/apollo.mjs','app/apollo-inbox.mjs','app/apollo-client.mjs','app/misty-notifications.mjs','app/codex-reader.mjs','scripts/apollo-discord-bot.mjs','scripts/check-apollo-inbox.mjs']}
targets[Path('/etc/systemd/system/apollo-bot.service')]=CANDIDATE/'scripts/apollo-bot.service'
targets[Path('/opt/misty-prominence/misty_context.py')]=CANDIDATE/'prominence/misty_context.py'
backup=Path('/var/backups/misty')/('apollo-inbox-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'));backup.mkdir(parents=True,mode=0o700)
snapshot=fork('snapshot','Apollo Luna/none quiet discussion inbox; preserve Misty/activity/reminders')
for dest in targets:
 if dest.exists():
  saved=backup/'files'/str(dest).lstrip('/');saved.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(dest,saved)
shutil.copy2('/etc/misty-prominence/config.json',backup/'misty-config.json')
shutil.copytree('/etc/systemd/system/apollo-bot.service.d',backup/'apollo-dropins')
with read_db(STATE/'focus.sqlite') as source,sqlite3.connect(backup/'focus-evidence.sqlite') as dest:source.backup(dest)
shutil.copy2(STATE/'workflows.json',backup/'workflows-evidence.json')
# Apollo handles SIGTERM by completing in-flight decisions and saving uncertainty.
# The shared collector, original laptop relay, Misty bridge and activity stay up.
run('systemctl','stop','apollo-bot')
with read_db('/var/lib/apollo-bot/chat.sqlite') as source,sqlite3.connect(backup/'apollo.sqlite') as dest:
 source.backup(dest)
 before={'cursor':source.execute("SELECT value FROM bot_settings WHERE key='misty_watch_cursor'").fetchone()[0],
         'codexCursor':source.execute("SELECT value FROM bot_settings WHERE key='codex_event_cursor'").fetchone()[0],
         'receipts':source.execute('SELECT seq,source,status,message_id FROM relay_notices').fetchall(),
         'buffers':source.execute('SELECT room_id,events,started_at FROM misty_watch_buffers ORDER BY room_id').fetchall()}
(backup/'before.json').write_text(json.dumps(before));(backup/'before.json').chmod(0o600)
report={'backup':str(backup),'forkSnapshot':snapshot,'productionChanges':[],'restoreDatabaseAutomatically':False}
(STAGE/'deployment.json').write_text(json.dumps(report,indent=2));(STAGE/'deployment.json').chmod(0o644)
try:
 for dest,src in targets.items():
  temp=dest.with_name(dest.name+'.candidate');shutil.copy2(src,temp);temp.chmod(0o644)
  if dest.is_relative_to(Path('/opt/misty-prominence')):
   user=pwd.getpwnam('misty-bot');os.chown(temp,user.pw_uid,user.pw_gid)
  os.replace(temp,dest);report['productionChanges'].append(str(dest))
 for dest in targets:
  if dest.suffix=='.mjs':run(NODE,'--check',str(dest),capture_output=True)
 assert fork('check')=='ok'
 run('systemd-analyze','verify','/etc/systemd/system/apollo-bot.service',capture_output=True)
 run('systemctl','daemon-reload')
 # Run additive migrations under Apollo's OS identity before starting its receiver.
 init="import {BotStore} from './app/discord-bot.mjs';import {ApolloMessenger} from './app/apollo.mjs';const s=new BotStore('/var/lib/apollo-bot/chat.sqlite');new ApolloMessenger(s,{},{});s.close();"
 run('runuser','-u','apollo-bot','--',NODE,'--disable-warning=ExperimentalWarning','--input-type=module','-e',init,cwd='/opt/apollo-bot',capture_output=True)
 with read_db('/var/lib/apollo-bot/chat.sqlite') as db:
  assert db.execute("SELECT value FROM bot_settings WHERE key='misty_watch_cursor'").fetchone()[0]==before['cursor']
  assert db.execute("SELECT value FROM bot_settings WHERE key='codex_event_cursor'").fetchone()[0]==before['codexCursor']
  assert db.execute('SELECT room_id,events,started_at FROM misty_watch_buffers ORDER BY room_id').fetchall()==before['buffers']
  for seq,source,status,message_id in before['receipts']:
   actual=db.execute('SELECT status,message_id FROM relay_notices WHERE seq=?',(seq,)).fetchone()
   if status in ('sent','unknown'):assert actual==(status,message_id),'Historical receipt changed'
  assert not db.execute("SELECT 1 FROM relay_notices WHERE status='queued' AND source NOT LIKE 'answer:%' AND source NOT LIKE 'progress:%'").fetchone()
 run('systemctl','start','apollo-bot')
except Exception:
 # Fail quiet. Never revive old proactive code or overwrite newer cursors/receipts.
 subprocess.run(['systemctl','stop','apollo-bot'],check=False,capture_output=True)
 report['failure']='Apollo left stopped; shared collection remains online. Repair candidate in place; never restore live database wholesale.'
 (STAGE/'deployment.json').write_text(json.dumps(report,indent=2));raise
fork('log','Apollo now pins gpt-6-luna/none for background and owner tool retrieval, saves discussions/Codex notices quietly, and provides on-demand inbox recaps. Preserved Misty gpt-6.1-sol/high, lightweight helpers, reminders/activity, approvals and one watcher. Backup: '+str(backup))
started=time.time();print(json.dumps({'backup':str(backup),'restart':fork('restart','Accurate Apollo store-only role instructions')}),flush=True)
for attempt in range(90):
 trial=STATE/'restart_trial.json'
 if trial.exists() and trial.stat().st_mtime>=started and not (STATE/'restart_request.json').exists():break
 time.sleep(2)
else:raise RuntimeError('Misty graceful restart pending; do not kill active work')
assert digest('/etc/misty-prominence/config.json')==baseline['hashes']['/etc/misty-prominence/config.json']
assert digest('/opt/apollo-bot/app/openai-analysis.mjs')==baseline['hashes']['/opt/apollo-bot/app/openai-analysis.mjs']
report.update(hashes={str(p):digest(p) for p in targets},preservedCursorsAndBuffersAtCutover=True,preservedHistoricalReceipts=True,mistyConfigUnchanged=True,sharedClientUnchanged=True)
(STAGE/'deployment.json').write_text(json.dumps(report,indent=2));(STAGE/'deployment.json').chmod(0o644)
print(json.dumps(report),flush=True)
