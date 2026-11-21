"""Read-only deployed feature verification. Never drafts, confirms or sends messages."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import urllib.error
import urllib.request

STAGE = Path('/tmp/archival-migration/misty-server-messages')
STATE = Path('/var/lib/misty-prominence')


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def data(path, query):
    with sqlite3.connect('file:' + path + '?mode=ro', uri=True) as db:
        return db.execute(query).fetchall()


def signature(path, query):
    return hashlib.sha256(json.dumps(data(path, query)).encode()).hexdigest()


def request(port, token, op, args):
    req = urllib.request.Request(f'http://127.0.0.1:{port}/call',
                                 data=json.dumps({'op': op, 'args': args}).encode(),
                                 headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=80) as response:
        return json.load(response)


def main():
    manifest = json.loads((STAGE / 'deployment.json').read_text())
    baseline = json.loads((STAGE / 'baseline.json').read_text())
    owner_baseline = json.loads((STAGE / 'owner-state-before-deploy.json').read_text())
    for name, expected in manifest['new'].items():
        assert sha(name) == expected, 'Deployed source mismatch: ' + name
    started = datetime.now(timezone.utc).isoformat()
    cmd = ['runuser', '-u', 'misty-bot', '--', 'env',
           'PROMINENCE_CONFIG=/etc/misty-prominence/config.json',
           '/opt/misty-prominence/venv/bin/python', '/opt/misty-prominence/misty.py',
           'message-inspect', '!example-room-0001:localhost', '--reply-to',
           'https://discord.com/channels/100000000000000030/100000000000000031/100000000000000079']
    result = subprocess.run(cmd, check=True, text=True, capture_output=True, timeout=90)
    inspection = json.loads(result.stdout)
    assert inspection['capability']['allowed'], inspection['capability']['reason']
    target = inspection['target']
    assert (target['guildId'], target['channelId'], target['replyTo']['messageId'], target['replyTo']['authorId']) == (
        '100000000000000030', '100000000000000031', '100000000000000079', '100000000000000040')
    assert target['mentions'] == 'suppressed'
    # These compare true historical receipts, not total archive rows/cursors that
    # continue updating normally. No original journal rows are reclassified.
    assert signature('/var/lib/archival/data/archive.sqlite', 'SELECT id,status,event_id,body FROM chat_outgoing ORDER BY id') == baseline['outgoing']
    assert signature('/var/lib/misty-bot/chat.sqlite', 'SELECT * FROM misty_message_drafts ORDER BY code') == baseline['drafts']
    auth = {}
    for port in [8792, 8795]:
        try:
            request(port, 'wrong-token', 'inspect', {})
        except urllib.error.HTTPError as error:
            assert error.code == 401
            auth[str(port)] = error.code
        else:
            raise AssertionError('Unauthenticated sender/bridge request accepted')
    reader = Path('/etc/misty-bot/apollo-reader-token').read_text().strip()
    apollo = {}
    for op in ['message_inspect', 'message_draft', 'message_confirm', 'message_status']:
        try:
            request(8794, reader, op, {})
        except urllib.error.HTTPError as error:
            assert error.code == 400
            apollo[op] = error.code
        else:
            raise AssertionError('Read-only Apollo accepted a personal-message operation')
    services = {}
    for unit in ['archival', 'misty-bot', 'misty-prominence', 'apollo-bot']:
        services[unit] = subprocess.run(['systemctl', 'is-active', unit], check=True, capture_output=True, text=True).stdout.strip()
    pids = []
    for p in Path('/proc').iterdir():
        if not p.name.isdigit():
            continue
        try:
            if b'/opt/misty-prominence/bot.py' in (p / 'cmdline').read_bytes().split(b'\0'):
                pids.append(int(p.name))
        except (OSError, PermissionError):
            pass
    assert len(pids) == 1, 'Expected exactly one existing Misty bot'
    old_pids = json.loads((STAGE / 'before-bot-pids.json').read_text())
    pending_restart = (STATE / 'restart_request.json').exists()
    trial = json.loads((STATE / 'restart_trial.json').read_text()) if (STATE / 'restart_trial.json').exists() else {}
    config = json.loads(Path('/etc/misty-prominence/config.json').read_text())
    report = {
        'started': started, 'verified': datetime.now(timezone.utc).isoformat(),
        'readOnlyCLI': 'message-inspect ROOM --reply-to MESSAGE_LINK',
        'guild': target['guildName'], 'guildId': target['guildId'],
        'channel': target['channelName'], 'channelId': target['channelId'], 'channelType': target['channelType'],
        'replyId': target['replyTo']['messageId'], 'replyAuthorId': target['replyTo']['authorId'],
        'verifiedSource': target['replyTo']['url'], 'capability': inspection['capability'],
        'pings': target['mentions'], 'outgoingJournalUnchanged': True, 'draftJournalUnchanged': True,
        'liveMessagesSentByVerification': 0, 'unauthenticatedRejected': auth, 'apolloOperationsRejected': apollo,
        'services': services, 'mistySingleBotPID': pids[0],
        'supportedRestartCompleted': not pending_restart and pids != old_pids,
        'restartTrialTime': trial.get('time'), 'mistyModel': config.get('agent_model', 'gpt-6.1-sol'), 'mistyEffort': config.get('agent_effort', 'high'),
        'protectedSourceConfigUnchanged': all((sha(p) if Path(p).is_file() else None) == expected for p, expected in baseline['protected'].items()),
        'focusUnchanged': signature(str(STATE / 'focus.sqlite'), 'SELECT * FROM focus ORDER BY id') == owner_baseline['focus'],
        'workflowsUnchanged': sha(STATE / 'workflows.json') == owner_baseline['workflows'],
        'priorOwnerStateUpdatesPreserved': manifest.get('prior_owner_state_updates', False),
        'rollback': manifest['backup'], 'deployedHashesVerified': len(manifest['new']),
    }
    (STAGE / 'verification.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report), flush=True)
    assert report['supportedRestartCompleted'], 'Supported restart still pending; wait without interrupting owner work.'
    assert report['protectedSourceConfigUnchanged'] and report['focusUnchanged'] and report['workflowsUnchanged']


if __name__ == '__main__':
    main()
