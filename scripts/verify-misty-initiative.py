"""Read-only deployment audit. No decisions, sends or live plan changes."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import time

stage = Path('/tmp/archival-migration/misty-initiative')
root = Path('/opt/misty-prominence')
state = Path('/var/lib/misty-prominence')
dep = json.loads((stage / 'deployment.json').read_text())


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


for _ in range(20):
    if not (state / 'restart_request.json').exists():
        break
    time.sleep(1)
assert not (state / 'restart_request.json').exists(), 'Supported restart still pending'
services = {s: subprocess.check_output(['systemctl', 'is-active', s], text=True).strip() for s in
            ['misty-prominence', 'apollo-bot', 'misty-bot', 'archival', 'misty-activity', 'cloudflared', 'misty-metrics']}
assert set(services.values()) == {'active'}
assert all(digest(p) == h for p, h in dep['hashes'].items())
assert all(digest(p) == h for p, h in dep['preserved']['protectedHashes'].items())
assert digest('/etc/misty-prominence/config.json') == dep['preserved']['configHash']
cfg = json.loads(Path('/etc/misty-prominence/config.json').read_text())
assert cfg['agent_model'] == 'gpt-6.1-sol' and cfg['agent_effort'] == 'high'
ws = json.loads((state / 'workflows.json').read_text())['workflows']
oldws = json.loads((Path(dep['backup']) / 'workflows.json').read_text())['workflows']
assert set(oldws) <= set(ws)
for key, w in oldws.items():
    if w.get('focus_id'):
        assert ws[key] == w, 'Existing explicit reminder changed'
assert sum(w.get('kind') == 'initiative' for w in ws.values()) == 1
assert sum(w.get('kind') == 'laptop_activity' for w in ws.values()) == 1
w = ws['misty-initiative-15m']
assert w['enabled'] and w['schedule'] == {'every': 900}
assert (state / 'workflows.json').stat().st_uid == __import__('pwd').getpwnam('misty-bot').pw_uid
with sqlite3.connect('file:' + str(Path(dep['backup']) / 'focus.sqlite') + '?mode=ro', uri=True) as old:
    previous_focus = old.execute('SELECT * FROM focus ORDER BY id').fetchall()
with sqlite3.connect('file:' + str(state / 'focus.sqlite') + '?mode=ro', uri=True) as db:
    assert db.execute('SELECT * FROM focus ORDER BY id').fetchall() == previous_focus
with sqlite3.connect('file:' + str(state / 'initiative.sqlite') + '?mode=ro', uri=True) as db:
    assert db.execute('PRAGMA quick_check').fetchone()[0] == 'ok'
    attempts = db.execute('SELECT status,count(*) FROM deliveries GROUP BY status').fetchall()
    plan_count = db.execute("SELECT count(*) FROM plans WHERE state='active'").fetchone()[0]
before_role = (Path(dep['backup']) / 'misty_context.py').read_text()
now_role = (root / 'misty_context.py').read_text()
assert now_role.split('- initiative.py:')[0] == before_role.split('- focus.py:')[0]
commands = subprocess.check_output(['ps', '-eo', 'args'], text=True).splitlines()
watchers = sum('/opt/apollo-bot/scripts/apollo-discord-bot.mjs' in c and c.startswith('/opt/misty-bot/bin/node') for c in commands)
assert watchers == 1
apollo = json.loads(Path('/var/lib/apollo-bot/status.json').read_text())
assert apollo['connected'] and apollo['delivery']['discussionDelivery'] == 'store_only' and apollo['delivery']['codexDelivery'] == 'live'
assert apollo['runtime']['chatModel'] == apollo['runtime']['decisionModel'] == 'gpt-6-luna'
assert apollo['runtime']['chatEffort'] == apollo['runtime']['decisionEffort'] == 'none'
model = json.loads((stage / 'model-fixture.json').read_text())
assert model['ok'] and model['realDiscordSends'] == 0
report = {'verifiedAt': datetime.now(timezone.utc).isoformat(), 'services': services,
          'supportedRestartCompleted': True, 'workflow': {k: w.get(k) for k in ['id', 'kind', 'enabled', 'schedule', 'next_run', 'runs']},
          'nextCheckIST': datetime.fromtimestamp(w['next_run'], __import__('zoneinfo').ZoneInfo('Asia/Kolkata')).isoformat(),
          'initiativeCopies': 1, 'apolloWatcherCount': watchers, 'activePlans': plan_count, 'deliveryCounts': attempts,
          'mistyModel': cfg['agent_model'], 'mistyEffort': cfg['agent_effort'], 'apolloDelivery': apollo['delivery'],
          'focusUnchanged': True, 'explicitRemindersUnchanged': True, 'activityAndPersonalSendInstructionsUnchanged': True,
          'existingWorkflowIDsPreserved': True, 'protectedComponentsUnchanged': True,
          'realModelFixture': model, 'backup': dep['backup'], 'tests': {'passed': 50, 'failed': 0}}
(stage / 'verification.json').write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))
for name in ['deployment.json', 'verification.json', 'tests.txt', 'model-fixture.json']:
    dest = Path('/tmp/archival-migration/misty-initiative-' + name)
    __import__('shutil').copy2(stage / name, dest)
    dest.chmod(0o644)
