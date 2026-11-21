import json
import os
from pathlib import Path
import tempfile
import time
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import agent_tasks
import config
import conversation
import fork_state
if sys.platform == 'win32':
    sys.modules.setdefault('fcntl',SimpleNamespace(LOCK_EX=1,LOCK_NB=2,LOCK_UN=8,LOCK_SH=4,
                                                   flock=lambda *_:None))
import supervisor


class TaskQueueTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data = patch.object(config, 'DATA_DIR', self.temp.name)
        self.owner = patch.object(config, 'OWNER_ID', '100000000000000005')
        self.data.start(); self.owner.start()
        message = {'id': '100000000000000006', 'channel_id': 'dm',
                   'author': {'id': config.OWNER_ID}, 'content': 'Analyze the project'}
        fork_state.enqueue([message]); fork_state.begin([message])
        self.run = conversation.start('dm', config.OWNER_ID, [message['id']])
        self.message = message['id']

    def tearDown(self):
        self.owner.stop(); self.data.stop(); self.temp.cleanup()

    def test_owner_handoff_is_idempotent_and_bound_to_verified_input(self):
        args = dict(origin='owner', task_key='owner:'+self.message+':analysis',
                    owner_message=self.message, owner_id=config.OWNER_ID, parent_run=self.run)
        first = agent_tasks.submit('analysis', 'Find evidence', **args)
        handoff=json.loads(first['context_json'])
        self.assertEqual(handoff['verifiedOwnerInput']['text'],'Analyze the project')
        self.assertEqual(handoff['recentConversation']['owner'][-1]['id'],self.message)
        self.assertEqual(first['id'], agent_tasks.submit('analysis', 'Find evidence', **args)['id'])
        with self.assertRaises(ValueError):
            agent_tasks.submit('analysis', 'Find evidence', **{**args, 'owner_message':'other'})
        claimed = agent_tasks.claim('analysis')
        self.assertEqual(claimed['id'], first['id'])
        with patch.dict(os.environ, {'PROMINENCE_SOURCE':'specialist', 'MISTY_AGENT_TASK_ID':first['id']}):
            self.assertEqual(agent_tasks.active_from_environment()['owner_message'], self.message)
        agent_tasks.finish(first['id'], 'completed', 'Verified result', ['source:1'])
        self.assertEqual(agent_tasks.pending_results(origin='owner')[0]['id'], first['id'])
        agent_tasks.mark_reported(first['id'])
        self.assertEqual(agent_tasks.pending_results(origin='owner'), [])

    def test_supervisor_cannot_impersonate_owner_and_stale_work_does_not_replay(self):
        with self.assertRaises(ValueError):
            agent_tasks.submit('coding', 'Fix', origin='supervisor', task_key='bad',
                               owner_message=self.message)
        with self.assertRaises(ValueError):
            agent_tasks.submit('coding', 'Fix', origin='supervisor', task_key='unregistered')
        task=agent_tasks.submit('analysis', 'Review', origin='supervisor', task_key='review-1')
        agent_tasks.claim('analysis', lease_seconds=1)
        with agent_tasks.database() as db:
            db.execute('UPDATE tasks SET lease_until=? WHERE id=?', (time.time()-1,task['id']))
        self.assertIsNone(agent_tasks.claim('analysis'))
        self.assertEqual(agent_tasks.get(task['id'])['state'], 'interrupted')
        with patch.dict(os.environ, {'PROMINENCE_SOURCE':'specialist', 'MISTY_AGENT_TASK_ID':task['id']}):
            with self.assertRaises(ValueError): agent_tasks.active_from_environment()

    def test_coding_handoff_does_not_block_a_new_owner_input(self):
        task=agent_tasks.submit('coding','Inspect the code',origin='owner',
                                task_key='owner:'+self.message+':coding',
                                owner_message=self.message,owner_id=config.OWNER_ID,parent_run=self.run)
        self.assertEqual(agent_tasks.claim('coding')['id'],task['id'])
        next_message={'id':'100000000000000007','channel_id':'dm',
                      'author':{'id':config.OWNER_ID},'content':'A separate question'}
        fork_state.enqueue([next_message])
        other=conversation.start('dm',config.OWNER_ID,[next_message['id']])
        self.assertNotEqual(other,self.run)
        self.assertEqual(agent_tasks.get(task['id'])['state'],'running')
        agent_tasks.finish(task['id'],'completed','Code inspected',['test:receipt'])
        self.assertEqual(agent_tasks.pending_results(origin='owner')[0]['id'],task['id'])

    def test_cancel_retains_checkpoint(self):
        task=agent_tasks.submit('analysis','Review',origin='supervisor',task_key='review-2')
        agent_tasks.claim('analysis')
        agent_tasks.checkpoint(task['id'], {'next':'test'})
        agent_tasks.stop(task['id'])
        self.assertEqual(json.loads(agent_tasks.get(task['id'])['checkpoint']),{'next':'test'})
        self.assertEqual(agent_tasks.get(task['id'])['state'],'cancelled')

    def test_supervisor_misty_turn_keeps_origin_and_no_owner_message(self):
        task=agent_tasks.submit('misty','Review this gap',origin='supervisor',task_key='misty-1')
        agent_tasks.claim('misty')
        run,state=conversation.start_internal(task['id'],'dm',config.OWNER_ID,origin='supervisor')
        self.assertEqual(state,'running')
        with patch.dict(os.environ,{'PROMINENCE_SOURCE':'owner','MISTY_CONVERSATION_RUN':run}):
            self.assertEqual(conversation.current_owner_message('old'),'')
            self.assertEqual(conversation.owner_run_info(run)['origin'],'supervisor')

    def test_supervisor_runs_once_for_new_evidence_then_stays_quiet(self):
        fake_lock=SimpleNamespace(LOCK_EX=1,LOCK_NB=2,flock=lambda *_:None)
        evidence=({'messages':[{'seq':1,'body':'new'}],'codex':[],'owner':[],'trace':[]},
                  {'archive':'1','codex':'0','owner':'0','trace':'0'},[])
        def run(task): agent_tasks.finish(task['id'],'completed','Reviewed')
        with patch.dict(sys.modules,{'fcntl':fake_lock}), \
             patch.object(supervisor,'collect',side_effect=[evidence,({'messages':[],'codex':[],'owner':[],'trace':[]},
                                                              {'archive':'1','codex':'0','owner':'0','trace':'1'},[])]), \
             patch.object(supervisor.initiative,'status',return_value={'paused':False,'plans':[]}), \
             patch.object(supervisor.initiative,'load_context',return_value={'recentProactive':[]}), \
             patch.object(supervisor.owner_trace,'read_since',return_value={'highWater':100}):
            first=supervisor.review(now=1800,run_agent=run)
            second=supervisor.review(now=3601,run_agent=run)
        self.assertEqual(first['state'],'completed')
        self.assertEqual(second,{'state':'quiet','modelCalled':False})
        self.assertEqual(agent_tasks.cursor('archive'),'1')
        self.assertEqual(agent_tasks.cursor('trace'),'1')

    def test_source_cursors_bootstrap_then_read_only_new_events(self):
        def bridge(op,args):
            if op=='archive':
                after=args['args']['after']
                return {'rows':[{'seq':7 if after==0 else 8,'body':'mail'}],
                        'highWater':7 if after==0 else 8}
            after=args['after']
            return {'events':[{'seq':4 if after==0 else 5,'text':'update'}],
                    'highWater':4 if after==0 else 5}
        with patch.object(supervisor.owner_trace,'read_since',return_value={'rows':[],'highWater':3}):
            first,cursors,errors=supervisor.collect(bridge)
            self.assertEqual(errors,[])
            self.assertEqual(first['messages'],[])
            self.assertEqual(first['codex'],[])
            for source,value in cursors.items():agent_tasks.advance_cursor(source,value)
            second,next_cursor,errors=supervisor.collect(bridge)
        self.assertEqual(second['messages'][0]['seq'],8)
        self.assertEqual(second['codex'][0]['seq'],5)
        self.assertEqual(next_cursor['archive'],'8')

    def test_trace_pruning_keeps_task_summary(self):
        task=agent_tasks.submit('analysis','Retain outcome',origin='supervisor',task_key='old-1')
        agent_tasks.record(task['id'],'decision','one')
        with agent_tasks.database() as db:
            db.execute('UPDATE task_events SET at=? WHERE task_id=?',(time.time()-31*86400,task['id']))
        agent_tasks.prune_events()
        self.assertEqual(agent_tasks.get(task['id'])['objective'],'Retain outcome')
        self.assertEqual(agent_tasks.list_tasks()[0]['events'],[])
        self.assertEqual(agent_tasks.list_tasks()[0]['summaries'][0]['kind'],'decision')


if __name__ == '__main__': unittest.main()
