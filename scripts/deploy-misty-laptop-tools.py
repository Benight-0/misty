"""Run staged on existing VM as root. Scoped source/config update; no chat jobs/messages."""
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

STAGE = Path('/tmp/archival-migration/misty-laptop-tools')
CANDIDATE = STAGE / 'candidate'
FORK = Path('/opt/misty-prominence')
STATE = Path('/var/lib/misty-prominence')


def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest() if Path(p).is_file() else None


def run(*args, **kw):
    return subprocess.run(args, text=True, check=True, **kw)


def fork(*args):
    return run('runuser', '-u', 'misty-bot', '--', 'env', 'PROMINENCE_CONFIG=/etc/misty-prominence/config.json',
               str(FORK / 'venv/bin/python'), *args, capture_output=True).stdout.strip()


def main():
    baseline = json.loads((STAGE / 'baseline.json').read_text())
    for entry in baseline.values():
        assert sha(entry['remote']) == entry['sha256'], 'Live source changed; merge first: ' + entry['remote']
    assert not (STATE / 'restart_request.json').exists(), 'Another supported restart is pending; source left untouched.'
    targets = {Path(v['remote']): CANDIDATE / local for local, v in baseline.items()}
    for rel in ['app/laptop-tools-broker.mjs', 'scripts/misty-laptop-tools-server.mjs']:
        targets[Path('/opt/misty-bot') / rel] = CANDIDATE / rel
    for rel in ['laptop_tools.py', 'laptop-tool-schemas.json']:
        targets[FORK / rel] = CANDIDATE / 'prominence' / rel
    targets[Path('/etc/systemd/system/misty-laptop-tools.service')] = CANDIDATE / 'deploy/misty-laptop-tools.service'
    targets[Path('/opt/misty-bot/docs/misty-laptop-tools.md')] = CANDIDATE / 'docs/misty-laptop-tools.md'
    for p, src in targets.items():
        assert src.is_file(), 'Missing staged source: ' + str(src)
        if str(p) not in [v['remote'] for v in baseline.values()]:
            assert not p.exists(), 'New target already exists; inspect it rather than overwrite: ' + str(p)
    configuration = Path('/etc/misty-prominence/config.json')
    old_config = json.loads(configuration.read_text())
    backup = Path('/var/backups/misty') / ('laptop-tools-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    backup.mkdir(parents=True, mode=0o700)
    old = {str(p): sha(p) for p in [*targets, configuration]}
    for p in [*targets, configuration]:
        if p.is_file():
            saved = backup / str(p).lstrip('/')
            saved.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, saved)
    # The new tools DB normally does not yet exist. If present, stop for an explicit merge.
    dbfile = Path('/var/lib/misty-bot/laptop-tools.sqlite')
    assert not dbfile.exists(), 'Tool storage already exists; preserve and inspect before update.'
    protected = {str(p): sha(p) for p in [STATE / 'workflows.json', STATE / 'focus.sqlite']}
    (backup / 'manifest.json').write_text(json.dumps({'old': old, 'protected': protected}, indent=2))
    snapshot = fork(str(FORK / 'selfupdate.py'), 'snapshot', 'Owner-approved direct Cline-derived laptop tools')
    (STAGE / 'rollback-location.txt').write_text(str(backup))
    # Keep current conversation uninterrupted. Do not answer/cancel it for deployment.
    with sqlite3.connect('file:' + str(STATE / 'inbox.sqlite') + '?mode=ro', uri=True) as db:
        assert not db.execute("SELECT 1 FROM inbox WHERE state IN ('running','delivering') LIMIT 1").fetchone(), 'Owner reply active; snapshot retained, deploy deferred.'
    account = pwd.getpwnam('misty-bot')
    installed = False
    try:
        for dest, src in targets.items():
            dest.parent.mkdir(parents=True, exist_ok=True)
            tmp = dest.with_name(dest.name + '.candidate')
            shutil.copy2(src, tmp)
            os.chmod(tmp, 0o644)
            if dest.is_relative_to(FORK) or dest.is_relative_to('/opt/misty-bot'):
                os.chown(tmp, account.pw_uid, account.pw_gid)
            os.replace(tmp, dest)
        changed_config = dict(old_config, laptop_tools_enabled=True)
        tmp = configuration.with_suffix('.candidate')
        tmp.write_text(json.dumps(changed_config, indent=2) + '\n')
        shutil.copystat(configuration, tmp)
        os.chown(tmp, configuration.stat().st_uid, configuration.stat().st_gid)
        os.replace(tmp, configuration)
        for p in targets:
            if p.suffix == '.mjs':
                run('/opt/misty-bot/bin/node', '--check', str(p), capture_output=True)
        assert fork(str(FORK / 'selfupdate.py'), 'check') == 'ok'
        run('systemctl', 'daemon-reload')
        run('systemctl', 'enable', '--now', 'misty-laptop-tools.service', capture_output=True)
        assert run('systemctl', 'is-active', 'misty-laptop-tools', capture_output=True).stdout.strip() == 'active'
        installed = True
    finally:
        if not installed:
            for p, value in old.items():
                dest = Path(p)
                if value is None:
                    dest.unlink(missing_ok=True)
                else:
                    shutil.copy2(backup / p.lstrip('/'), dest)
    fork(str(FORK / 'selfupdate.py'), 'log', 'Added private same-agent laptop MCP tools, adapted pinned Cline executors, durable receipts and hidden Windows worker; retained owner message approval rules and all monitoring.')
    restart = fork(str(FORK / 'selfupdate.py'), 'restart', 'Load direct laptop tool instructions; keep current owner state')
    report = {'backup': str(backup), 'snapshot': snapshot, 'restart_request': restart,
              'installed_hashes': {str(p): sha(p) for p in targets}, 'protected_before': protected,
              'config_changed_keys': [k for k in changed_config if changed_config.get(k) != old_config.get(k)],
              'note': 'Source installed; verify supported restart logs and actual MCP/worker path separately. No messages sent.'}
    (backup / 'deployment.json').write_text(json.dumps(report, indent=2))
    (STAGE / 'deployment.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
