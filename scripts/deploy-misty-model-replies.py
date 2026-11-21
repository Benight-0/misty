"""Remove the canned owner reply path from the running Misty VM service."""
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
SOURCES = ('bot.py', 'conversation.py')
TESTS = ('test_conversation.py', 'test_persistent_owner.py', 'test_overlay.py')
BASELINE = {
    'bot.py': '68c79f0bccabffbebba4039bb76378149850a869db4bf3fba8b23a98af9ab896',
    'conversation.py': '4ddb7a7ddc452ffa07bde32a9f28b8541bef88b6df2f68245925ebc69b05d474',
    'owner_quick.py': '04171e7c62a260f9cfca2e06d8389c987f428431ac90d4d32ff08dcafd8ddf78',
}

REMOTE = r'''
import hashlib,io,json,os,shutil,sqlite3,subprocess,sys,tarfile,tempfile,time
from pathlib import Path
ROOT=Path('/opt/misty-prominence');DB=Path('/var/lib/misty-prominence/inbox.sqlite')
CONFIG=Path('/etc/misty-prominence/config.json');SERVICE='misty-prominence.service'
BASELINE={'bot.py':'68c79f0bccabffbebba4039bb76378149850a869db4bf3fba8b23a98af9ab896',
          'conversation.py':'4ddb7a7ddc452ffa07bde32a9f28b8541bef88b6df2f68245925ebc69b05d474',
          'owner_quick.py':'04171e7c62a260f9cfca2e06d8389c987f428431ac90d4d32ff08dcafd8ddf78'}
def sha(data):return hashlib.sha256(data).hexdigest()
def run(*args,**kw):return subprocess.run(args,check=True,text=True,capture_output=True,timeout=kw.get('timeout',120),env=kw.get('env'),cwd=kw.get('cwd'))
def counts():
 with sqlite3.connect('file:'+str(DB)+'?mode=ro',uri=True) as con:
  return {table:con.execute('SELECT count(*) FROM '+table).fetchone()[0] for table in ('inbox','conversation_runs','conversation_outbox')}
def idle():
 with sqlite3.connect('file:'+str(DB)+'?mode=ro',uri=True) as con:
  return con.execute("SELECT count(*) FROM conversation_runs WHERE state='running'").fetchone()[0]==0
def ready():
 if run('systemctl','is-active',SERVICE).stdout.strip()!='active':return False
 group=run('systemctl','show',SERVICE,'-p','ControlGroup','--value').stdout.strip()
 try:
  cmds=[Path('/proc/'+pid+'/cmdline').read_bytes() for pid in (Path('/sys/fs/cgroup')/group.lstrip('/')/'cgroup.procs').read_text().split()]
 except OSError:return False
 return any(b'app-server' in command and b'codex' in command for command in cmds)
if os.geteuid()!=0:raise RuntimeError('Root VM maintenance access required')
with tarfile.open(fileobj=io.BytesIO(sys.stdin.buffer.read()),mode='r:gz') as archive:
 members=archive.getmembers()
 data={m.name:archive.extractfile(m).read() for m in members if m.isfile() and m.size<2_000_000}
 if len(data)!=len(members):raise RuntimeError('Invalid deployment bundle')
manifest=json.loads(data.pop('manifest.json'))
expected={'bot.py','conversation.py','test_conversation.py','test_persistent_owner.py','test_overlay.py'}
if set(data)!=expected or set(manifest)!=expected:raise RuntimeError('Unexpected bundle scope')
if any(sha(data[name])!=manifest[name] for name in expected):raise RuntimeError('Bundle source hash mismatch')
for name,digest in BASELINE.items():
 target=ROOT/name
 if target.is_symlink() or sha(target.read_bytes())!=digest:raise RuntimeError('Production source drift: '+name)
if json.loads(CONFIG.read_text()).get('agent_effort')!='low':raise RuntimeError('Owner effort is not low')
if run('systemctl','is-active',SERVICE).stdout.strip()!='active':raise RuntimeError('Misty service is inactive')
with tempfile.TemporaryDirectory(prefix='misty-model-replies-') as temp:
 stage=Path(temp)
 for name,content in data.items():(stage/name).write_bytes(content)
 run('python3','-m','py_compile',*[str(stage/name) for name in expected])
 env={**os.environ,'PROMINENCE_OWNER_ID':'100000000000000005','PYTHONPATH':str(stage)+':'+str(ROOT)}
 env.pop('PROMINENCE_CONFIG',None)
 run('python3','-m','unittest','-q','test_conversation','test_persistent_owner','test_overlay',env=env,cwd=str(stage))
 print('Focused VM tests passed',flush=True)
 for _ in range(24):
  if idle():break
  time.sleep(5)
 else:raise RuntimeError('Owner run stayed active; nothing deployed')
 stamp=time.strftime('%Y%m%dT%H%M%SZ',time.gmtime())
 snapshot=run('runuser','-u','misty-bot','--','env','PROMINENCE_CONFIG=/etc/misty-prominence/config.json',
              str(ROOT/'venv/bin/python'),str(ROOT/'selfupdate.py'),'snapshot','Remove fixed owner replies').stdout.strip()
 backup=Path('/var/backups/misty')/('model-replies-before-'+stamp)
 backup.mkdir(parents=True,mode=0o700)
 for name in BASELINE:shutil.copy2(ROOT/name,backup/name)
 with sqlite3.connect(DB) as source,sqlite3.connect(backup/'inbox.sqlite') as saved:source.backup(saved)
 with sqlite3.connect(backup/'inbox.sqlite') as saved:
  if saved.execute('PRAGMA quick_check').fetchone()[0]!='ok':raise RuntimeError('Inbox backup integrity failed')
 before=counts()
 if not idle():raise RuntimeError('Owner run started during backup; nothing deployed')
 changed=False
 try:
  for name in ('bot.py','conversation.py'):
   target=ROOT/name
   if sha(target.read_bytes())!=BASELINE[name]:raise RuntimeError('Source drift during install: '+name)
   stat=target.stat();pending=target.with_name(target.name+'.model-new')
   pending.write_bytes(data[name]);os.chown(pending,stat.st_uid,stat.st_gid);pending.chmod(stat.st_mode&0o777)
   os.replace(pending,target);changed=True
  (ROOT/'owner_quick.py').unlink()
  run('systemctl','restart',SERVICE)
  for _ in range(90):
   if ready():break
   time.sleep(1)
  else:raise RuntimeError('Warm owner process did not return')
  runtime=json.loads(Path('/var/lib/misty-prominence/conversation_runtime.json').read_text())
  check=run('runuser','-u','misty-bot','--','env','PROMINENCE_CONFIG=/etc/misty-prominence/config.json',
            str(ROOT/'venv/bin/python'),str(ROOT/'selfupdate.py'),'check').stdout.strip()
  after=counts()
  if runtime.get('effort')!='low' or check!='ok' or (ROOT/'owner_quick.py').exists():raise RuntimeError('Runtime verification failed')
  if any(after[name]<before[name] for name in before):raise RuntimeError('Inbox count decreased')
  if any(sha((ROOT/name).read_bytes())!=manifest[name] for name in ('bot.py','conversation.py')):raise RuntimeError('Installed hash mismatch')
  if b'owner_quick' in (ROOT/'bot.py').read_bytes():raise RuntimeError('Fixed-response import remains')
 except Exception:
  if changed:
   for name in BASELINE:shutil.copy2(backup/name,ROOT/name)
   subprocess.run(('systemctl','restart',SERVICE),check=False)
  raise
 for stale in (ROOT/'__pycache__').glob('owner_quick*.pyc'):stale.unlink(missing_ok=True)
 receipt={'at':stamp,'backup':str(backup),'snapshot':snapshot,'before':before,'after':after,
          'files':{name:sha((ROOT/name).read_bytes()) for name in ('bot.py','conversation.py')},
          'fixedReplyModulePresent':(ROOT/'owner_quick.py').exists(),'service':run('systemctl','is-active',SERVICE).stdout.strip(),
          'appServerWarm':ready(),'agentEffort':runtime['effort']}
 (backup/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
 print(json.dumps(receipt),flush=True)
'''


def main():
    data = {name: (ROOT / 'prominence' / name).read_bytes() for name in SOURCES + TESTS}
    manifest = {name: hashlib.sha256(content).hexdigest() for name, content in data.items()}
    bundle = io.BytesIO()
    with tarfile.open(fileobj=bundle, mode='w:gz') as archive:
        for name, content in {**data, 'manifest.json': json.dumps(manifest).encode()}.items():
            entry = tarfile.TarInfo(name)
            entry.size = len(content)
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
