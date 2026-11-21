"""Restore visibility for historical Gmail threads after enabling VM Gmail."""
import json
from pathlib import Path
import sqlite3
import sys


ARCHIVE = '/var/lib/archival/data/archive.sqlite'
backup = Path(sys.argv[1]).resolve()
expected_threads = int(sys.argv[2])
if not backup.is_file() or backup.name != 'archive.sqlite' or not backup.parent.name.startswith('misty-gmail-before-'):
    raise RuntimeError('A verified pre-deployment archive snapshot is required.')

with sqlite3.connect(ARCHIVE, timeout=20) as db:
    db.execute('BEGIN IMMEDIATE')
    try:
        groups = db.execute("""SELECT connected,tracked,source_joined,include_profile,count(*)
            FROM conversations WHERE platform='gmail'
            GROUP BY connected,tracked,source_joined,include_profile""").fetchall()
        if groups != [(0, 0, 1, 0, expected_threads)]:
            raise RuntimeError('Gmail thread flags changed; inspect before activation.')
        before = db.execute('SELECT (SELECT count(*) FROM messages),'
                            '(SELECT count(*) FROM gmail_messages)').fetchone()
        changed = db.execute("""UPDATE conversations SET connected=1,tracked=1
            WHERE platform='gmail' AND connected=0 AND tracked=0
              AND source_joined=1 AND include_profile=0""").rowcount
        if changed != expected_threads:
            raise RuntimeError('Unexpected Gmail thread count.')
        old = db.execute("SELECT value FROM settings WHERE key='gmail_revision'").fetchone()
        revision = json.loads(old[0]) if old else 0
        db.execute("""INSERT INTO settings(key,value) VALUES('gmail_revision',?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value""", (json.dumps(revision + 1),))
        after = db.execute('SELECT (SELECT count(*) FROM messages),'
                           '(SELECT count(*) FROM gmail_messages)').fetchone()
        if after != before:
            raise RuntimeError('Message counts changed during activation.')
        db.commit()
    except Exception:
        db.rollback()
        raise
print(json.dumps({'activatedGmailThreads': changed, 'gmailMessages': after[1],
                  'totalMessages': after[0], 'profileAnalysisEnabled': 0}))
