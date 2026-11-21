"""Run on the Linux VM as root; never emit credential values."""
import os
import pathlib
import pwd
import sqlite3

staging = pathlib.Path('/tmp/archival-migration')
target = pathlib.Path('/var/lib/archival')
account = pwd.getpwnam('archival')
for source_name, destination_name in [('bridge.db', 'whatsapp.sqlite'), ('discord.db', 'discord-migration.sqlite')]:
    source = sqlite3.connect(str(staging / source_name))
    if source.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
        raise RuntimeError('Session database integrity check failed')
    destination = target / destination_name
    if destination.exists():
        raise RuntimeError('Refusing to overwrite an existing migrated session')
    with sqlite3.connect(str(destination)) as copied:
        source.backup(copied)
    source.close()
    os.chmod(destination, 0o600)
    os.chown(destination, account.pw_uid, account.pw_gid)
    with sqlite3.connect(str(destination)) as copied:
        print(destination_name, 'verified')
        for table in ['user', 'message', 'user_login', 'whatsmeow_device', 'whatsmeow_version']:
            columns = [row[1] for row in copied.execute('PRAGMA table_info(' + table + ')')]
            if columns:
                print(table, columns)
        if source_name == 'discord.db':
            row = copied.execute('SELECT discord_token FROM user WHERE mxid=?', ('@owner:localhost',)).fetchone()
            if not row or not row[0]:
                raise RuntimeError('Existing Discord session token not found')
            secret = pathlib.Path('/etc/archival/discord-token')
            with secret.open('x') as output:
                output.write(row[0])
            os.chmod(secret, 0o640)
            os.chown(secret, 0, account.pw_gid)
            print('Discord credential saved privately.')
