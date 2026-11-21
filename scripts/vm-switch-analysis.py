"""Deploy the authorized Luna switch, preserving configuration and saved work."""
import datetime
import grp
import hashlib
import json
import os
import pathlib
import shutil
import sqlite3
import subprocess
import tarfile

os.umask(0o077)
root = pathlib.Path('/opt/archival')
archive = pathlib.Path('/tmp/archival-migration/luna-update.tar.gz')
runtime = pathlib.Path('/etc/archival/runtime.env')
files = ['app/vm-server.mjs', 'app/briefings.mjs', 'app/briefing-history.mjs', 'scripts/migrate-analysis-model.mjs', 'scripts/check-analysis-model.mjs', 'docs/vm-deployment.md']
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup = pathlib.Path('/var/lib/archival/model-switch-' + stamp)
backup.mkdir(mode=0o700)

def metadata():
    with sqlite3.connect('file:/var/lib/archival/data/archive.sqlite?mode=ro', uri=True) as db:
        notes = {(room, key): hashlib.sha256(payload.encode()).hexdigest() for room, key, payload in db.execute('SELECT room_id,hash,payload FROM briefing_history_nodes')}
        summaries = {(room, revision): hashlib.sha256(payload.encode()).hexdigest() for room, revision, payload in db.execute('SELECT room_id,revision,payload FROM chat_briefings')}
        return notes, summaries, db.execute('SELECT count(*),sum(is_me) FROM messages').fetchone()

with tarfile.open(archive) as bundle:
    members = {member.name: member for member in bundle.getmembers()}
    if set(members) != set(files) or any(not member.isfile() for member in members.values()):
        raise SystemExit('Unexpected deployment files; running service was preserved.')

previous = {}
for name in files:
    path = root / name
    previous[name] = path.exists()
    if path.exists():
        saved = backup / name
        saved.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, saved)
shutil.copy2(runtime, backup / 'runtime.env')
subprocess.run(['systemctl', 'stop', 'archival'], check=True)
try:
    before, summaries, messages = metadata()
    with tarfile.open(archive) as bundle:
        for name in files:
            destination = root / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            with bundle.extractfile(name) as source, destination.open('wb') as target:
                shutil.copyfileobj(source, target)
            os.chown(destination, 0, 0)
            os.chmod(destination, 0o644)
    subprocess.run(['runuser', '-u', 'archival', '--', '/opt/archival/bin/node', '--max-old-space-size=384', '--expose-gc', '--disable-warning=ExperimentalWarning', '/opt/archival/scripts/migrate-analysis-model.mjs', '/var/lib/archival/data/archive.sqlite', 'gpt-5.4-mini', 'gpt-5.6-luna'], check=True, timeout=300)
    after, new_summaries, new_messages = metadata()
    if any(after.get(key) != value for key, value in before.items()) or summaries != new_summaries or messages != new_messages:
        raise RuntimeError('Archive preservation check did not pass.')
    lines = [line for line in runtime.read_text().splitlines() if not line.startswith('ARCHIVAL_MODEL=')]
    temporary = runtime.with_suffix('.env.pending')
    temporary.write_text('\n'.join(lines + ['ARCHIVAL_MODEL=gpt-5.6-luna']) + '\n')
    os.chown(temporary, 0, grp.getgrnam('archival').gr_gid)
    os.chmod(temporary, 0o640)
    temporary.replace(runtime)
    subprocess.run(['systemctl', 'start', 'archival'], check=True)
    print(json.dumps({'model': 'gpt-5.6-luna', 'original_checkpoints_preserved': len(before), 'reused_checkpoint_aliases': len(after)-len(before), 'published_summaries_preserved': len(summaries), 'messages_preserved': messages[0], 'rollback_directory': str(backup)}))
except BaseException:
    for name in files:
        if previous[name]:
            shutil.copy2(backup / name, root / name)
    shutil.copy2(backup / 'runtime.env', runtime)
    subprocess.run(['systemctl', 'start', 'archival'], check=False)
    raise
