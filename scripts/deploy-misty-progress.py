"""Deploy only the disposable owner-status feature to the paired VM."""
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
SSH = ROOT / 'data/deployment/ssh_config'
RUNTIME = ('bot.py', 'owner_loop.py', 'overlay.py', 'activity.py', 'owner_progress.py')
TESTS = ('test_owner_progress.py', 'test_persistent_owner.py', 'test_overlay.py')
BASELINE = {
    'bot.py': '22b6089dc876fba2c5b01a16203e590054b14c466e003503661fd04f206adcab',
    'owner_loop.py': '9388a3af84053a19a13f3fdfe563b05f7fc3850cd3a79b702179bf57ac4122c7',
    'overlay.py': '1ead444307aa893295bfcda9012f49cadcf51d34a38528661fee238232d4e9a5',
    'activity.py': 'c8300b9ba3fc48a56ee8ca2e5b0f9163849e96a552c48dc6376394d59bc23540',
}

REMOTE = r'''
import hashlib,io,json,os,shutil,socket,sqlite3,subprocess,sys,tarfile,tempfile,time
from pathlib import Path
ROOT=Path('/opt/misty-prominence');DB=Path('/var/lib/misty-prominence/inbox.sqlite')
SERVICE='misty-prominence.service'
def sha(data):return hashlib.sha256(data).hexdigest()
def run(*args,**kw):return subprocess.run(args,check=True,text=True,capture_output=True,timeout=kw.get('timeout',120),env=kw.get('env'),cwd=kw.get('cwd'))
def idle():
 with sqlite3.connect('file:'+str(DB)+'?mode=ro',uri=True) as db:
  return db.execute("SELECT count(*) FROM conversation_runs WHERE state='running'").fetchone()[0]==0
def counts():
 with sqlite3.connect('file:'+str(DB)+'?mode=ro',uri=True) as db:
  return {t:db.execute('SELECT count(*) FROM '+t).fetchone()[0] for t in ('inbox','conversation_runs','conversation_outbox')}
def ready():
 if run('systemctl','is-active',SERVICE).stdout.strip()!='active':return False
 if not Path('/var/lib/misty-prominence/overlay.sock').exists():return False
 group=run('systemctl','show',SERVICE,'-p','ControlGroup','--value').stdout.strip()
 try:
  pids=(Path('/sys/fs/cgroup')/group.lstrip('/')/'cgroup.procs').read_text().split()
  cmds=[Path('/proc/'+x+'/cmdline').read_bytes() for x in pids]
 except OSError:return False
 return any(b'app-server' in c and b'codex' in c for c in cmds)
def working():
 script='import json,socket; s=socket.socket(socket.AF_UNIX); s.settimeout(20); s.connect("/var/lib/misty-prominence/overlay.sock"); s.sendall(b\'{"op":"working"}\\n\'); print(s.makefile().readline())'
 result=run('runuser','-u','misty-bot','--','python3','-c',script)
 body=json.loads(result.stdout)
 if 'error' in body or 'result' not in body or 'active' not in body['result']:raise RuntimeError('Overlay status unavailable')
 return body['result']
if os.geteuid()!=0:raise RuntimeError('Root VM maintenance access required')
with tarfile.open(fileobj=io.BytesIO(sys.stdin.buffer.read()),mode='r:gz') as archive:
 members=archive.getmembers()
 data={m.name:archive.extractfile(m).read() for m in members if m.isfile() and m.size<2_000_000}
 if len(data)!=len(members):raise RuntimeError('Invalid deployment bundle')
manifest=json.loads(data.pop('manifest.json'))
names=set(manifest['runtime']);tests=set(manifest['tests'])
if names!={'bot.py','owner_loop.py','overlay.py','activity.py','owner_progress.py'} or tests!={'test_owner_progress.py','test_persistent_owner.py','test_overlay.py'} or set(data)!=names|tests:
 raise RuntimeError('Unexpected deployment scope')
for name in names|tests:
 if sha(data[name])!=manifest['source'][name]:raise RuntimeError('Bundle source changed: '+name)
for name,expected in manifest['baseline'].items():
 target=ROOT/name
 if target.is_symlink() or sha(target.read_bytes())!=expected:raise RuntimeError('Production source drift: '+name)
if (ROOT/'owner_progress.py').exists():raise RuntimeError('Progress source already exists')
if run('systemctl','is-active',SERVICE).stdout.strip()!='active':raise RuntimeError('Misty service is inactive')
with tempfile.TemporaryDirectory(prefix='misty-progress-') as temporary:
 stage=Path(temporary)
 for name,content in data.items():(stage/name).write_bytes(content)
 run('python3','-m','py_compile',*[str(stage/name) for name in data])
 env={**os.environ,'PROMINENCE_OWNER_ID':'100000000000000005','PYTHONPATH':str(stage)+':'+str(ROOT)}
 env.pop('PROMINENCE_CONFIG',None)
 run('python3','-m','unittest','-q',*[name[:-3] for name in sorted(tests)],env=env,cwd=str(stage))
 print('Focused VM tests passed',flush=True)
 for _ in range(24):
  if idle():break
  time.sleep(5)
 else:raise RuntimeError('Owner run stayed active; nothing deployed')
 stamp=time.strftime('%Y%m%dT%H%M%SZ',time.gmtime())
 snapshot=run('runuser','-u','misty-bot','--','env','PROMINENCE_CONFIG=/etc/misty-prominence/config.json',
              str(ROOT/'venv/bin/python'),str(ROOT/'selfupdate.py'),'snapshot','Temporary owner progress').stdout.strip()
 backup=Path('/var/backups/misty')/('owner-progress-before-'+stamp)
 backup.mkdir(mode=0o700,parents=True)
 for name in manifest['baseline']:shutil.copy2(ROOT/name,backup/name)
 with sqlite3.connect(DB) as source,sqlite3.connect(backup/'inbox.sqlite') as saved:source.backup(saved)
 with sqlite3.connect(backup/'inbox.sqlite') as saved:
  if saved.execute('PRAGMA quick_check').fetchone()[0]!='ok':raise RuntimeError('Inbox backup integrity failed')
 before=counts()
 if not idle():raise RuntimeError('Owner run started during backup; nothing deployed')
 installed=[]
 try:
  for name in sorted(names):
   target=ROOT/name
   if name in manifest['baseline'] and sha(target.read_bytes())!=manifest['baseline'][name]:raise RuntimeError('Source drift during install: '+name)
   if name=='owner_progress.py' and target.exists():raise RuntimeError('Progress source appeared during install')
   stat=(ROOT/'owner_loop.py').stat() if name=='owner_progress.py' else target.stat()
   pending=target.with_name(target.name+'.progress-new')
   pending.write_bytes(data[name]);os.chown(pending,stat.st_uid,stat.st_gid);pending.chmod(stat.st_mode&0o777)
   os.replace(pending,target);installed.append(name)
  run('systemctl','restart',SERVICE)
  for _ in range(90):
   if ready():break
   time.sleep(1)
  else:raise RuntimeError('Misty app-server did not warm after restart')
  check=run('runuser','-u','misty-bot','--','env','PROMINENCE_CONFIG=/etc/misty-prominence/config.json',
            str(ROOT/'venv/bin/python'),str(ROOT/'selfupdate.py'),'check')
  if check.stdout.strip()!='ok':raise RuntimeError('Misty self-check failed')
  live=working()
  if live.get('active'):raise RuntimeError('Progress unexpectedly active after restart')
  after=counts()
  if any(after[t]<before[t] for t in before):raise RuntimeError('Owner inbox count decreased')
  if any(sha((ROOT/n).read_bytes())!=manifest['source'][n] for n in names):raise RuntimeError('Installed hash mismatch')
 except Exception:
  for name in installed:
   if name=='owner_progress.py':(ROOT/name).unlink(missing_ok=True)
   else:shutil.copy2(backup/name,ROOT/name)
  subprocess.run(('systemctl','restart',SERVICE),check=False)
  raise
 receipt={'at':stamp,'backup':str(backup),'snapshot':snapshot,'before':before,'after':after,
          'files':{n:sha((ROOT/n).read_bytes()) for n in sorted(names)},
          'service':run('systemctl','is-active',SERVICE).stdout.strip(),'appServerWarm':ready(),
          'overlayWorking':live}
 (backup/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
 print(json.dumps(receipt),flush=True)
'''


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    data = {name: (ROOT / 'prominence' / name).read_bytes() for name in RUNTIME + TESTS}
    manifest = {'runtime': RUNTIME, 'tests': TESTS, 'baseline': BASELINE,
                'source': {name: digest(content) for name, content in data.items()}}
    bundle = io.BytesIO()
    with tarfile.open(fileobj=bundle, mode='w:gz') as archive:
        for name, content in {**data, 'manifest.json': json.dumps(manifest).encode()}.items():
            entry = tarfile.TarInfo(name)
            entry.size = len(content)
            entry.mode = 0o644
            archive.addfile(entry, io.BytesIO(content))
    loader = 'import base64;exec(base64.b64decode("' + base64.b64encode(REMOTE.encode()).decode() + '"))'
    command = 'sudo -n python3 -c ' + shlex.quote(loader)
    result = subprocess.run(['ssh.exe', '-T', '-F', str(SSH), '-o', 'BatchMode=yes',
                             '-o', 'ConnectTimeout=30', 'archival-vm', command],
                            input=bundle.getvalue(), capture_output=True, timeout=900)
    if result.stdout:
        print(result.stdout.decode(errors='replace'), end='')
    if result.stderr:
        print(result.stderr.decode(errors='replace'), end='', file=sys.stderr)
    if result.returncode:
        raise RuntimeError(f'VM deployment failed with exit code {result.returncode}')


if __name__ == '__main__':
    main()
