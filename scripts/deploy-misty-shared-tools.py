"""Scoped, hash-checked rollout of Misty's shared browser/desktop broker."""
import base64
import hashlib
import io
import json
from pathlib import Path
import shlex
import subprocess
import sys
import tarfile

ROOT=Path(__file__).resolve().parents[1]
SSH=ROOT/'data/deployment/ssh_config'
TARGETS={
 'app/laptop-tools-broker.mjs':'/opt/misty-bot/app/laptop-tools-broker.mjs',
 'app/shared-tool-sessions.mjs':'/opt/misty-bot/app/shared-tool-sessions.mjs',
 'app/browser-harness-adapter.mjs':'/opt/misty-bot/app/browser-harness-adapter.mjs',
 'app/vm-browser-executor.mjs':'/opt/misty-bot/app/vm-browser-executor.mjs',
 'scripts/misty-laptop-tools-server.mjs':'/opt/misty-bot/scripts/misty-laptop-tools-server.mjs',
 'scripts/misty-browser-worker.mjs':'/opt/misty-bot/scripts/misty-browser-worker.mjs',
 'prominence/laptop_tools.py':'/opt/misty-prominence/laptop_tools.py',
 'prominence/laptop-tool-schemas.json':'/opt/misty-prominence/laptop-tool-schemas.json',
 'prominence/agent_worker.py':'/opt/misty-prominence/agent_worker.py',
 'deploy/misty-laptop-tools.service':'/etc/systemd/system/misty-laptop-tools.service',
 'deploy/misty-browser.service':'/etc/systemd/system/misty-browser.service',
}
BASELINE={
 '/opt/misty-bot/app/laptop-tools-broker.mjs':'8d9bb0bd342e6d8cd9ab03afbbdfc68d5e98b12a0703d32b8ac19d33d085e9d5',
 '/opt/misty-bot/scripts/misty-laptop-tools-server.mjs':'315da9d4cfb688686242f40c42264543cd7a980ad1b469cd4f93b3a90694dd70',
 '/opt/misty-prominence/laptop_tools.py':'4aef568701a0631fd79344d3bba7a8f1849f37154575cd4cfa2677f25cf01a88',
 '/opt/misty-prominence/laptop-tool-schemas.json':'5771ff8e842229b19b7256aade21153dd91038e6edad8a8d701cb5f71a33b929',
 '/opt/misty-prominence/agent_worker.py':'3e679fc7fec5b9ff5ebe0ca76ca3597ccf662dc3715e3f8def809cbd447cc5f1',
 '/etc/systemd/system/misty-laptop-tools.service':'45ca459d9dcca83a23ad69ce999bf32916152aa1dcb42ec9af608099823a33b6',
}
REMOTE=r'''
import hashlib,io,json,os,secrets,shutil,sqlite3,subprocess,sys,tarfile,tempfile,time,urllib.request
from pathlib import Path
def sha(body):return hashlib.sha256(body).hexdigest()
def run(*args,timeout=90):return subprocess.run(args,check=True,capture_output=True,text=True,timeout=timeout).stdout.strip()
with tarfile.open(fileobj=io.BytesIO(sys.stdin.buffer.read()),mode='r:gz') as archive:
 members=archive.getmembers();data={m.name:archive.extractfile(m).read() for m in members if m.isfile() and m.size<2000000}
 if len(data)!=len(members):raise RuntimeError('Unexpected bundle member')
 manifest=json.loads(data.pop('manifest.json'))
if set(data)!=set(manifest['targets']):raise RuntimeError('Unexpected deployment scope')
for name,body in data.items():
 if sha(body)!=manifest['source'][name]:raise RuntimeError('Bundle hash changed: '+name)
for dest,expected in manifest['baseline'].items():
 if sha(Path(dest).read_bytes())!=expected:raise RuntimeError('Live source drift: '+dest)
for dest in set(manifest['targets'].values())-set(manifest['baseline']):
 if Path(dest).exists():raise RuntimeError('New target already exists: '+dest)
with tempfile.TemporaryDirectory(prefix='misty-shared-tools-') as temporary:
 stage=Path(temporary)
 for name,body in data.items():
  target=stage/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(body)
 for name in data:
  if name.endswith('.mjs'):run('/opt/misty-bot/bin/node','--check',str(stage/name))
  if name.endswith('.py'):run('python3','-m','py_compile',str(stage/name))
  if name.endswith('.json'):json.loads(data[name])
 print('Staged syntax and schema checks passed',flush=True)
 def active():
  with sqlite3.connect('file:/var/lib/misty-prominence/agent_tasks.sqlite?mode=ro',uri=True) as db:
   tasks=db.execute("SELECT count(*) FROM tasks WHERE state='running'").fetchone()[0]
  with sqlite3.connect('file:/var/lib/misty-prominence/inbox.sqlite?mode=ro',uri=True) as db:
   turns=db.execute("SELECT count(*) FROM conversation_runs WHERE state='running'").fetchone()[0]
  return tasks,turns
 for _ in range(12):
  if active()==(0,0):break
  time.sleep(5)
 else:raise RuntimeError('Owner or delegated task is still active; no files installed')
 stamp=time.strftime('%Y%m%dT%H%M%SZ',time.gmtime())
 backup=Path('/var/backups/misty')/('shared-tools-before-'+stamp);backup.mkdir(mode=0o700,parents=True)
 for dest in manifest['baseline']:
  saved=backup/dest.lstrip('/');saved.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(dest,saved)
 with sqlite3.connect('/var/lib/misty-bot/laptop-tools.sqlite') as live,sqlite3.connect(backup/'laptop-tools.sqlite') as saved:live.backup(saved)
 if active()!=(0,0):raise RuntimeError('Work started during backup; no files installed')
 token=Path('/etc/misty-bot/vm-browser-token');created_token=False;installed=[]
 try:
  if not token.exists():
   fd=os.open(token,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
   with os.fdopen(fd,'w') as stream:stream.write(secrets.token_hex(32)+'\n')
   created_token=True
  for name,dest in manifest['targets'].items():
   target=Path(dest);expected=manifest['baseline'].get(dest)
   if expected and sha(target.read_bytes())!=expected:raise RuntimeError('Source drift during install: '+dest)
   stat=target.stat() if expected else target.parent.stat()
   pending=target.with_name(target.name+'.shared-new')
   pending.write_bytes(data[name]);os.chown(pending,stat.st_uid,stat.st_gid);pending.chmod((stat.st_mode&0o777) if expected else 0o644)
   os.replace(pending,target);installed.append(dest)
  run('systemctl','daemon-reload')
  run('systemctl','restart','misty-laptop-tools.service')
  run('systemctl','restart','misty-agents.service')
  run('systemctl','enable','--now','misty-browser.service')
  for _ in range(30):
   states={s:run('systemctl','is-active',s) for s in ('misty-laptop-tools.service','misty-agents.service','misty-browser.service')}
   if all(v=='active' for v in states.values()):break
   time.sleep(1)
  else:raise RuntimeError('Shared tool services did not become active')
  for name,dest in manifest['targets'].items():
   if sha(Path(dest).read_bytes())!=manifest['source'][name]:raise RuntimeError('Deployed hash mismatch: '+dest)
  secret=Path('/etc/misty-bot/prominence-token').read_text().strip()
  request=urllib.request.Request('http://127.0.0.1:8798/call',data=b'{"action":"status"}',headers={'Authorization':'Bearer '+secret,'Content-Type':'application/json'})
  with urllib.request.urlopen(request,timeout=5) as response:status=json.load(response)
  if 'browser_run' not in status['tools'] or 'desktop_ax' not in status['tools']:raise RuntimeError('Broker tool catalog is stale')
 except Exception:
  subprocess.run(('systemctl','stop','misty-browser.service'),check=False,capture_output=True)
  for dest in installed:
   if dest in manifest['baseline']:shutil.copy2(backup/dest.lstrip('/'),dest)
   else:Path(dest).unlink(missing_ok=True)
  if created_token:token.unlink(missing_ok=True)
  subprocess.run(('systemctl','daemon-reload'),check=False,capture_output=True)
  for service in ('misty-laptop-tools.service','misty-agents.service'):
   subprocess.run(('systemctl','restart',service),check=False,capture_output=True)
  raise
 receipt={'backup':str(backup),'at':stamp,'files':len(installed),'services':states,'brokerTools':len(status['tools'])}
 (backup/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
 print(json.dumps(receipt),flush=True)
'''

