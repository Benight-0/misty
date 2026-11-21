"""Consistent, bounded backups of the live archive, sessions and configuration."""
import datetime
from contextlib import closing
import hashlib
import json
import os
import pathlib
import shutil
import signal
import sqlite3
import tarfile
import tempfile

DIRECTORY = pathlib.Path('/var/backups/archival')
ROOT = pathlib.Path('/var/lib/archival')

def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()

def copy_database(source, target):
    print('Snapshot started:', source.name, flush=True)
    with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True, timeout=15)) as live:
        live.execute('PRAGMA cache_size=-2048')
        # Pin a WAL read snapshot so incoming messages cannot restart the copy.
        # Writers continue in WAL; the snapshot is released after this database.
        live.execute('BEGIN')
        live.execute('SELECT count(*) FROM sqlite_schema').fetchone()
        with closing(sqlite3.connect(target)) as copied:
            copied.execute('PRAGMA cache_size=-2048')
            live.backup(copied, pages=128, sleep=0.025)
            copied.execute('PRAGMA journal_mode=DELETE')
            if copied.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                raise RuntimeError('Backup database failed verification')
        live.rollback()
    print('Snapshot verified:', source.name, flush=True)

def main():
    os.umask(0o027)
    DIRECTORY.mkdir(mode=0o750, parents=True, exist_ok=True)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    filename = 'archival-' + stamp + '.tar.gz'
    destination = DIRECTORY / filename
    if destination.exists():
        raise RuntimeError('Backup filename already exists')
    partial = DIRECTORY / (filename + '.partial')
    try:
        with tempfile.TemporaryDirectory(prefix='.staging-', dir=DIRECTORY) as temporary:
            staging = pathlib.Path(temporary)
            copy_database(ROOT / 'data/archive.sqlite', staging / 'archive.sqlite')
            copy_database(ROOT / 'whatsapp.sqlite', staging / 'whatsapp.sqlite')
            config = staging / 'config'
            config.mkdir(mode=0o700)
            for name in ['discord-token', 'openai-key', 'runtime.env']:
                shutil.copyfile(pathlib.Path('/etc/archival') / name, config / name)
                os.chmod(config / name, 0o600)
            gmail_credentials = ROOT / 'gmail/credentials.json'
            if gmail_credentials.is_file():
                shutil.copyfile(gmail_credentials, config / 'gmail-credentials.json')
                os.chmod(config / 'gmail-credentials.json', 0o600)
            tunnel_token = pathlib.Path('/etc/cloudflared/archival-token')
            if tunnel_token.is_file():
                shutil.copyfile(tunnel_token, config / 'cloudflare-tunnel-token')
                os.chmod(config / 'cloudflare-tunnel-token', 0o600)
            # Include source and dependency checksums, without build caches/binaries.
            app = pathlib.Path('/opt/archival')
            for name in ['app', 'docs', 'scripts']:
                shutil.copytree(app / name, staging / name)
            collector = staging / 'collector'
            collector.mkdir()
            for name in ['main.go', 'go.mod', 'go.sum']:
                shutil.copyfile(app / 'collector-src' / name, collector / name)
            for name in ['archival.service', 'cloudflared.service', 'archival-backup.service', 'archival-backup.timer']:
                unit = pathlib.Path('/etc/systemd/system') / name
                if unit.is_file():
                    shutil.copyfile(unit, staging / name)
            manifest = {'version': 1, 'createdUTC': stamp, 'files': {}}
            for path in sorted(staging.rglob('*')):
                if path.is_file():
                    manifest['files'][path.relative_to(staging).as_posix()] = {'bytes': path.stat().st_size, 'sha256': digest(path)}
            (staging / 'manifest.json').write_text(json.dumps(manifest), encoding='utf8')
            with tarfile.open(partial, 'w:gz', compresslevel=1) as archive:
                for path in sorted(staging.iterdir()):
                    archive.add(path, arcname=path.name)
            with partial.open('rb') as output:
                os.fsync(output.fileno())
            os.chmod(partial, 0o640)
            partial.replace(destination)
        latest = {'version': 1, 'filename': filename, 'createdUTC': stamp, 'bytes': destination.stat().st_size, 'sha256': digest(destination)}
        latest_partial = DIRECTORY / 'latest.json.partial'
        latest_partial.write_text(json.dumps(latest), encoding='utf8')
        os.chmod(latest_partial, 0o640)
        latest_partial.replace(DIRECTORY / 'latest.json')
        # Retention is limited to our completed backup files in this directory.
        for old in sorted(DIRECTORY.glob('archival-*.tar.gz'), reverse=True)[3:]:
            if old.parent.resolve() != DIRECTORY.resolve() or not old.is_file():
                raise RuntimeError('Unexpected backup retention path')
            old.unlink()
        print(json.dumps(latest))
    finally:
        partial.unlink(missing_ok=True)

if __name__ == '__main__':
    def stop_backup(signum, frame):
        raise SystemExit(128 + signum)
    signal.signal(signal.SIGTERM, stop_backup)
    main()
