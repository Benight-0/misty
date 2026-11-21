"""Deploy only Misty overlay Gmail/approval sources through the paired VM connection.

No credential is transferred and no personal message or email is submitted.
Every live source is checked against the inspected baseline before replacement.
"""
import base64
import hashlib
import io
import json
from pathlib import Path
import shlex
import subprocess
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[1]
SSH_CONFIG = ROOT / 'data/deployment/ssh_config'
SOURCES = {
    'archival/app/gmail-store.mjs': 'app/gmail-store.mjs',
    'archival/app/gmail.mjs': 'app/gmail.mjs',
    'archival/app/gmail-overlay.mjs': 'app/gmail-overlay.mjs',
    'archival/app/server.mjs': 'app/server.mjs',
    'archival/app/message-backend.mjs': 'app/message-backend.mjs',
    'misty-bot/app/misty-messages.mjs': 'app/misty-messages.mjs',
    'misty-bot/app/misty-prominence-bridge.mjs': 'app/misty-prominence-bridge.mjs',
    'misty-prominence/overlay.py': 'prominence/overlay.py',
    'misty-prominence/overlay_agent.py': 'prominence/overlay_agent.py',
}
BASELINE = {
    'archival/app/gmail-store.mjs': 'b406bd617e25501c62e1d7d0a74488f168b505f59abcd16236318112a4718d0a',
    'archival/app/gmail.mjs': '79b12467d82b4be52858d9bb5142ca32868578660c0f39a6d8b3c75a501b32b9',
    'archival/app/gmail-overlay.mjs': None,
    'archival/app/server.mjs': '069ce2ed42b413843b45ce37bc69606b16bf28e9226b1823971218c6ddfa7e17',
    'archival/app/message-backend.mjs': 'de2e95b5d3588c1a2097296507a3139fde9021baf5001e3874bc455caa65dceb',
    'misty-bot/app/misty-messages.mjs': '8531756e5d2fdfe1648ee4352a4f9cc2156fda0de582e4f35ba8995a362911a0',
    'misty-bot/app/misty-prominence-bridge.mjs': '02163600bfe17bc5e0b0e33a1ba3a470a1a60a0525117a2285646ad62539fb75',
    'misty-prominence/overlay.py': '6f3799f973041a0dd9428c5612a1d37d47e6dbc1f7b5f04094610a0d15ebdeac',
    'misty-prominence/overlay_agent.py': 'efdaa0ac0bb98b5f498092885bf950e97b8a0c6a9d47862f486089ca8b772db4',
}

