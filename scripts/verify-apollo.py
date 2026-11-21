"""Read-only deployment audit. Outputs status/receipts/hashes, never chat bodies or credentials."""
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import time

def connect(file):return sqlite3.connect('file:'+str(file)+'?mode=ro',uri=True)
def setting(db,key):
    row=db.execute('SELECT value FROM bot_settings WHERE key=?',(key,)).fetchone()
    return json.loads(row[0]) if row else None

result={'at':int(time.time()*1000),'services':{},'state':{},'hashes':{}}
for name in ['archival','misty-bot','misty-prominence','apollo-bot']:
    values=subprocess.check_output(['systemctl','show',name,'--property=ActiveState,SubState,NRestarts,MemoryCurrent'],text=True)
    result['services'][name]=dict(line.split('=',1) for line in values.splitlines() if '=' in line)
for name in ['misty-bot','apollo-bot']:
    root=Path('/var/lib')/name
    with connect(root/'chat.sqlite') as db:
        data={'identity':setting(db,'bot'),'cursor':setting(db,'misty_watch_cursor'),'lastPoll':setting(db,'misty_watch_last_poll'),'paused':bool(setting(db,'misty_notifications_paused')),'exclusions':setting(db,'watch_excluded_channels'),'watchJobs':db.execute('SELECT state,count(*) FROM misty_watch_jobs GROUP BY state').fetchall(),'partialBuffers':db.execute('SELECT count(*),coalesce(sum(json_array_length(events)),0) FROM misty_watch_buffers').fetchone(),'watchReceipts':db.execute("SELECT status,count(*) FROM relay_notices WHERE source LIKE 'watch:%' GROUP BY status").fetchall(),'turns':db.execute('SELECT status,count(*) FROM bot_turns GROUP BY status').fetchall()}
        if name=='apollo-bot':
            data['setupReceipt']=db.execute("SELECT status,message_id FROM relay_notices WHERE source LIKE 'setup:apollo-role-split:%'").fetchall()
            data['answerSources']=db.execute("SELECT count(*) FROM bot_turns WHERE status='sent' AND reply LIKE '%](https://discord.com/channels/%'").fetchone()[0]
        else:data['monitor']=setting(db,'conversation_monitor')
        result['state'][name]=data
    result['state'][name]['gateway']=json.loads((root/'status.json').read_text())
result['watcherDisabledInMisty']='MISTY_CHAT_NOTIFICATIONS=off' in subprocess.check_output(['systemctl','show','misty-bot','--property=Environment'],text=True)
result['apolloEnabled']=subprocess.check_output(['systemctl','is-enabled','apollo-bot'],text=True).strip()
for name,relatives in {
    'apollo-bot':['app/apollo.mjs','app/misty-notifications.mjs','app/misty-archive.mjs','app/discord-bot.mjs','app/openai-analysis.mjs','scripts/apollo-discord-bot.mjs'],
    'misty-bot':['app/misty-notifications.mjs','app/misty-prominence-bridge.mjs','app/misty-knowledge.mjs','app/misty-archive.mjs','scripts/misty-discord-bot.mjs'],
    'misty-prominence':['misty_context.py']
}.items():
    for relative in relatives:
        file=Path('/opt')/name/relative;result['hashes'][str(file)]=hashlib.sha256(file.read_bytes()).hexdigest()
with connect('/var/lib/archival/data/archive.sqlite') as db:
    result['excludedBotEvents']=db.execute("SELECT c.remote_id,count(*) FROM misty_message_events e JOIN conversations c ON c.id=e.room_id WHERE e.seq>428 AND c.remote_id IN (?,?) GROUP BY c.remote_id",('100000000000000046','100000000000000078')).fetchall()
assert all(s['ActiveState']=='active' for s in result['services'].values())
assert result['watcherDisabledInMisty'] and result['apolloEnabled']=='enabled'
assert all(result['state'][n]['gateway']['connected'] for n in ['misty-bot','apollo-bot'])
assert result['state']['misty-bot']['cursor']==428
assert result['state']['apollo-bot']['cursor']>=430
assert time.time()*1000-result['state']['apollo-bot']['lastPoll']<20000
assert result['state']['apollo-bot']['setupReceipt'][0][0]=='sent'
print(json.dumps(result))
