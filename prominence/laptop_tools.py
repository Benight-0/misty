"""Named MCP tools for Misty's own agent; authenticated loopback only, no model loop."""
import json
import os
from pathlib import Path
import sys
import time
import urllib.error
import urllib.request
import uuid

import config

HERE = Path(__file__).resolve().parent


def request(action, args=None, identity=None):
    token = Path(config.get('misty_bridge_token_file', '/run/credentials/misty-prominence.service/prominence-token')).read_text().strip()
    payload = dict(args or {})
    from conversation import current_owner_message
    source=os.environ.get('PROMINENCE_SOURCE', '')
    task_id=os.environ.get('MISTY_AGENT_TASK_ID', '')
    if source=='owner' and os.environ.get('MISTY_CONVERSATION_RUN'):
        from conversation import owner_run_info
        run=owner_run_info(os.environ['MISTY_CONVERSATION_RUN'])
        if run.get('origin')=='supervisor':
            source='supervisor';task_id=run['task_id']
    payload.update(ownerMessageId=current_owner_message(os.environ.get('MISTY_OWNER_MESSAGE_ID', '')),
                   source=source,agentTaskId=task_id)
    if identity:
        payload.update(ownerMessageId=identity.get('ownerMessageId',''),
                       source=identity.get('source',''),agentTaskId=identity.get('agentTaskId',''))
    req = urllib.request.Request('http://127.0.0.1:8798/call', data=json.dumps({'action': action, 'args': payload}).encode(),
                                 headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise ValueError(json.load(error).get('error', 'Laptop broker rejected the call')) from None


def definitions():
    return json.loads((HERE / 'laptop-tool-schemas.json').read_text())


def call_tool(name, arguments):
    args = dict(arguments)
    if name == 'laptop_status':
        return request('status')
    if name == 'laptop_task':
        action = args.pop('action')
        if action == 'control':
            args['action'] = args.pop('action_name')
        return request(action, args)
    if name == 'laptop_session':
        action = args.pop('action')
        for old, new in (('task_id','taskId'),('session_id','sessionId'),
                         ('child_agent_task_id','childAgentTaskId')):
            if old in args: args[new] = args.pop(old)
        return request('session_' + action, args)
    if name == 'laptop_result':
        return request('result', args)
    allowed = {t['name'] for t in definitions()}
    if name not in allowed:
        raise ValueError('Unknown laptop tool')
    task = args.pop('task_id')
    session = args.pop('session_id', None)
    operation = args.pop('operation_id', None) or str(uuid.uuid4())
    submitted = request('submit', {'taskId': task, 'sessionId': session,
                                   'tool': name.removeprefix('laptop_'), 'arguments': args,
                                   'operationId': operation})
    # A timeout only stops waiting. The operation/receipt remains queryable by ID.
    deadline = time.monotonic() + 50
    while time.monotonic() < deadline:
        result = request('result', {'id': submitted['id']})
        if result['state'] not in ('queued', 'executing', 'review_pending', 'reviewing'):
            if result['state'] == 'awaiting_owner':
                result['instruction'] = 'This operation was held by the former review flow. Do not resubmit it; ask the owner for a fresh instruction.'
            return result
        time.sleep(0.5)
    return {'id': submitted['id'], 'state': result['state'], 'pending': True,
            'instruction': 'Use laptop_result with this ID. Do not submit the operation again.'}


def dispatch(message):
    method = message.get('method')
    if method == 'initialize':
        return {'protocolVersion': message.get('params', {}).get('protocolVersion', '2024-11-05'),
                'capabilities': {'tools': {}}, 'serverInfo': {'name': 'misty-private-laptop-tools', 'version': '1.0.0'}}
    if method == 'ping':
        return {}
    if method == 'tools/list':
        return {'tools': definitions()}
    if method == 'tools/call':
        try:
            params = message['params']
            value = call_tool(params['name'], params.get('arguments', {}))
            output = value.get('result', {}).get('output') if isinstance(value.get('result'), dict) else None
            images = [item for item in output if isinstance(item,dict) and item.get('type')=='image'] if isinstance(output,list) else []
            if isinstance(output,dict) and output.get('image'):
                images.append({'type':'image','mimeType':output.pop('mimeType','image/jpeg'),
                               'data':output.pop('image')})
            if isinstance(output,list) and images:
                value['result']['output']=[item for item in output if item not in images]
            return {'content': [{'type': 'text', 'text': json.dumps(value, ensure_ascii=False)}] + images,
                    'isError': value.get('state') in ('failed', 'unknown', 'cancelled')}
        except Exception as error:
            return {'content': [{'type': 'text', 'text': json.dumps({'error': str(error)[:1000]})}], 'isError': True}
    raise ValueError('Unsupported MCP method')


def main(argv):
    if argv:
        if argv[0] in ('status', 'result'):
            value = request(argv[0], {'id': argv[1]} if len(argv) > 1 else {})
        elif argv[0] in ('pause', 'resume', 'cancel'):
            value = request('control', {'action': argv[0], **({'taskId': argv[1]} if len(argv) > 1 else {})})
        else:
            raise ValueError('Use status | result ID | pause [TASK] | resume [TASK] | cancel TASK')
        print(json.dumps(value, ensure_ascii=False))
        return
    # Newline-delimited stdio MCP. Notifications receive no response.
    for line in sys.stdin:
        if len(line) > 150000:
            continue
        try:
            message = json.loads(line)
            if 'id' not in message:
                continue
            try:
                response = {'jsonrpc': '2.0', 'id': message['id'], 'result': dispatch(message)}
            except Exception:
                response = {'jsonrpc': '2.0', 'id': message['id'], 'error': {'code': -32601, 'message': 'Unsupported MCP request'}}
            print(json.dumps(response, ensure_ascii=False), flush=True)
        except (ValueError, TypeError):
            continue


if __name__ == '__main__':
    main(sys.argv[1:])
