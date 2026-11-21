"""Scoped self-update through Misty's existing supervisor; no bot kill/relaunch."""
from datetime import datetime, timezone
import hashlib
import fcntl
import json
import os
from pathlib import Path
import pwd
import shutil
import sqlite3
import subprocess

STAGE = Path('/tmp/archival-migration/misty-initiative-timing')
CANDIDATE = STAGE / 'candidate/prominence'
ROOT = Path('/opt/misty-prominence')
STATE = Path('/var/lib/misty-prominence')


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def fork(*args):
    return run('runuser', '-u', 'misty-bot', '--', 'env',
               'PROMINENCE_CONFIG=/etc/misty-prominence/config.json',
               str(ROOT / 'venv/bin/python'), str(ROOT / 'selfupdate.py'),
               *args, capture_output=True).stdout.strip()


assert not (STATE / 'restart_request.json').exists(), 'Another update is pending'
previous = json.loads((STAGE / 'previous-deployment.json').read_text())
for path, expected in previous['hashes'].items():
    assert digest(path) == expected, 'Live source changed; merge first: ' + path
assert (CANDIDATE / 'bot.py').read_bytes() == (ROOT / 'bot.py').read_bytes(), 'Bot must remain untouched'
old_role, new_role = (ROOT / 'misty_context.py').read_text(), (CANDIDATE / 'misty_context.py').read_text()
for section in (lambda s: s.split('- initiative.py:')[0], lambda s: s.split('- focus.py:')[1]):
    assert section(old_role) == section(new_role), 'Unrelated role instruction changed'

tests = run(str(ROOT / 'venv/bin/python'), '-W', 'ignore::ResourceWarning', '-m', 'unittest',
            'test_initiative', 'test_focus', 'test_laptop_activity', 'test_activity', 'test_fork',
            cwd=CANDIDATE, capture_output=True)
(STAGE / 'tests.txt').write_text(tests.stdout + tests.stderr)

snapshot = fork('snapshot', 'Remove owner-rejected fixed initiative limits; preserve plans, receipts and other services')
backup = Path('/var/backups/misty') / ('initiative-timing-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
backup.mkdir(mode=0o700)
targets = ['misty_context.py', 'initiative.py', 'test_initiative.py']
for name in targets:
    if (ROOT / name).exists():
        shutil.copy2(ROOT / name, backup / name)
config_hash = digest('/etc/misty-prominence/config.json')
protected = {str(p): digest(p) for p in [ROOT / 'laptop_activity.py', ROOT / 'workflows.py',
    Path('/opt/apollo-bot/app/apollo.mjs'), Path('/opt/apollo-bot/app/apollo-inbox.mjs')]}
for name in ['focus.sqlite', 'inbox.sqlite', 'initiative.sqlite']:
    with sqlite3.connect('file:' + str(STATE / name) + '?mode=ro', uri=True) as db, sqlite3.connect(backup / name) as copy:
        db.backup(copy)
# Consistent shared workflow snapshot under its actual application lock; read only.
with open(STATE / '.workflows.lock') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    shutil.copy2(STATE / 'workflows.json', backup / 'workflows.json')
for name in ['outbox.jsonl', 'laptop_activity_state.json']:
    if (STATE / name).exists():
        shutil.copy2(STATE / name, backup / name)
before = {'configHash': config_hash, 'protectedHashes': protected,
          'workflowIDs': list(json.loads((backup / 'workflows.json').read_text())['workflows']),
          'botHash': digest(ROOT / 'bot.py')}
(backup / 'before.json').write_text(json.dumps(before, indent=2))
user = pwd.getpwnam('misty-bot')
for name in targets:
    temp = ROOT / (name + '.candidate')
    shutil.copy2(CANDIDATE / name, temp)
    temp.chmod(0o644)
    os.chown(temp, user.pw_uid, user.pw_gid)
    os.replace(temp, ROOT / name)
assert fork('check') == 'ok'
# Import only the helper; do not start a replacement bot/session or run a live decision.
init = "import initiative,json;print(json.dumps({'workflow':initiative.ensure_workflow(),'status':initiative.status()}))"
initialized = json.loads(run('runuser', '-u', 'misty-bot', '--', 'env',
    'PROMINENCE_CONFIG=/etc/misty-prominence/config.json', str(ROOT / 'venv/bin/python'),
    '-c', init, cwd=ROOT, capture_output=True).stdout)
assert digest('/etc/misty-prominence/config.json') == config_hash
assert all(digest(p) == h for p, h in protected.items())
fork('log', 'Owner correction: initiative timing/frequency/length model-decided; removed daily/topic/gap/quiet-hour/urgency-window and plan-count/horizon policy caps. Saved natural talking preferences, model-selected review wake and changed-context review. Pause and uncertain-send protection retained; no plans/receipts reset, no test DMs. Main model, reminders, activity, Apollo and approvals unchanged. Backup: ' + str(backup))
restart = fork('restart', 'Apply owner-selected uncapped context-driven check-ins')
report = {'deployedAt': datetime.now(timezone.utc).isoformat(), 'backup': str(backup), 'snapshot': snapshot,
          'supportedRestart': restart, 'initialState': initialized,
          'hashes': {str(ROOT / n): digest(ROOT / n) for n in targets}, 'preserved': before,
          'rollback': 'Restore only backed-up source with selfupdate check/log/restart. Do not overwrite live SQLite, plans, receipts, workflow state, focus or inbox; storage copies are recovery snapshots only.'}
(STAGE / 'deployment.json').write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))
