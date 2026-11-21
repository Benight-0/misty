"""Deploy only Misty's persistent owner worker through the paired VM SSH account."""
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
RUNTIME = ('bot.py', 'owner_loop.py', 'conversation.py', 'conversation_tools.py',
           'config.py', 'dm.py', 'laptop_activity.py')
BASELINE = {
    'bot.py': '1bcea34bf3abb8fbefe784782150143c79c9994df4a6eebcf199d65b49a25955',
    'owner_loop.py': '239ebfd558d3496fddf86a0134a05441bd24dcc71c54b6f03db31363934d803a',
    'conversation.py': '65f1a6d5cf7eab353a4437a29d87551aeb43d5eb21e1c2ba59a4535913e1b4a8',
    'conversation_tools.py': 'bfce0c3d1e5e4ac0d6c4974d30310d69b54f990d5ba87ae0d62225e28c319445',
    'config.py': 'adb9ef886ba0654e36a5b2530ff0f8b52e5f533a6e57b4e40e9febb01dde436e',
    'dm.py': 'f0206ea3fdbf603c7e0cd44207d09c8ce7cf8a5e5cbe2d85df3dd8b8783f8d0e',
    'laptop_activity.py': 'b60d231850b7ad08a1b8f7e4a151c66ee777d812680325b8eefad2a60ed4750f',
}

REMOTE = r'''
import hashlib,io,json,os,shutil,sqlite3,subprocess,sys,tarfile,tempfile,time
from pathlib import Path
ROOT=Path('/opt/misty-prominence')
DB=Path('/var/lib/misty-prominence/inbox.sqlite')
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
if os.geteuid()!=0:raise RuntimeError('Root VM maintenance access required')
with tarfile.open(fileobj=io.BytesIO(sys.stdin.buffer.read()),mode='r:gz') as archive:
 members=archive.getmembers()
 data={m.name:archive.extractfile(m).read() for m in members if m.isfile() and m.size<2_000_000}
 if len(data)!=len(members):raise RuntimeError('Invalid deployment bundle')
manifest=json.loads(data.pop('manifest.json'))
names=set(manifest['baseline'])
if names!=set(manifest['source']) or names!=set(manifest['runtime']) or names!=set(data)-{'test_persistent_owner.py','test_conversation.py'} or len(names)!=7:
 raise RuntimeError('Unexpected deployment scope')
for name in ('test_persistent_owner.py','test_conversation.py'):
 if sha(data[name])!=manifest['tests'][name]:raise RuntimeError('Test source changed: '+name)
for name in names:
 target=ROOT/name
 if target.is_symlink() or sha(target.read_bytes())!=manifest['baseline'][name]:raise RuntimeError('Production source drift: '+name)
 if sha(data[name])!=manifest['source'][name]:raise RuntimeError('Bundle source changed: '+name)
if run('systemctl','is-active',SERVICE).stdout.strip()!='active':raise RuntimeError('Misty service is inactive')
with tempfile.TemporaryDirectory(prefix='misty-warm-owner-') as temporary:
 stage=Path(temporary)
 for name,content in data.items():(stage/name).write_bytes(content)
 run('python3','-m','py_compile',*[str(stage/name) for name in data])
 env={**os.environ,'PROMINENCE_OWNER_ID':'100000000000000005',
      'PYTHONPATH':str(stage)+':'+str(ROOT)}
 env.pop('PROMINENCE_CONFIG',None)
 test=run('python3','-m','unittest','-q','test_persistent_owner','test_conversation',env=env,cwd=str(stage))
 print('Focused VM tests passed',flush=True)
 for _ in range(24):
  if idle():break
  time.sleep(5)
 else:raise RuntimeError('Owner run stayed active; nothing deployed')
 stamp=time.strftime('%Y%m%dT%H%M%SZ',time.gmtime())
 snapshot=run('runuser','-u','misty-bot','--','env','PROMINENCE_CONFIG=/etc/misty-prominence/config.json',
              str(ROOT/'venv/bin/python'),str(ROOT/'selfupdate.py'),'snapshot','Warm owner app-server').stdout.strip()
 backup=Path('/var/backups/misty')/('warm-owner-before-'+stamp)
 backup.mkdir(mode=0o700,parents=True)
 for name in names:shutil.copy2(ROOT/name,backup/name)
 with sqlite3.connect(DB) as source,sqlite3.connect(backup/'inbox.sqlite') as saved:source.backup(saved)
 with sqlite3.connect(backup/'inbox.sqlite') as saved:
  if saved.execute('PRAGMA quick_check').fetchone()[0]!='ok':raise RuntimeError('Inbox backup integrity failed')
 before=counts()
 if not idle():raise RuntimeError('Owner run started during backup; nothing deployed')
 installed=[]
 try:
  for name in sorted(names):
   target=ROOT/name
   if sha(target.read_bytes())!=manifest['baseline'][name]:raise RuntimeError('Source drift during install: '+name)
   stat=target.stat()
   pending=target.with_name(target.name+'.warm-owner-new')
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
  after=counts()
  if any(after[t]<before[t] for t in before):raise RuntimeError('Owner inbox count decreased')
  if any(sha((ROOT/n).read_bytes())!=manifest['source'][n] for n in names):raise RuntimeError('Installed hash mismatch')
 except Exception:
  for name in installed:shutil.copy2(backup/name,ROOT/name)
  subprocess.run(('systemctl','restart',SERVICE),check=False)
  raise
 receipt={'at':stamp,'backup':str(backup),'snapshot':snapshot,'before':before,'after':after,
          'files':{n:sha((ROOT/n).read_bytes()) for n in sorted(names)},
          'service':run('systemctl','is-active',SERVICE).stdout.strip(),'appServerWarm':ready()}
 (backup/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
 print(json.dumps(receipt),flush=True)
'''


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    data = {name: (ROOT / 'prominence' / name).read_bytes() for name in RUNTIME}
    data['test_persistent_owner.py'] = (ROOT / 'prominence/test_persistent_owner.py').read_bytes()
    data['test_conversation.py'] = (ROOT / 'prominence/test_conversation.py').read_bytes()
    manifest = {'runtime': RUNTIME, 'baseline': BASELINE,
                'source': {name: digest(data[name]) for name in RUNTIME},
                'tests': {name: digest(data[name]) for name in ('test_persistent_owner.py','test_conversation.py')}}
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
