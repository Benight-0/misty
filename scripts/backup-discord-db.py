"""Linux-only online SQLite backup from /database to the private /out mount."""
import json, os, sqlite3
from datetime import datetime, timezone

target='/out/discord-backup-'+datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')+'.sqlite'
if os.path.exists(target): raise SystemExit('Backup already exists')
with sqlite3.connect('file:/database/bridge.db?mode=ro',uri=True) as src:
    with sqlite3.connect(target) as dst:
        src.backup(dst)
        assert dst.execute('PRAGMA quick_check').fetchone()[0]=='ok'
        counts={t:dst.execute('SELECT count(*) FROM '+t).fetchone()[0] for t in ['user','portal','message']}
os.chmod(target,0o600)
print(json.dumps({'backup':target,'verified':True,'counts':counts}))
