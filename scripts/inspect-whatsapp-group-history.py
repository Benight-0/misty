import json
import pathlib
import sqlite3
import sys

choices=json.loads(pathlib.Path('/tmp/archival-migration/whatsapp-group-choices.json').read_text())
selected=[g for g in choices['choices'] if g['treatment']=='G']
with sqlite3.connect('file:/var/lib/archival/data/archive.sqlite?mode=ro',uri=True) as db:
    for group in selected:
        rooms=db.execute("SELECT id,remote_id,name,message_count,connected,tracked FROM conversations WHERE platform='whatsapp' AND kind='group' AND (remote_id=? OR name=?)",(group['id'],group['name'])).fetchall()
        print('GROUP',json.dumps({'name':group['name'],'rooms':rooms}))
        for room in rooms:
            print('OLDEST_META',db.execute('SELECT id,sender,ts,is_me,type FROM messages WHERE room_id=? ORDER BY ts LIMIT 1',(room[0],)).fetchone())
    print('RAW_TABLE_COUNT',db.execute('SELECT count(*) FROM native_whatsapp_raw').fetchone()[0])
with sqlite3.connect('file:/var/lib/archival/whatsapp.sqlite?mode=ro',uri=True) as db:
    tables=[r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")]
    print('SESSION_TABLE_NAMES',tables)
    for name in ('message','portal','whatsapp_history_sync_conversation','whatsapp_history_sync_message'):
        if name in tables:
            print('BRIDGE_COLUMNS',name,[r[1] for r in db.execute('PRAGMA table_info('+name+')')])
    for group in selected:
        print('BRIDGE_GROUP_META',group['name'],db.execute('SELECT room_id,id,sender_id,timestamp,mxid FROM message WHERE room_id=? ORDER BY timestamp LIMIT 1',(group['id'],)).fetchone())
        print('STORED_HISTORY',group['name'],db.execute('SELECT count(*),min(timestamp),max(timestamp),max(length(data)) FROM whatsapp_history_sync_message WHERE chat_jid=?',(group['id'],)).fetchone())
if len(sys.argv)>1:
    sys.exit(0)
base=next(pathlib.Path('/home/ubuntu/go/pkg/mod/go.mau.fi').glob('whatsmeow@*'))
for filename,needles in [('send.go',['func (cli *Client) BuildHistorySyncRequest','func (cli *Client) SendPeerMessage']),('proto/waHistorySync/WAWebProtobufsHistorySync.pb.go',['type Conversation struct','type HistorySync struct'])]:
    source=base/filename
    if not source.exists():
        print('MISSING_SOURCE',filename)
        continue
    lines=source.read_text().splitlines()
    for i,line in enumerate(lines):
        if any(needle in line for needle in needles):
            print('LIBRARY',filename,'\n'.join(lines[i:i+48]))
