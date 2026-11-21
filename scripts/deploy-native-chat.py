"""Stage or install only the reviewed Discord-send capability; do not touch credentials."""
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

ROOT=Path('/opt/archival')
STAGE=Path('/tmp/archival-migration/native-chat')
CANDIDATE=STAGE/'candidate-v2'
NODE=ROOT/'bin/node'
FILES={'app/server.mjs','app/chat.mjs','app/native-chat.mjs','app/chat-ai.mjs','app/public/chat.js','scripts/misty-message.mjs','app/tests/native-chat.test.mjs','app/tests/chat-ui.test.mjs','app/tests/vm-runtime.test.mjs'}
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None
def run(*args,**kwargs):return subprocess.run(args,check=True,**kwargs)
def snapshot(db):return {table:db.execute('SELECT count(*) FROM '+table).fetchone()[0] for table in ['messages','chat_briefings','briefing_history_nodes','conversations']}

mode=sys.argv[1]
if mode=='stage':
 STAGE.mkdir(parents=True,exist_ok=True)
 assert not CANDIDATE.exists(),'Candidate already exists'
 baseline={name:digest(ROOT/name) for name in FILES}
 expected={'app/server.mjs':'ee140437d2168a1ff112d8bd3384437fe2f6e135b232ba3332e09e2a3b6f646d','app/chat.mjs':'f9e883ffdfb3cf31df92c992070b42563cf7becea9485321a20e36400c2257f2','app/public/chat.js':'6743febd42f36bb5ea4a8312edfa0898906f6701b87cc7dcbecdb4a717bb49c6'}
 for name,hash_value in expected.items():assert baseline[name]==hash_value,'Deployed source changed: '+name
 assert shutil.disk_usage('/var/lib/archival').free>600_000_000,'Insufficient space for a rollback copy'
 shutil.copytree(ROOT/'app',CANDIDATE/'app')
 (CANDIDATE/'scripts').mkdir()
 shutil.copy2(ROOT/'scripts/discord-server-ids.txt',CANDIDATE/'scripts/discord-server-ids.txt')
 with tarfile.open(STAGE/'native-chat.tar.gz','r:gz') as bundle:
  members=bundle.getmembers()
  assert {m.name for m in members}==FILES and all(m.isfile() for m in members),'Unexpected bundle contents'
  for member in members:
   dest=CANDIDATE/member.name;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(bundle.extractfile(member).read());dest.chmod(0o644)
   run(str(NODE),'--check',str(dest))
 run(str(NODE),'--disable-warning=ExperimentalWarning','--test','app/tests/native-chat.test.mjs','app/tests/chat.test.mjs','app/tests/chat-ui.test.mjs','app/tests/vm-runtime.test.mjs',cwd=CANDIDATE)
 (STAGE/'baseline.json').write_text(json.dumps(baseline))
 print('Candidate syntax and targeted tests passed.',flush=True)
elif mode=='install':
 baseline=json.loads((STAGE/'baseline.json').read_text())
 for name,expected in baseline.items():assert digest(ROOT/name)==expected,'Deployed source changed after staging: '+name
 backup=Path('/var/lib/archival')/time.strftime('native-chat-before-%Y%m%dT%H%M%SZ',time.gmtime());backup.mkdir(mode=0o700)
 secret_paths=[Path('/etc/archival')/name for name in ['runtime.env','discord-token','openai-key']]
 secrets={str(p):digest(p) for p in secret_paths}
 run('systemctl','stop','archival',timeout=45)
 installed=[]
 try:
  with sqlite3.connect('file:/var/lib/archival/data/archive.sqlite?mode=ro',uri=True) as db:
   before=snapshot(db)
   dest=sqlite3.connect(backup/'archive.sqlite')
   try:db.backup(dest)
   finally:dest.close()
  for name in FILES:
   target=ROOT/name;old=backup/name
   if target.exists():old.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(target,old)
   target.parent.mkdir(parents=True,exist_ok=True)
   temp=target.with_name(target.name+'.native-chat-new');shutil.copyfile(CANDIDATE/name,temp);temp.chmod(0o644);shutil.chown(temp,user='archival',group='archival');temp.replace(target);installed.append(name)
  assert {str(p):digest(p) for p in secret_paths}==secrets,'Runtime credentials or configuration changed'
  with sqlite3.connect('file:/var/lib/archival/data/archive.sqlite?mode=ro',uri=True) as db:assert snapshot(db)==before,'Existing archive counts changed during install'
  run('systemctl','start','archival',timeout=30)
  print(json.dumps({'backup':str(backup),'preserved':before,'credentialsUnchanged':True,'installed':sorted(installed)}),flush=True)
 except:
  for name in installed:
   old=backup/name;target=ROOT/name
   if old.exists():shutil.copy2(old,target)
   else:target.unlink(missing_ok=True)
  run('systemctl','start','archival',timeout=30)
  raise
else:raise SystemExit('Choose stage or install')
