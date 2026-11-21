"""Task-scoped MCP handoff tools; specialists cannot publish to the owner."""
import json
import sys

import agent_tasks


def definitions():
    specs = [
        ('save_checkpoint', 'Save objective state and operation receipt IDs before a pause or risky continuation.',
         {'state': {'type': 'object', 'additionalProperties': True}}, ['state']),
        ('complete_task', 'Return verified findings or completed work to Misty. Do not claim success without evidence.',
         {'summary': {'type': 'string'}, 'evidence': {'type': 'array', 'items': {'type': 'string'}}}, ['summary', 'evidence']),
        ('ask_misty', 'Return a question or blocker to Misty; do not contact the owner directly.',
         {'question': {'type': 'string'}, 'state': {'type': 'object', 'additionalProperties': True}}, ['question', 'state']),
        ('record_decision', 'Record a concise decision and its reason for the supervisor trace.',
         {'decision': {'type': 'string'}, 'reason': {'type': 'string'}}, ['decision', 'reason']),
        ('delegate_task', 'Supervisor only: assign a coding, analysis or Misty task with a stable key.',
         {'role': {'type': 'string', 'enum': ['coding','analysis','misty']},
          'objective': {'type': 'string'}, 'project': {'type': 'string'},
          'success': {'type': 'string'}, 'context': {'type': 'object', 'additionalProperties': True},
         'idempotency_key': {'type': 'string'}}, ['role','objective','success','idempotency_key']),
        ('publish_owner', 'Supervisor only: queue one useful, non-repetitive Misty DM notice to the owner.',
         {'text': {'type': 'string'}, 'idempotency_key': {'type': 'string'}},
         ['text','idempotency_key']),
        ('project_prepare', 'Prepare an isolated worktree in a registered owned project for this task. A supervisor run may name the registered project to bind itself first.',
         {'project': {'type': 'string'}}, []),
        ('project_publish', 'Run registered checks and push a reviewed task branch; never deploy without a verified release recipe.', {}, []),
        ('project_release', 'Run the registered reversible release and health check, with rollback on failure.', {}, []),
    ]
    return [{'name': name, 'description': description,
             'inputSchema': {'type': 'object', 'properties': properties,
                             'required': required, 'additionalProperties': False}}
            for name, description, properties, required in specs]


def call_tool(name, args):
    task = agent_tasks.active_from_environment()
    task_id = task['id']
    if task['role']=='supervisor':
        import config
        if config.enabled('supervisor_read_only',True) and name in (
                'delegate_task','publish_owner','project_prepare','project_publish','project_release','ask_misty'):
            raise ValueError('Supervisor is in read-only rollout mode')
    if name == 'save_checkpoint':
        agent_tasks.checkpoint(task_id, args['state'])
        return {'saved': True, 'taskId': task_id}
    if name == 'complete_task':
        agent_tasks.finish(task_id, 'completed', args['summary'], args['evidence'])
        return {'completed': True, 'taskId': task_id}
    if name == 'ask_misty':
        agent_tasks.checkpoint(task_id, args['state'])
        agent_tasks.finish(task_id, 'waiting', args['question'])
        return {'waiting': True, 'taskId': task_id}
    if name == 'record_decision':
        agent_tasks.record(task_id, 'decision', json.dumps(args, ensure_ascii=False))
        return {'recorded': True}
    if name == 'delegate_task' and task['role'] == 'supervisor':
        child = agent_tasks.submit(args['role'], args['objective'], origin='supervisor',
                                   task_key='supervisor:'+task_id+':'+args['idempotency_key'],
                                   project=args.get('project',''), success=args.get('success',''),
                                   context=args.get('context',{}))
        return {'taskId':child['id'],'state':child['state']}
    if name == 'publish_owner' and task['role'] == 'supervisor':
        import conversation
        return conversation.queue_background(args['idempotency_key'],args['text'])
    if name in ('project_prepare','project_publish','project_release'):
        import agent_projects
        if name=='project_prepare' and task['role']=='supervisor' and args.get('project'):
            task=agent_tasks.bind_project(task_id,args['project'])
        elif name=='project_prepare' and args.get('project') and args['project']!=task['project']:
            raise ValueError('Task is bound to another project')
        return {'project_prepare':agent_projects.prepare,
                'project_publish':agent_projects.publish,
                'project_release':agent_projects.release}[name](task)
    raise ValueError('Unknown task tool')


def main():
    for line in sys.stdin:
        try:
            request = json.loads(line)
            if 'id' not in request:
                continue
            method = request.get('method')
            if method == 'initialize':
                result = {'protocolVersion': request.get('params', {}).get('protocolVersion', '2024-11-05'),
                          'capabilities': {'tools': {}}, 'serverInfo': {'name': 'misty-task', 'version': '1.0'}}
            elif method == 'ping':
                result = {}
            elif method == 'tools/list':
                result = {'tools': definitions()}
            elif method == 'tools/call':
                try:
                    value = call_tool(request['params']['name'], request['params'].get('arguments', {}))
                    result = {'content': [{'type': 'text', 'text': json.dumps(value)}]}
                except Exception as error:
                    result = {'content': [{'type': 'text', 'text': str(error)[:500]}], 'isError': True}
            else:
                raise ValueError('Unsupported method')
            response = {'jsonrpc': '2.0', 'id': request['id'], 'result': result}
        except Exception as error:
            response = {'jsonrpc': '2.0', 'id': request.get('id'), 'error': {'code': -32602, 'message': str(error)[:500]}}
        print(json.dumps(response), flush=True)


if __name__ == '__main__':
    main()
