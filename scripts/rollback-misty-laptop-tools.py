"""Run on VM as root with the retained backup path. Dry run unless --apply.

Source/config only: never restores an old journal, cursor, receipt or focus state.
Stop the Windows 'Misty Laptop Tools' task before applying. Misty itself uses its
supported selfupdate restart, never a forced service/bot kill.
"""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def main():
    if len(sys.argv) < 2:
        raise SystemExit('Usage: rollback-misty-laptop-tools.py BACKUP [--apply]')
    backup = Path(sys.argv[1]).resolve()
    assert backup.is_relative_to('/var/backups/misty') and backup.name.startswith('laptop-tools-')
    manifest = json.loads((backup / 'manifest.json').read_text())
    deployed = json.loads((backup / 'deployment.json').read_text())
    # Refuse to overwrite later source changes. An operator must merge those.
    for name, expected in deployed['installed_hashes'].items():
        assert sha(Path(name)) == expected, 'Newer source requires a scoped merge: ' + name
    print('Verified installed source. Journals, receipts, reminders and focus state will be retained.')
    if '--apply' not in sys.argv:
        print('Dry run. Stop the Windows Misty Laptop Tools task, then pass --apply to roll back.')
        return
    saved_config = json.loads((backup / 'etc/misty-prominence/config.json').read_text())
    config_path = Path('/etc/misty-prominence/config.json')
    current = json.loads(config_path.read_text())
    assert current.get('laptop_tools_enabled') is True, 'Config changed; inspect rather than overwrite.'
    # Snapshot current affected source/config again, without reverting any state DB.
    checkpoint = backup / ('before-rollback-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    checkpoint.mkdir(mode=0o700)
    for name in manifest['old']:
        source = Path(name)
        if source.is_file():
            dest = checkpoint / name.lstrip('/')
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, dest)
    subprocess.run(['systemctl','disable','--now','misty-laptop-tools.service'], check=True)
    # Keep new, now inactive modules on disk for inspection; restore only original files.
    for name, previous in manifest['old'].items():
        if previous is None or name == str(config_path):
            continue
        shutil.copy2(backup / name.lstrip('/'), Path(name))
    if 'laptop_tools_enabled' in saved_config:
        current['laptop_tools_enabled'] = saved_config['laptop_tools_enabled']
    else:
        current.pop('laptop_tools_enabled', None)
    # Only the setting introduced by this deployment changes; preserve other live config.
    config_path.write_text(json.dumps(current, indent=2) + '\n')
    command = ['/usr/sbin/runuser','-u','misty-bot','--','env','PROMINENCE_CONFIG=/etc/misty-prominence/config.json',
               '/opt/misty-prominence/venv/bin/python','/opt/misty-prominence/selfupdate.py']
    subprocess.run([*command,'check'], check=True)
    subprocess.run([*command,'log','Rolled back direct laptop tool source/config only; retained all live state and receipts.'], check=True)
    subprocess.run([*command,'restart','Load scoped laptop-tool rollback after current owner work is idle'], check=True)


if __name__ == '__main__':
    main()
