"""Offline owner Discord logout; run in a network-disabled SQLite helper.

Retains identity/portal/message rows and clears only the owner's token and gateway
resume state. The bridge must be stopped. No credentials are printed or backed up.
"""
import json
from pathlib import Path
import sqlite3


def logout(path):
    assert path.is_file(), 'Expected bridge database missing: ' + str(path)
    with sqlite3.connect(str(path), timeout=20) as db:
        db.execute('PRAGMA busy_timeout=20000')
        owner = db.execute('SELECT dcid FROM user WHERE mxid=?', ('@owner:localhost',)).fetchone()
        assert owner and owner[0] == '100000000000000023', 'Database does not match expected owner'
        counts = {table: db.execute('SELECT count(*) FROM ' + table).fetchone()[0]
                  for table in ['user', 'portal', 'message']}
        before = db.execute("SELECT discord_token IS NOT NULL AND discord_token<>'' FROM user WHERE mxid=?",
                            ('@owner:localhost',)).fetchone()[0]
        db.execute('UPDATE user SET discord_token=NULL, heartbeat_session=NULL WHERE mxid=? AND dcid=?',
                   ('@owner:localhost', '100000000000000023'))
        db.commit()
        assert db.execute('PRAGMA quick_check').fetchone()[0] == 'ok'
        assert counts == {table: db.execute('SELECT count(*) FROM ' + table).fetchone()[0] for table in counts}
        assert db.execute('SELECT discord_token,heartbeat_session FROM user WHERE mxid=?',
                          ('@owner:localhost',)).fetchone() == (None, None)
        return {'database': str(path), 'loginPreviouslySaved': bool(before), 'loginPresent': False,
                'gatewayResumeStatePresent': False, 'integrity': 'ok', 'preservedCounts': counts}


if __name__ == '__main__':
    paths = [Path('/database/bridge.db'), Path('/legacy/bridge.db')]
    print(json.dumps({'logout': [logout(path) for path in paths]}))
