"""Install the reviewed UI bundle without changing data, credentials or service settings."""
import hashlib
import json
import os
import pathlib
import shutil
import sqlite3
import subprocess
import tarfile
import time
import urllib.error
import urllib.request

root=pathlib.Path('/opt/archival').resolve()
bundle=pathlib.Path('/tmp/archival-migration/misty-ui.tar.gz')
allowed={f'app/public/{name}' for name in ['index.html','app.js','style.css','misty.css','misty.js','briefings.js','chat.js','gmail.js']}
allowed.update(['app/server.mjs','app/store.mjs','app/person-profile.mjs'])
backup=pathlib.Path('/var/lib/archival')/time.strftime('ui-before-misty-%Y%m%dT%H%M%SZ',time.gmtime())
backup.mkdir(mode=0o700)
with sqlite3.connect('file:/var/lib/archival/data/archive.sqlite?mode=ro',uri=True) as db:
    before={table:db.execute('SELECT count(*) FROM '+table).fetchone()[0] for table in ['messages','chat_briefings','briefing_history_nodes']}
    # Original immutable checkpoint hashes make post-restart preservation reviewable.
    checkpoints={room+'|'+key:hashlib.sha256(payload.encode()).hexdigest() for room,key,payload in db.execute('SELECT room_id,hash,payload FROM briefing_history_nodes')}
(backup/'archive-counts.json').write_text(json.dumps(before))
(backup/'checkpoint-hashes.json').write_text(json.dumps(checkpoints))
with tarfile.open(bundle,'r:gz') as archive:
    members=archive.getmembers()
    if {member.name for member in members}!=allowed or any(not m.isfile() for m in members):
        raise SystemExit('Unexpected bundle entries')
    for member in members:
        target=(root/member.name).resolve()
        if root not in target.parents:
            raise SystemExit('Target outside application root')
        if target.exists():
            old=backup/member.name
            old.parent.mkdir(parents=True,exist_ok=True)
            shutil.copy2(target,old)
        content=archive.extractfile(member).read()
        staging=target.with_name(target.name+'.misty-new')
        staging.write_bytes(content)
        staging.chmod(0o644)
        shutil.chown(staging,user='archival',group='archival')
        os.replace(staging,target)
print('Previous code saved:',str(backup),flush=True)
print('Existing archive counts:',json.dumps(before),flush=True)
subprocess.run(['systemctl','restart','archival'],check=True,timeout=30)
for attempt in range(55):
    try:
        request=urllib.request.Request('http://127.0.0.1:8787/',headers={'Host':'archival.example.com'})
        urllib.request.urlopen(request,timeout=3)
    except urllib.error.HTTPError as error:
        if error.code==401:
            print('Misty origin ready; unauthenticated access rejected.',flush=True)
            break
    except (OSError,TimeoutError):
        pass
    time.sleep(2)
else:
    raise SystemExit('Origin did not become ready; previous code is available in backup.')
with sqlite3.connect('file:/var/lib/archival/data/archive.sqlite?mode=ro',uri=True) as db:
    after={table:db.execute('SELECT count(*) FROM '+table).fetchone()[0] for table in before}
    current={room+'|'+key:hashlib.sha256(payload.encode()).hexdigest() for room,key,payload in db.execute('SELECT room_id,hash,payload FROM briefing_history_nodes')}
    retained=sum(current.get(key)==value for key,value in checkpoints.items())
    print('Archive counts after restart:',json.dumps(after),flush=True)
    print('Original checkpoint payloads preserved:',retained,'/',len(checkpoints),flush=True)
    if retained!=len(checkpoints):
        raise SystemExit('Checkpoint preservation check needs review')
print('Misty UI deployment complete.',flush=True)
