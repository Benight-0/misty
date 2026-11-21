"""Deploy the small aggregate-only dashboard. No archive/bot service restart."""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import socket
import subprocess
import tarfile
import time
import urllib.error
import urllib.request

STAGE=Path('/tmp/archival-migration/misty-metrics')
ROOT=Path('/opt/misty-metrics')
STATE=Path('/var/lib/misty-metrics')
AGENT=Path('/opt/misty-prominence/agent.py')


def run(*args,**kwargs):
    return subprocess.run(args,check=True,text=True,**kwargs)


assert hashlib.sha256(AGENT.read_bytes()).hexdigest()=='5dc0814e31c885bed469a06e72f4f18b171c8d062ff84d02f00193f91610e044', 'Agent source changed; merge before install.'
assert not ROOT.exists(), 'Already deployed; use an incremental upgrade.'
with socket.socket() as sock:
    sock.bind(('127.0.0.1',8793))
stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup=Path('/var/lib/misty-prominence')/('metrics-before-'+stamp)
backup.mkdir(mode=0o700)
shutil.copy2(AGENT,backup/'agent.py')
helper=AGENT.with_name('usage_metrics.py')
if helper.exists():shutil.copy2(helper,backup/helper.name)
candidate=STAGE/'candidate'
candidate.mkdir(exist_ok=True)
with tarfile.open(STAGE/'bundle.tar.gz') as bundle:
    for member in bundle.getmembers():
        assert member.isfile() and not Path(member.name).is_absolute() and '..' not in Path(member.name).parts
        assert member.name.startswith(('metrics/','prominence/'))
        target=candidate/member.name;target.parent.mkdir(parents=True,exist_ok=True)
        target.write_bytes(bundle.extractfile(member).read());target.chmod(0o644)
run('python3','-m','unittest','discover','-s','metrics','-p','test_metrics.py','-v',cwd=candidate)
shutil.copytree(candidate/'metrics',ROOT)
try:pwd.getpwnam('misty-metrics')
except KeyError:run('useradd','--system','--user-group','--home-dir','/nonexistent','--shell','/usr/sbin/nologin','misty-metrics')
STATE.mkdir(mode=0o711,exist_ok=True);STATE.chmod(0o711)
os.umask(0o077)
initial=run('python3',str(ROOT/'collect.py'),'--state',str(STATE),capture_output=True)
print('initial',initial.stdout.strip(),flush=True)
public=json.loads((STATE/'public/metrics.json').read_text())
assert public['usage']['records']>0 and public['usage']['estimatedUsd']>0
assert public['usage']['models'] and public['host']['diskTotalBytes']>0
serialized=json.dumps(public)
assert all(word not in serialized for word in ('sk-proj-','room_id','PRIVATE_REQUEST','/var/lib/','PRIVATE_CONTACT_MARKER'))
user=pwd.getpwnam('misty-bot')
for name in ('usage_metrics.py','agent.py'):
    temp=AGENT.parent/(name+'.metrics-candidate')
    shutil.copy2(candidate/'prominence'/name,temp);temp.chmod(0o644);os.chown(temp,user.pw_uid,user.pw_gid)
    os.replace(temp,AGENT.parent/name)
run('runuser','-u','misty-bot','--','env','PROMINENCE_CONFIG=/etc/misty-prominence/config.json',
    '/opt/misty-prominence/venv/bin/python','/opt/misty-prominence/selfupdate.py','check')

service='''[Unit]
Description=Misty public aggregate metrics dashboard
After=network.target
[Service]
Type=simple
User=misty-metrics
Group=misty-metrics
ExecStart=/usr/bin/python3 -B /opt/misty-metrics/server.py
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
InaccessiblePaths=/var/lib/archival /var/lib/misty-bot /var/lib/apollo-bot /var/lib/misty-prominence /etc/archival /etc/misty-bot /etc/apollo-bot /etc/misty-prominence /etc/cloudflared
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_UNIX
CapabilityBoundingSet=
MemoryHigh=40M
MemoryMax=64M
CPUQuota=10%
TasksMax=16
[Install]
WantedBy=multi-user.target
'''
sampler='''[Unit]
Description=Collect Misty aggregate usage and host metrics
[Service]
Type=oneshot
ExecStart=/usr/bin/python3 -B /opt/misty-metrics/collect.py
UMask=0077
Nice=15
IOSchedulingClass=idle
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/misty-metrics
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_UNIX
IPAddressDeny=any
MemoryMax=128M
CPUQuota=20%
TimeoutStartSec=45
'''
timer='''[Unit]
Description=Refresh Misty public metrics every minute
[Timer]
OnBootSec=20s
OnUnitActiveSec=60s
AccuracySec=1s
Unit=misty-metrics-collect.service
[Install]
WantedBy=timers.target
'''
for name,body in [('misty-metrics.service',service),('misty-metrics-collect.service',sampler),('misty-metrics-collect.timer',timer)]:
    target=Path('/etc/systemd/system')/name;target.write_text(body);target.chmod(0o644)
run('systemd-analyze','verify','/etc/systemd/system/misty-metrics.service','/etc/systemd/system/misty-metrics-collect.service','/etc/systemd/system/misty-metrics-collect.timer')
run('systemctl','daemon-reload')
run('systemctl','enable','--now','misty-metrics.service','misty-metrics-collect.timer')
run('systemctl','start','misty-metrics-collect.service')
for attempt in range(15):
    try:
        urllib.request.urlopen('http://127.0.0.1:8793/healthz',timeout=2).close()
        break
    except urllib.error.URLError:
        if attempt==14:raise
        time.sleep(1)
with urllib.request.urlopen('http://127.0.0.1:8793/metrics.json',timeout=5) as response:
    assert response.status==200 and 'Set-Cookie' not in response.headers
    live=json.load(response)
for route in ('/api/chats','/../../etc/passwd','/archive.sqlite','/metrics.sqlite'):
    try:urllib.request.urlopen('http://127.0.0.1:8793'+route,timeout=5)
    except urllib.error.HTTPError as error:assert error.code==404
    else:raise AssertionError('Unexpected public route')
assert run('systemctl','is-active','archival','misty-bot','misty-prominence','apollo-bot','cloudflared',capture_output=True).stdout.split()==['active']*5
report=dict(backup=str(backup),origin='http://127.0.0.1:8793',hostname='status.example.com',
            estimatedUsd=live['usage']['estimatedUsd'],records=live['usage']['records'],
            models=[r['model'] for r in live['usage']['models']],
            hashes={str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in ROOT.rglob('*') if p.is_file() and '__pycache__' not in p.parts})
(STAGE/'deployment.json').write_text(json.dumps(report,indent=2));(STAGE/'deployment.json').chmod(0o644)
print(json.dumps(report),flush=True)
