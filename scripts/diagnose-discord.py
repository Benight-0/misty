"""Read only from a Linux mount. Never print authentication credentials."""
import json, os, sqlite3, sys, urllib.request, urllib.error

path='/database/bridge.db' if os.path.exists('/database/bridge.db') else '/data/bridge.db'
with sqlite3.connect('file:'+path+'?mode=ro', uri=True) as db:
    db.row_factory=sqlite3.Row
    print(json.dumps({'schema': {t:[r[1] for r in db.execute('PRAGMA table_info("'+t+'")')] for t in ['user','portal','message']}}))
    print(json.dumps({'portal':[dict(r) for r in db.execute('SELECT dcid,receiver,type,other_user_id,mxid,name,first_event_id FROM portal WHERE dcid=?',('100000000000000029',))]}))
    print(json.dumps({'messages':[dict(r) for r in db.execute('SELECT dcid,dc_sender,timestamp,mxid,sender_mxid FROM message WHERE dc_chan_id=? ORDER BY timestamp DESC LIMIT 6',('100000000000000029',))]}))
    if '--remote' in sys.argv:
        token=db.execute('SELECT discord_token FROM user WHERE mxid=?',('@owner:localhost',)).fetchone()[0]
        known={r[0]:r[1] for r in db.execute('SELECT dcid,mxid FROM message WHERE dc_chan_id=?',('100000000000000029',))}

if '--remote' in sys.argv:
    req=urllib.request.Request('https://discord.com/api/v9/channels/100000000000000029/messages?limit=100',headers={'Authorization':token,'User-Agent':'Mozilla/5.0'})
    try:
        with urllib.request.urlopen(req,timeout=30) as response:
            messages=json.load(response)
        with open('/out/rumal-remote.json','w') as output: json.dump(messages,output)
        with open('/out/rumal-verification.json','w') as output: json.dump([{'discord_id':m['id'],'matrix_id':known.get(m['id']),'own':m.get('author',{}).get('id')=='100000000000000023'} for m in messages],output)
        print(json.dumps({'remote_count':len(messages),'missing_in_bridge':sum(m['id'] not in known for m in messages),'latest': [{'id':m['id'],'timestamp':m['timestamp'],'own':m.get('author',{}).get('id')=='100000000000000023','in_bridge':m['id'] in known} for m in messages[:8]]}))
    except urllib.error.HTTPError as error:
        print(json.dumps({'remote_http_status':error.code}));sys.exit(1)