def main():
    data={name:(ROOT/name).read_bytes() for name in TARGETS}
    manifest={'targets':TARGETS,'baseline':BASELINE,'source':{name:hashlib.sha256(body).hexdigest() for name,body in data.items()}}
    bundle=io.BytesIO()
    with tarfile.open(fileobj=bundle,mode='w:gz') as archive:
        for name,body in {**data,'manifest.json':json.dumps(manifest).encode()}.items():
            entry=tarfile.TarInfo(name);entry.size=len(body);entry.mode=0o644
            archive.addfile(entry,io.BytesIO(body))
    loader='import base64;exec(base64.b64decode("'+base64.b64encode(REMOTE.encode()).decode()+'"))'
    command='sudo -n python3 -c '+shlex.quote(loader)
    result=subprocess.run(['ssh.exe','-T','-F',str(SSH),'-o','BatchMode=yes','-o','ConnectTimeout=30','archival-vm',command],input=bundle.getvalue(),capture_output=True,timeout=300)
    if result.stdout:print(result.stdout.decode(errors='replace'),end='')
    if result.stderr:print(result.stderr.decode(errors='replace'),end='',file=sys.stderr)
    if result.returncode:raise RuntimeError('Scoped VM deployment failed with exit code '+str(result.returncode))

if __name__=='__main__':main()
