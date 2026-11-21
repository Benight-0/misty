"""Run an isolated real owner-loop check without a Discord sender or live inbox.

Usage on the VM:
  PROMINENCE_CONFIG=/etc/misty-prominence/config.json \
  CODEX_HOME=/var/lib/misty-prominence/.codex \
  python3 verify-misty-owner-loop.py --source /opt/misty-prominence
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import uuid


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--source',required=True)
    args=parser.parse_args()
    source=Path(args.source).resolve()
    sys.path.insert(0,str(source))
    import config
    import conversation as c
    import fork_state

    with tempfile.TemporaryDirectory(prefix='misty-owner-loop-check-') as directory:
        config.DATA_DIR=directory
        owner=config.OWNER_ID
        marker=Path(directory)/'command-ran.txt'
        prompt=(f'This is an isolated implementation test. Execute the harmless VM shell '
                f'command printf owner_loop_ok > {marker}. Then use '
                'misty_conversation.publish_message with text HOOK_OK and '
                'idempotency_key hook-ok. Return after that. No Discord dispatcher is '
                'active. Do not contact people or websites.')
        message={'id':'100000000000000024','channel_id':'isolated-owner-check',
                 'author':{'id':owner},'content':prompt}
        fork_state.enqueue([message])
        fork_state.begin([message])
        run=c.start(message['channel_id'],owner,[message['id']])
        environment={**os.environ,'PROMINENCE_DATA_DIR':directory,
                     'PROMINENCE_SOURCE':'owner','MISTY_CONVERSATION_RUN':run,
                     'MISTY_OWNER_MESSAGE_ID':message['id'],
                     'MISTY_OWNER_ACCOUNT_ID':owner,
                     'MISTY_OWNER_CHANNEL_ID':message['channel_id']}
        command=[sys.executable,str(source/'agent.py'),'-p','--model',
                 config.CLAUDE_MODEL,'--effort',config.get('agent_effort','high'),
                 '--permission-mode','bypassPermissions','--session-id',str(uuid.uuid4()),
                 '--append-system-prompt','Isolated authorized test. Use only the requested '
                 'harmless command and conversation tools.','--output-format','stream-json']
        result=subprocess.run(command,input=prompt,text=True,capture_output=True,
                              timeout=180,env=environment)
        with c.connection() as con:
            c.schema(con)
            messages=con.execute('SELECT body,state FROM conversation_outbox WHERE run=? '
                                 'ORDER BY id',(run,)).fetchall()
            review_table=con.execute("SELECT 1 FROM sqlite_master WHERE name='vm_tool_audit'").fetchone()
        report={'exit':result.returncode,
                'command_marker':marker.read_text() if marker.exists() else None,
                'outbox_messages':messages,'review_table':bool(review_table),
                'run_state':c.run_info(run)['state'],
                'stderr_tail':result.stderr[-400:]}
        print(json.dumps(report))
        assert result.returncode==0,report
        assert report['command_marker']=='owner_loop_ok',report
        assert any(body=='HOOK_OK' for body,_ in messages),report
        assert not review_table,report
        assert report['run_state']=='idle',report


if __name__=='__main__':
    main()
