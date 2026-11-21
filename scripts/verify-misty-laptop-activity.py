"""Private live checks; prints/saves sanitized evidence and never sends a DM."""
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
import subprocess
import urllib.error
import urllib.request

STAGE=Path('/tmp/archival-migration/misty-laptop-activity')
def stamp(value):return datetime.fromtimestamp(value/1000,timezone.utc).isoformat() if value else None
def call(op,token,args=None):
    request=urllib.request.Request('http://127.0.0.1:8797/'+op,data=json.dumps(args or {}).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(request,timeout=15) as response:return response.status,json.load(response)
    except urllib.error.HTTPError as error:return error.code,None

reader=Path('/etc/misty-bot/prominence-token').read_text().strip()
relay=Path('/var/lib/misty-bot/relay-token').read_text().strip()
with sqlite3.connect('file:/var/lib/misty-bot/chat.sqlite?mode=ro',uri=True) as db:
    worker=json.loads(db.execute("SELECT value FROM bot_settings WHERE key='relay_catalog'").fetchone()[0])['worker']
    relay_job=db.execute("SELECT status FROM relay_jobs WHERE code='5c160c6ebd'").fetchone()
code,activity=call('read',reader);assert code==200
assert not activity['status']['paused'] and activity['status']['captureAgeMs']<90000
assert activity['current'] and activity['current']['capturedAt']
sample=activity['current'];status=activity['status']
with sqlite3.connect('file:/var/lib/misty-bot/laptop-activity.sqlite?mode=ro',uri=True) as db:
    before=db.execute('SELECT count(*),max(received) FROM laptop_activity_samples').fetchone()
    receipt=db.execute('SELECT received FROM laptop_activity_samples WHERE id=?',(sample['id'],)).fetchone()[0]
code,_=call('publish',relay,{'worker':worker,'samples':[sample]});assert code==200
with sqlite3.connect('file:/var/lib/misty-bot/laptop-activity.sqlite?mode=ro',uri=True) as db:
    after=db.execute('SELECT count(*),max(received) FROM laptop_activity_samples').fetchone()
    assert db.execute('SELECT received FROM laptop_activity_samples WHERE id=?',(sample['id'],)).fetchone()[0]==receipt
assert before==after
auth={
    'unauthenticated':call('read','wrong')[0],
    'wrong_pairing':call('publish',relay,{'worker':'wrong','samples':[sample]})[0],
    'relay_cannot_read':call('read',relay)[0],
    'reader_cannot_publish':call('publish',reader,{'worker':worker,'samples':[sample]})[0],
    'invented_owner_cannot_control':call('control',reader,{'paused':True,'ownerMessageId':'invented'})[0],
}
assert auth=={'unauthenticated':401,'wrong_pairing':400,'relay_cannot_read':400,'reader_cannot_publish':400,'invented_owner_cannot_control':400}

# Read through Misty's actual CLI with the existing service environment, not a
# replacement laptop/editor session. The model fixture is ephemeral and tool-free.
pid=subprocess.check_output(['systemctl','show','misty-prominence','-p','MainPID','--value'],text=True).strip()
service_env=dict(part.split('=',1) for part in Path('/proc/'+pid+'/environ').read_bytes().decode().split('\0') if '=' in part)
env_keys=['CODEX_HOME','PATH','PROMINENCE_CONFIG','TZ','CREDENTIALS_DIRECTORY']
prefix=['runuser','-u','misty-bot','--','env']+[key+'='+service_env[key] for key in env_keys if key in service_env]
python='/opt/misty-prominence/venv/bin/python'
cli=json.loads(subprocess.check_output(prefix+[python,'/opt/misty-prominence/misty.py','activity','status'],text=True))
assert cli['workflow']['id']=='laptop-activity-15m' and cli['workflow']['schedule']=={'every':900}
assert cli['workflow']['enabled']
fixture=r'''
import json,sys,time
sys.path.insert(0,'/opt/misty-prominence')
import laptop_activity as a
live=a.request('read');context=a.load_context(live)
dry=a.run_check(dry_run=True)
fixture={'status':{'state':'active','paused':False,'captureAgeMs':1000,'receiptAgeMs':500},
 'current':{'sessionState':'active','foreground':{'application':'Code','title':'synthetic activity integration fixture'},
 'windows':[{'application':'BACKGROUND_GAME_NOT_USED'}],'chrome':{'currentTab':None,'tabs':[{'title':'INACTIVE_TAB_NOT_USED'}]}},
 'interval':{'samples':30,'activeSeconds':800,'foregroundObservations':[{'application':'Code','title':'synthetic activity integration fixture','observedSeconds':800}]}}
context['nearbyFocusReminders']=[]
result=a.decide(fixture,context,{},a.model_ask)
assert result['modelCalled'] and result['reason']!='invalid_model_decision',result
assert 'BACKGROUND_GAME_NOT_USED' not in json.dumps(a.decision_input(fixture,context))
print(json.dumps({'focusCount':len(context['focus']),'relevantNotesCount':len(context['relevantNotes']),
 'contextStorage':context['storage'],'realDryRun':dry,'syntheticModelDecision':result,'testDMsSent':0}))
'''
model=json.loads(subprocess.check_output(prefix+[python,'-c',fixture],text=True,timeout=90))
current=activity['current']
report={'capturedAt':stamp(status['capturedAt']),'receivedAt':stamp(status['receivedAt']),
 'state':status['state'],'locked':current['locked'],'idleSeconds':current['idleSeconds'],
 'foregroundApplication':(current['foreground'] or {}).get('application'),
 'openWindowCount':len(current['windows']),'openApplications':sorted(set(w['application'] for w in current['windows'])),
 'chrome':{'state':status['chrome'],'reason':status['chromeReason'],
           'tabs':len(current['chrome']['tabs']) if status['chrome']=='available' else None,
           'profiles':len(current['chrome'].get('profiles',[])),
           'windows':len(set(t['windowId'] for t in current['chrome']['tabs'])),
           'activeInWindowTabs':sum(t['activeInWindow'] for t in current['chrome']['tabs']),
           'focusedChromeWindows':len(set(t['windowId'] for t in current['chrome']['tabs'] if t['windowFocused'])),
           'currentForegroundTabKnown':bool(current['chrome'].get('currentTab')),
           'truncated':current['chrome'].get('truncated',False),'titlesAndURLsOmitted':True},
 'intervalSamples':activity['interval']['samples'],'authentication':auth,'duplicateReceiptUnchanged':True,
 'workflow':cli['workflow'],'decision':model,'existingCodexJobStatus':relay_job[0] if relay_job else None,
 'testDMsSent':0}
(STAGE/'verification.json').write_text(json.dumps(report,indent=2));(STAGE/'verification.json').chmod(0o644)
print(json.dumps(report,indent=2))
