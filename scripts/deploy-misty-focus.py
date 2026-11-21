"""Incremental focus/reminder upgrade. Run as root on the VM after staged checks.

Verifies the captured source baseline and waits for the fork's graceful restart.
Never touches archive data, relay receipts, approvals or another service.
"""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import sqlite3
import subprocess
import time

STAGE = Path('/tmp/archival-migration/misty-focus')
ROOT = Path('/opt/misty-prominence')
STATE = Path('/var/lib/misty-prominence')
FILES = ('bot.py', 'misty_context.py', 'workflows.py', 'focus.py', 'test_focus.py')
CONFIG = '/etc/misty-prominence/config.json'
PYTHON = str(ROOT / 'venv/bin/python')
user = pwd.getpwnam('misty-bot')


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def agent(*args):
    return run('runuser', '-u', 'misty-bot', '--', 'env', 'PROMINENCE_CONFIG=' + CONFIG,
               PYTHON, *args, capture_output=True)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


baseline = json.loads((STAGE / 'baseline.json').read_text())
assert all(digest(ROOT / name) == checksum for name, checksum in baseline.items()), 'Source changed since capture; merge it first.'
assert not (STATE / 'restart_request.json').exists(), 'Another self-update restart is pending.'
with sqlite3.connect('file:' + str(STATE / 'inbox.sqlite') + '?mode=ro', uri=True) as db:
    assert not db.execute("SELECT count(*) FROM inbox WHERE state IN ('running','delivering')").fetchone()[0], 'An owner turn is active; wait.'

stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup = STATE / ('focus-before-' + stamp)
backup.mkdir(mode=0o700)
for name in FILES:
    if (ROOT / name).exists():
        shutil.copy2(ROOT / name, backup / name)
for name in ('workflows.json', 'context.db', 'focus.sqlite'):
    src = STATE / name
    if src.exists():
        if src.suffix in ('.db', '.sqlite'):
            with sqlite3.connect('file:' + str(src) + '?mode=ro', uri=True) as db, sqlite3.connect(backup / name) as target:
                db.backup(target)
        else:
            shutil.copy2(src, backup / name)
snapshot = agent(str(ROOT / 'selfupdate.py'), 'snapshot', 'Current work notes and linked deadline reminders').stdout.strip()
before = run('systemctl', 'show', 'misty-prominence', '-p', 'MainPID', '--value', capture_output=True).stdout.strip()

try:
    for name in FILES:
        temp = ROOT / (name + '.candidate')
        shutil.copyfile(STAGE / name, temp)
        temp.chmod(0o644)
        os.chown(temp, user.pw_uid, user.pw_gid)
        os.replace(temp, ROOT / name)
    checked = agent(str(ROOT / 'selfupdate.py'), 'check')
    assert checked.stdout.strip() == 'ok', checked.stdout
except Exception:
    for name in FILES:
        if (backup / name).exists():
            shutil.copy2(backup / name, ROOT / name)
        else:
            (ROOT / name).unlink(missing_ok=True)
    raise

agent(str(ROOT / 'selfupdate.py'), 'log', 'Added current work list, priorities, sourced commitments, linked IST reminders and explicit laptop Codex delegation guidance.')
restart_at = time.time()
restart = agent(str(ROOT / 'selfupdate.py'), 'restart', 'Current work notes and linked deadline reminders')
print(json.dumps({'backup': str(backup), 'snapshot': snapshot, 'restart': restart.stdout.strip()}), flush=True)
deadline = time.monotonic() + 65
while time.monotonic() < deadline:
    time.sleep(2)
    current = run('systemctl', 'show', 'misty-prominence', '-p', 'MainPID', '--value', capture_output=True).stdout.strip()
    # supervise.py remains the main PID. The trial file proves its child processed the request.
    trial = STATE / 'restart_trial.json'
    pending = STATE / 'restart_request.json'
    if trial.exists() and trial.stat().st_mtime >= restart_at and not pending.exists():
        break
else:
    raise RuntimeError('Graceful restart still pending. Do not force-restart an active owner task.')

seed = {'title': 'Misty personal assistant development', 'kind': 'project', 'priority': 'now',
        'basis': 'owner', 'source': 'Owner request 2026-10-23: helper, worker, coder, reminder; current focus/deadline notes; access laptop Codex.',
        'notes': 'Keep current work and commitments; recommend priorities; delegate approved implementation to laptop Codex. Apollo handles proactive chat updates.',
        'next_action': 'Use the work list for new commitments and keep coding requests tied to approved tasks. No personal deadline supplied yet.'}
agent(str(ROOT / 'focus.py'), 'put', 'misty-associate', json.dumps(seed))
manifest = {'backup': str(backup), 'snapshot': snapshot,
            'hashes': {name: digest(ROOT / name) for name in FILES},
            'mainPidBefore': before, 'mainPidAfter': current,
            'seededDeadlineCount': 0, 'discordMessagesSent': 0}
(STAGE / 'deployment.json').write_text(json.dumps(manifest, indent=2))
print(json.dumps(manifest), flush=True)
