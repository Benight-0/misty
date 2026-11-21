"""Scoped, read-only live runtime/MCP verification. Does not start an agent/session."""
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
SSH = ['ssh', '-F', str(ROOT / 'data/deployment/ssh_config'), 'archival-vm']
REMOTE = r'''
from datetime import datetime, timezone
import json, os, pathlib, subprocess
P = pathlib.Path
def run(*args):
    return subprocess.run(args, text=True, capture_output=True, check=True).stdout.strip()
pid = int(run('systemctl', 'show', 'misty-prominence', '-p', 'MainPID', '--value'))
env = dict(x.split('=',1) for x in P(f'/proc/{pid}/environ').read_bytes().decode().split('\0') if '=' in x)
state = P('/var/lib/misty-prominence')
boot = int(next(line.split()[1] for line in P('/proc/stat').read_text().splitlines() if line.startswith('btime ')))
report = {'observedUTC': datetime.now(timezone.utc).isoformat(), 'supervisorPID': pid,
 'services': {s: run('systemctl','is-active',s) for s in ['misty-prominence','misty-bot','apollo-bot','archival','misty-activity','misty-laptop-tools']},
 'pendingRestart': json.loads((state/'restart_request.json').read_text()) if (state/'restart_request.json').exists() else None,
 'trial': json.loads((state/'restart_trial.json').read_text()) if (state/'restart_trial.json').exists() else None,
 'ownerAskPending': (state/'ask.json').exists(), 'runtime': []}
for p in P('/proc').iterdir():
    if not p.name.isdigit(): continue
    try:
        cmd = (p/'cmdline').read_bytes().split(b'\0')
        if any(x.endswith(b'/bot.py') or x == b'bot.py' for x in cmd):
            start = boot + int((p/'stat').read_text().rsplit(')',1)[1].split()[19])/os.sysconf('SC_CLK_TCK')
            report['runtime'].append({'pid':int(p.name),'startedUTC':datetime.fromtimestamp(start,timezone.utc).isoformat(),
                'startedAfterToolInstructionsInstalled': start > P('/opt/misty-prominence/misty_context.py').stat().st_mtime})
    except (FileNotFoundError,PermissionError,ProcessLookupError): pass
logs = run('journalctl','-u','misty-prominence','--since','2026-10-24 17:48:00 UTC','--no-pager','-o','cat')
report['restartLog'] = [line[:500] for line in logs.splitlines() if line.startswith('restarting for an update:') or line.startswith('[supervise]')][-12:]
report['privateListener'] = [line.strip() for line in run('ss','-ltnp').splitlines() if ':8798 ' in line]
inner = r"""
import json, os, pathlib, subprocess, sys
sys.path.insert(0,'/opt/misty-prominence')
import agent, config
args = agent.options(['--permission-mode','bypassPermissions','--effort',str(config.get('agent_effort','low'))])
previous = os.environ.get('PROMINENCE_SOURCE')
os.environ['PROMINENCE_SOURCE']='owner'
cmd = agent.command(args, 'existing-session-verification-placeholder')
overrides=[]
for i,value in enumerate(cmd):
    if value=='-c' and cmd[i+1].startswith('mcp_servers.misty_laptop.'):
        overrides.extend(['-c',cmd[i+1]])
get = subprocess.run([config.CODEX, *overrides, 'mcp','get','misty_laptop','--json'],text=True,capture_output=True,timeout=20)
p = subprocess.Popen([sys.executable,'/opt/misty-prominence/laptop_tools.py'],text=True,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
def rpc(i,method,params=None):
    p.stdin.write(json.dumps({'jsonrpc':'2.0','id':i,'method':method,'params':params or {}})+'\n');p.stdin.flush()
    return json.loads(p.stdout.readline())
init=rpc(1,'initialize',{'protocolVersion':'2024-11-05','capabilities':{},'clientInfo':{'name':'deployment-verifier','version':'1'}})
tools=rpc(2,'tools/list')
status=rpc(3,'tools/call',{'name':'laptop_status','arguments':{}})
denial=rpc(4,'tools/call',{'name':'laptop_task','arguments':{'action':'start','workspace':r'C:\Users\Public\Downloads\misty','objective':'Admission negative verification only; no owner id supplied','write':False,'commands':False}})
p.stdin.close();p.wait(timeout=10)
value=json.loads(status['result']['content'][0]['text'])
print(json.dumps({'model':cmd[cmd.index('-m')+1], 'effort':args.effort,'enabled':config.get('laptop_tools_enabled'),
 'existingSessionPreserved':cmd[-2:]==['resume','existing-session-verification-placeholder'],
 'codexMcpGetExit':get.returncode,'codexMcpConfig':json.loads(get.stdout) if get.returncode==0 else get.stderr[:500],
 'mcpInitialize':init['result']['serverInfo'],'mcpTools':[t['name'] for t in tools['result']['tools']],
 'mcpStatus':value,'mcpStatusIsError':status['result'].get('isError',False),
 'unrecordedOwnerAdmissionDenied':denial['result'].get('isError',False),
 'unrecordedOwnerAdmission':json.loads(denial['result']['content'][0]['text'])},ensure_ascii=False))
"""
command=['/usr/bin/nsenter','--target',str(pid),'--mount','--','/usr/sbin/runuser','-u','misty-bot','--preserve-environment','--','/opt/misty-prominence/venv/bin/python','-']
r=subprocess.run(command, input=inner,text=True,capture_output=True,env={**os.environ,**env},timeout=40)
if r.returncode:
    report['mcpFailure']={'code':r.returncode,'stderr':r.stderr[-1500:]}
else: report['mcp']=json.loads(r.stdout)
print(json.dumps(report,indent=2))
'''


if __name__ == '__main__':
    result = subprocess.run([*SSH, 'sudo python3 -'], input=REMOTE, text=True, capture_output=True, timeout=70)
    if result.returncode:
        raise SystemExit(result.stderr)
    report = json.loads(result.stdout)
    target = ROOT / 'data/deployment/laptop-tools/runtime-verification.json'
    target.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, indent=2))
