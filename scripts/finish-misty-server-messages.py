"""Finish this scoped deployment from its already verified consistent backups.

The persistent Misty agent and pending dm.py ask are left running. Helper CLI
updates are backward compatible. Its role reload uses selfupdate's idle queue.
"""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import pwd
import shutil
import sqlite3

import deploy_misty_server_messages as deployment


def main():
    d = deployment
    baseline = json.loads((d.STAGE / 'baseline.json').read_text())
    backup = Path((d.STAGE / 'rollback-location.txt').read_text()).resolve()
    assert backup.parent == Path('/var/backups/misty') and backup.name.startswith('server-messages-')
    manifest = json.loads((backup / 'manifest.json').read_text())
    assert manifest['old'] == baseline['source']
    assert (backup / 'archive.sqlite').is_file() and (backup / 'chat.sqlite').is_file()
    assert not (backup / 'INCOMPLETE.txt').exists()
    for p, expected in {**baseline['source'], **baseline['protected']}.items():
        assert d.sha(p) == expected, 'Live source/config changed: ' + p
    assert not (d.STATE / 'restart_request.json').exists()
    assert not d.rows('/var/lib/archival/data/archive.sqlite', "SELECT 1 FROM chat_outgoing WHERE status='sending' LIMIT 1")
    assert not d.rows('/var/lib/misty-bot/chat.sqlite', "SELECT 1 FROM misty_message_drafts WHERE state='submitting' LIMIT 1")
    # Preserve the owner's latest work, including changes made during backup.
    owner_state = {'focus': d.row_hash(d.STATE / 'focus.sqlite', 'SELECT * FROM focus ORDER BY id'),
                   'workflows': d.sha(d.STATE / 'workflows.json'), 'at': datetime.now(timezone.utc).isoformat()}
    (d.STAGE / 'owner-state-before-deploy.json').write_text(json.dumps(owner_state))
    with sqlite3.connect('file:/var/lib/misty-bot/chat.sqlite?mode=ro', uri=True) as source, sqlite3.connect(backup / 'chat-predeploy.sqlite') as saved:
        source.execute('BEGIN')
        source.execute('SELECT count(*) FROM sqlite_master').fetchone()
        source.backup(saved)
        source.rollback()
    (backup / 'chat-predeploy.sqlite').chmod(0o600)
    # The full archive snapshot is retained; record current outgoing rows too.
    journal = d.rows('/var/lib/archival/data/archive.sqlite', 'SELECT * FROM chat_outgoing ORDER BY id')
    (backup / 'outgoing-predeploy.json').write_text(json.dumps(journal))
    (backup / 'outgoing-predeploy.json').chmod(0o600)
    print('Reusing verified consistent full backups; refreshed current approval/outgoing snapshots.', flush=True)
    account = pwd.getpwnam('misty-bot')
    try:
        for filename, expected in manifest['new'].items():
            p = Path(filename)
            src = d.CANDIDATE / ('prominence/' + p.name if p.is_relative_to(d.FORK) else
                                 'docs/' + p.name if p.suffix == '.md' else 'app/' + p.name)
            assert d.sha(src) == expected
            assert d.sha(p) == manifest['old'][filename]
            p.parent.mkdir(parents=True, exist_ok=True)
            tmp = p.with_name(p.name + '.server-message-candidate')
            shutil.copy2(src, tmp)
            tmp.chmod(0o644)
            if p.is_relative_to(d.FORK):
                os.chown(tmp, account.pw_uid, account.pw_gid)
            os.replace(tmp, p)
        for filename in manifest['new']:
            if filename.endswith('.mjs'):
                d.run(d.NODE, '--check', filename, capture_output=True)
        assert d.fork(str(d.FORK / 'selfupdate.py'), 'check').stdout.strip() == 'ok'
        # Existing Node services have durable queues and graceful stop handlers.
        # The actual Misty agent/owner ask is not killed or relaunched here.
        d.run('systemctl', 'restart', 'archival', 'misty-bot')
    except Exception:
        for filename, old in manifest['old'].items():
            p = Path(filename)
            if old is None:
                p.unlink(missing_ok=True)
            else:
                shutil.copy2(backup / filename.lstrip('/'), p)
        d.run('systemctl', 'restart', 'archival', 'misty-bot')
        raise
    d.fork(str(d.FORK / 'selfupdate.py'), 'log', 'Discord selected guild text/thread messages and proper replies: immutable exact preview and fresh owner yes; owner/guild/permission/reply revalidation, suppressed pings, durable acknowledgements and no unknown retry. Preserve active owner question and latest focus/workflow changes. Read-only live verification only.')
    manifest['restart'] = d.fork(str(d.FORK / 'selfupdate.py'), 'restart', 'Enable Discord server preview/reply support after the active owner conversation finishes').stdout.strip()
    manifest['deployed_at'] = datetime.now(timezone.utc).isoformat()
    manifest['protected_unchanged'] = all(d.sha(p) == expected for p, expected in baseline['protected'].items())
    manifest['focus_unchanged'] = d.row_hash(d.STATE / 'focus.sqlite', 'SELECT * FROM focus ORDER BY id') == owner_state['focus']
    manifest['workflows_unchanged'] = d.sha(d.STATE / 'workflows.json') == owner_state['workflows']
    manifest['prior_owner_state_updates'] = owner_state['focus'] != baseline['focus'] or owner_state['workflows'] != baseline['workflows']
    assert manifest['protected_unchanged'] and manifest['focus_unchanged'] and manifest['workflows_unchanged']
    (d.STAGE / 'deployment.json').write_text(json.dumps(manifest, indent=2))
    print(json.dumps(manifest), flush=True)


if __name__ == '__main__':
    main()
