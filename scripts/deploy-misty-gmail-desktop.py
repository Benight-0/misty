"""Deploy the reviewed Gmail Desktop-client bridge and staged token over SSH stdin.

No credential is printed, written into a transfer bundle, or passed in command arguments.
"""
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import shlex
import subprocess
import tarfile


ROOT = Path(__file__).resolve().parents[1]
SOURCES = ('app/gmail.mjs', 'app/public/app.js', 'docs/misty-gmail.md')
STAGED = ROOT / 'data/deployment/misty-gmail-auth/credentials.json'
SSH_CONFIG = ROOT / 'data/deployment/ssh_config'
BASELINE = {
    'app/gmail.mjs': 'd83d0a602a9c611f78652c0536d545a5275930ff2d91194df18467d41d48ce56',
    'app/public/app.js': 'b0c9e663c4a736c7ece1be37324b0b27532456ee4047d68fe358e7c4072c6b55',
    'docs/misty-gmail.md': '0faac2dd4771acb48bafe4ce75a415cb2a34463d6ca2aa5311ec527870eb5199',
}
SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'

REMOTE = r'''
import hashlib
import io
import json
import os
from pathlib import Path
import pwd
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request

root=Path('/opt/archival')
names=('app/gmail.mjs','app/public/app.js','docs/misty-gmail.md')
db=Path('/var/lib/archival/data/archive.sqlite')
credential=Path('/var/lib/archival/gmail/credentials.json')
scope='https://www.googleapis.com/auth/gmail.readonly'
def digest(data): return hashlib.sha256(data).hexdigest()
def command(*args): return subprocess.run(args,check=True,text=True,capture_output=True,timeout=120)
def counts():
    with sqlite3.connect(db) as c:
        return dict(zip(('messages','gmail_messages'),c.execute('SELECT (SELECT count(*) FROM messages),(SELECT count(*) FROM gmail_messages)').fetchone()))
def ready():
    req=urllib.request.Request('http://127.0.0.1:8787/api/gmail',headers={'Host':'archival.example.com'})
    try: urllib.request.urlopen(req,timeout=3); return False
    except urllib.error.HTTPError as e: return e.code==401
    except OSError: return False
if os.geteuid()!=0: raise RuntimeError('VM root access required')
with tarfile.open(fileobj=io.BytesIO(sys.stdin.buffer.read()),mode='r:gz') as bundle:
    members=bundle.getmembers()
    if {m.name for m in members}!={*names,'manifest.json','credentials.json'} or not all(m.isfile() and m.size<2_000_000 for m in members):
        raise RuntimeError('Unexpected Gmail deployment stream')
    data={m.name:bundle.extractfile(m).read() for m in members}
manifest=json.loads(data.pop('manifest.json'))
vault=json.loads(data['credentials.json'])
accounts=vault.get('accounts') or {}
if vault.get('clientType')!='desktop' or len(accounts)!=1 or not vault.get('client',{}).get('client_id'):
    raise RuntimeError('Expected one staged Desktop OAuth mailbox')
account_id,account=next(iter(accounts.items()))
if manifest['account_id']!=account_id or set(account.get('scopes') or ())!={scope} or not account.get('refresh_token'):
    raise RuntimeError('Staged token is not Gmail read-only for the expected mailbox')
if any(digest(data[name])!=manifest['source'][name] for name in names):
    raise RuntimeError('Reviewed source hash mismatch')
for name in names:
    target=root/name
    if target.is_symlink() or (digest(target.read_bytes()) if target.exists() else None)!=manifest['baseline'][name]:
        raise RuntimeError('Production file drifted: '+name)
if credential.exists() or credential.is_symlink():
    raise RuntimeError('VM Gmail credentials already exist; stop to preserve them')
if command('systemctl','is-active','archival.service').stdout.strip()!='active':
    raise RuntimeError('Archival must be active before deployment')
with sqlite3.connect(db) as c:
    if not c.execute('SELECT 1 FROM gmail_accounts WHERE id=?',(account_id,)).fetchone():
        raise RuntimeError('Staged mailbox does not match archived Gmail account')
    if c.execute("SELECT count(*) FROM chat_outgoing WHERE status='sending'").fetchone()[0]:
        raise RuntimeError('A personal message is being sent; retry later')
stamp=time.strftime('%Y%m%dT%H%M%SZ',time.gmtime())
backup=Path('/var/backups/archival')/('misty-gmail-desktop-before-'+stamp)
backup.mkdir(mode=0o700)
print('Baseline checked; stopping only archival.service for backup and install.',flush=True)
installed=[]
with tempfile.TemporaryDirectory(prefix='misty-gmail-desktop-') as td:
    stage=Path(td)
    for name in names:
        p=stage/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(data[name])
        if name.endswith(('.mjs','.js')):command(str(root/'bin/node'),'--check',str(p))
    command('systemctl','stop','archival.service')
    try:
        with sqlite3.connect(db) as c:
            if c.execute("SELECT count(*) FROM chat_outgoing WHERE status='sending'").fetchone()[0]:
                raise RuntimeError('A personal send was active at shutdown; retry later')
        before=counts()
        with sqlite3.connect(db) as source, sqlite3.connect(backup/'archive.sqlite') as saved:
            source.backup(saved,pages=256)
            if saved.execute('PRAGMA quick_check').fetchone()[0]!='ok':
                raise RuntimeError('Archive backup failed integrity check')
        for name in names:
            target=root/name;saved=backup/name;saved.parent.mkdir(parents=True,exist_ok=True)
            if target.exists():shutil.copy2(target,saved)
            pending=target.with_name(target.name+'.gmail-desktop-new')
            pending.write_bytes(data[name])
            if target.exists():
                st=target.stat();os.chown(pending,st.st_uid,st.st_gid);pending.chmod(st.st_mode&0o777)
            else:pending.chmod(0o644)
            os.replace(pending,target);installed.append(name)
        identity=pwd.getpwnam('archival')
        credential.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
        credential.parent.chmod(0o700)
        os.chown(credential.parent,identity.pw_uid,identity.pw_gid)
        pending=credential.with_name('credentials.json.gmail-desktop-new')
        fd=os.open(pending,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        try:
            with os.fdopen(fd,'wb') as output:output.write(data['credentials.json'])
        except Exception:
            pending.unlink(missing_ok=True);raise
        os.chown(pending,identity.pw_uid,identity.pw_gid)
        os.replace(pending,credential)
        command('systemctl','start','archival.service')
        for attempt in range(360):
            if ready():break
            if attempt in (29,59,119,179,239,299):print('Waiting for Archival startup ('+str(attempt+1)+'s).',flush=True)
            time.sleep(1)
        else:raise RuntimeError('Archival did not become ready with owner access enforced')
        after=counts()
        if any(after[k]<before[k] for k in before):raise RuntimeError('Archive counts decreased')
        if any(digest((root/name).read_bytes())!=manifest['source'][name] for name in names):
            raise RuntimeError('Deployed hash mismatch')
    except Exception:
        credential.unlink(missing_ok=True)
        for name in reversed(installed):
            target=root/name;saved=backup/name
            if saved.exists():shutil.copy2(saved,target)
            else:target.unlink(missing_ok=True)
        subprocess.run(('systemctl','start','archival.service'),check=False)
        raise
receipt={'at':stamp,'backup':str(backup),'before':before,'after':after,
         'files':{name:digest((root/name).read_bytes()) for name in names},
         'gmail_account_id':account_id,'service':command('systemctl','is-active','archival.service').stdout.strip()}
(backup/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt))
'''


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    vault_bytes = STAGED.read_bytes()
    vault = json.loads(vault_bytes)
    accounts = vault.get('accounts') or {}
    if vault.get('clientType') != 'desktop' or len(accounts) != 1:
        raise RuntimeError('A single staged Desktop Gmail authorization is required.')
    account_id, account = next(iter(accounts.items()))
    if set(account.get('scopes') or ()) != {SCOPE} or not account.get('refresh_token'):
        raise RuntimeError('The staged Gmail token is not read-only.')
    files = {name: (ROOT / name).read_bytes() for name in SOURCES}
    manifest = {'source': {name: digest(data) for name, data in files.items()},
                'baseline': BASELINE, 'account_id': account_id}
    bundle = io.BytesIO()
    with tarfile.open(fileobj=bundle, mode='w:gz') as archive:
        for name, data in {**files, 'credentials.json': vault_bytes,
                           'manifest.json': json.dumps(manifest).encode()}.items():
            entry = tarfile.TarInfo(name)
            entry.size = len(data)
            entry.mode = 0o600 if name == 'credentials.json' else 0o644
            archive.addfile(entry, io.BytesIO(data))
    loader = 'import base64;exec(base64.b64decode("' + base64.b64encode(REMOTE.encode()).decode() + '"))'
    command = 'sudo -n python3 -c ' + shlex.quote(loader)
    try:
        result = subprocess.run(['ssh.exe', '-F', str(SSH_CONFIG), '-o', 'ConnectTimeout=30',
                                 'archival-vm', command], input=bundle.getvalue(),
                                capture_output=True, timeout=900)
    except subprocess.TimeoutExpired as error:
        raise RuntimeError('VM SSH deployment exceeded fifteen minutes; audit production before retrying.') from None
    if result.stdout:
        print(result.stdout.decode(errors='replace'), end='')
    if result.stderr:
        print(result.stderr.decode(errors='replace'), end='', file=__import__('sys').stderr)
    if result.returncode:
        raise RuntimeError(f'VM SSH deployment failed with exit code {result.returncode}.')


if __name__ == '__main__':
    main()
