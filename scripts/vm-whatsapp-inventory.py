"""Deploy the metadata-only joined-group query without changing runtime settings."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import time

STAGE = Path('/tmp/archival-migration')
FILES = {
    'main.go': (Path('/opt/archival/collector-src/main.go'), ('2f046b91c441180c3c6b717e3338479083bdae443234ab496353494a5f6f76ad', '457ba3a0ea57af05eb598d10970e9b6272677bd275cd61a9387de8a82bb2416c')),
    'native-ingest.mjs': (Path('/opt/archival/app/native-ingest.mjs'), ('3fb704f45ed5f5b1c4812a37c36078243a1d45dfed47290b9877faa765290cb4', 'e47da060ced7768f15fb87a7eb3de84b2ae3114eaf9fb7ddb9f18975681cb327')),
}
BINARY = Path('/opt/archival/bin/archival-collector')

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def check_baseline():
    for path, expected in FILES.values():
        if digest(path) not in expected:
            raise RuntimeError('Deployment stopped: live file changed: ' + str(path))

def snapshot():
    with sqlite3.connect('file:/var/lib/archival/data/archive.sqlite?mode=ro', uri=True, timeout=10) as db:
        settings = dict(db.execute("SELECT key,value FROM settings WHERE key IN ('whatsapp_group_inventory','whatsapp_group_inventory_error','native_discord','native_whatsapp','native_collector_error')"))
        flags = {row[0]: list(row[1:]) for row in db.execute('SELECT id,connected,tracked,followed,include_profile FROM conversations')}
        return {
            'settings': {key: json.loads(value) for key, value in settings.items()},
            'flags': flags,
            'messages': db.execute('SELECT count(*) FROM messages').fetchone()[0],
            'analysis_nodes': db.execute('SELECT count(*) FROM briefing_history_nodes').fetchone()[0],
            'runtime_hash': digest(Path('/etc/archival/runtime.env')),
        }

mode = sys.argv[1]
if mode == 'build':
    check_baseline()
    build = STAGE / 'whatsapp-inventory-build'
    build.mkdir(exist_ok=True)
    for name in ('go.mod', 'go.sum'):
        shutil.copy2(Path('/opt/archival/collector-src') / name, build / name)
    shutil.copy2(STAGE / 'inventory-main.go', build / 'main.go')
    env = dict(os.environ, PATH='/opt/archival/build/go/bin:' + os.environ['PATH'], GOMAXPROCS='1', GOFLAGS='-p=1', GOMEMLIMIT='350MiB', GOCACHE='/home/ubuntu/.cache/go-build', GOMODCACHE='/home/ubuntu/go/pkg/mod')
    subprocess.run(['go', 'build', '-trimpath', '-ldflags=-s', '-o', str(STAGE / 'collector-with-inventory'), '.'], cwd=build, env=env, check=True)
    print('Collector build passed.', flush=True)
elif mode == 'install':
    check_baseline()
    backup = Path('/var/lib/archival/group-inventory-before-' + time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()))
    backup.mkdir(mode=0o700)
    subprocess.run(['systemctl', 'stop', 'archival'], check=True, timeout=40)
    before = snapshot()
    (backup / 'before.json').write_text(json.dumps(before))
    targets = [(BINARY, STAGE / 'collector-with-inventory', 'collector', 0o755)]
    targets += [(path, STAGE / ('inventory-' + name), name, 0o644) for name, (path, _) in FILES.items()]
    for dest, source, name, permissions in targets:
        shutil.copy2(dest, backup / name)
    try:
        for dest, source, name, permissions in targets:
            candidate = dest.with_name(dest.name + '.inventory-new')
            shutil.copyfile(source, candidate)
            candidate.chmod(permissions)
            candidate.replace(dest)
        subprocess.run(['systemctl', 'start', 'archival'], check=True, timeout=40)
    except BaseException:
        for dest, source, name, permissions in targets:
            shutil.copy2(backup / name, dest)
        subprocess.run(['systemctl', 'start', 'archival'], timeout=40)
        raise
    after = snapshot()
    assert before['flags'] == after['flags'], 'Conversation flags changed unexpectedly'
    assert before['runtime_hash'] == after['runtime_hash'], 'Runtime settings changed unexpectedly'
    print(json.dumps({'backup': str(backup), 'flags_preserved': True, 'runtime_preserved': True, 'messages': after['messages'], 'analysis_nodes': after['analysis_nodes']}), flush=True)
elif mode in ('report', 'export'):
    data = snapshot()
    data.pop('flags')
    data.pop('runtime_hash')
    if mode == 'export':
        inventory = data['settings'].get('whatsapp_group_inventory')
        if not inventory:
            raise RuntimeError('No successful membership snapshot yet')
        output = STAGE / 'whatsapp-current-memberships.json'
        output.write_text(json.dumps(inventory, ensure_ascii=False, indent=2))
        output.chmod(0o600)
        shutil.chown(output, user='ubuntu', group='ubuntu')
        groups = inventory['groups']
        data['settings']['whatsapp_group_inventory'] = {
            'at': inventory['at'], 'entries': len(groups),
            'communities': sum(g['community'] for g in groups),
            'unnamed': sum(not g['name'] for g in groups),
        }
    print(json.dumps(data, ensure_ascii=False))
else:
    raise SystemExit('Expected build, install or report')
