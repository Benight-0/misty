"""Live read-only state audit plus an isolated real-model fixture; no Discord sends."""
from datetime import datetime,timezone
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import time

stage=Path('/tmp/archival-migration/apollo-inbox');deployment=json.loads((stage/'deployment.json').read_text());backup=Path(deployment['backup'])
def read_db(p):return sqlite3.connect('file:'+str(p)+'?mode=ro',uri=True)
def settings(db):return {k:json.loads(v) for k,v in db.execute('SELECT key,value FROM bot_settings')}
def environment(service):
 pid=subprocess.check_output(['systemctl','show',service,'-p','MainPID','--value'],text=True).strip()
 return dict(v.split('=',1) for v in Path('/proc/'+pid+'/environ').read_bytes().decode().split('\0') if '=' in v)
env=environment('apollo-bot');runtime={k:v for k,v in env.items() if k.startswith('APOLLO_')}
assert runtime.get('APOLLO_CHAT_MODEL')==runtime.get('APOLLO_DECISION_MODEL')=='gpt-6-luna'
assert runtime.get('APOLLO_CHAT_REASONING')==runtime.get('APOLLO_DECISION_REASONING')=='none'
assert runtime.get('APOLLO_DELIVERY_MODE')=='store_only'
for attempt in range(20):
 status=json.loads(Path('/var/lib/apollo-bot/status.json').read_text())
 if status.get('connected'):break
 time.sleep(2)
assert status['connected'] and status['runtime']['deliveryMode']=='store_only'
with read_db(backup/'apollo.sqlite') as db:
 before=db.execute('SELECT seq,source,status,message_id FROM relay_notices').fetchall();oldsettings=settings(db);assert db.execute('PRAGMA quick_check').fetchone()[0]=='ok'
with read_db('/var/lib/apollo-bot/chat.sqlite') as db:
 current=settings(db)
 assert current['misty_watch_cursor']>=oldsettings['misty_watch_cursor'] and current['codex_event_cursor']>=oldsettings['codex_event_cursor']
 assert current['bot']==oldsettings['bot'] and current['watch_excluded_channels']==oldsettings['watch_excluded_channels']
 for seq,source,state,message in before:
  if state in ('sent','unknown'):assert db.execute('SELECT status,message_id FROM relay_notices WHERE seq=?',(seq,)).fetchone()==(state,message)
 maxseq=max((r[0] for r in before),default=0)
 leaked=db.execute("SELECT count(*) FROM relay_notices WHERE seq>? AND status='sent' AND source NOT LIKE 'answer:%' AND source NOT LIKE 'progress:%'",(maxseq,)).fetchone()[0];assert leaked==0
 queued=db.execute("SELECT count(*) FROM relay_notices WHERE status='queued' AND source NOT LIKE 'answer:%' AND source NOT LIKE 'progress:%'").fetchone()[0];assert queued==0
 findings=db.execute('SELECT kind,count(*) FROM apollo_findings GROUP BY kind').fetchall()
 decisions=db.execute("SELECT json_extract(decision,'$.model'),json_extract(decision,'$.reasoningEffort'),count(*) FROM misty_watch_jobs WHERE state='done' AND json_valid(decision) AND json_extract(decision,'$.model')='gpt-6-luna' GROUP BY 1,2").fetchall()
 counts={'findings':findings,'queuedBackground':queued,'newBackgroundSends':leaked,'watchCursor':current['misty_watch_cursor'],'codexCursor':current['codex_event_cursor'],'monitoringPaused':current.get('misty_notifications_paused',False),'recentDecisionModels':decisions}
commands=subprocess.check_output(['ps','-eo','args'],text=True).splitlines();watchers=sum('/opt/apollo-bot/scripts/apollo-discord-bot.mjs' in c and c.startswith('/opt/misty-bot/bin/node') for c in commands);assert watchers==1
mistyenv=environment('misty-bot');assert mistyenv['MISTY_CHAT_NOTIFICATIONS']=='off' and mistyenv['MISTY_BOT_MODEL']=='gpt-6.1-sol' and mistyenv['MISTY_BOT_REASONING']=='high'
cfg=json.loads(Path('/etc/misty-prominence/config.json').read_text());assert cfg['agent_model']=='gpt-6.1-sol' and cfg['agent_effort']=='high'
services={s:subprocess.check_output(['systemctl','is-active',s],text=True).strip() for s in ['apollo-bot','misty-bot','misty-prominence','archival','misty-activity','cloudflared','misty-metrics','misty-metrics-collect.timer']};assert set(services.values())=={'active'}
hashes={p:hashlib.sha256(Path(p).read_bytes()).hexdigest()==expected for p,expected in deployment['hashes'].items()};assert all(hashes.values())
workflows=json.loads(Path('/var/lib/misty-prominence/workflows.json').read_text())['workflows'];previous=json.loads((backup/'workflows-evidence.json').read_text())['workflows'];assert set(previous)<=set(workflows)
assert sum(w.get('kind')=='laptop_activity' for w in workflows.values())==1
oldcontext=(backup/'files/opt/misty-prominence/misty_context.py').read_text();newcontext=Path('/opt/misty-prominence/misty_context.py').read_text()
assert oldcontext.split('- focus.py:')[0]==newcontext.split('- focus.py:')[0],'Activity/personal-message instructions changed'
# LoadCredential is mounted privately inside the existing service namespace.
# Enter that filesystem for the isolated check, then drop to the same OS user.
pid=subprocess.check_output(['systemctl','show','apollo-bot','-p','MainPID','--value'],text=True).strip()
prefix=['nsenter','-t',pid,'-m','--','runuser','-u','apollo-bot','--','env']+[k+'='+v for k,v in env.items() if k.startswith('APOLLO_') or k=='CREDENTIALS_DIRECTORY']
output=subprocess.check_output(prefix+['/opt/misty-bot/bin/node','--disable-warning=ExperimentalWarning','/opt/apollo-bot/scripts/check-apollo-inbox.mjs'],text=True,timeout=150)
model=json.loads(output);assert model['ok'] and model['realDiscordSends']==0
report={'verifiedAt':datetime.now(timezone.utc).isoformat(),'effectiveProcessEnvironment':runtime,'statusRuntime':status['runtime'],
 'misty':{k:cfg[k] for k in ['agent_model','agent_effort','gate_model','social_model']},'services':services,'watcherCount':watchers,
 'storage':counts,'historicalSentAndUnknownReceiptsPreserved':True,'cursorsMonotonic':True,'identityAndExclusionsUnchanged':True,
 'workflowIDsPreserved':True,'laptopActivityAndPersonalMessageInstructionsUnchanged':True,'deployedHashesMatch':hashes,'liveModelFixture':model,'backup':str(backup)}
(stage/'verification.json').write_text(json.dumps(report,indent=2));(stage/'verification.json').chmod(0o644)
print(json.dumps(report,indent=2))
