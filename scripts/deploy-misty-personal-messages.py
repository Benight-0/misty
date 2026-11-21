"""Guarded VM installation of owner-confirmed personal messages. Run as root."""
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
import urllib.error
import urllib.request

STAGE=Path('/tmp/archival-migration/misty-personal-messages')
CANDIDATE=STAGE/'candidate'
FORK=Path('/opt/misty-prominence')
STATE=Path('/var/lib/misty-prominence')

def run(*args,**kwargs):return subprocess.run(args,check=True,text=True,**kwargs)
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None
def db(path):return sqlite3.connect('file:'+str(path)+'?mode=ro',uri=True)
def fork(*args):return run('runuser','-u','misty-bot','--','env','PROMINENCE_CONFIG=/etc/misty-prominence/config.json',str(FORK/'venv/bin/python'),*args,capture_output=True)
def request(port,token,path,body):
 req=urllib.request.Request(f'http://127.0.0.1:{port}{path}',data=json.dumps(body).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
 with urllib.request.urlopen(req,timeout=12) as response:return json.load(response)

baseline=json.loads((STAGE/'baseline.json').read_text())
for filename,expected in baseline.items():assert digest(Path(filename))==expected,'Live source changed: '+filename
assert not (STATE/'restart_request.json').exists(),'Self-update already pending.'
with db(STATE/'inbox.sqlite') as c:assert not c.execute("SELECT 1 FROM inbox WHERE state IN ('running','delivering') LIMIT 1").fetchone(),'An owner turn is active.'
with db('/var/lib/archival/data/archive.sqlite') as c:assert not c.execute("SELECT 1 FROM chat_outgoing WHERE status='sending' LIMIT 1").fetchone(),'A message is being sent.'
with db('/var/lib/misty-bot/chat.sqlite') as c:assert not c.execute("SELECT 1 FROM relay_jobs WHERE status IN ('claimed','submitting','running') LIMIT 1").fetchone(),'A Codex task is active.'

targets={}
for p in ['server.mjs','vm-server.mjs','native-chat.mjs','message-backend.mjs']:targets[Path('/opt/archival/app')/p]=CANDIDATE/'app'/p
for p in ['main.go','whatsapp-send.go']:targets[Path('/opt/archival/collector-src')/p]=CANDIDATE/'collector'/p
targets[Path('/opt/archival/bin/archival-collector')]=STAGE/'archival-collector'
for p in ['misty-prominence-bridge.mjs','misty-messages.mjs','message-backend.mjs']:targets[Path('/opt/misty-bot/app')/p]=CANDIDATE/'app'/p
targets[Path('/opt/misty-bot/scripts/misty-discord-bot.mjs')]=CANDIDATE/'scripts/misty-discord-bot.mjs'
for p in ['misty.py','misty_context.py']:targets[FORK/p]=CANDIDATE/'prominence'/p
for p in targets:assert str(p) in baseline,'Missing baseline: '+str(p)
for p in targets.values():assert p.exists(),'Missing candidate: '+str(p)

credential=Path('/etc/archival/message-token')
drops={Path('/etc/systemd/system/archival.service.d/personal-messages.conf'):'[Service]\nLoadCredential=message-token:/etc/archival/message-token\nEnvironment=ARCHIVAL_MESSAGE_TOKEN_FILE=/run/credentials/archival.service/message-token\n',Path('/etc/systemd/system/misty-bot.service.d/personal-messages.conf'):'[Service]\nLoadCredential=message-token:/etc/archival/message-token\n'}
assert not credential.exists() and all(not p.exists() for p in drops),'Sender credential/drop-in already exists; inspect first.'
backup=STATE/('personal-messages-before-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'));backup.mkdir(mode=0o700)
for p in targets:
 if p.exists():saved=backup/str(p).lstrip('/');saved.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,saved)
