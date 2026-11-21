"""One explicit deployment-verification file read, through the real private worker.

The fixture is administratively queued in ONLY the new tooling database. It is
labelled deployment-verification, not a fabricated Discord owner message. Normal
owner admission is tested separately; this adds no production authorization path.
No model, Codex session, contact message, shell command or file edit is requested.
"""
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import time
import uuid

spec = importlib.util.spec_from_file_location('verify_laptop_tools', Path(__file__).with_name('verify-misty-laptop-tools.py'))
verification = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verification)
RUNTIME, ROOT, SSH = verification.REMOTE, verification.ROOT, verification.SSH


def remote(code):
    result = subprocess.run([*SSH, 'sudo python3 -'], input=code, text=True, capture_output=True, timeout=65)
    if result.returncode:
        raise RuntimeError(result.stderr[-1500:])
    return result.stdout


if __name__ == '__main__':
    operation_id, task_id = str(uuid.uuid4()), str(uuid.uuid4())
    fixture = ROOT / 'tooling/laptop-tools-smoke.txt'
    assert not fixture.exists(), 'Refuse to overwrite an existing file.'
    content = ('Misty laptop tools deployment verification\nOperation: ' + operation_id + '\n').encode()
    fixture.write_bytes(content)
    expected = hashlib.sha256(content).hexdigest()
    queued_at = datetime.now(timezone.utc).isoformat()
    js = '''
import {DatabaseSync} from 'node:sqlite';
import {digest} from '/opt/misty-bot/app/laptop-tools-broker.mjs';
const db=new DatabaseSync('/var/lib/misty-bot/laptop-tools.sqlite'); db.exec('PRAGMA busy_timeout=5000');
const now=Date.now(),expires=now+120000;
const task={workspace:WORKSPACE,objective:'Deployment verification: read only tooling/laptop-tools-smoke.txt for the current owner-approved implementation',ownerMessageId:'deployment-verification:OPERATION',write:false,commands:false};
const resolved={...task,id:TASK,paused:false,expires};
const op={id:OPERATION,task:resolved,tool:'read_files',args:{files:[{path:'tooling/laptop-tools-smoke.txt'}]},expires};op.hash=digest({task:op.task,tool:op.tool,args:op.args});
db.prepare("INSERT INTO work_tasks VALUES(?,?,?,?,?,'active',?)").run(TASK,task.ownerMessageId,task.objective,task.workspace,JSON.stringify(task),expires);
db.prepare("INSERT INTO work_operations VALUES(?,?,?,?,?,'queued',NULL,?,?)").run(OPERATION,TASK,op.tool,JSON.stringify(op),op.hash,now,now);
db.close();console.log(JSON.stringify({id:OPERATION,task:TASK,queuedAt:now,hash:op.hash}));
'''.replace("'deployment-verification:OPERATION'", json.dumps('deployment-verification:' + operation_id))
    js = js.replace('WORKSPACE', json.dumps(str(ROOT))).replace('OPERATION', json.dumps(operation_id)).replace('TASK', json.dumps(task_id))
    setup = 'import subprocess\nr=subprocess.run(["/opt/misty-bot/bin/node","--input-type=module","-"],input=' + repr(js) + ',text=True,capture_output=True,check=True)\nprint(r.stdout)\n'
    receipt = json.loads(remote(setup))
    report = {'kind': 'explicit deployment verification, not an owner-message approval', 'operationId': operation_id,
              'taskId': task_id, 'localQueuedUTC': queued_at, 'expectedSHA256': expected, 'queued': receipt}
    try:
        query = f'''
import sqlite3,json
with sqlite3.connect('file:/var/lib/misty-bot/laptop-tools.sqlite?mode=ro',uri=True) as db:
 db.row_factory=sqlite3.Row
 row=dict(db.execute('SELECT id,state,result,created,updated FROM work_operations WHERE id=?',({operation_id!r},)).fetchone())
 row['result']=json.loads(row['result']) if row['result'] else None
 print(json.dumps(row))
'''
        for attempt in range(20):
            result = json.loads(remote(query))
            if result['state'] not in ('queued', 'executing'):
                break
            time.sleep(1)
        report['receipt'] = result
        assert result['state'] == 'succeeded', result
        output = result['result']['output'][0]['result']
        assert operation_id in output and 'Misty laptop tools deployment verification' in output
        assert expected in result['result']['evidence'].values()
        # The normal MCP reader uses the service's existing credential mount.
        probe = RUNTIME.replace("{'name':'laptop_status','arguments':{}}", "{'name':'laptop_result','arguments':{'id':" + repr(operation_id) + "}}")
        probe_report = json.loads(remote(probe))
        mcp_result = probe_report['mcp']['mcpStatus']
        assert not probe_report['mcp']['mcpStatusIsError'] and mcp_result['id'] == operation_id
        assert mcp_result['state'] == 'succeeded'
        report['mcpReceiptReadUTC'] = probe_report['observedUTC']
        report['mcpReceiptReadMatches'] = mcp_result['result'] == result['result']
        report['verified'] = True
    finally:
        # Remove only our own known fixture; retain all journals and receipts.
        if fixture.exists() and fixture.read_bytes() == content:
            fixture.unlink()
        report['finishedUTC'] = datetime.now(timezone.utc).isoformat()
        (ROOT / 'data/deployment/laptop-tools/live-fixture.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, indent=2))
