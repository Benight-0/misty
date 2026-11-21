"""Run in Linux with the Discord bridge stopped; preserve an independent backup."""
import json, os, sqlite3
from datetime import datetime, timezone

source = '/data/bridge.db'
target = '/database/bridge.db'
backup = '/out/discord-before-native-' + datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S') + '.sqlite'
if os.path.exists(target):
    raise SystemExit('Destination already exists; refusing to overwrite it')
with sqlite3.connect('file:' + source + '?mode=ro', uri=True) as src:
    counts = {t:src.execute('SELECT count(*) FROM ' + t).fetchone()[0] for t in ['user', 'portal', 'message']}
    for path in [backup, target]:
        with sqlite3.connect(path) as dst:
            src.backup(dst)
            assert dst.execute('PRAGMA quick_check').fetchone()[0] == 'ok'
            assert counts == {t:dst.execute('SELECT count(*) FROM ' + t).fetchone()[0] for t in counts}
        os.chmod(path, 0o600)
os.chown('/database', 1337, 1337)
os.chown(target, 1337, 1337)
print(json.dumps({'verified': True, 'counts': counts, 'backup': backup, 'target': target}))
