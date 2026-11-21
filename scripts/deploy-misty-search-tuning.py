"""Deploy only Misty's FTS result-formatting improvement to the VM."""
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
FILES = ('context.py', 'test_context_search.py')
BASELINE = '7e2e422111132285945b91e29282552783faf3589ea4f2593904283dd870fbac'

REMOTE = r'''
import hashlib,io,json,os,shutil,sqlite3,subprocess,sys,tarfile,tempfile,time
from pathlib import Path
ROOT=Path('/opt/misty-prominence');DB=Path('/var/lib/misty-prominence/context.db')
BASELINE='7e2e422111132285945b91e29282552783faf3589ea4f2593904283dd870fbac'
def sha(data):return hashlib.sha256(data).hexdigest()
def run(*args,**kwargs):
 return subprocess.run(args,check=True,text=True,capture_output=True,timeout=kwargs.get('timeout',120),env=kwargs.get('env'),cwd=kwargs.get('cwd'))
if os.geteuid()!=0:raise RuntimeError('Root VM maintenance access required')
with tarfile.open(fileobj=io.BytesIO(sys.stdin.buffer.read()),mode='r:gz') as archive:
 members=archive.getmembers()
 if {m.name for m in members}!={'context.py','test_context_search.py','manifest.json'}:raise RuntimeError('Unexpected bundle scope')
 data={m.name:archive.extractfile(m).read() for m in members if m.isfile() and m.size<2_000_000}
 if len(data)!=3:raise RuntimeError('Invalid bundle')
manifest=json.loads(data.pop('manifest.json'))
if any(sha(data[name])!=manifest[name] for name in data):raise RuntimeError('Bundle hash mismatch')
target=ROOT/'context.py'
if target.is_symlink() or sha(target.read_bytes())!=BASELINE:raise RuntimeError('Production context source drift')
with sqlite3.connect('file:'+str(DB)+'?mode=ro',uri=True) as con:
 before=con.execute('SELECT count(*) FROM item').fetchone()[0]
with tempfile.TemporaryDirectory(prefix='misty-search-tuning-') as temp:
 stage=Path(temp)
 for name,content in data.items():(stage/name).write_bytes(content)
 run('python3','-m','py_compile',str(stage/'context.py'),str(stage/'test_context_search.py'))
 env={**os.environ,'PROMINENCE_OWNER_ID':'100000000000000005','PYTHONPATH':str(stage)+':'+str(ROOT)}
 env.pop('PROMINENCE_CONFIG',None)
 run('python3','-m','unittest','-q','test_context_search',env=env,cwd=str(stage))
 stamp=time.strftime('%Y%m%dT%H%M%SZ',time.gmtime())
 snapshot=run('runuser','-u','misty-bot','--','env','PROMINENCE_CONFIG=/etc/misty-prominence/config.json',
              str(ROOT/'venv/bin/python'),str(ROOT/'selfupdate.py'),'snapshot','FTS snippet tuning').stdout.strip()
 backup=Path('/var/backups/misty')/('search-tuning-before-'+stamp)
 backup.mkdir(parents=True,mode=0o700)
 shutil.copy2(target,backup/'context.py')
 if sha(target.read_bytes())!=BASELINE:raise RuntimeError('Source drift during install')
 stat=target.stat();pending=target.with_name('context.py.search-new')
 try:
  pending.write_bytes(data['context.py']);os.chown(pending,stat.st_uid,stat.st_gid);pending.chmod(stat.st_mode&0o777)
  os.replace(pending,target)
  if sha(target.read_bytes())!=manifest['context.py']:raise RuntimeError('Installed hash mismatch')
  with sqlite3.connect('file:'+str(DB)+'?mode=ro',uri=True) as con:
   after=con.execute('SELECT count(*) FROM item').fetchone()[0]
  if after<before:raise RuntimeError('Context item count decreased')
  check=run('runuser','-u','misty-bot','--','env','PROMINENCE_CONFIG=/etc/misty-prominence/config.json',
            str(ROOT/'venv/bin/python'),str(ROOT/'selfupdate.py'),'check').stdout.strip()
  if check!='ok':raise RuntimeError('Self-update check failed')
  probe='import context,time,statistics,json; out={}; qs=("deadline","interview","Misty","Princeton deadline"); '+\
        '\nfor q in qs:\n samples=[]\n for _ in range(9):\n  t=time.perf_counter(); rows=context.search(q,8); samples.append((time.perf_counter()-t)*1000)\n out[q]={"medianMs":round(statistics.median(samples),2),"results":len(rows)}\nprint(json.dumps(out))'
  search=json.loads(run('runuser','-u','misty-bot','--','env','PROMINENCE_CONFIG=/etc/misty-prominence/config.json',
                        str(ROOT/'venv/bin/python'),'-c',probe,cwd=str(ROOT)).stdout)
 except Exception:
  shutil.copy2(backup/'context.py',target)
  pending.unlink(missing_ok=True)
  raise
 receipt={'at':stamp,'backup':str(backup),'snapshot':snapshot,'beforeItems':before,'afterItems':after,
          'sourceHash':sha(target.read_bytes()),'search':search,'service':run('systemctl','is-active','misty-prominence.service').stdout.strip()}
 (backup/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
 print(json.dumps(receipt),flush=True)
'''


def main():
    data = {name: (ROOT / 'prominence' / name).read_bytes() for name in FILES}
    manifest = {name: hashlib.sha256(content).hexdigest() for name, content in data.items()}
    bundle = io.BytesIO()
    with tarfile.open(fileobj=bundle, mode='w:gz') as archive:
        for name, content in {**data, 'manifest.json': json.dumps(manifest).encode()}.items():
            entry = tarfile.TarInfo(name)
            entry.size = len(content)
            archive.addfile(entry, io.BytesIO(content))
    loader = 'import base64;exec(base64.b64decode("' + __import__('base64').b64encode(REMOTE.encode()).decode() + '"))'
    command = 'sudo -n python3 -c ' + shlex.quote(loader)
    result = subprocess.run(['ssh.exe', '-T', '-F', str(SSH), '-o', 'BatchMode=yes',
                             '-o', 'ConnectTimeout=30', 'archival-vm', command],
                            input=bundle.getvalue(), capture_output=True, timeout=600)
    if result.stdout:
        print(result.stdout.decode(errors='replace'), end='')
    if result.stderr:
        print(result.stderr.decode(errors='replace'), end='', file=sys.stderr)
    if result.returncode:
        raise RuntimeError(f'VM deployment failed with exit code {result.returncode}')


if __name__ == '__main__':
    main()
