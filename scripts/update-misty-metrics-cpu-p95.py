"""Rolling seven-day CPU percentile; metrics-only update, no bot/model changes."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import time
import urllib.request

STAGE = Path('/tmp/archival-migration/misty-metrics-cpu-p95')
ROOT = Path('/opt/misty-metrics')
STATE = Path('/var/lib/misty-metrics')
FILES = ['collect.py', 'test_metrics.py', 'public/dashboard.js', 'public/style.css', 'public/index.html']
EXPECTED = {
    'collect.py': '3e8fda02893cc33f1c40b88d16a45b0c96ebfd2037684753afd08ed460d820ea',
    'test_metrics.py': '74b0a4c49758d8dc4198d207f7da0cfa5010f990b429c01b6f66e7880d08271c',
    'public/dashboard.js': '602360a1ab1dbafb35013850cdef3ea0b314eb32cdc3f572a500a881008202f1',
    'public/style.css': '3bfa2d2234781c4fe896cbd48e43465ffdb69b921a116d39ff90e83b385973c4',
    'public/index.html': '10797f1cb7eaf3f40f11b1289388e01e8e0619c6c37690d100ab3c170c21d9ff',
}


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def run(*args):
    return subprocess.check_output(args, text=True).strip()


assert all(digest(ROOT / name) == expected for name, expected in EXPECTED.items()), 'Live metrics changed; merge first'
assert 'Ran 15 tests' in (STAGE / 'tests.txt').read_text() and '\nOK' in (STAGE / 'tests.txt').read_text()
protected_paths = ['/opt/misty-metrics/server.py', '/opt/misty-metrics/resources.py',
                   '/opt/misty-prominence/agent.py', '/opt/misty-prominence/usage_metrics.py',
                   '/opt/misty-prominence/initiative.py', '/opt/misty-prominence/laptop_activity.py',
                   '/opt/misty-prominence/misty_context.py', '/etc/misty-prominence/config.json',
                   '/opt/apollo-bot/app/apollo.mjs', '/opt/apollo-bot/app/apollo-inbox.mjs']
protected = {p: digest(p) for p in protected_paths}
backup = Path('/var/backups/misty') / ('metrics-cpu-p95-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
backup.mkdir(mode=0o700)
timer_active = subprocess.run(['systemctl', 'is-active', '--quiet', 'misty-metrics-collect.timer']).returncode == 0
run('systemctl', 'stop', 'misty-metrics-collect.timer')
try:
    # Let the current read-only refresh finish; never race its ledger transaction.
    for _ in range(50):
        if run('systemctl', 'show', '-p', 'ActiveState', '--value', 'misty-metrics-collect.service') not in ('active', 'activating', 'deactivating', 'reloading'):
            break
        time.sleep(1)
    else:
        raise RuntimeError('Collector still active; no source replaced')
    for name in FILES:
        dest = backup / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / name, dest)
    with sqlite3.connect('file:' + str(STATE / 'metrics.sqlite') + '?mode=ro', uri=True) as src:
        with sqlite3.connect(backup / 'metrics.sqlite') as dest:
            src.backup(dest)
        ledger_before = src.execute('SELECT count(*),sum(cost) FROM usage').fetchone()
        cursor_before = dict(src.execute('SELECT id,value FROM cursor'))
    shutil.copy2(STATE / 'public/metrics.json', backup / 'metrics.json')
    (backup / 'before.json').write_text(json.dumps({'hashes': EXPECTED, 'protected': protected,
                                                   'timerActive': timer_active, 'ledger': ledger_before}, indent=2))
    # Publish backend before new markup; static assets are read per request, no server restart needed.
    for name in FILES:
        pending = ROOT / (name + '.cpu-p95-candidate')
        shutil.copy2(STAGE / 'candidate/metrics' / name, pending)
        pending.chmod(0o644)
        pending.replace(ROOT / name)
    run('systemctl', 'start', 'misty-metrics-collect.service')
finally:
    if timer_active:
        run('systemctl', 'start', 'misty-metrics-collect.timer')

with urllib.request.urlopen('http://127.0.0.1:8793/metrics.json', timeout=5) as response:
    live = json.load(response)
tasks, usage = live['usage']['tasks'], live['usage']
assert abs(sum(t['estimatedUsd'] or 0 for t in tasks) - usage['estimatedUsd']) < 1e-8
assert sum(t['records'] for t in tasks) == usage['records']
assert sum(t['unpricedRecords'] for t in tasks) == usage['unpricedRecords']
assert abs(sum(t['shareOfPricedCostPercent'] or 0 for t in tasks) - 100) < 1e-8
assert all(digest(p) == h for p, h in protected.items())
with sqlite3.connect('file:' + str(STATE / 'metrics.sqlite') + '?mode=ro', uri=True) as db:
    assert db.execute('PRAGMA quick_check').fetchone()[0] == 'ok'
    # Usage/cursors are never reset or rewritten by task grouping. New records may arrive normally.
    db.execute('ATTACH DATABASE ? AS before', (str(backup / 'metrics.sqlite'),))
    assert db.execute('SELECT count(*) FROM (SELECT * FROM before.usage EXCEPT SELECT * FROM main.usage)').fetchone()[0] == 0
    assert db.execute('SELECT count(*) FROM (SELECT * FROM before.samples EXCEPT SELECT * FROM main.samples)').fetchone()[0] == 0
    stamp = live['updatedAt']
    samples = db.execute('SELECT at,cpu FROM samples WHERE at>=? AND at<=? AND cpu BETWEEN 0 AND 100', (stamp-7*86400000,stamp)).fetchall()
    ordered = sorted(value for at,value in samples)
    import math
    expected_p95 = ordered[math.ceil(.95*len(ordered))-1] if ordered else None
    assert live['cpuSevenDays']['p95Percent'] == expected_p95
    assert live['cpuSevenDays']['sampleCount'] == len(samples)
    cursors = dict(db.execute('SELECT id,value FROM cursor'))
    for key, old in cursor_before.items():
        if key.startswith('db:'):
            assert json.loads(cursors[key]) >= json.loads(old)
services = {s: run('systemctl', 'is-active', s) for s in ['misty-metrics', 'misty-metrics-collect.timer',
            'misty-prominence', 'apollo-bot', 'misty-bot', 'archival', 'misty-activity', 'cloudflared']}
assert set(services.values()) == {'active'}
report = {'deployedAt': datetime.now(timezone.utc).isoformat(), 'backup': str(backup),
          'hashes': {str(ROOT / name): digest(ROOT / name) for name in FILES},
          'protectedUnchanged': True, 'services': services, 'botOrDashboardRestarts': 0,
          'oldUsageRowsUnchanged': True, 'cursorResets': 0,
          'taskTotalsMatchOverall': True, 'cpuSevenDays': live['cpuSevenDays'], 'oldCpuSamplesUnchanged': True, 'records': usage['records'],
          'tests': {'passed': 15, 'failed': 0},
          'rollback': 'Restore only backed-up metrics source files, run misty-metrics-collect.service; keep live metrics.sqlite and cursors. No bot restart needed.'}
(STAGE / 'deployment.json').write_text(json.dumps(report, indent=2))
subprocess.run(['logger', '-t', 'misty-metrics', 'Added rolling seven-day CPU p95; source/storage backup: ' + str(backup)], check=True)
(STAGE / 'preview.json').write_text(json.dumps(live, indent=2))
for name in ['deployment.json', 'tests.txt', 'preview.json']:
    dest = Path('/tmp/archival-migration/misty-metrics-cpu-p95-' + name)
    shutil.copy2(STAGE / name, dest)
    dest.chmod(0o644)
print(json.dumps(report, indent=2))
