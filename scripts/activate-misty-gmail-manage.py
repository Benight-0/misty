"""Install a freshly authorized Gmail read+compose+modify token on the VM.

The token travels only in SSH stdin. No email is drafted or sent by this script.
"""
import base64
import hashlib
import io
import json
from pathlib import Path
import shlex
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
STAGED = ROOT / 'data/deployment/misty-gmail-manage-auth/credentials.json'
SSH_CONFIG = ROOT / 'data/deployment/ssh_config'
READ = 'https://www.googleapis.com/auth/gmail.readonly'
COMPOSE = 'https://www.googleapis.com/auth/gmail.compose'
SEND = 'https://www.googleapis.com/auth/gmail.send'
MODIFY = 'https://www.googleapis.com/auth/gmail.modify'

REMOTE = r'''
import hashlib,json,os,pwd,shutil,sqlite3,subprocess,sys,time,urllib.error,urllib.request
from pathlib import Path
TOKEN=Path('/var/lib/archival/gmail/credentials.json')
DB=Path('/var/lib/archival/data/archive.sqlite')
read='https://www.googleapis.com/auth/gmail.readonly'
compose='https://www.googleapis.com/auth/gmail.compose'
send='https://www.googleapis.com/auth/gmail.send'
modify='https://www.googleapis.com/auth/gmail.modify'
def run(*args):return subprocess.run(args,check=True,text=True,capture_output=True,timeout=240)
def ready():
 try:urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8787/api/gmail',headers={'Host':'archival.example.com'}),timeout=3);return False
 except urllib.error.HTTPError as e:return e.code==401
 except OSError:return False
if os.geteuid()!=0:raise RuntimeError('Root required')
data=sys.stdin.buffer.read()
if len(data)>100_000:raise RuntimeError('Gmail authorization stream is too large')
new=json.loads(data)
old=json.loads(TOKEN.read_text())
if new.get('clientType')!='desktop' or new.get('client')!=old.get('client') or set(new.get('accounts',{}))!=set(old.get('accounts',{})) or len(new['accounts'])!=1:raise RuntimeError('Gmail client or mailbox changed')
account_id,account=next(iter(new['accounts'].items()))
scopes=set(account.get('scopes') or ())
if not {read,compose,modify}.issubset(scopes) or not scopes.issubset({read,compose,send,modify}) or not account.get('refresh_token') or not account.get('access_token'):raise RuntimeError('Gmail read, compose and modify authorization missing')
with sqlite3.connect(DB) as c:
 if not c.execute('SELECT 1 FROM gmail_accounts WHERE id=? AND enabled=1',(account_id,)).fetchone():raise RuntimeError('Expected connected Gmail mailbox is unavailable')
 if c.execute("SELECT 1 FROM chat_outgoing WHERE status='sending' LIMIT 1").fetchone():raise RuntimeError('A personal message is sending')
if run('systemctl','is-active','archival.service').stdout.strip()!='active':raise RuntimeError('Archival inactive before token activation')
stamp=time.strftime('%Y%m%dT%H%M%SZ',time.gmtime())
backup=Path('/var/backups/archival')/('misty-gmail-manage-before-'+stamp)
backup.mkdir(mode=0o700)
shutil.copy2(TOKEN,backup/'credentials.json')
(backup/'credential.sha256').write_text(hashlib.sha256(TOKEN.read_bytes()).hexdigest()+'\n')
run('systemctl','stop','archival.service')
try:
 identity=pwd.getpwnam('archival')
 pending=TOKEN.with_name('credentials.json.manage-new')
 fd=os.open(pending,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'wb') as output:output.write(data)
 os.chown(pending,identity.pw_uid,identity.pw_gid)
 os.replace(pending,TOKEN)
 run('systemctl','start','archival.service')
 for attempt in range(360):
  if ready():break
  if attempt in (29,59,119,179,239,299):print('Waiting for Archival startup ('+str(attempt+1)+'s).',flush=True)
  time.sleep(1)
 else:raise RuntimeError('Archival did not become ready')
 if hashlib.sha256(TOKEN.read_bytes()).hexdigest()!=hashlib.sha256(data).hexdigest():raise RuntimeError('Installed Gmail token hash differs')
 if run('systemctl','is-active','archival.service').stdout.strip()!='active':raise RuntimeError('Archival inactive after token activation')
except Exception:
 shutil.copy2(backup/'credentials.json',TOKEN)
 subprocess.run(('systemctl','start','archival.service'),check=False)
 raise
receipt={'at':stamp,'backup':str(backup),'credential_sha256':hashlib.sha256(TOKEN.read_bytes()).hexdigest(),'account_id':account_id,'scopes':sorted(scopes),'service':'active'}
(backup/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt),flush=True)
'''


def main():
    data = STAGED.read_bytes()
    vault = json.loads(data)
    accounts = vault.get('accounts') or {}
    if vault.get('clientType') != 'desktop' or len(accounts) != 1:
        raise RuntimeError('Expected one staged Desktop OAuth mailbox.')
    account = next(iter(accounts.values()))
    scopes = set(account.get('scopes') or ())
    if not {READ, COMPOSE, MODIFY}.issubset(scopes) or not scopes.issubset({READ, COMPOSE, SEND, MODIFY}):
        raise RuntimeError('Staged token lacks Gmail read, compose and modify permission.')
    loader = 'import base64;exec(base64.b64decode("' + base64.b64encode(REMOTE.encode()).decode() + '"))'
    command = 'sudo -n python3 -c ' + shlex.quote(loader)
    try:
        result = subprocess.run(['ssh.exe', '-F', str(SSH_CONFIG), '-o', 'ConnectTimeout=30',
                                 'archival-vm', command], input=data, capture_output=True, timeout=600)
    except subprocess.TimeoutExpired:
        raise RuntimeError('Token activation exceeded ten minutes; audit production before retrying.') from None
    if result.stdout:
        print(result.stdout.decode(errors='replace'), end='')
    if result.stderr:
        print(result.stderr.decode(errors='replace'), end='', file=sys.stderr)
    if result.returncode:
        raise RuntimeError(f'VM token activation failed with exit code {result.returncode}.')


if __name__ == '__main__':
    main()
