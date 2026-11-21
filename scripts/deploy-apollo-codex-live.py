"""In-place owner opt-in for live Codex notices; never reset inbox or watcher."""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import sqlite3
import subprocess

STAGE = Path('/tmp/archival-migration/apollo-codex-live')
CANDIDATE = STAGE / 'candidate'
NODE = '/opt/misty-bot/bin/node'


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def fork(*args):
    return run('runuser', '-u', 'misty-bot', '--', 'env',
               'PROMINENCE_CONFIG=/etc/misty-prominence/config.json',
               '/opt/misty-prominence/venv/bin/python',
               '/opt/misty-prominence/selfupdate.py', *args,
               capture_output=True).stdout.strip()


targets = {Path('/opt/apollo-bot') / p: CANDIDATE / p for p in [
    'app/apollo.mjs', 'app/apollo-inbox.mjs', 'scripts/apollo-discord-bot.mjs']}
targets[Path('/opt/misty-prominence/misty_context.py')] = CANDIDATE / 'prominence/misty_context.py'
baseline = json.loads((STAGE / 'previous-deployment.json').read_text())['hashes']
for path in targets:
    assert digest(path) == baseline[str(path)], 'Live source changed; merge first: ' + str(path)
assert not Path('/var/lib/misty-prominence/restart_request.json').exists()
tests = run(NODE, '--disable-warning=ExperimentalWarning', '--test',
            'app/tests/apollo-inbox.test.mjs', 'app/tests/apollo.test.mjs',
            'app/tests/misty-direct-codex.test.mjs', 'app/tests/misty-notifications.test.mjs',
            'app/tests/misty-messages.test.mjs', cwd=CANDIDATE, capture_output=True)
(STAGE / 'tests.txt').write_text(tests.stdout)
backup = Path('/var/backups/misty') / ('apollo-codex-live-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
backup.mkdir(mode=0o700)
snapshot = fork('snapshot', 'Owner opt-in: live Codex updates only; conversations remain quiet')
for path in targets:
    dest = backup / 'files' / str(path).lstrip('/')
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, dest)
config_hash = digest('/etc/misty-prominence/config.json')
run('systemctl', 'stop', 'apollo-bot')
with sqlite3.connect('file:/var/lib/apollo-bot/chat.sqlite?mode=ro', uri=True) as db, sqlite3.connect(backup / 'apollo.sqlite') as copy:
    db.backup(copy)
    before = {'settings': dict(db.execute('SELECT key,value FROM bot_settings')),
              'receipts': db.execute('SELECT seq,source,status,message_id FROM relay_notices').fetchall(),
              'buffers': db.execute('SELECT room_id,events,started_at FROM misty_watch_buffers ORDER BY room_id').fetchall()}
assert 'apollo_codex_live_since' not in before['settings'], 'Already opted in; do not reset activation boundary'
(backup / 'before.json').write_text(json.dumps(before))
try:
    for dest, src in targets.items():
        temp = dest.with_name(dest.name + '.candidate')
        shutil.copy2(src, temp)
        temp.chmod(0o644)
        if str(dest).startswith('/opt/misty-prominence/'):
            user = pwd.getpwnam('misty-bot')
            os.chown(temp, user.pw_uid, user.pw_gid)
        os.replace(temp, dest)
        if dest.suffix == '.mjs':
            run(NODE, '--check', str(dest), capture_output=True)
    assert fork('check') == 'ok'
    init = "import {BotStore} from './app/discord-bot.mjs';import {ApolloMessenger} from './app/apollo.mjs';const s=new BotStore('/var/lib/apollo-bot/chat.sqlite');const a=new ApolloMessenger(s,{},{});console.log(JSON.stringify(a.deliveryStatus()));s.close();"
    delivery = json.loads(run('runuser', '-u', 'apollo-bot', '--', NODE,
        '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', init,
        cwd='/opt/apollo-bot', capture_output=True).stdout)
    with sqlite3.connect('file:/var/lib/apollo-bot/chat.sqlite?mode=ro', uri=True) as db:
        settings = dict(db.execute('SELECT key,value FROM bot_settings'))
        for key in ['misty_watch_cursor', 'codex_event_cursor', 'bot', 'watch_excluded_channels', 'misty_notifications_paused']:
            assert settings.get(key) == before['settings'].get(key), key
        assert db.execute('SELECT seq,source,status,message_id FROM relay_notices').fetchall() == [tuple(r) for r in before['receipts']]
        assert db.execute('SELECT room_id,events,started_at FROM misty_watch_buffers ORDER BY room_id').fetchall() == before['buffers']
    run('systemctl', 'start', 'apollo-bot')
except Exception:
    subprocess.run(['systemctl', 'stop', 'apollo-bot'], check=False)
    raise
assert digest('/etc/misty-prominence/config.json') == config_hash
fork('log', 'Owner enabled live new Codex commentary/turn-ending notices from Apollo. Discussion inbox stays store-only; models, approvals, activity and cursor/receipt state unchanged. Backup: ' + str(backup))
restart = fork('restart', 'Accurate role instructions: live Codex notices, quiet conversation inbox')
report = {'deployedAt': datetime.now(timezone.utc).isoformat(), 'backup': str(backup),
          'forkSnapshot': snapshot, 'supportedRestart': restart, 'delivery': delivery,
          'historicalReceiptsCursorsAndBuffersPreservedAtCutover': True,
          'mistyConfigUnchanged': True, 'hashes': {str(p): digest(p) for p in targets},
          'rollback': 'Restore affected source only with Apollo gracefully stopped; retain current DB/cursors/receipts. Misty uses selfupdate restart. Never overwrite live storage.'}
(STAGE / 'deployment.json').write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))