snapshot=fork(str(FORK/'selfupdate.py'),'snapshot','Personal Discord and WhatsApp sending after an exact owner yes').stdout.strip()
try:
 credential.write_text(os.urandom(32).hex());credential.chmod(0o600)
 for dest,src in targets.items():
  temp=dest.with_name(dest.name+'.candidate');shutil.copy2(src,temp);temp.chmod(0o755 if dest.name=='archival-collector' else 0o644)
  if dest.is_relative_to(FORK):
   account=pwd.getpwnam('misty-bot');os.chown(temp,account.pw_uid,account.pw_gid)
  os.replace(temp,dest)
 for p,body in drops.items():p.parent.mkdir(parents=True,exist_ok=True);p.write_text(body);p.chmod(0o644)
 for p in targets:
  if p.suffix=='.mjs':run('/opt/misty-bot/bin/node','--check',str(p),capture_output=True)
 assert fork(str(FORK/'selfupdate.py'),'check').stdout.strip()=='ok'
 run('systemctl','daemon-reload');run('systemctl','restart','archival','misty-bot')
 token=credential.read_text().strip()
 for attempt in range(90):
  try:
   with db('/var/lib/archival/data/archive.sqlite') as c:
    rows=c.execute("SELECT id,remote_id,platform FROM conversations WHERE platform IN ('discord','whatsapp') AND kind='dm' AND connected=1 AND tracked=1").fetchall()
   rooms={r[2]:r for r in rows}
   caps={platform:request(8795,token,'/call',{'op':'inspect','args':{'room':rooms[platform][0]}})['capability']['allowed'] for platform in ['discord','whatsapp']}
   assert all(caps.values()),'Collectors still connecting.'
   assert request(8796,token,'/inspect',{'chat':rooms['whatsapp'][1]})['ready']
   break
  except (OSError,AssertionError):
   if attempt%10==0:print('Waiting for archive startup and collector connections...',flush=True)
   if attempt==89:raise
   time.sleep(2)
 reader=Path('/etc/misty-bot/apollo-reader-token').read_text().strip()
 for op in ['message_draft','message_confirm','message_status']:
  try:request(8794,reader,'/call',{'op':op,'args':{}})
  except urllib.error.HTTPError as error:assert error.code==400
  else:raise AssertionError('Apollo accepted a personal-message operation.')
 for port,path in [(8795,'/call'),(8796,'/inspect')]:
  try:request(port,'incorrect',path,{})
  except urllib.error.HTTPError as error:assert error.code==401
  else:raise AssertionError('Sender endpoint did not require its credential.')
except Exception:
 for p in targets:
  saved=backup/str(p).lstrip('/')
  if baseline[str(p)] is not None:shutil.copy2(saved,p)
  else:p.unlink(missing_ok=True)
 for p in drops:p.unlink(missing_ok=True)
 credential.unlink(missing_ok=True)
 run('systemctl','daemon-reload');run('systemctl','restart','archival','misty-bot')
 raise

fork(str(FORK/'selfupdate.py'),'log','Personal Discord/WhatsApp text sending: delivered exact preview then a fresh owner yes, immutable destination/body, durable receipts and no automatic ambiguous retry. Apollo remains read-only.')
started=time.time();restart=fork(str(FORK/'selfupdate.py'),'restart','Enable owner-confirmed personal messages')
print(json.dumps({'backup':str(backup),'snapshot':snapshot,'restart':restart.stdout.strip()}),flush=True)
for attempt in range(25):
 trial=STATE/'restart_trial.json'
 if trial.exists() and trial.stat().st_mtime>=started and not (STATE/'restart_request.json').exists():break
 time.sleep(2)
else:raise RuntimeError('Graceful fork restart is pending; do not interrupt owner work.')
run('systemctl','is-active','misty-prominence','misty-bot','archival','apollo-bot')
report={'backup':str(backup),'snapshot':snapshot,'capabilities':caps,'whatsappSessionReady':True,'unauthorizedRequestsRejected':True,'apolloWriteOperationsRejected':True,'thirdPartyTestMessagesSent':0,'hashes':{str(p):digest(p) for p in targets}}
(STAGE/'deployment.json').write_text(json.dumps(report,indent=2));(STAGE/'deployment.json').chmod(0o644)
print(json.dumps(report),flush=True)
