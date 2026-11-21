"""Install a hashed, scoped Gmail bundle on the VM; run as root with a tar.gz path."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request


FILES = (
    'app/gmail.mjs',
    'app/server.mjs',
    'app/vm-server.mjs',
    'app/public/app.js',
    'scripts/misty-archive-query.py',
    'scripts/vm-backup.py',
    'docs/misty-gmail.md',
)
ROOT = Path('/opt/archival')
DB = Path('/var/lib/archival/data/archive.sqlite')
NODE = ROOT / 'bin/node'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def run(*args):
    return subprocess.run(args, check=True, text=True, capture_output=True, timeout=90)


def counts():
    with sqlite3.connect(DB) as db:
        return dict(zip(('messages', 'gmail_messages'), db.execute(
            'SELECT (SELECT count(*) FROM messages),'
            '(SELECT count(*) FROM gmail_messages)').fetchone()))


def ready():
    request = urllib.request.Request('http://127.0.0.1:8787/api/gmail',
                                     headers={'Host': 'archival.example.com'})
    try:
        urllib.request.urlopen(request, timeout=3)
        return False  # The private API must not answer an unauthenticated request.
    except urllib.error.HTTPError as error:
        return error.code == 401
    except OSError:
        return False


def main(bundle_path):
    if os.geteuid() != 0:
        raise RuntimeError('Run with VM maintenance root access.')
    with tarfile.open(bundle_path, 'r:gz') as bundle:
        members = bundle.getmembers()
        if {member.name for member in members} != {*FILES, 'manifest.json'} or not all(
                member.isfile() and member.size <= 2_000_000 for member in members):
            raise RuntimeError('Unexpected Gmail bundle contents.')
        data = {member.name: bundle.extractfile(member).read() for member in members}
    manifest = json.loads(data.pop('manifest.json'))
    if set(manifest.get('source', {})) != set(FILES) or set(manifest.get('baseline', {})) != set(FILES):
        raise RuntimeError('Unexpected Gmail manifest targets.')
    for name in FILES:
        target = ROOT / name
        if target.is_symlink():
            raise RuntimeError('Refusing symlink target: ' + name)
        current = digest(target.read_bytes()) if target.exists() else None
        if current != manifest['baseline'][name]:
            raise RuntimeError('Production file changed since review: ' + name)
        if digest(data[name]) != manifest['source'][name]:
            raise RuntimeError('Staged file differs from reviewed source: ' + name)
    if counts()['messages'] < 1:
        raise RuntimeError('Archive is unexpectedly empty.')
    if run('systemctl', 'is-active', 'archival.service').stdout.strip() != 'active':
        raise RuntimeError('Archival is not active before deployment.')
    with sqlite3.connect(DB) as db:
        if db.execute("SELECT count(*) FROM chat_outgoing WHERE status='sending'").fetchone()[0]:
            raise RuntimeError('A personal message is being sent; retry later.')
    stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
    backup = Path('/var/backups/archival') / ('misty-gmail-before-' + stamp)
    backup.mkdir(mode=0o700)
    print('Baseline verified; stopping only archival.service for a consistent archive snapshot.', flush=True)
    with tempfile.TemporaryDirectory(prefix='misty-gmail-stage-') as temporary:
        stage = Path(temporary)
        for name in FILES:
            path = stage / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data[name])
            if name.endswith('.mjs') or name.endswith('.js'):
                run(str(NODE), '--check', str(path))
            elif name.endswith('.py'):
                compile(data[name].decode('utf-8'), name, 'exec')
        installed = []
        run('systemctl', 'stop', 'archival.service')
        try:
            with sqlite3.connect(DB) as db:
                if db.execute("SELECT count(*) FROM chat_outgoing WHERE status='sending'").fetchone()[0]:
                    raise RuntimeError('A personal send was active at shutdown.')
            before = counts()
            with sqlite3.connect(DB) as source, sqlite3.connect(backup / 'archive.sqlite') as saved:
                source.backup(saved, pages=256)
                if saved.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                    raise RuntimeError('Archive backup failed integrity check.')
            print('Archive snapshot verified; installing scoped Gmail files.', flush=True)
            credentials = Path('/var/lib/archival/gmail/credentials.json')
            if credentials.is_file():
                shutil.copy2(credentials, backup / 'gmail-credentials.json')
                (backup / 'gmail-credentials.json').chmod(0o600)
            for name in FILES:
                target = ROOT / name
                if target.exists():
                    saved = backup / name
                    saved.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(target, saved)
                target.parent.mkdir(parents=True, exist_ok=True)
                pending = target.with_name(target.name + '.gmail-new')
                pending.write_bytes(data[name])
                if target.exists():
                    stat = target.stat()
                    os.chown(pending, stat.st_uid, stat.st_gid)
                    pending.chmod(stat.st_mode & 0o777)
                else:
                    pending.chmod(0o644)
                os.replace(pending, target)
                installed.append(name)
            run('systemctl', 'start', 'archival.service')
            for attempt in range(120):
                if ready():
                    break
                if attempt in (29, 59, 89):
                    print('Waiting for Archival to finish startup (' + str(attempt + 1) + 's).', flush=True)
                time.sleep(1)
            else:
                raise RuntimeError('Archival did not become ready with owner access enforced.')
            after = counts()
            if any(after[key] < before[key] for key in before):
                raise RuntimeError('Archive counts decreased after deployment.')
            if any(digest((ROOT / name).read_bytes()) != manifest['source'][name] for name in FILES):
                raise RuntimeError('Installed source hash mismatch.')
        except Exception:
            for name in reversed(installed):
                target = ROOT / name
                saved = backup / name
                if saved.exists():
                    shutil.copy2(saved, target)
                else:
                    target.unlink(missing_ok=True)
            subprocess.run(('systemctl', 'start', 'archival.service'), check=False)
            raise
    receipt = {'at': stamp, 'backup': str(backup), 'before': before, 'after': after,
               'files': {name: digest((ROOT / name).read_bytes()) for name in FILES},
               'service': run('systemctl', 'is-active', 'archival.service').stdout.strip()}
    (backup / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main(Path(sys.argv[1]))
