"""Deploy scoped Gmail archive and Misty email-tool source; preserve live tokens.

This script does not authorize Gmail, send email, or replace credentials.
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
    'archival/app/store.mjs': 'app/store.mjs',
    'archival/app/server.mjs': 'app/server.mjs',
    'archival/app/vm-server.mjs': 'app/vm-server.mjs',
    'archival/app/message-backend.mjs': 'app/message-backend.mjs',
    'archival/app/public/app.js': 'app/public/app.js',
    'archival/app/public/style.css': 'app/public/style.css',
    'archival/docs/misty-gmail.md': 'docs/misty-gmail.md',
    'misty-bot/app/misty-messages.mjs': 'app/misty-messages.mjs',
    'misty-bot/app/misty-prominence-bridge.mjs': 'app/misty-prominence-bridge.mjs',
    'misty-prominence/misty.py': 'prominence/misty.py',
    'misty-prominence/misty_context.py': 'prominence/misty_context.py',
}
BASELINE = {
    'archival/app/gmail-store.mjs': 'cdcccb420c1f0054a03272faca8c0855bd42da36a1d1dfe2cdcbb92039170c13',
    'archival/app/gmail.mjs': '66852e10d066107aa883c857c0861e9e2dfba49dec181a87bce2199d6440dc77',
    'archival/app/store.mjs': '82d2e553b2aa3483a0ac62bd0dae221585fb3a5f292fccb2f25dbe641001cec3',
    'archival/app/server.mjs': 'c6b950698c15700f65192cb03f5329f2d201973b418230b6b9f110dbbd210675',
    'archival/app/vm-server.mjs': 'db20598f462919f7d7a14fa80303cd510a050b5abf750adc768be8f884abd0e6',
    'archival/app/message-backend.mjs': '811b074f48c921a0834d4570bf70b563f466b48951c3e5b2d3f92c8d9fee8e8a',
    'archival/app/public/app.js': '34af12994414542d9951eedd68245fbb93d34a0970d1bf22ea67e2a58fe649eb',
    'archival/app/public/style.css': 'e6687e790a94f8c9374d3de9968d7867e474ecf1fe6055fa76e637787fb589d6',
    'archival/docs/misty-gmail.md': '8b24994eed962ef89a33bdfbe5f5befd6a6fb4b1c0114cdeace5436e356e4570',
    'misty-bot/app/misty-messages.mjs': 'a7c7bbef02b0a5f6bc7cb6dfc2760542bba093730280c9f142897ad01cda7bd3',
    'misty-bot/app/misty-prominence-bridge.mjs': 'c4b7d55218052c6b1679b9998d685a0bf15908c8f91ef99411ff7a7d76f291ae',
    'misty-prominence/misty.py': '5a1ae57e9372789cab24c8ae64d25e73d885ee765c8a65666704550279e4508c',
    'misty-prominence/misty_context.py': 'bc6d74c6aed9b81f9c654ffea5ad961c14f700589800990cb4693a48a095e459',
}

REMOTE = r'''
import hashlib,io,json,os,pwd,shutil,sqlite3,subprocess,sys,tarfile,tempfile,time,urllib.error,urllib.request
from pathlib import Path
ROOT=Path('/opt')
DB=Path('/var/lib/archival/data/archive.sqlite')
BOT_DB=Path('/var/lib/misty-bot/chat.sqlite')
INBOX=Path('/var/lib/misty-prominence/inbox.sqlite')
FORK=Path('/opt/misty-prominence')
def sha(data):return hashlib.sha256(data).hexdigest()
def run(*args,timeout=240):return subprocess.run(args,check=True,text=True,capture_output=True,timeout=timeout)
def counts():
 with sqlite3.connect(DB) as c:
  return dict(zip(('messages','gmail_messages','attachment_files','attachment_bytes'),c.execute('SELECT (SELECT count(*) FROM messages),(SELECT count(*) FROM gmail_messages),(SELECT count(*) FROM gmail_attachment_blobs),(SELECT coalesce(sum(size),0) FROM gmail_attachment_blobs)').fetchone())) if has_attachments() else dict(zip(('messages','gmail_messages'),c.execute('SELECT (SELECT count(*) FROM messages),(SELECT count(*) FROM gmail_messages)').fetchone()))
def has_attachments():
 with sqlite3.connect(DB) as c:return bool(c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gmail_attachment_blobs'").fetchone())
def busy():
 with sqlite3.connect(DB) as c:
  if c.execute("SELECT 1 FROM chat_outgoing WHERE status='sending' LIMIT 1").fetchone():return 'personal message is sending'
 with sqlite3.connect(BOT_DB) as c:
  if c.execute("SELECT 1 FROM misty_message_drafts WHERE state='submitting' LIMIT 1").fetchone():return 'personal confirmation is submitting'
 with sqlite3.connect(INBOX) as c:
  if c.execute("SELECT 1 FROM inbox WHERE state IN ('running','delivering') LIMIT 1").fetchone():return 'owner reply is active'
 return ''
def ready():
 try:urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8787/api/gmail',headers={'Host':'archival.example.com'}),timeout=3);return False
 except urllib.error.HTTPError as e:return e.code==401
 except OSError:return False
def fork(*args):return run('runuser','-u','misty-bot','--','env','PROMINENCE_CONFIG=/etc/misty-prominence/config.json',str(FORK/'venv/bin/python'),str(FORK/'selfupdate.py'),*args,timeout=240)
if os.geteuid()!=0:raise RuntimeError('Root required')
with tarfile.open(fileobj=io.BytesIO(sys.stdin.buffer.read()),mode='r:gz') as archive:
 members=archive.getmembers()
 data={m.name:archive.extractfile(m).read() for m in members if m.isfile() and m.size<2_000_000}
 if len(data)!=len(members):raise RuntimeError('Invalid source bundle')
manifest=json.loads(data.pop('manifest.json'))
names=set(manifest['baseline'])
if set(data)!=names or set(manifest['source'])!=names or len(names)!=13:raise RuntimeError('Unexpected deployment scope')
for name in names:
 target=ROOT/name
 if target.is_symlink() or sha(target.read_bytes())!=manifest['baseline'][name]:raise RuntimeError('Production source drift: '+name)
 if sha(data[name])!=manifest['source'][name]:raise RuntimeError('Source bundle changed: '+name)
for service in ('archival.service','misty-bot.service','misty-prominence.service'):
 if run('systemctl','is-active',service).stdout.strip()!='active':raise RuntimeError('Service inactive: '+service)
for attempt in range(24):
 state=busy()
 if not state:break
 if attempt%6==0:print('Waiting for '+state,flush=True)
 time.sleep(5)
else:raise RuntimeError('Owner activity remained active; no deployment performed')
stamp=time.strftime('%Y%m%dT%H%M%SZ',time.gmtime())
backup=Path('/var/backups/archival')/('misty-gmail-full-before-'+stamp)
backup.mkdir(mode=0o700)
with tempfile.TemporaryDirectory(prefix='misty-gmail-full-') as tmp:
 stage=Path(tmp)
 for name,content in data.items():
  p=stage/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(content)
  if p.suffix in ('.mjs','.js'):run('/opt/misty-bot/bin/node','--check',str(p))
  if p.suffix=='.py':run('python3','-m','py_compile',str(p))
 print('Backing up archive and scoped source before installation.',flush=True)
 before=counts()
 with sqlite3.connect(DB) as source,sqlite3.connect(backup/'archive.sqlite') as saved:
  last=[time.monotonic()]
  def progress(status,remaining,total):
   now=time.monotonic()
   if now-last[0]>=10:
    print('Archive backup: '+str(total-remaining)+' / '+str(total)+' pages.',flush=True)
    last[0]=now
  source.backup(saved,pages=512,sleep=0.05,progress=progress)
  if saved.execute('PRAGMA quick_check').fetchone()[0]!='ok':raise RuntimeError('Archive backup integrity check failed')
 with sqlite3.connect(BOT_DB) as source,sqlite3.connect(backup/'misty-chat.sqlite') as saved:source.backup(saved)
 for name in names:
  dest=backup/name;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(ROOT/name,dest)
 (backup/'baseline.json').write_text(json.dumps(manifest,indent=2)+'\n')
 if busy():raise RuntimeError('Owner activity began during backup; source untouched')
 for name in names:
  if sha((ROOT/name).read_bytes())!=manifest['baseline'][name]:raise RuntimeError('Source drift during backup: '+name)
 snapshot=fork('snapshot','Gmail complete archive and owner-approved email tools').stdout.strip()
 print('Backup complete; installing Gmail source.',flush=True)
 stopped=[];installed=[]
 try:
  for service in ('misty-bot.service','archival.service'):
   run('systemctl','stop',service);stopped.append(service)
  if busy():raise RuntimeError('Owner send became active at shutdown')
  for name in sorted(names):
   target=ROOT/name;st=target.stat();pending=target.with_name(target.name+'.gmail-full-new')
   pending.write_bytes(data[name]);os.chown(pending,st.st_uid,st.st_gid);pending.chmod(st.st_mode&0o777)
   os.replace(pending,target);installed.append(name)
  run('systemctl','start','archival.service')
  for attempt in range(360):
   if ready():break
   if attempt in (29,59,119,179,239,299):print('Waiting for Archival startup ('+str(attempt+1)+'s).',flush=True)
   time.sleep(1)
  else:raise RuntimeError('Archival did not become ready with owner access enforced')
  run('systemctl','start','misty-bot.service')
  if fork('check').stdout.strip()!='ok':raise RuntimeError('Misty fork check failed')
  fork('restart','Enable Gmail archive and owner-approved email tools')
  for service in ('archival.service','misty-bot.service','misty-prominence.service'):
   if run('systemctl','is-active',service).stdout.strip()!='active':raise RuntimeError('Service failed after deployment: '+service)
  for name in names:
   if sha((ROOT/name).read_bytes())!=manifest['source'][name]:raise RuntimeError('Deployed hash mismatch: '+name)
  after=counts()
  if after['gmail_messages']<before['gmail_messages']:raise RuntimeError('Archived Gmail count decreased')
 except Exception:
  for name in reversed(installed):shutil.copy2(backup/name,ROOT/name)
  for service in stopped:subprocess.run(('systemctl','start',service),check=False)
  try:fork('restart','Restore source after failed Gmail rollout')
  except Exception:pass
  raise
receipt={'at':stamp,'backup':str(backup),'snapshot':snapshot,'before':before,'after':after,'files':{name:sha((ROOT/name).read_bytes()) for name in sorted(names)},'services':{s:run('systemctl','is-active',s).stdout.strip() for s in ('archival.service','misty-bot.service','misty-prominence.service')}}
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
