"""Add verified Luna rate and fill missing saved costs; no model/API calls or bot changes."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import time
import urllib.request

STAGE = Path('/tmp/archival-migration/misty-metrics-luna')
ROOT = Path('/opt/misty-metrics')
STATE = Path('/var/lib/misty-metrics')
FILES = ['collect.py', 'test_metrics.py', 'public/index.html']
EXPECTED = {
    'collect.py': 'f096fcbe09fdac5f6f2109c4e7c964cbbfa6e3d32d15117b9394235043e70adc',
    'test_metrics.py': 'e0eedd3af76a6ca9d33228a9bec43b15f53fc73fb0917135131fb3863b1bf038',
    'public/index.html': '7142a8eb2e0a1e55c897ee9511c64925493103f1c969f4975f7f2eaffae6d6cc',
}


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def run(*args):
    return subprocess.check_output(args, text=True).strip()


assert all(digest(ROOT / name) == expected for name, expected in EXPECTED.items()), 'Live metrics changed; merge first'
assert 'Ran 13 tests' in (STAGE / 'tests.txt').read_text() and '\nOK' in (STAGE / 'tests.txt').read_text()
protected_paths = ['/opt/misty-metrics/server.py', '/opt/misty-metrics/resources.py',
                   '/opt/misty-prominence/agent.py', '/opt/misty-prominence/usage_metrics.py',
                   '/opt/misty-prominence/initiative.py', '/opt/misty-prominence/laptop_activity.py',
                   '/opt/misty-prominence/misty_context.py', '/etc/misty-prominence/config.json',
                   '/opt/apollo-bot/app/apollo.mjs', '/opt/apollo-bot/app/apollo-inbox.mjs']
protected = {p: digest(p) for p in protected_paths}
backup = Path('/var/backups/misty') / ('metrics-luna-rate-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
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
        pending = ROOT / (name + '.task-candidate')
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
    # Every old non-price field remains byte-for-byte the same; only missing Luna prices may change.
    columns='id,source,model,at,input,cached,write,output'
    assert db.execute('SELECT count(*) FROM (SELECT '+columns+' FROM before.usage EXCEPT SELECT '+columns+' FROM main.usage)').fetchone()[0] == 0
    changed=db.execute('SELECT old.model,old.source,old.cost,new.cost FROM before.usage old JOIN main.usage new ON old.id=new.id WHERE old.cost IS NOT new.cost').fetchall()
    assert all(model=='gpt-6-luna' and source in ('analysis','misty','apollo') and old is None and new is not None for model,source,old,new in changed)
    luna=db.execute("SELECT count(*),sum(cost),sum(cost IS NULL) FROM usage WHERE model='gpt-6-luna'").fetchone()
    assert luna[0]>0 and luna[1]>0 and luna[2]==0
    old_changed_count=len(changed)
    recovered_cost=sum(row[3] for row in changed)
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
          'oldCountersUnchanged': True, 'cursorResets': 0, 'savedRecordsPriced': old_changed_count,
          'recoveredEstimatedUsd': recovered_cost, 'lunaRecords': luna[0], 'lunaEstimatedUsd': luna[1], 'lunaUnpriced': luna[2],
          'taskTotalsMatchOverall': True, 'rateSource': 'https://developers.openai.com/api/docs/models/gpt-6-luna',
          'lunaRatesPerMillion': {'input': .10, 'cached': .01, 'write': .125, 'output': .50}, 'tasks': tasks, 'records': usage['records'],
          'tests': {'passed': 13, 'failed': 0},
          'rollback': 'Restore source only and rerun collector; retain the live ledger/cursors. For targeted price rollback, join the recovery backup by id and revert only the originally NULL Luna costs after pausing the timer; never restore the whole live ledger.'}
(STAGE / 'deployment.json').write_text(json.dumps(report, indent=2))
subprocess.run(['logger', '-t', 'misty-metrics', 'Added verified GPT-6 Luna rate and filled missing saved price estimates; source/storage backup: ' + str(backup)], check=True)
for name in ['deployment.json', 'tests.txt']:
    dest = Path('/tmp/archival-migration/misty-metrics-luna-' + name)
    shutil.copy2(STAGE / name, dest)
    dest.chmod(0o644)
print(json.dumps(report, indent=2))
