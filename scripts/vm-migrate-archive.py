"""Initial migration only. Keep the complete original snapshot for rollback."""
import json, os, pathlib, pwd, sqlite3, tarfile
root=pathlib.Path('/var/lib/archival')
destination=root/'data/archive.sqlite'
if destination.exists():
    raise RuntimeError('Archive already exists; refusing to replace it')
with tarfile.open('/tmp/archival-migration/archive.tar.gz') as archive:
    members=archive.getmembers()
    if len(members)!=1 or not members[0].isfile() or not members[0].name.endswith('.sqlite'):
        raise RuntimeError('Unexpected archive content')
    with archive.extractfile(members[0]) as source, destination.open('xb') as output:
        import shutil
        shutil.copyfileobj(source,output)
account=pwd.getpwnam('archival')
os.chmod(destination,0o600);os.chown(destination,account.pw_uid,account.pw_gid)
with sqlite3.connect(destination) as db:
    if db.execute('PRAGMA quick_check').fetchone()[0]!='ok':raise RuntimeError('Archive check failed')
    scope="((platform='discord' AND server_id='' AND kind IN ('dm','group')) OR (platform='whatsapp' AND kind='dm'))"
    preferences=[dict(zip(['id','connected','tracked','include_profile'],row)) for row in db.execute('SELECT id,connected,tracked,include_profile FROM conversations')]
    db.execute('INSERT OR REPLACE INTO settings VALUES(?,?)',('pre_vm_conversation_preferences',json.dumps(preferences)))
    db.execute('UPDATE conversations SET connected=0,tracked=0,include_profile=0 WHERE NOT '+scope)
    print('Eligible private chats:',db.execute('SELECT count(*) FROM conversations WHERE '+scope).fetchone()[0])
    print('Eligible private messages:',db.execute('SELECT count(*) FROM messages m JOIN conversations c ON c.id=m.room_id WHERE '+scope).fetchone()[0])
    print('Non-private archive preserved, collection paused.')
