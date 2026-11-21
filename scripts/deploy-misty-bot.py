"""Prepare a separate bot service. The collector, archive and existing settings are untouched."""
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import sys
import tarfile

STAGE=Path('/tmp/archival-migration/misty-bot')
ROOT=Path('/opt/misty-bot')
RUNTIME={'app/misty-self.mjs','app/misty-dialogue.mjs','app/misty-rephraser.mjs','app/misty-knowledge.mjs','app/misty-archive.mjs','app/misty-notifications.mjs','app/misty-work.mjs','app/discord-bot.mjs','app/openai-analysis.mjs','app/misty-relay.mjs','app/misty-persona.mjs','app/misty-conversation.mjs','app/misty-style.mjs','app/misty-components.mjs','app/misty-interactions.mjs','app/codex-relay-client.mjs','app/codex-live-session.mjs','scripts/misty-discord-bot.mjs','scripts/misty-relay-agent.mjs'}
FILES=RUNTIME|{'app/tests/discord-bot.test.mjs','app/tests/misty-relay.test.mjs','app/tests/misty-conversation.test.mjs','app/tests/misty-interactions.test.mjs','scripts/misty-bot.service','collector/cmd/misty-bot-gateway/go.mod','collector/cmd/misty-bot-gateway/go.sum','collector/cmd/misty-bot-gateway/main.go','collector/cmd/misty-bot-gateway/main_test.go'}

def run(*args,**kwargs):return subprocess.run(args,check=True,**kwargs)
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()

mode=sys.argv[1]
if mode=='stage':
 candidate=STAGE/'candidate'
 candidate.mkdir(parents=True,exist_ok=True)
 with tarfile.open(STAGE/'misty-bot.tar.gz','r:gz') as bundle:
  members=bundle.getmembers()
  assert {m.name for m in members}==FILES and all(m.isfile() for m in members),'Unexpected bundle contents'
  for member in members:
   target=candidate/member.name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(bundle.extractfile(member).read());target.chmod(0o644)
 node='/opt/archival/bin/node'
 for name in ['app/discord-bot.mjs','scripts/misty-discord-bot.mjs']:run(node,'--check',str(candidate/name))
 run(node,'--disable-warning=ExperimentalWarning','--test','app/tests/discord-bot.test.mjs','app/tests/misty-relay.test.mjs','app/tests/misty-conversation.test.mjs','app/tests/misty-interactions.test.mjs',cwd=candidate)
 go='/opt/archival/build/go/bin/go'
 run('/opt/archival/build/go/bin/gofmt','-w',str(candidate/'collector/cmd/misty-bot-gateway/main.go'))
 env=dict(os.environ,PATH='/opt/archival/build/go/bin:'+os.environ['PATH'],GOMAXPROCS='1',GOFLAGS='-p=1',GOMEMLIMIT='250MiB',GOCACHE='/home/ubuntu/.cache/go-build',GOMODCACHE='/home/ubuntu/go/pkg/mod')
 run(go,'test','.',cwd=candidate/'collector/cmd/misty-bot-gateway',env=env,timeout=300)
 run(go,'build','-trimpath','-ldflags=-s','-o',str(STAGE/'gateway'),'.',cwd=candidate/'collector/cmd/misty-bot-gateway',env=env,timeout=300)
 print('Bot tests and pinned Go build passed.',flush=True)
elif mode=='install':
 assert not ROOT.exists(),'Bot directory already exists; review before updating'
 assert not Path('/etc/systemd/system/misty-bot.service').exists(),'Bot unit already exists'
 assert not Path('/etc/misty-bot').exists(),'Bot credential directory already exists'
 existing_paths=[Path('/etc/archival')/n for n in ('runtime.env','discord-token','openai-key')]
 original={str(p):digest(p) for p in existing_paths}
 try:pwd.getpwnam('misty-bot')
 except KeyError:run('useradd','--system','--user-group','--home-dir','/var/lib/misty-bot','--no-create-home','--shell','/usr/sbin/nologin','misty-bot')
 for directory in ('app','scripts','bin'):(ROOT/directory).mkdir(parents=True,mode=0o755)
 for name in RUNTIME:
  shutil.copyfile(STAGE/'candidate'/name,ROOT/name);(ROOT/name).chmod(0o644)
 # A hard link shares the existing Node executable without adding another large copy.
 os.link('/opt/archival/bin/node',ROOT/'bin/node')
 shutil.copyfile(STAGE/'gateway',ROOT/'bin/gateway');(ROOT/'bin/gateway').chmod(0o755)
 Path('/etc/misty-bot').mkdir(mode=0o700)
 shutil.copyfile(STAGE/'candidate/scripts/misty-bot.service','/etc/systemd/system/misty-bot.service')
 Path('/etc/systemd/system/misty-bot.service').chmod(0o644)
 run('systemd-analyze','verify','/etc/systemd/system/misty-bot.service')
 run('systemctl','daemon-reload');run('systemctl','enable','misty-bot')
 assert original=={str(p):digest(p) for p in existing_paths},'Existing configuration changed'
 print(json.dumps({'installed':str(ROOT),'service':'enabled; awaiting bot token','existingCredentialsUnchanged':True}),flush=True)
elif mode=='token':
 # Read the secret from SSH stdin; it is never a command argument or log entry.
 token=sys.stdin.read().strip()
 assert token and len(token)<500 and not any(c.isspace() for c in token),'Invalid token file format'
 directory=Path('/etc/misty-bot');assert directory.is_dir() and directory.stat().st_mode&0o077==0
 target=directory/'discord-token';assert not target.exists(),'A token already exists; review before replacing it'
 descriptor=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(descriptor,'w') as out:out.write(token+'\n')
 run('systemctl','reset-failed','misty-bot');run('systemctl','start','misty-bot')
 print('Bot token installed privately; service start requested.',flush=True)
else:raise SystemExit('Choose stage, install or token')
