"""Targeted VM upgrade. Run as root with a staged tree; preserves live databases."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import time

FILES={
 'app/misty-notifications.mjs':'/opt/misty-bot/app/misty-notifications.mjs',
 'app/misty-prominence-bridge.mjs':'/opt/misty-bot/app/misty-prominence-bridge.mjs',
 'scripts/misty-discord-bot.mjs':'/opt/misty-bot/scripts/misty-discord-bot.mjs',
 'scripts/misty-archive-query.py':'/opt/archival/scripts/misty-archive-query.py',
 'prominence/misty_context.py':'/opt/misty-prominence/misty_context.py',
}

def main():
    assert os.geteuid()==0
    stage=Path(sys.argv[1]).resolve()
    for relative,target in FILES.items():
        assert (stage/relative).is_file() and Path(target).is_file()
        assert not Path(target).is_symlink()
    with sqlite3.connect('file:/var/lib/misty-prominence/inbox.sqlite?mode=ro',uri=True) as db:
        assert not db.execute("SELECT 1 FROM inbox WHERE state IN ('running','delivering') LIMIT 1").fetchone(),'Owner turn in progress; retry after it finishes.'
    backup=Path('/var/lib/misty-bot/notifications-before-'+time.strftime('%Y%m%dT%H%M%SZ',time.gmtime()))
    backup.mkdir(mode=0o700)
    subprocess.run(['systemctl','stop','misty-prominence','misty-bot'],check=True)
    installed=[]
    try:
        for relative,target in FILES.items():
            old=backup/relative;old.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(target,old)
        for name,filename in [('bridge','/var/lib/misty-bot/chat.sqlite'),('fork-inbox','/var/lib/misty-prominence/inbox.sqlite')]:
            with sqlite3.connect('file:'+filename+'?mode=ro',uri=True) as source,sqlite3.connect(backup/(name+'.sqlite')) as dest:source.backup(dest)
        for relative,target in FILES.items():
            target=Path(target);stat=target.stat();pending=target.with_name(target.name+'.notification-upgrade')
            shutil.copyfile(stage/relative,pending);os.chmod(pending,stat.st_mode&0o777);os.chown(pending,stat.st_uid,stat.st_gid);os.replace(pending,target);installed.append(relative)
        subprocess.run(['systemctl','start','misty-bot','misty-prominence'],check=True)
        time.sleep(4)
        subprocess.run(['systemctl','is-active','misty-bot','misty-prominence','archival'],check=True)
        hashes={relative:hashlib.sha256(Path(target).read_bytes()).hexdigest() for relative,target in FILES.items()}
        (backup/'installed.json').write_text(json.dumps(hashes,indent=2))
        print(json.dumps({'backup':str(backup),'sha256':hashes}))
    except BaseException:
        subprocess.run(['systemctl','stop','misty-prominence','misty-bot'])
        for relative in installed:shutil.copy2(backup/relative,FILES[relative])
        subprocess.run(['systemctl','start','misty-bot','misty-prominence'])
        # Never restore old databases over new events/delivery receipts.
        raise

if __name__=='__main__':main()
