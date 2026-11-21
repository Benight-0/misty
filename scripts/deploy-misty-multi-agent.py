"""Scoped VM code rollout. Role flags are activated separately after verification."""
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
 'prominence/agent_tasks.py':'/opt/misty-prominence/agent_tasks.py',
 'prominence/agent_worker.py':'/opt/misty-prominence/agent_worker.py',
 'prominence/agent_runtime.py':'/opt/misty-prominence/agent_runtime.py',
 'prominence/agent_projects.py':'/opt/misty-prominence/agent_projects.py',
 'prominence/agent_metrics.py':'/opt/misty-prominence/agent_metrics.py',
 'prominence/task_tools.py':'/opt/misty-prominence/task_tools.py',
 'prominence/supervisor.py':'/opt/misty-prominence/supervisor.py',
 'prominence/bot.py':'/opt/misty-prominence/bot.py',
 'prominence/owner_loop.py':'/opt/misty-prominence/owner_loop.py',
 'prominence/conversation.py':'/opt/misty-prominence/conversation.py',
 'prominence/conversation_tools.py':'/opt/misty-prominence/conversation_tools.py',
 'prominence/laptop_tools.py':'/opt/misty-prominence/laptop_tools.py',
 'prominence/config.py':'/opt/misty-prominence/config.py',
 'prominence/owner_trace.py':'/opt/misty-prominence/owner_trace.py',
 'prominence/overlay.py':'/opt/misty-prominence/overlay.py',
 'scripts/misty-laptop-tools-server.mjs':'/opt/misty-bot/scripts/misty-laptop-tools-server.mjs',
 'app/laptop-tools-broker.mjs':'/opt/misty-bot/app/laptop-tools-broker.mjs',
 'app/misty-prominence-bridge.mjs':'/opt/misty-bot/app/misty-prominence-bridge.mjs',
 'app/codex-events.mjs':'/opt/misty-bot/app/codex-events.mjs',
 'app/misty-archive.mjs':'/opt/archival/app/misty-archive.mjs',
 'scripts/misty-archive-query.py':'/opt/archival/scripts/misty-archive-query.py',
 'deploy/misty-agents.service':'/etc/systemd/system/misty-agents.service',
}
BASELINE={
 '/opt/misty-prominence/bot.py':'0794f228b16280d530dcec450f6aacdc1ce60ad08da1b0758000282e45faccb6',
 '/opt/misty-prominence/owner_loop.py':'1b01ec7ec086d64932996e1a95c79d4a3f924509833b10609aa10bf00d332ab6',
 '/opt/misty-prominence/conversation.py':'188a6245504c49e3bb41da972efece0ecfba8a2d75851ec7c85532a2c9bfce05',
 '/opt/misty-prominence/conversation_tools.py':'35b3ac9ec3b882967ea661e5acf2b44922dacbd9719c076b568bc35ed757a8ee',
 '/opt/misty-prominence/laptop_tools.py':'b101feb3ac23f3ace853c1f01b78c3c7332f2825f547eccf4e3188ecea92f709',
 '/opt/misty-prominence/config.py':'c9c7a84907ffb56aa87b893cb3202a81b6cf08b30e834418db14747b699071f6',
 '/opt/misty-prominence/owner_trace.py':'8fb7ace9bb2003bd86c8ca96f526168423da0cc46c35b52273b0755f7eed700d',
 '/opt/misty-prominence/overlay.py':'12e9611b6654a4097227d928dc9474bfa949c36cb9de66c8105e781bf5e60d25',
 '/opt/misty-bot/scripts/misty-laptop-tools-server.mjs':'8532159a8fbd91d8c33e42fa891b2351c03d06c4e676977dcee0d9638a9c811f',
 '/opt/misty-bot/app/laptop-tools-broker.mjs':'2bf7cd0d029e5008e337550da9909dc023cd99f9711edf823194444d90663db1',
 '/opt/misty-bot/app/misty-prominence-bridge.mjs':'a474c3e53e014e8036da6199a76d8e551247fec2456b5816f2bf18c622e48a53',
 '/opt/misty-bot/app/codex-events.mjs':'4ca8ff6add49d0a442933b654e1cbf1832c04ca10fadcfeb57d22ecd8ba095a3',
 '/opt/archival/app/misty-archive.mjs':'8e5eb3fbfc799ced9be1bb8286620a63a41c917c6da859ad6497b50802af7605',
 '/opt/archival/scripts/misty-archive-query.py':'6a72d2d4f4125e1632f78ff4e4cffce4ed21b94d82bfd492b26acacc0a6eeab9',
}
TESTS=('test_agent_tasks.py','test_agent_projects.py','test_owner_trace.py')
REMOTE=r'''
import hashlib,io,json,os,shutil,sqlite3,subprocess,sys,tarfile,tempfile,time
from pathlib import Path
def sha(data):return hashlib.sha256(data).hexdigest()
def run(*args,timeout=120,env=None,cwd=None):return subprocess.run(args,check=True,capture_output=True,text=True,timeout=timeout,env=env,cwd=cwd)
def counts():
 with sqlite3.connect('file:/var/lib/misty-prominence/inbox.sqlite?mode=ro',uri=True) as db:
  return {name:db.execute('SELECT count(*) FROM '+name).fetchone()[0] for name in ('inbox','conversation_runs','conversation_outbox')}
def idle():
 with sqlite3.connect('file:/var/lib/misty-prominence/inbox.sqlite?mode=ro',uri=True) as db:
  return db.execute("SELECT count(*) FROM conversation_runs WHERE state='running'").fetchone()[0]==0
def services():return {s:run('systemctl','is-active',s).stdout.strip() for s in ('archival','misty-bot','misty-laptop-tools','misty-prominence')}
with tarfile.open(fileobj=io.BytesIO(sys.stdin.buffer.read()),mode='r:gz') as archive:
 members=archive.getmembers()
 data={m.name:archive.extractfile(m).read() for m in members if m.isfile() and m.size<2_000_000}
 if len(data)!=len(members):raise RuntimeError('Unexpected bundle member')
 manifest=json.loads(data.pop('manifest.json'))
if set(data)!=set(manifest['targets'])|set(manifest['tests']):raise RuntimeError('Unexpected deployment scope')
for name,body in data.items():
 if sha(body)!=manifest['source'][name]:raise RuntimeError('Bundle hash changed: '+name)
for dest,expected in manifest['baseline'].items():
 path=Path(dest)
 if path.is_symlink() or sha(path.read_bytes())!=expected:raise RuntimeError('Live source drift: '+dest)
for dest in set(manifest['targets'].values())-set(manifest['baseline']):
 if Path(dest).exists():raise RuntimeError('New target already exists: '+dest)
if any(state!='active' for state in services().values()):raise RuntimeError('One service is already inactive')
with tempfile.TemporaryDirectory(prefix='misty-agents-') as temporary:
 stage=Path(temporary)
 for name,body in data.items():
  target=stage/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(body)
 py=[str(stage/name) for name in data if name.endswith('.py')]
 run('python3','-m','py_compile',*py)
 for name in data:
  if name.endswith('.mjs'):run('/opt/misty-bot/bin/node','--check',str(stage/name))
 env={**os.environ,'PYTHONPATH':str(stage/'prominence')+':/opt/misty-prominence',
      'PROMINENCE_OWNER_ID':'100000000000000005'}
 env.pop('PROMINENCE_CONFIG',None)
 run('python3','-m','unittest','-q',*[Path(name).stem for name in manifest['tests']],env=env,cwd=str(stage/'prominence'),timeout=180)
 print('Staged syntax and focused VM tests passed',flush=True)
 for _ in range(24):
  if idle():break
  time.sleep(5)
 else:raise RuntimeError('Owner turn stayed active; no files installed')
 stamp=time.strftime('%Y%m%dT%H%M%SZ',time.gmtime())
 backup=Path('/var/backups/misty')/('multi-agent-before-'+stamp)
 backup.mkdir(mode=0o700,parents=True)
 before=counts()
 for dest in manifest['baseline']:
  saved=backup/dest.lstrip('/');saved.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(dest,saved)
 with sqlite3.connect('/var/lib/misty-prominence/inbox.sqlite') as source,sqlite3.connect(backup/'inbox.sqlite') as saved:source.backup(saved)
 if not idle():raise RuntimeError('Owner turn started during backup; no files installed')
 installed=[];order=('archival','misty-bot','misty-laptop-tools','misty-prominence')
 try:
  for name,dest in manifest['targets'].items():
   target=Path(dest);previous=manifest['baseline'].get(dest)
   if previous and sha(target.read_bytes())!=previous:raise RuntimeError('Source drift during install: '+dest)
   stat=target.stat() if previous else (target.parent/'bot.py').stat() if target.name=='agent_tasks.py' else Path('/opt/misty-prominence/bot.py').stat()
   pending=target.with_name(target.name+'.agents-new')
   pending.write_bytes(data[name]);os.chown(pending,stat.st_uid,stat.st_gid);pending.chmod((stat.st_mode&0o777) if previous else 0o644)
   os.replace(pending,target);installed.append(dest)
  run('systemctl','daemon-reload')
  for service in order:run('systemctl','restart',service,timeout=120)
  for _ in range(90):
   if all(state=='active' for state in services().values()) and Path('/var/lib/misty-prominence/overlay.sock').exists():break
   time.sleep(1)
  else:raise RuntimeError('Services did not return healthy')
  check=run('runuser','-u','misty-bot','--','env','PROMINENCE_CONFIG=/etc/misty-prominence/config.json',
            '/opt/misty-prominence/venv/bin/python','/opt/misty-prominence/selfupdate.py','check')
  if check.stdout.strip()!='ok':raise RuntimeError('Misty self-check failed')
  after=counts()
  if any(after[k]<before[k] for k in before):raise RuntimeError('Owner conversation count decreased')
  if any(sha(Path(dest).read_bytes())!=manifest['source'][name] for name,dest in manifest['targets'].items()):raise RuntimeError('Deployed hash mismatch')
 except Exception:
  for dest in installed:
   if dest in manifest['baseline']:shutil.copy2(backup/dest.lstrip('/'),dest)
   else:Path(dest).unlink(missing_ok=True)
  subprocess.run(('systemctl','daemon-reload'),check=False,capture_output=True)
  for service in order:subprocess.run(('systemctl','restart',service),check=False,capture_output=True)
  raise
 receipt={'backup':str(backup),'at':stamp,'files':len(installed),'services':services(),
          'ownerCountsBefore':before,'ownerCountsAfter':after,'flags':'unchanged'}
 (backup/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
 print(json.dumps(receipt),flush=True)
'''


