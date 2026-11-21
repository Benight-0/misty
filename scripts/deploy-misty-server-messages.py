"""Scoped update only. Run the staged copy as root on the existing VM after tests.

No messages/drafts/approvals are created. Rollback restores source only; additive
columns and current outgoing journals/cursors/receipts must never be overwritten.
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

STAGE = Path('/tmp/archival-migration/misty-server-messages')
CANDIDATE = STAGE / 'candidate'
FORK = Path('/opt/misty-prominence')
STATE = Path('/var/lib/misty-prominence')
NODE = '/opt/misty-bot/bin/node'


def sha(path):
    p = Path(path)
    return hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def fork(*args):
    return run('runuser', '-u', 'misty-bot', '--', 'env',
               'PROMINENCE_CONFIG=/etc/misty-prominence/config.json',
               str(FORK / 'venv/bin/python'), *args, capture_output=True)


def rows(path, query):
    with sqlite3.connect('file:' + str(path) + '?mode=ro', uri=True) as con:
        return con.execute(query).fetchall()


def row_hash(path, query):
    return hashlib.sha256(json.dumps(rows(path, query)).encode()).hexdigest()


def main():
    baseline = json.loads((STAGE / 'baseline.json').read_text())
    for p, expected in {**baseline['source'], **baseline['protected']}.items():
        assert sha(p) == expected, 'Live source/config changed: ' + p
    assert not (STATE / 'restart_request.json').exists(), 'Self-update already pending.'
    assert not rows('/var/lib/archival/data/archive.sqlite', "SELECT 1 FROM chat_outgoing WHERE status='sending' LIMIT 1"), 'Personal send active.'
    assert not rows('/var/lib/misty-bot/chat.sqlite', "SELECT 1 FROM misty_message_drafts WHERE state='submitting' LIMIT 1"), 'Personal confirmation active.'
    targets = {}
    for name in ['message-target.mjs', 'native-chat.mjs', 'chat-store.mjs', 'chat.mjs', 'message-backend.mjs']:
        targets[Path('/opt/archival/app') / name] = CANDIDATE / 'app' / name
    for name in ['message-target.mjs', 'message-backend.mjs', 'misty-messages.mjs', 'misty-prominence-bridge.mjs']:
        targets[Path('/opt/misty-bot/app') / name] = CANDIDATE / 'app' / name
    for name in ['misty.py', 'misty_context.py']:
        targets[FORK / name] = CANDIDATE / 'prominence' / name
    targets[Path('/opt/archival/docs/misty-personal-messages.md')] = CANDIDATE / 'docs/misty-personal-messages.md'
    for dest, source in targets.items():
        assert str(dest) in baseline['source'] and source.is_file(), 'Missing candidate/baseline: ' + str(dest)
    backup = Path('/var/backups/misty') / ('server-messages-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    backup.mkdir(parents=True, mode=0o700)
    backup.chmod(0o700)
    for p in [*targets, *map(Path, baseline['protected'])]:
        if p.is_file():
            saved = backup / str(p).lstrip('/')
            saved.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, saved)
    print('Source/config snapshot: ' + str(backup), flush=True)
    # SQLite online backup API gives consistent databases, including WAL content.
    # Outgoing/draft hashes must stay stable across both snapshots; otherwise stop.
    for label, p, query in [
        ('outgoing', '/var/lib/archival/data/archive.sqlite', 'SELECT id,status,event_id,body FROM chat_outgoing ORDER BY id'),
        ('drafts', '/var/lib/misty-bot/chat.sqlite', 'SELECT * FROM misty_message_drafts ORDER BY code'),
    ]:
        assert row_hash(p, query) == baseline[label], 'Sending state changed; inspect before deploying.'
        dest = backup / ('archive.sqlite' if label == 'outgoing' else 'chat.sqlite')
        with sqlite3.connect('file:' + p + '?mode=ro', uri=True) as source, sqlite3.connect(dest) as saved:
            # Pin one WAL read snapshot. Without this, continuous collector
            # writes can restart an incremental online backup indefinitely.
            source.execute('BEGIN')
            source.execute('SELECT count(*) FROM sqlite_master').fetchone()
            last = [time.monotonic()]
            def progress(status, remaining, total):
                if time.monotonic() - last[0] > 20:
                    print(f'Backing up {label}: {total - remaining}/{total} pages', flush=True)
                    last[0] = time.monotonic()
            source.backup(saved, pages=1024, sleep=0.05, progress=progress)
            source.rollback()
            assert saved.execute('PRAGMA quick_check').fetchone()[0] == 'ok'
        dest.chmod(0o600)
        print('Consistent backup: ' + dest.name, flush=True)
    for label, p, query in [
        ('outgoing', '/var/lib/archival/data/archive.sqlite', 'SELECT id,status,event_id,body FROM chat_outgoing ORDER BY id'),
        ('drafts', '/var/lib/misty-bot/chat.sqlite', 'SELECT * FROM misty_message_drafts ORDER BY code'),
    ]:
        assert row_hash(p, query) == baseline[label], 'Sending state changed during backup.'
    snapshot = fork(str(FORK / 'selfupdate.py'), 'snapshot', 'Owner-confirmed Discord server messages and replies').stdout.strip()
    manifest = {'backup': str(backup), 'snapshot': snapshot, 'old': baseline['source'],
                'new': {str(p): sha(src) for p, src in targets.items()}}
    (backup / 'manifest.json').write_text(json.dumps(manifest, indent=2))
    (STAGE / 'rollback-location.txt').write_text(str(backup))
    # Source-only rollback. Retain live databases and additive columns, including
    # any new receipts/unknown sends. Old code rejects guild drafts rather than
    # converting them to private messages or retrying submissions.
    rollback = '''import json,os,shutil,subprocess\nfrom pathlib import Path\nb=Path(__file__).resolve().parent\nm=json.loads((b/'manifest.json').read_text())\nfor name,old in m['old'].items():\n p=Path(name);s=b/name.lstrip('/')\n if old is None:p.unlink(missing_ok=True)\n else:shutil.copy2(s,p)\nsubprocess.run(['systemctl','restart','archival','misty-bot'],check=True)\nsubprocess.run(['runuser','-u','misty-bot','--','env','PROMINENCE_CONFIG=/etc/misty-prominence/config.json','/opt/misty-prominence/venv/bin/python','/opt/misty-prominence/selfupdate.py','restart','Rollback server-message source; retain current journals'],check=True)\n'''
    (backup / 'rollback-source.py').write_text(rollback)
    account = pwd.getpwnam('misty-bot')
    # Backups are read-only and can run during a conversation. Wait for the
    # current owner turn before replacing tools or restarting the Node bridge.
    for attempt in range(120):
        if not rows(STATE / 'inbox.sqlite', "SELECT 1 FROM inbox WHERE state IN ('running','delivering') LIMIT 1"):
            break
        if attempt % 6 == 0:
            print('Waiting for the current owner reply before source deployment...', flush=True)
        time.sleep(5)
    else:
        raise RuntimeError('Owner conversation is still active; snapshots retained, source untouched.')
    assert not rows('/var/lib/archival/data/archive.sqlite', "SELECT 1 FROM chat_outgoing WHERE status='sending' LIMIT 1"), 'Personal send became active.'
    assert not rows('/var/lib/misty-bot/chat.sqlite', "SELECT 1 FROM misty_message_drafts WHERE state='submitting' LIMIT 1"), 'Personal confirmation became active.'
    # Owner work can legitimately update these while the online backup runs.
    # Protect the latest state at source replacement, not an earlier owner turn.
    focus_before = row_hash(STATE / 'focus.sqlite', 'SELECT * FROM focus ORDER BY id')
    workflows_before = sha(STATE / 'workflows.json')
    (STAGE / 'owner-state-before-deploy.json').write_text(json.dumps({'focus': focus_before, 'workflows': workflows_before}))
    try:
        for dest, source in targets.items():
            assert sha(dest) == baseline['source'][str(dest)], 'Source changed since snapshot.'
            dest.parent.mkdir(parents=True, exist_ok=True)
            tmp = dest.with_name(dest.name + '.server-message-candidate')
            shutil.copy2(source, tmp)
            tmp.chmod(0o644)
            if dest.is_relative_to(FORK):
                os.chown(tmp, account.pw_uid, account.pw_gid)
            os.replace(tmp, dest)
        for p in targets:
            if p.suffix == '.mjs':
                run(NODE, '--check', str(p), capture_output=True)
        assert fork(str(FORK / 'selfupdate.py'), 'check').stdout.strip() == 'ok'
        run('systemctl', 'restart', 'archival', 'misty-bot')
    except Exception:
        # Restore only scoped sources; never roll back databases/cursors/receipts.
        for p in targets:
            saved = backup / str(p).lstrip('/')
            if baseline['source'][str(p)] is None:
                p.unlink(missing_ok=True)
            else:
                shutil.copy2(saved, p)
        run('systemctl', 'restart', 'archival', 'misty-bot')
        raise
    fork(str(FORK / 'selfupdate.py'), 'log', 'Discord selected server text/thread posts and proper replies through immutable full preview plus fresh owner yes; reverify owner/guild/permissions/reply, suppress pings, preserve private-chat approval and durable unknown/no-retry receipts. No live posts during verification.')
    restart = fork(str(FORK / 'selfupdate.py'), 'restart', 'Enable verified Discord server drafts/replies under the existing exact-preview and fresh-owner-yes rule').stdout.strip()
    manifest['restart'] = restart
    manifest['deployed_at'] = datetime.now(timezone.utc).isoformat()
    manifest['protected_unchanged'] = all(sha(p) == expected for p, expected in baseline['protected'].items())
    manifest['focus_unchanged'] = row_hash(STATE / 'focus.sqlite', 'SELECT * FROM focus ORDER BY id') == focus_before
    manifest['workflows_unchanged'] = sha(STATE / 'workflows.json') == workflows_before
    manifest['prior_owner_state_updates'] = focus_before != baseline['focus'] or workflows_before != baseline['workflows']
    assert manifest['protected_unchanged'] and manifest['focus_unchanged'] and manifest['workflows_unchanged'], 'Unrelated state changed; inspect without restoring live state.'
    (STAGE / 'deployment.json').write_text(json.dumps(manifest, indent=2))
    print(json.dumps(manifest), flush=True)


if __name__ == '__main__':
    main()
