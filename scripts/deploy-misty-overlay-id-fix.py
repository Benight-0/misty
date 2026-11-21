"""Scoped production reload of the overlay request-ID routing fix."""
import base64
import hashlib
from pathlib import Path
import shlex
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'prominence/overlay.py'
EXPECTED = '3092ba73e4665be62b2d0995ca9500775f90bfaf41ac41769c5416cbd512193d'
SSH_CONFIG = ROOT / 'data/deployment/ssh_config'
REMOTE = r'''
import hashlib,json,os,pwd,shutil,sqlite3,subprocess,sys,tempfile,time
from pathlib import Path
LIVE=Path('/opt/misty-prominence/overlay.py')
INBOX=Path('/var/lib/misty-prominence/inbox.sqlite')
def sha(data):return hashlib.sha256(data).hexdigest()
def run(*args):return subprocess.run(args,check=True,text=True,capture_output=True,timeout=240)
def fork(*args):return run('runuser','-u','misty-bot','--','env','PROMINENCE_CONFIG=/etc/misty-prominence/config.json','/opt/misty-prominence/venv/bin/python','/opt/misty-prominence/selfupdate.py',*args)
if os.geteuid()!=0:raise RuntimeError('Root maintenance access required')
payload=json.loads(sys.stdin.buffer.readline())
data=bytes.fromhex(payload['source'])
if len(data)>500000 or sha(data)!=payload['sha'] or sha(LIVE.read_bytes())!=payload['baseline']:raise RuntimeError('Overlay source changed before installation')
with tempfile.NamedTemporaryFile(suffix='.py') as staged:
 staged.write(data);staged.flush();run('python3','-m','py_compile',staged.name)
for attempt in range(24):
 with sqlite3.connect(INBOX) as c:
  busy=c.execute("SELECT 1 FROM conversation_runs WHERE state='running' LIMIT 1").fetchone()
 if not busy:break
 time.sleep(5)
else:raise RuntimeError('Owner conversation remained active')
stamp=time.strftime('%Y%m%dT%H%M%SZ',time.gmtime())
backup=Path('/var/backups/misty')/('overlay-id-fix-before-'+stamp)
backup.mkdir(parents=True,mode=0o700)
shutil.copy2(LIVE,backup/'overlay.py')
snapshot=fork('snapshot','Overlay Gmail message ID routing').stdout.strip()
if sha(LIVE.read_bytes())!=payload['baseline']:raise RuntimeError('Overlay source drifted during backup')
old=LIVE.stat();pending=LIVE.with_name('overlay.py.id-fix-new')
pending.write_bytes(data);os.chown(pending,old.st_uid,old.st_gid);pending.chmod(old.st_mode&0o777)
try:
 os.replace(pending,LIVE)
 if fork('check').stdout.strip()!='ok':raise RuntimeError('Misty fork check failed')
 fork('restart','Overlay Gmail message ID routing')
 for attempt in range(60):
  if run('systemctl','is-active','misty-prominence.service').stdout.strip()=='active' and Path('/var/lib/misty-prominence/overlay.sock').exists():break
  time.sleep(1)
 else:raise RuntimeError('Overlay service did not recover')
 if sha(LIVE.read_bytes())!=payload['sha']:raise RuntimeError('Installed hash differs')
except Exception:
 shutil.copy2(backup/'overlay.py',LIVE)
 try:fork('restart','Restore overlay after failed ID routing fix')
 except Exception:pass
 raise
receipt={'at':stamp,'backup':str(backup),'snapshot':snapshot,'sha256':sha(LIVE.read_bytes()),'service':'active'}
(backup/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt))
'''


def main():
    data = SOURCE.read_bytes()
    payload = {'source': data.hex(), 'sha': hashlib.sha256(data).hexdigest(), 'baseline': EXPECTED}
    loader = 'import base64;exec(base64.b64decode("' + base64.b64encode(REMOTE.encode()).decode() + '"))'
    command = 'sudo -n python3 -c ' + shlex.quote(loader)
    result = subprocess.run(['ssh.exe', '-F', str(SSH_CONFIG), '-o', 'ConnectTimeout=30',
                             'archival-vm', command], input=(__import__('json').dumps(payload)+'\n').encode(),
                            capture_output=True, timeout=360)
    if result.stdout:print(result.stdout.decode(errors='replace'),end='')
    if result.stderr:print(result.stderr.decode(errors='replace'),end='',file=sys.stderr)
    if result.returncode:raise RuntimeError('Overlay ID fix deployment failed; audit the VM before retrying.')


if __name__ == '__main__':main()
