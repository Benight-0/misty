"""Owner-only MCP publishing/checkpoint tools for the duplex agent."""
import json
import os
import sys

import conversation as c


def definitions():
    specs=[
        ('publish_message','Send a message to the verified owner DM and continue working. Use your own voice. A stable key prevents duplicate delivery. This cannot message other people.',
         {'text':{'type':'string'},'idempotency_key':{'type':'string'},'reply_to':{'type':'string'}},['text','idempotency_key']),
        ('save_checkpoint','Persist active objectives, next steps and operation receipt IDs for recovery.',
         {'state':{'type':'object','additionalProperties':True}},['state']),
        ('complete_task','Record that an objective is complete; this does not end other work.',
         {'task':{'type':'string'},'evidence':{'type':'string'}},['task','evidence']),
        ('wait_for_input','Save a checkpoint when nothing is runnable. Return from the turn after calling; new owner input wakes the runtime.',
         {'state':{'type':'object','additionalProperties':True}},['state']),
        ('delegate_task','Assign substantial coding or analysis work to a separate agent. The task returns asynchronously to Misty. Keep the owner informed yourself; specialists cannot message the owner.',
         {'role':{'type':'string','enum':['coding','analysis']},'objective':{'type':'string'},
          'project':{'type':'string'},'success':{'type':'string'},
          'context':{'type':'object','additionalProperties':True},'idempotency_key':{'type':'string'}},
         ['role','objective','success','idempotency_key']),
    ]
    return [{'name':n,'description':d,'inputSchema':{'type':'object','properties':p,'required':r,'additionalProperties':False}} for n,d,p,r in specs]


def call_tool(name,args):
    if os.environ.get('PROMINENCE_SOURCE')!='owner': raise ValueError('Owner-only tools')
    info=c.owner_run_info(os.environ.get('MISTY_CONVERSATION_RUN',''))
    run=info['id']
    if name=='publish_message': return c.publish(run,args['idempotency_key'],args['text'],args.get('reply_to'))
    if name in ('save_checkpoint','wait_for_input'): return c.checkpoint(run,args['state'])
    if name=='complete_task':
        state=json.loads(info['checkpoint']);state.setdefault('completed',[]).append(args)
        return c.checkpoint(run,state)
    if name=='delegate_task':
        import config
        if not config.enabled('multi_agent_enabled'):
            raise ValueError('Specialist workers are disabled')
        import agent_tasks
        if info.get('origin')=='supervisor':
            parent=agent_tasks.get(info['task_id'])
            if not parent or parent['state']!='running' or parent['origin']!='supervisor':
                raise ValueError('Active supervisor task required')
            task=agent_tasks.submit(args['role'],args['objective'],origin='supervisor',
                                    task_key='supervisor:'+info['task_id']+':'+args['idempotency_key'],
                                    project=args.get('project',''),success=args.get('success',''),
                                    context=args.get('context',{}))
        else:
            task=agent_tasks.submit(args['role'],args['objective'],origin='owner',
                                    task_key='owner:'+info['latest_message']+':'+args['idempotency_key'],
                                    project=args.get('project',''),success=args.get('success',''),
                                    context=args.get('context',{}),owner_message=info['latest_message'],
                                    owner_id=info['owner'],parent_run=run)
        return {'taskId':task['id'],'state':task['state'],'role':task['role']}
    raise ValueError('Unknown tool')


def main():
    for line in sys.stdin:
        try:
            m=json.loads(line)
            if 'id' not in m: continue
            method=m.get('method')
            if method=='initialize': result={'protocolVersion':m.get('params',{}).get('protocolVersion','2024-11-05'),'capabilities':{'tools':{}},'serverInfo':{'name':'misty-conversation','version':'1.0'}}
            elif method=='ping': result={}
            elif method=='tools/list': result={'tools':definitions()}
            elif method=='tools/call':
                p=m['params']
                try: result={'content':[{'type':'text','text':json.dumps(call_tool(p['name'],p.get('arguments',{})))}]}
                except Exception as e: result={'content':[{'type':'text','text':str(e)}],'isError':True}
            else: raise ValueError('Unsupported method')
            response={'jsonrpc':'2.0','id':m['id'],'result':result}
        except Exception as e:
            response={'jsonrpc':'2.0','id':m.get('id'),'error':{'code':-32602,'message':str(e)}}
        print(json.dumps(response),flush=True)


if __name__=='__main__': main()
