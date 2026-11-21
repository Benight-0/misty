"""Offline, one-time notification handoff. Neither Discord API nor model calls."""
import json
import sqlite3
import sys

TABLES=('misty_watch_jobs','misty_watch_buffers','misty_watch_log','misty_server_memory')
SETTINGS=('misty_watch_cursor','misty_watch_last_poll','misty_notifications_paused')

def handoff(source, destination, identity, started_at):
    # The caller must stop the old watcher and initialize the destination schema.
    db=sqlite3.connect(destination)
    try:
        db.execute('ATTACH DATABASE ? AS old',(str(source),))
        db.execute('BEGIN IMMEDIATE')
        get=lambda key: db.execute('SELECT value FROM old.bot_settings WHERE key=?',(key,)).fetchone()
        if get('conversation_monitor') and json.loads(get('conversation_monitor')[0])=='apollo':
            raise ValueError('Notification handoff already completed; do not replay it.')
        if db.execute('SELECT 1 FROM bot_turns LIMIT 1').fetchone() or db.execute('SELECT 1 FROM relay_notices LIMIT 1').fetchone():
            raise ValueError('Apollo already has conversation data; refusing to overwrite it.')
        old_bot=json.loads(get('bot')[0])
        assert identity['id']!=old_bot['id'] and identity['channel']!=old_bot['channel']
        counts={}
        for table in TABLES:
            columns=[r[1] for r in db.execute('PRAGMA main.table_info('+table+')')]
            assert columns and columns==[r[1] for r in db.execute('PRAGMA old.table_info('+table+')')]
            db.execute('INSERT INTO main.'+table+' SELECT * FROM old.'+table)
            counts[table]=db.execute('SELECT count(*) FROM main.'+table).fetchone()[0]
        db.execute("UPDATE main.misty_watch_jobs SET state='queued' WHERE state='running'")
        for key in SETTINGS:
            value=get(key)
            if value:db.execute('INSERT OR REPLACE INTO main.bot_settings VALUES(?,?)',(key,value[0]))
        columns='source,body,status,message_id,payload'
        db.execute('INSERT INTO main.relay_notices('+columns+") SELECT "+columns+" FROM old.relay_notices WHERE source LIKE 'watch:%' ORDER BY seq")
        counts['watch_notices']=db.execute('SELECT count(*) FROM main.relay_notices').fetchone()[0]
        counts['queued_transferred']=db.execute("SELECT count(*) FROM main.relay_notices WHERE status='queued'").fetchone()[0]
        counts['uncertain_not_resent']=db.execute("SELECT count(*) FROM main.relay_notices WHERE status IN ('sending','unknown')").fetchone()[0]
        db.execute("UPDATE main.relay_notices SET status='unknown' WHERE status='sending'")
        db.execute("UPDATE old.relay_notices SET status='handed_off' WHERE source LIKE 'watch:%' AND status='queued'")
        exclusions=[old_bot['channel'],identity['channel']]
        for key,value in {
            'bot':identity,'expected_bot':identity,'started_at':started_at,
            'misty_channel':old_bot['channel'],'watch_excluded_channels':exclusions,
            'apollo_handoff':{'source':'Misty','counts':counts,'at':started_at}
        }.items():db.execute('INSERT OR REPLACE INTO main.bot_settings VALUES(?,?)',(key,json.dumps(value)))
        for key,value in {'conversation_monitor':'apollo','watch_excluded_channels':exclusions}.items():
            db.execute('INSERT OR REPLACE INTO old.bot_settings VALUES(?,?)',(key,json.dumps(value)))
        db.commit()
        return counts
    except BaseException:
        db.rollback()
        raise
    finally:db.close()

if __name__=='__main__':
    print(json.dumps(handoff(sys.argv[1],sys.argv[2],json.loads(sys.argv[3]),int(sys.argv[4]))))
