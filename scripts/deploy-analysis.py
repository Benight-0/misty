"""Stage or install the bounded analysis optimization; never print credentials or chat text."""
import hashlib
import json
import os
import pathlib
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request

root=pathlib.Path('/opt/archival')
candidate=pathlib.Path('/tmp/archival-migration/analysis-candidate')
bundle=pathlib.Path('/tmp/archival-migration/analysis-optimization.tar.gz')
allowed={'app/'+name for name in ['briefing-history.mjs','briefings.mjs','briefing-store.mjs','openai-analysis.mjs','vm-server.mjs','vm-analysis-worker.mjs','store.mjs','native-runtime.mjs']}
if sys.argv[1:] == ['stage']:
    candidate.mkdir(mode=0o755,exist_ok=True)
    shutil.copytree(root/'app',candidate/'app',dirs_exist_ok=True)
    with tarfile.open(bundle,'r:gz') as archive:
        members=archive.getmembers()
        if {m.name for m in members}!=allowed or any(not m.isfile() for m in members):
            raise SystemExit('Unexpected bundle entries')
        for m in members:
            target=candidate/m.name
            target.write_bytes(archive.extractfile(m).read())
            target.chmod(0o644)
            subprocess.run(['/opt/archival/bin/node','--check',str(target)],check=True)
    print('Candidate staged and syntax checked:',candidate,flush=True)
    raise SystemExit(0)
if sys.argv[1:] != ['install']:
    raise SystemExit('Usage: deploy-analysis.py stage|install')
for name in allowed:
    if not (candidate/name).is_file():raise SystemExit('Stage candidate first')
backup=pathlib.Path('/var/lib/archival')/time.strftime('analysis-before-optimization-%Y%m%dT%H%M%SZ',time.gmtime())
backup.mkdir(mode=0o700)
subprocess.run(['systemctl','stop','archival'],check=True,timeout=35)
try:
    with sqlite3.connect('file:/var/lib/archival/data/archive.sqlite?mode=ro',uri=True) as db:
        before={t:db.execute('SELECT count(*) FROM '+t).fetchone()[0] for t in ['messages','chat_briefings','briefing_history_nodes']}
        saved={(room,key):hashlib.sha256(payload.encode()).hexdigest() for room,key,payload in db.execute('SELECT room_id,hash,payload FROM briefing_history_nodes')}
        summaries={room:hashlib.sha256(payload.encode()).hexdigest() for room,payload in db.execute('SELECT room_id,payload FROM chat_briefings')}
        destination=sqlite3.connect(backup/'archive.sqlite')
        try:db.backup(destination)
        finally:destination.close()
    shutil.copy2('/etc/archival/runtime.env',backup/'runtime.env')
    for name in allowed:
        target=root/name
        if target.exists():
            previous=backup/name;previous.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(target,previous)
        temp=target.with_suffix(target.suffix+'.analysis-new')
        shutil.copyfile(candidate/name,temp);temp.chmod(0o644);shutil.chown(temp,user='archival',group='archival');os.replace(temp,target)
    env=pathlib.Path('/etc/archival/runtime.env')
    lines=[line for line in env.read_text().splitlines() if not line.startswith('ARCHIVAL_ANALYSIS_CONCURRENCY=')]
    env.write_text('\n'.join(lines+['ARCHIVAL_ANALYSIS_CONCURRENCY=3'])+'\n');env.chmod(0o640);shutil.chown(env,user='root',group='archival')
    with sqlite3.connect('file:/var/lib/archival/data/archive.sqlite?mode=ro',uri=True) as db:
        current={(room,key):hashlib.sha256(payload.encode()).hexdigest() for room,key,payload in db.execute('SELECT room_id,hash,payload FROM briefing_history_nodes')}
        published={room:hashlib.sha256(payload.encode()).hexdigest() for room,payload in db.execute('SELECT room_id,payload FROM chat_briefings')}
    assert saved==current and summaries==published,'Saved analyses changed during installation'
    print('Before restart:',json.dumps(before),'All saved output payloads unchanged.',flush=True)
except BaseException:
    for name in allowed:
        if (backup/name).exists():shutil.copy2(backup/name,root/name)
    if (backup/'runtime.env').exists():shutil.copy2(backup/'runtime.env','/etc/archival/runtime.env')
    subprocess.run(['systemctl','start','archival'],check=False,timeout=30)
    raise
subprocess.run(['systemctl','start','archival'],check=True,timeout=30)
for attempt in range(40):
    try:
        request=urllib.request.Request('http://127.0.0.1:8787/',headers={'Host':'archival.example.com'})
        urllib.request.urlopen(request,timeout=3)
    except urllib.error.HTTPError as error:
        if error.code==401:break
    except (OSError,TimeoutError):pass
    time.sleep(1)
else:raise SystemExit('Origin not ready; rollback code and SQLite snapshot: '+str(backup))
with sqlite3.connect('file:/var/lib/archival/data/archive.sqlite?mode=ro',uri=True) as db:
    current={(room,key):hashlib.sha256(payload.encode()).hexdigest() for room,key,payload in db.execute('SELECT room_id,hash,payload FROM briefing_history_nodes')}
    retained=sum(current.get(k)==v for k,v in saved.items())
    print('Original checkpoint payloads retained:',retained,'/',len(saved),flush=True)
    if retained!=len(saved):raise SystemExit('Checkpoint retention requires review')
print('Optimization installed; rollback and database snapshot:',backup,flush=True)
