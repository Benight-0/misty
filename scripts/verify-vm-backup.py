"""Restore-check a downloaded backup without printing messages or credentials."""
import hashlib
import datetime
from contextlib import closing
import json
import pathlib
import sqlite3
import sys
import tarfile
import tempfile

directory = pathlib.Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else pathlib.Path(__file__).resolve().parent.parent / 'data/vm-backups'
latest = json.loads((directory / 'latest.json').read_text(encoding='utf-8-sig'))
artifact = directory / latest['filename']
observed = {}
manifest = None
with tempfile.TemporaryDirectory(prefix='.restore-check-', dir=directory) as temporary:
    restore = pathlib.Path(temporary)
    with tarfile.open(artifact, 'r|gz') as archive:
        for member in archive:
            if not member.isfile():
                continue
            source = archive.extractfile(member)
            if member.name == 'manifest.json':
                manifest = json.load(source)
                continue
            digest = hashlib.sha256()
            output = (restore / member.name).open('wb') if member.name in ['archive.sqlite', 'whatsapp.sqlite'] else None
            try:
                for block in iter(lambda: source.read(1024 * 1024), b''):
                    digest.update(block)
                    if output:
                        output.write(block)
            finally:
                if output:
                    output.close()
            if member.name in observed:
                raise RuntimeError('Duplicate backup archive entry')
            observed[member.name] = {'bytes': member.size, 'sha256': digest.hexdigest()}
    if not manifest or manifest.get('version') != 1 or manifest['files'] != observed:
        raise RuntimeError('Backup file manifest does not match its contents')
    for name in ['archive.sqlite', 'whatsapp.sqlite']:
        with closing(sqlite3.connect((restore / name).as_uri() + '?mode=ro', uri=True)) as db:
            if db.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                raise RuntimeError('Restored database failed verification')
            if name == 'archive.sqlite':
                print('Restored archive messages:', db.execute('SELECT count(*) FROM messages').fetchone()[0])
                print('Restored analysis checkpoints:', db.execute('SELECT count(*) FROM briefing_history_nodes').fetchone()[0])
            else:
                print('Restored WhatsApp linked devices:', db.execute('SELECT count(*) FROM whatsmeow_device').fetchone()[0])
print('Verified backup files:', len(observed))
print('Restore check passed:', artifact.name)
(directory / 'restore-check.json').write_text(json.dumps({'filename': artifact.name, 'checkedUTC': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'files': len(observed), 'passed': True}), encoding='utf8')