def main():
    data={name:(ROOT/name).read_bytes() for name in TARGETS}
    data.update({'prominence/'+name:(ROOT/'prominence'/name).read_bytes() for name in TESTS})
    manifest={'targets':TARGETS,'baseline':BASELINE,'tests':['prominence/'+name for name in TESTS],
              'source':{name:hashlib.sha256(body).hexdigest() for name,body in data.items()}}
    bundle=io.BytesIO()
    with tarfile.open(fileobj=bundle,mode='w:gz') as archive:
        for name,body in {**data,'manifest.json':json.dumps(manifest).encode()}.items():
            entry=tarfile.TarInfo(name);entry.size=len(body);entry.mode=0o644
            archive.addfile(entry,io.BytesIO(body))
    loader='import base64;exec(base64.b64decode("'+base64.b64encode(REMOTE.encode()).decode()+'"))'
    command='sudo -n python3 -c '+shlex.quote(loader)
    result=subprocess.run(['ssh.exe','-T','-F',str(SSH),'-o','BatchMode=yes','-o','ConnectTimeout=30','archival-vm',command],
                          input=bundle.getvalue(),capture_output=True,timeout=900)
    if result.stdout:print(result.stdout.decode(errors='replace'),end='')
    if result.stderr:print(result.stderr.decode(errors='replace'),end='',file=sys.stderr)
    if result.returncode:raise RuntimeError('Scoped VM deployment failed with exit code '+str(result.returncode))


if __name__=='__main__':main()
