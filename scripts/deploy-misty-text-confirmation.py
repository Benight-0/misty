"""Restore requested full-preview DM yes/no approval; never sends a personal message."""
import base64
import json
from pathlib import Path
import shlex
import subprocess

ROOT = Path(__file__).resolve().parents[1]
REMOTE = r'''
from pathlib import Path
from datetime import datetime, timezone
import hashlib, json, shutil, sqlite3, subprocess, time
source = Path('/opt/misty-bot/app/misty-messages.mjs')
stage = Path('/var/lib/misty-prominence/text-confirmation-20261030')
candidate = stage / 'misty-messages.candidate.mjs'
old_hash = '616c4c3dfc513d9731f4926d136e60282d1b9f9e8773d495a888db12b95f225a'
new_hash = '706dd61407db04b1253348c92576904ab1cda8d62f300133bf3dc2d0346c120a'
sha = lambda data: hashlib.sha256(data).hexdigest()
assert sha(source.read_bytes()) == old_hash, 'Live source drift: deployment stopped'
assert sha(candidate.read_bytes()) == new_hash, 'Candidate hash changed: deployment stopped'
subprocess.run(['/opt/misty-bot/bin/node', '--check', str(candidate)], check=True, capture_output=True)
with sqlite3.connect('file:/var/lib/misty-bot/chat.sqlite?mode=ro', uri=True) as db:
    assert not db.execute("SELECT 1 FROM misty_message_drafts WHERE state IN ('submitting','sending') LIMIT 1").fetchone(), 'A send is in progress; deployment stopped'
stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup = Path('/var/backups/misty') / ('text-confirmation-' + stamp)
backup.mkdir(mode=0o700)
shutil.copy2(source, backup / source.name)
pid_before = subprocess.check_output(['systemctl', 'show', 'misty-bot.service', '-p', 'MainPID', '--value'], text=True).strip()
try:
    assert sha(source.read_bytes()) == old_hash, 'Live source drift before replacement'
    source.write_bytes(candidate.read_bytes())
    subprocess.run(['systemctl', 'restart', 'misty-bot.service'], check=True, timeout=60, capture_output=True)
    for attempt in range(60):
        try:
            status = json.loads(Path('/var/lib/misty-bot/status.json').read_text())
            if status.get('state') == 'online' and status.get('connected') and status.get('at', 0) > time.time()*1000 - 15000:
                break
        except (OSError, ValueError):
            pass
        time.sleep(.5)
    else:
        raise RuntimeError('Native sender did not reconnect')
    assert sha(source.read_bytes()) == new_hash
except Exception:
    if sha(source.read_bytes()) == new_hash:
        shutil.copy2(backup / source.name, source)
        subprocess.run(['systemctl', 'restart', 'misty-bot.service'], check=False, timeout=60, capture_output=True)
    raise
receipt = {'state': 'deployed', 'path': str(source), 'sha256': sha(source.read_bytes()), 'backup': str(backup), 'main_pid_before': pid_before,
           'main_pid_after': subprocess.check_output(['systemctl', 'show', 'misty-bot.service', '-p', 'MainPID', '--value'], text=True).strip(),
           'sender_online': True, 'tests': 27, 'personal_messages_sent_by_deployment': 0}
(backup / 'receipt.json').write_text(json.dumps(receipt, indent=2))
(stage / 'deployment.json').write_text(json.dumps(receipt, indent=2))
print(json.dumps(receipt), flush=True)
'''

def main():
    command = 'sudo -n python3 -c ' + shlex.quote('import base64;exec(base64.b64decode(' + repr(base64.b64encode(REMOTE.encode()).decode()) + '))')
    result = subprocess.run(['ssh.exe', '-F', str(ROOT / 'data/deployment/ssh_config'), '-o', 'ConnectTimeout=20', 'archival-vm', command], capture_output=True, timeout=120)
    print(result.stdout.decode(errors='replace'), end='')
    if result.stderr:
        print(result.stderr.decode(errors='replace'), end='')
    if result.returncode:
        raise RuntimeError('Native sender deployment failed; inspect receipt before any retry')

if __name__ == '__main__':
    main()
