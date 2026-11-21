"""Isolated real-backend probe. Run on the VM as root; sends no Discord messages."""
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import time
import uuid

stage=Path('/tmp/archival-migration/misty-prominence')
root=Path('/opt/misty-prominence-probe')
root.mkdir(mode=0o700,exist_ok=True)
shutil.copytree(stage/'candidate/prominence',root/'source',dirs_exist_ok=True)
if not (root/'venv/bin/python').exists():shutil.copytree(stage/'venv',root/'venv',symlinks=True)
shutil.copytree(stage/'runtime',root/'runtime',dirs_exist_ok=True)
home=root/'home';home.mkdir(mode=0o700,exist_ok=True);(home/'.codex').mkdir(mode=0o700,exist_ok=True)
key=Path('/etc/archival/openai-key').read_text().strip()
auth=home/'.codex/auth.json';auth.write_text(json.dumps({'auth_mode':'apikey','OPENAI_API_KEY':key}));auth.chmod(0o600)
settings=home/'config.json';settings.write_text(json.dumps({'data_dir':str(home),'codex_bin':str(root/'runtime/bin/codex'),'agent_backend':'codex','agent_model':'gpt-6.1-sol'}));settings.chmod(0o600)
marker='MISTY_FORK_CONTEXT_4f9b';fixture=home/'fixture.txt';fixture.write_text(marker)
u=pwd.getpwnam('misty-bot')
for p in [root,*root.rglob('*')]:
    if not p.is_symlink():os.chown(p,u.pw_uid,u.pw_gid)
env={'HOME':str(home),'CODEX_HOME':str(home/'.codex'),'PROMINENCE_CONFIG':str(settings),'TOKIO_WORKER_THREADS':'2'}
base=['runuser','-u','misty-bot','--','env',*[k+'='+v for k,v in env.items()],str(root/'venv/bin/python'),str(root/'source/agent.py')]
sid=str(uuid.uuid4());start=time.monotonic()
try:
    first=subprocess.run(base+['-p','--model','gpt-6.1-sol','--effort','high','--permission-mode','bypassPermissions','--session-id',sid,'--output-format','stream-json'],input='Read '+str(fixture)+' using the shell tool. Reply exactly with its contents. Do not modify files, use web or send messages.',capture_output=True,text=True,timeout=180,cwd=home)
    print(json.dumps({'firstExit':first.returncode,'firstOutput':first.stdout[-2500:],'firstError':first.stderr[-500:]}),flush=True)
    assert first.returncode==0
    lines=[json.loads(line) for line in first.stdout.splitlines() if line.strip()]
    assert lines[-1].get('result')==marker,lines[-1]
    assert any(x.get('type')=='assistant' for x in lines),'No actual tool use was observed'
    second=subprocess.run(base+['-p','--model','gpt-6.1-sol','--effort','high','--permission-mode','bypassPermissions','--resume',sid],input='What exact marker did you just read? Reply with it only. Do not call tools.',capture_output=True,text=True,timeout=180,cwd=home)
    print(json.dumps({'resumeExit':second.returncode,'resumeOutput':second.stdout[-500:],'resumeError':second.stderr[-500:]}),flush=True)
    assert second.returncode==0 and second.stdout.strip()==marker
    third=subprocess.run(base+['-p','--model','gpt-5.6-luna','--effort','low','--tools','','--no-session-persistence'],input='Reply with exactly: MISTY_SOCIAL_OK. Do not use tools.',capture_output=True,text=True,timeout=90,cwd=home)
    assert third.returncode==0 and third.stdout.strip()=='MISTY_SOCIAL_OK',(third.returncode,third.stdout[-500:],third.stderr[-500:])
    result={'realToolUse':True,'persistentContextResume':True,'cheapSocialBackend':True,'seconds':round(time.monotonic()-start,2),'productionDiscordMessagesSent':0}
    (stage/'backend-verification.json').write_text(json.dumps(result,indent=2));print(json.dumps(result),flush=True)
finally:
    auth.unlink(missing_ok=True)
