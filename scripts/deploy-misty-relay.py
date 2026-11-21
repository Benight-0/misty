"""Update only the separate Misty bot, retaining a rollback copy and its SQLite data."""
import datetime
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
STAGE=Path('/tmp/archival-migration/misty-relay-update')
FILES={'app/misty-self.mjs','app/misty-dialogue.mjs','app/misty-rephraser.mjs','app/misty-knowledge.mjs','app/misty-archive.mjs','app/misty-notifications.mjs','app/misty-work.mjs','app/discord-bot.mjs','app/misty-relay.mjs','app/misty-persona.mjs','app/misty-conversation.mjs','app/misty-style.mjs','app/misty-components.mjs','app/misty-interactions.mjs','app/openai-analysis.mjs','app/codex-relay-client.mjs','app/codex-live-session.mjs','app/tests/codex-live-session.test.mjs','app/tests/discord-bot.test.mjs','app/tests/misty-relay.test.mjs','app/tests/misty-conversation.test.mjs','app/tests/misty-interactions.test.mjs','scripts/misty-discord-bot.mjs','scripts/misty-relay-agent.mjs','scripts/build-misty-voice.mjs','collector/cmd/misty-bot-gateway/main.go','collector/cmd/misty-bot-gateway/main_test.go','collector/cmd/misty-bot-gateway/go.mod','collector/cmd/misty-bot-gateway/go.sum'}
def run(*args,**kw):return subprocess.run(args,check=True,**kw)
candidate=STAGE/'candidate';candidate.mkdir(parents=True,exist_ok=True)
with tarfile.open(STAGE/'bundle.tar.gz','r:gz') as bundle:
 members=bundle.getmembers()
 assert {m.name for m in members}==FILES and all(m.isfile() for m in members),'Unexpected bundle contents'
 for member in members:
  target=candidate/member.name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(bundle.extractfile(member).read());target.chmod(0o644)
node=str(ROOT/'bin/node')
for name in FILES:
 if name.endswith('.mjs'):run(node,'--check',str(candidate/name),stdout=subprocess.DEVNULL)
run(node,'--disable-warning=ExperimentalWarning','--test','app/tests/codex-live-session.test.mjs','app/tests/discord-bot.test.mjs','app/tests/misty-relay.test.mjs','app/tests/misty-conversation.test.mjs','app/tests/misty-interactions.test.mjs',cwd=candidate)
go='/opt/archival/build/go/bin/go'
env=dict(os.environ,PATH='/opt/archival/build/go/bin:'+os.environ['PATH'],GOMAXPROCS='1',GOFLAGS='-p=1',GOMEMLIMIT='250MiB',GOCACHE='/home/ubuntu/.cache/go-build',GOMODCACHE='/home/ubuntu/go/pkg/mod')
run('/opt/archival/build/go/bin/gofmt','-w',str(candidate/'collector/cmd/misty-bot-gateway/main.go'))
run(go,'test','.',cwd=candidate/'collector/cmd/misty-bot-gateway',env=env,timeout=300)
run(go,'build','-trimpath','-ldflags=-s','-o',str(STAGE/'gateway'),'.',cwd=candidate/'collector/cmd/misty-bot-gateway',env=env,timeout=300)
if len(sys.argv)>1 and sys.argv[1]=='stage':
 print('Candidate staged and focused tests passed; production unchanged.')
 sys.exit(0)
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup=Path('/var/lib/misty-bot')/('relay-before-'+stamp);backup.mkdir(mode=0o700)
for name in FILES:
 if (ROOT/name).exists():
  target=backup/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(ROOT/name,target)
shutil.copyfile(ROOT/'bin/gateway',backup/'gateway')
run('systemctl','stop','misty-bot')
try:
 with sqlite3.connect('/var/lib/misty-bot/chat.sqlite') as src,sqlite3.connect(backup/'chat.sqlite') as dst:src.backup(dst)
 # The separate bot receives a bounded style profile, never archive credentials.
 profile_path=STAGE/'owner-voice.json'
 if profile_path.exists():
  profile=json.loads(profile_path.read_text())
  assert profile.get('version') in (1,2) and profile.get('count',0)>=10
  with sqlite3.connect('/var/lib/misty-bot/chat.sqlite') as db:
   db.execute('INSERT INTO bot_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',('owner_voice',json.dumps(profile)))
 for name in FILES:
  if '/tests/' in name:continue
  target=ROOT/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(candidate/name,target);target.chmod(0o644)
 shutil.copyfile(STAGE/'gateway',ROOT/'bin/gateway');(ROOT/'bin/gateway').chmod(0o755)
 run('systemctl','start','misty-bot')
 for attempt in range(30):
  time.sleep(1)
  status=json.loads(Path('/var/lib/misty-bot/status.json').read_text())
  if status.get('state')=='online' and status.get('at',0)>time.time()*1000-5000:break
 else:raise RuntimeError('Bot did not reconnect')
 print(json.dumps({'installed':True,'backup':str(backup),'bot':status['state']}))
except Exception:
 run('systemctl','stop','misty-bot')
 for name in FILES:
  if (backup/name).exists():shutil.copyfile(backup/name,ROOT/name)
 shutil.copyfile(backup/'gateway',ROOT/'bin/gateway');(ROOT/'bin/gateway').chmod(0o755)
 run('systemctl','start','misty-bot')
 raise
