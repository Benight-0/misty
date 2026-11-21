"""Install the tested Discord allowlist upgrade; run on VM as root."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import time

ARCHIVE_FILES=['discord-server-policies.mjs','native-ingest.mjs','native-runtime.mjs','discord-history-store.mjs','misty-server-summaries.mjs','briefing-store.mjs','briefings.mjs','store.mjs']
FILES={**{'app/'+f:'/opt/archival/app/'+f for f in ARCHIVE_FILES},
 'scripts/misty-archive-query.py':'/opt/archival/scripts/misty-archive-query.py',
 'scripts/apply-discord-server-choices.mjs':'/opt/archival/scripts/apply-discord-server-choices.mjs',
 'scripts/seed-discord-server-links.mjs':'/opt/archival/scripts/seed-discord-server-links.mjs',
 'app/misty-notifications.mjs':'/opt/misty-bot/app/misty-notifications.mjs',
 'prominence/misty_context.py':'/opt/misty-prominence/misty_context.py',
 'collector/archival-collector':'/opt/archival/bin/archival-collector',
 **{'collector/'+f:'/opt/archival/collector-src/'+f for f in ['main.go','discord-servers.go','discord-servers_test.go']}}
SERVICES=['archival','misty-bot','misty-prominence']

def main():
    assert os.geteuid()==0
    stage=Path(sys.argv[1]).resolve()
    for relative,target in FILES.items():
        assert (stage/relative).is_file(),relative
        assert not Path(target).is_symlink()
    with sqlite3.connect('file:/var/lib/misty-prominence/inbox.sqlite?mode=ro',uri=True) as db:
        assert not db.execute("SELECT 1 FROM inbox WHERE state IN ('running','delivering') LIMIT 1").fetchone(),'Owner turn in progress; retry later.'
    backup=Path('/var/lib/archival/discord-before-'+time.strftime('%Y%m%dT%H%M%SZ',time.gmtime()));backup.mkdir(mode=0o700)
    subprocess.run(['systemctl','stop',*reversed(SERVICES)],check=True)
    installed=[];started=False
    try:
        for relative,target in FILES.items():
            if Path(target).exists():
                old=backup/relative;old.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(target,old)
        for name,filename in [('archive','/var/lib/archival/data/archive.sqlite'),('bridge','/var/lib/misty-bot/chat.sqlite'),('inbox','/var/lib/misty-prominence/inbox.sqlite')]:
            with sqlite3.connect('file:'+filename+'?mode=ro',uri=True) as source,sqlite3.connect(backup/(name+'.sqlite')) as dest:source.backup(dest)
        (backup/'files.json').write_text(json.dumps(FILES,indent=2))
        for relative,filename in FILES.items():
            target=Path(filename);stat=target.stat() if target.exists() else target.parent.stat();pending=target.with_name(target.name+'.discord-upgrade')
            shutil.copyfile(stage/relative,pending);os.chmod(pending,0o755 if relative.endswith('archival-collector') else 0o644);os.chown(pending,stat.st_uid,stat.st_gid);os.replace(pending,target);installed.append(relative)
        subprocess.run(['/opt/misty-bot/bin/node','/opt/archival/scripts/apply-discord-server-choices.mjs','/var/lib/archival/data/archive.sqlite',str(stage/'discord-server-choices.json'),str(stage/'discord-server-channels.json')],check=True)
        if (stage/'discord-gp-source-links.json').exists():
            subprocess.run(['/opt/misty-bot/bin/node','/opt/archival/scripts/seed-discord-server-links.mjs','/var/lib/archival/data/archive.sqlite',str(stage/'discord-gp-source-links.json')],check=True)
        # Files created by the root migration must remain writable by the service.
        archive=Path('/var/lib/archival/data/archive.sqlite');owner=archive.stat()
        for suffix in ('-wal','-shm'):
            p=Path(str(archive)+suffix)
            if p.exists():os.chown(p,owner.st_uid,owner.st_gid)
        started=True
        subprocess.run(['systemctl','start',*SERVICES],check=True)
        time.sleep(5)
        subprocess.run(['systemctl','is-active',*SERVICES],check=True)
        hashes={r:hashlib.sha256(Path(t).read_bytes()).hexdigest() for r,t in FILES.items()};(backup/'installed.json').write_text(json.dumps(hashes,indent=2))
        print(json.dumps({'backup':str(backup),'installed':len(hashes),'sha256':hashes}))
    except BaseException:
        if not started:
            for relative in installed:
                old=backup/relative;target=Path(FILES[relative])
                if old.exists():shutil.copy2(old,target)
                else:target.unlink(missing_ok=True)
            # No service has resumed since the snapshot; safe archive-only rollback.
            archive=Path('/var/lib/archival/data/archive.sqlite');stat=archive.stat()
            for suffix in ('-wal','-shm'):Path(str(archive)+suffix).unlink(missing_ok=True)
            shutil.copyfile(backup/'archive.sqlite',archive);os.chown(archive,stat.st_uid,stat.st_gid)
            subprocess.run(['systemctl','start',*SERVICES])
        # After services resume, never overwrite live messages or delivery receipts.
        print('Upgrade needs inspection; backup='+str(backup),file=sys.stderr)
        raise

if __name__=='__main__':main()
