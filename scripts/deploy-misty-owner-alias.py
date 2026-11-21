"""Scoped VM installer. Run staged as root after the candidate verification passes."""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import sqlite3
import subprocess

STAGE = Path('/tmp/archival-migration/misty-owner-alias-20261025')
CANDIDATE = STAGE / 'candidate'
FORK = Path('/opt/misty-prominence')
STATE = Path('/var/lib/misty-prominence')
PRIMARY, ALIAS = '100000000000000023', '100000000000000034'


def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest() if Path(p).is_file() else None


def run(*args, **kw):
    return subprocess.run(args, text=True, check=True, **kw)


def fork(*args):
    return run('runuser', '-u', 'misty-bot', '--', 'env', 'PROMINENCE_CONFIG=/etc/misty-prominence/config.json',
               str(FORK / 'venv/bin/python'), *args, capture_output=True).stdout.strip()


def backup_db(source, target):
    with sqlite3.connect('file:' + str(source) + '?mode=ro', uri=True, timeout=30) as src, sqlite3.connect(target) as dst:
        src.backup(dst)
        assert dst.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    os.chmod(target, 0o600)


def main():
    baseline = json.loads((STAGE / 'baseline.json').read_text())
    assert (STAGE / 'verified.json').is_file(), 'Run staged tests/build first.'
    verified = json.loads((STAGE / 'verified.json').read_text())
    for p, digest in verified['candidate_hashes'].items():
        assert sha(p) == digest, 'Candidate changed after verification: ' + p
    for entry in baseline['files'].values():
        assert sha(entry['remote']) == entry['sha256'], 'Live source changed: ' + entry['remote']
    assert sha('/opt/misty-bot/bin/gateway') == baseline['gatewayHash'], 'Gateway changed.'
    assert not (STATE / 'restart_request.json').exists(), 'Another supported restart pending.'
    assert not (STATE / 'ask_pending.json').exists(), 'Owner question pending; do not interrupt.'
    with sqlite3.connect('file:' + str(STATE / 'inbox.sqlite') + '?mode=ro', uri=True) as db:
        assert not db.execute("SELECT 1 FROM inbox WHERE state IN ('running','delivering') LIMIT 1").fetchone(), 'Owner turn active; defer deployment.'
    node_db = Path('/var/lib/misty-bot/chat.sqlite')
    with sqlite3.connect('file:' + str(node_db) + '?mode=ro', uri=True) as db:
        assert not db.execute("SELECT 1 FROM bot_turns WHERE status IN ('generating','ready') LIMIT 1").fetchone(), 'Owner bridge reply active; defer deployment.'
    targets = {Path(v['remote']): CANDIDATE / local for local, v in baseline['files'].items()}
    targets[Path('/opt/misty-bot/app/owner-routing.mjs')] = CANDIDATE / 'app/owner-routing.mjs'
    targets[Path('/opt/misty-bot/docs/misty-owner-accounts.md')] = CANDIDATE / 'docs/misty-owner-accounts.md'
    targets[Path('/etc/systemd/system/misty-bot.service.d/owner-accounts.conf')] = CANDIDATE / 'deploy/misty-owner-accounts.conf'
    targets[Path('/opt/misty-bot/bin/gateway')] = STAGE / 'gateway'
    for dest in targets:
        if str(dest) not in [v['remote'] for v in baseline['files'].values()] and dest.name != 'gateway':
            assert not dest.exists(), 'New source exists; inspect before overwrite: ' + str(dest)
    configfile = Path('/etc/misty-prominence/config.json')
    accountsfile = Path('/etc/misty-bot/owner-accounts.json')
    assert not accountsfile.exists(), 'Owner allowlist exists; merge explicitly.'
    old_config = json.loads(configfile.read_text())
    assert str(old_config['owner_id']) == PRIMARY
    assert not old_config.get('owner_alias_ids'), 'Existing aliases require merge.'
    assert old_config.get('agent_model') == 'gpt-6.1-sol' and old_config.get('agent_effort') == 'low'
    backup = Path('/var/backups/misty') / ('owner-alias-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    backup.mkdir(parents=True, mode=0o700)
    old = {str(p): sha(p) for p in [*targets, configfile, accountsfile]}
    for p in [*targets, configfile, accountsfile]:
        if p.is_file():
            saved = backup / str(p).lstrip('/')
            saved.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, saved)
    protected = {str(p): sha(p) for p in [STATE / 'workflows.json', STATE / 'focus.sqlite', STATE / 'owner_session.txt']}
    snapshot = fork(str(FORK / 'selfupdate.py'), 'snapshot', 'Verified alternate owner account; same session and same-DM approvals')
    (STAGE / 'rollback-location.txt').write_text(str(backup))
    (backup / 'manifest.json').write_text(json.dumps({'old': old, 'protected': protected, 'snapshot': snapshot}, indent=2))
    account = pwd.getpwnam('misty-bot')
    installed = False
    run('systemctl', 'stop', 'misty-bot.service')
    try:
        # Source rollback never overwrites these current journals/cursors/receipts.
        backup_db(node_db, backup / 'chat.sqlite')
        backup_db(STATE / 'inbox.sqlite', backup / 'inbox.sqlite')
        for dest, src in targets.items():
            dest.parent.mkdir(parents=True, exist_ok=True)
            tmp = dest.with_name(dest.name + '.owner-candidate')
            shutil.copy2(src, tmp)
            os.chmod(tmp, 0o755 if dest.name == 'gateway' else 0o644)
            os.chown(tmp, *( (0, 0) if str(dest).startswith('/etc/systemd/') else (account.pw_uid, account.pw_gid) ))
            os.replace(tmp, dest)
        changed_config = dict(old_config, owner_alias_ids=[ALIAS])
        tmp = configfile.with_suffix('.owner-candidate')
        tmp.write_text(json.dumps(changed_config, indent=2) + '\n')
        shutil.copystat(configfile, tmp)
        os.chown(tmp, configfile.stat().st_uid, configfile.stat().st_gid)
        os.replace(tmp, configfile)
        accountsfile.write_text(json.dumps([PRIMARY, ALIAS]) + '\n')
        os.chmod(accountsfile, 0o640); os.chown(accountsfile, 0, account.pw_gid)
        for p in targets:
            if p.suffix == '.mjs': run('/opt/misty-bot/bin/node', '--check', str(p), capture_output=True)
        assert fork(str(FORK / 'selfupdate.py'), 'check') == 'ok'
        installed = True
    finally:
        if not installed:
            for p, digest in old.items():
                dest = Path(p)
                if digest is None: dest.unlink(missing_ok=True)
                else: shutil.copy2(backup / p.lstrip('/'), dest)
        run('systemctl', 'daemon-reload')
        run('systemctl', 'start', 'misty-bot.service')
    fork(str(FORK / 'selfupdate.py'), 'log', 'Added explicitly owner-verified alternate Discord account 100000000000000034. Shared existing owner session/tools, DM-bound replies/cards/previews and fresh yes; primary reminders, Apollo and disconnected personal tracker preserved. Tested with mocks; no test messages sent.')
    restart = fork(str(FORK / 'selfupdate.py'), 'restart', 'Load verified second owner account and same-DM reply/approval routing')
    report = {'backup': str(backup), 'snapshot': snapshot, 'restart_request': restart,
              'installed_hashes': {str(p): sha(p) for p in targets}, 'protected_before': protected,
              'config_changed_keys': [k for k in changed_config if changed_config.get(k) != old_config.get(k)],
              'accounts': [PRIMARY, ALIAS], 'storage_backups': ['chat.sqlite', 'inbox.sqlite'],
              'note': 'Installed; verify actual supported restart and both live DM mappings. No test messages.'}
    (backup / 'deployment.json').write_text(json.dumps(report, indent=2))
    (STAGE / 'deployment.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == '__main__': main()
