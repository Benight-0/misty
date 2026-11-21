"""Apply the one-file transient-status turn-boundary correction."""
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
BASELINE = '8608247e429170ef42396e7a7cee49e9a4b7ff5cda003160298320bac1a159a2'
REMOTE = r'''
import hashlib,io,json,os,shutil,sqlite3,subprocess,sys,tarfile,tempfile,time
from pathlib import Path
ROOT=Path('/opt/misty-prominence');TARGET=ROOT/'owner_progress.py'
DB=Path('/var/lib/misty-prominence/inbox.sqlite');SERVICE='misty-prominence.service'
def sha(data):return hashlib.sha256(data).hexdigest()
def run(*args,**kw):return subprocess.run(args,check=True,text=True,capture_output=True,timeout=kw.get('timeout',120),env=kw.get('env'),cwd=kw.get('cwd'))
def idle():
 with sqlite3.connect('file:'+str(DB)+'?mode=ro',uri=True) as db:
  return db.execute("SELECT count(*) FROM conversation_runs WHERE state='running'").fetchone()[0]==0
def ready():
 if run('systemctl','is-active',SERVICE).stdout.strip()!='active':return False
 group=run('systemctl','show',SERVICE,'-p','ControlGroup','--value').stdout.strip()
 try:
  cmds=[Path('/proc/'+x+'/cmdline').read_bytes() for x in (Path('/sys/fs/cgroup')/group.lstrip('/')/'cgroup.procs').read_text().split()]
 except OSError:return False
 return any(b'app-server' in c and b'codex' in c for c in cmds)
if os.geteuid()!=0:raise RuntimeError('Root VM maintenance access required')
with tarfile.open(fileobj=io.BytesIO(sys.stdin.buffer.read()),mode='r:gz') as archive:
 members=archive.getmembers()
 data={m.name:archive.extractfile(m).read() for m in members if m.isfile() and m.size<2_000_000}
 if set(data)!={'owner_progress.py','test_owner_progress.py','manifest.json'} or len(members)!=3:raise RuntimeError('Unexpected bundle scope')
manifest=json.loads(data.pop('manifest.json'))
if TARGET.is_symlink() or sha(TARGET.read_bytes())!=manifest['baseline']:raise RuntimeError('Production source drift')
for name in data:
 if sha(data[name])!=manifest['source'][name]:raise RuntimeError('Bundle source changed: '+name)
with tempfile.TemporaryDirectory(prefix='misty-progress-guard-') as temporary:
 stage=Path(temporary)
 for name,content in data.items():(stage/name).write_bytes(content)
 run('python3','-m','py_compile',*[str(stage/name) for name in data])
 env={**os.environ,'PYTHONPATH':str(stage)+':'+str(ROOT)}
 run('python3','-m','unittest','-q','test_owner_progress',env=env,cwd=str(stage))
 print('Focused VM status tests passed',flush=True)
 for _ in range(24):
  if idle():break
  time.sleep(5)
 else:raise RuntimeError('Owner turn stayed active; nothing deployed')
 stamp=time.strftime('%Y%m%dT%H%M%SZ',time.gmtime())
 backup=Path('/var/backups/misty')/('owner-progress-guard-before-'+stamp)
 backup.mkdir(mode=0o700,parents=True)
 shutil.copy2(TARGET,backup/TARGET.name)
 snapshot=run('runuser','-u','misty-bot','--','env','PROMINENCE_CONFIG=/etc/misty-prominence/config.json',
              str(ROOT/'venv/bin/python'),str(ROOT/'selfupdate.py'),'snapshot','Owner progress turn boundary').stdout.strip()
 if not idle():raise RuntimeError('Owner turn started during backup; nothing deployed')
 try:
  if sha(TARGET.read_bytes())!=manifest['baseline']:raise RuntimeError('Source drift during install')
  stat=TARGET.stat();pending=TARGET.with_name(TARGET.name+'.guard-new')
  pending.write_bytes(data['owner_progress.py']);os.chown(pending,stat.st_uid,stat.st_gid);pending.chmod(stat.st_mode&0o777)
  os.replace(pending,TARGET)
  run('systemctl','restart',SERVICE)
  for _ in range(90):
   if ready():break
   time.sleep(1)
  else:raise RuntimeError('Misty did not warm after restart')
  check=run('runuser','-u','misty-bot','--','env','PROMINENCE_CONFIG=/etc/misty-prominence/config.json',
            str(ROOT/'venv/bin/python'),str(ROOT/'selfupdate.py'),'check')
  if check.stdout.strip()!='ok' or sha(TARGET.read_bytes())!=manifest['source']['owner_progress.py']:
   raise RuntimeError('Post-restart verification failed')
 except Exception:
  shutil.copy2(backup/TARGET.name,TARGET)
  subprocess.run(('systemctl','restart',SERVICE),check=False)
  raise
 receipt={'at':stamp,'backup':str(backup),'snapshot':snapshot,'file':sha(TARGET.read_bytes()),
          'service':run('systemctl','is-active',SERVICE).stdout.strip(),'appServerWarm':ready()}
 (backup/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
 print(json.dumps(receipt),flush=True)
'''


def main():
    files = {name: (ROOT / 'prominence' / name).read_bytes()
             for name in ('owner_progress.py', 'test_owner_progress.py')}
    manifest = {'baseline': BASELINE,
                'source': {name: hashlib.sha256(content).hexdigest() for name, content in files.items()}}
    bundle = io.BytesIO()
    with tarfile.open(fileobj=bundle, mode='w:gz') as archive:
        for name, content in {**files, 'manifest.json': json.dumps(manifest).encode()}.items():
            entry = tarfile.TarInfo(name)
            entry.size = len(content)
            entry.mode = 0o644
            archive.addfile(entry, io.BytesIO(content))
    loader = 'import base64;exec(base64.b64decode("' + base64.b64encode(REMOTE.encode()).decode() + '"))'
    result = subprocess.run(['ssh.exe', '-T', '-F', str(SSH), '-o', 'BatchMode=yes',
                             '-o', 'ConnectTimeout=30', 'archival-vm',
                             'sudo -n python3 -c ' + shlex.quote(loader)],
                            input=bundle.getvalue(), capture_output=True, timeout=900)
    if result.stdout:
        print(result.stdout.decode(errors='replace'), end='')
    if result.stderr:
        print(result.stderr.decode(errors='replace'), end='', file=sys.stderr)
    if result.returncode:
        raise RuntimeError(f'VM deployment failed with exit code {result.returncode}')


if __name__ == '__main__':
    main()