REMOTE = r'''
import hashlib,io,json,os,pwd,shutil,sqlite3,subprocess,sys,tarfile,tempfile,time,urllib.error,urllib.request
from pathlib import Path
ROOT=Path('/opt');DB=Path('/var/lib/archival/data/archive.sqlite')
BOT_DB=Path('/var/lib/misty-bot/chat.sqlite');INBOX=Path('/var/lib/misty-prominence/inbox.sqlite')
FORK=Path('/opt/misty-prominence')
def sha(data):return hashlib.sha256(data).hexdigest()
def run(*args,timeout=240):return subprocess.run(args,check=True,text=True,capture_output=True,timeout=timeout)
def fork(*args):return run('runuser','-u','misty-bot','--','env','PROMINENCE_CONFIG=/etc/misty-prominence/config.json',str(FORK/'venv/bin/python'),str(FORK/'selfupdate.py'),*args)
def counts():
 with sqlite3.connect(DB) as c:
  return dict(zip(('gmail','attachments','messages'),c.execute('SELECT (SELECT count(*) FROM gmail_messages),(SELECT count(*) FROM gmail_attachment_blobs),(SELECT count(*) FROM messages)').fetchone()))
def busy():
 with sqlite3.connect(DB) as c:
  if c.execute("SELECT 1 FROM chat_outgoing WHERE status='sending' LIMIT 1").fetchone():return 'a personal send'
 with sqlite3.connect(BOT_DB) as c:
  if c.execute("SELECT 1 FROM misty_message_drafts WHERE state='submitting' LIMIT 1").fetchone():return 'an approval submission'
 with sqlite3.connect(INBOX) as c:
  if c.execute("SELECT 1 FROM inbox WHERE state IN ('running','delivering') LIMIT 1").fetchone():return 'an owner reply'
 return ''
def ready():
 try:urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8787/api/gmail',headers={'Host':'archival.example.com'}),timeout=3);return False
 except urllib.error.HTTPError as e:return e.code==401
 except OSError:return False
if os.geteuid()!=0:raise RuntimeError('VM maintenance root access required')
with tarfile.open(fileobj=io.BytesIO(sys.stdin.buffer.read()),mode='r:gz') as archive:
 members=archive.getmembers()
 data={m.name:archive.extractfile(m).read() for m in members if m.isfile() and m.size<2_000_000}
 if len(data)!=len(members):raise RuntimeError('Invalid deployment bundle')
manifest=json.loads(data.pop('manifest.json'))
names=set(manifest['baseline'])
if set(data)!=names or set(manifest['source'])!=names or len(names)!=9:raise RuntimeError('Unexpected deployment scope')
for name in names:
 target=ROOT/name
 if target.is_symlink() or (sha(target.read_bytes()) if target.exists() else None)!=manifest['baseline'][name]:raise RuntimeError('Production source drift: '+name)
 if sha(data[name])!=manifest['source'][name]:raise RuntimeError('Bundle source changed: '+name)
for service in ('archival.service','misty-bot.service','misty-prominence.service'):
 if run('systemctl','is-active',service).stdout.strip()!='active':raise RuntimeError('Service inactive: '+service)
for attempt in range(24):
 state=busy()
 if not state:break
 if attempt%6==0:print('Waiting for '+state,flush=True)
 time.sleep(5)
else:raise RuntimeError('Owner activity remained active; source unchanged')
stamp=time.strftime('%Y%m%dT%H%M%SZ',time.gmtime())
backup=Path('/var/backups/archival')/('misty-overlay-gmail-before-'+stamp)
backup.mkdir(mode=0o700)
with tempfile.TemporaryDirectory(prefix='misty-overlay-gmail-') as tmp:
 stage=Path(tmp)
 for name,content in data.items():
  p=stage/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(content)
  if p.suffix=='.mjs':run('/opt/misty-bot/bin/node','--check',str(p))
  if p.suffix=='.py':run('python3','-m','py_compile',str(p))
 before=counts()
 for name in names:
  target=ROOT/name
  if (sha(target.read_bytes()) if target.exists() else None)!=manifest['baseline'][name]:raise RuntimeError('Source drift before backup: '+name)
 snapshot=fork('snapshot','Native Gmail inbox and app approvals').stdout.strip()
 installed=[];stopped=[]
 try:
  for service in ('misty-bot.service','archival.service'):
   run('systemctl','stop',service);stopped.append(service)
  for source_path,destination in ((DB,backup/'archive.sqlite'),(BOT_DB,backup/'misty-chat.sqlite')):
   source=sqlite3.connect(source_path)
   try:
    checkpoint=source.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()
    if checkpoint[0]:raise RuntimeError('Database checkpoint could not complete: '+str(source_path))
   finally:source.close()
   shutil.copy2(source_path,destination)
   with sqlite3.connect(destination) as saved:
    if saved.execute('PRAGMA quick_check').fetchone()[0]!='ok':raise RuntimeError('Database backup failed integrity check: '+str(source_path))
  for name in names:
   if (ROOT/name).exists():
    destination=backup/name;destination.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(ROOT/name,destination)
  (backup/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
  for name in names:
   target=ROOT/name
   if (sha(target.read_bytes()) if target.exists() else None)!=manifest['baseline'][name]:raise RuntimeError('Source drift during backup: '+name)
  for name in sorted(names):
   target=ROOT/name;existing=target.stat() if target.exists() else None
   pending=target.with_name(target.name+'.overlay-gmail-new');pending.write_bytes(data[name])
   if existing:os.chown(pending,existing.st_uid,existing.st_gid);pending.chmod(existing.st_mode&0o777)
   else:
    owner=pwd.getpwnam('archival');os.chown(pending,owner.pw_uid,owner.pw_gid);pending.chmod(0o644)
   os.replace(pending,target);installed.append(name)
  run('systemctl','start','archival.service')
  for attempt in range(180):
   if ready():break
   time.sleep(1)
  else:raise RuntimeError('Archival did not become ready')
  run('systemctl','start','misty-bot.service')
  if fork('check').stdout.strip()!='ok':raise RuntimeError('Misty fork check failed')
  fork('restart','Native Gmail inbox and app approvals')
  for attempt in range(60):
   if all(run('systemctl','is-active',s).stdout.strip()=='active' for s in ('archival.service','misty-bot.service','misty-prominence.service')) and Path('/var/lib/misty-prominence/overlay.sock').exists():break
   time.sleep(1)
  else:raise RuntimeError('Misty services or overlay socket did not recover')
  for name in names:
   if sha((ROOT/name).read_bytes())!=manifest['source'][name]:raise RuntimeError('Deployed source hash mismatch: '+name)
  after=counts()
  if any(after[k]<before[k] for k in before):raise RuntimeError('Archived data count decreased')
 except Exception:
  for name in reversed(installed):
   if manifest['baseline'][name] is None:(ROOT/name).unlink(missing_ok=True)
   else:shutil.copy2(backup/name,ROOT/name)
  for service in stopped:subprocess.run(('systemctl','start',service),check=False)
  try:fork('restart','Restore sources after failed Gmail overlay rollout')
  except Exception:pass
  raise
receipt={'at':stamp,'backup':str(backup),'snapshot':snapshot,'before':before,'after':after,
 'files':{name:sha((ROOT/name).read_bytes()) for name in sorted(names)},
 'services':{s:run('systemctl','is-active',s).stdout.strip() for s in ('archival.service','misty-bot.service','misty-prominence.service')}}
(backup/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt),flush=True)
'''


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    files = {name: (ROOT / source).read_bytes() for name, source in SOURCES.items()}
    manifest = {'source': {name: digest(data) for name, data in files.items()}, 'baseline': BASELINE}
    bundle = io.BytesIO()
    with tarfile.open(fileobj=bundle, mode='w:gz') as archive:
        for name, data in {**files, 'manifest.json': json.dumps(manifest).encode()}.items():
            entry = tarfile.TarInfo(name)
            entry.size = len(data)
            entry.mode = 0o644
            archive.addfile(entry, io.BytesIO(data))
    loader = 'import base64;exec(base64.b64decode("' + base64.b64encode(REMOTE.encode()).decode() + '"))'
    command = 'sudo -n python3 -c ' + shlex.quote(loader)
    try:
        result = subprocess.run(['ssh.exe', '-F', str(SSH_CONFIG), '-o', 'ConnectTimeout=30',
                                 'archival-vm', command], input=bundle.getvalue(),
                                capture_output=True, timeout=900)
    except subprocess.TimeoutExpired:
        raise RuntimeError('Deployment exceeded 15 minutes; audit production before retrying.') from None
    if result.stdout:
        print(result.stdout.decode(errors='replace'), end='')
    if result.stderr:
        print(result.stderr.decode(errors='replace'), end='', file=sys.stderr)
    if result.returncode:
        raise RuntimeError(f'VM deployment failed with exit code {result.returncode}.')


if __name__ == '__main__':
    main()
