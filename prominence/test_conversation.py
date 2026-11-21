import ast
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import agent
import config
import conversation as c
import conversation_tools as tools
import fork_state
import owner_loop
import vm_review


class ConversationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.patch=patch.object(config,'DATA_DIR',self.temp.name);self.patch.start()
        self.owner=config.OWNER_ID
        self.first=self.message('100','first')
        fork_state.enqueue([self.first]);fork_state.begin([self.first])
        self.run=c.start('dm',self.owner,['100'])

    def tearDown(self): self.patch.stop();self.temp.cleanup()

    def message(self,id,text='more',channel='dm',owner=None):
        return {'id':id,'channel_id':channel,'author':{'id':owner or self.owner},'content':text}

    def test_new_input_is_ordered_and_accepted_only_after_ack(self):
        msgs=[self.message('101'),self.message('102')]
        fork_state.enqueue(msgs);fork_state.enqueue(msgs)
        self.assertEqual([m['id'] for m in c.pending(self.run)],['101','102'])
        c.offer(self.run,msgs)
        self.assertFalse(c.pending(self.run));self.assertFalse(fork_state.queued('101'))
        self.assertEqual(c.run_info(self.run)['latest_message'],'100')
        c.accept(self.run,msgs,'turn')
        self.assertEqual(c.run_info(self.run)['latest_message'],'102')

    def test_discord_newest_first_batch_is_steered_oldest_first(self):
        # GET /channels/{id}/messages returns newest first.
        newest_first=[self.message('102'),self.message('101')]
        fork_state.enqueue(newest_first)
        pending=c.pending(self.run)
        self.assertEqual([m['id'] for m in pending],['101','102'])
        c.offer(self.run,pending)
        c.accept(self.run,pending,'turn')
        self.assertEqual(c.run_info(self.run)['latest_message'],'102')

    def test_authorization_uses_real_accepted_input(self):
        fork_state.enqueue([self.message('101')]);c.offer(self.run,[self.message('101')])
        with patch.dict(os.environ,{'MISTY_CONVERSATION_RUN':self.run,'PROMINENCE_SOURCE':'owner'}):
            self.assertEqual(c.current_owner_message('old'),'100')
            c.accept(self.run,[self.message('101')],'turn')
            self.assertEqual(c.current_owner_message('old'),'101')
            c.finish(self.run)
            with self.assertRaises(ValueError): c.current_owner_message('old')

    def test_other_channels_and_guests_cannot_be_steered(self):
        fork_state.enqueue([self.message('101',channel='other'),self.message('102',owner='guest')])
        self.assertEqual(c.pending(self.run),[])
        with self.assertRaises(ValueError): c.start('other',self.owner,['100'])

    def test_rejected_steer_returns_input_to_queue(self):
        msgs=[self.message('101')];fork_state.enqueue(msgs)
        class Reject:
            def request(self,*a): raise owner_loop.RPCError('turn already completed')
        self.assertFalse(owner_loop.steer(Reject(),self.run,'thread','turn',msgs))
        self.assertTrue(fork_state.queued('101'))
        self.assertEqual([m['id'] for m in c.pending(self.run)],['101'])

    def test_unknown_steer_never_replays(self):
        msgs=[self.message('101')];fork_state.enqueue(msgs)
        class Timeout:
            def request(self,*a): raise TimeoutError('ack lost')
        with self.assertRaises(TimeoutError): owner_loop.steer(Timeout(),self.run,'thread','turn',msgs)
        c.recover()
        self.assertFalse(fork_state.queued('101'))
        self.assertEqual(c.run_info(self.run)['state'],'interrupted')

    def test_publication_is_idempotent_and_binding_is_immutable(self):
        a=c.publish(self.run,'answer','same');b=c.publish(self.run,'answer','same')
        self.assertEqual(a['messages'],b['messages'])
        with self.assertRaises(ValueError): c.publish(self.run,'answer','different')
        with self.assertRaises(ValueError): c.publish(self.run,'answer','same\nextra')
        with self.assertRaises(ValueError): c.publish(self.run,'bad','reply','another-room-message')

    def test_output_dispatches_before_task_finishes(self):
        c.publish(self.run,'progress','still working')
        sent=[]
        self.assertTrue(c.dispatch_one(lambda *args: sent.append(args) or {'id':'receipt'}))
        self.assertEqual(sent[0][0],'dm');self.assertEqual(sent[0][1],'still working')
        self.assertEqual(c.run_info(self.run)['state'],'running')
        self.assertFalse(c.dispatch_one(lambda *a: self.fail('duplicate delivery')))

    def test_ambiguous_delivery_is_never_retried(self):
        c.publish(self.run,'answer','hello')
        def broken(*args): raise TimeoutError('POST response lost')
        c.dispatch_one(broken);c.recover()
        self.assertFalse(c.dispatch_one(lambda *a: self.fail('replayed')))
        self.assertEqual(c.continuity('dm')['unknown_deliveries'],['answer:0'])

    def test_new_independent_message_survives_old_unknown_delivery(self):
        c.publish(self.run,'old','old')
        c.dispatch_one(lambda *a: None)
        c.publish(self.run,'new','new')
        self.assertTrue(c.dispatch_one(lambda *a: {'id':'new-receipt'}))

    def test_restart_preserves_queued_output_and_checkpoint(self):
        c.checkpoint(self.run,{'pending_operation':'receipt-123','next':'read result'})
        c.publish(self.run,'queued','safe to deliver once')
        c.recover()
        self.assertEqual(c.continuity('dm')['recent_runs'][0]['checkpoint']['pending_operation'],'receipt-123')
        self.assertTrue(c.dispatch_one(lambda *a: {'id':'receipt'}))
        self.assertEqual(fork_state.pending('dm'),[])

    def test_previous_outside_thread_exchange_is_available_to_the_next_model_turn(self):
        c.finish(self.run)
        old_message=self.message('101','hi')
        fork_state.enqueue([old_message]);fork_state.begin([old_message])
        old_run=c.start('dm',self.owner,['101'])
        c.publish(old_run,'earlier','response from an earlier run')
        c.finish(old_run)
        self.assertEqual(c.continuity('dm')['outside_thread_exchanges'],
                         [{'owner':'hi','misty':'response from an earlier run','delivery':'queued'}])
        next_message=self.message('102','what is due this week?')
        fork_state.enqueue([next_message]);fork_state.begin([next_message])
        agent_run=c.start('dm',self.owner,['102'])
        c.mark_turn(agent_run,'thread','turn')
        c.finish(agent_run)
        self.assertEqual(c.continuity('dm')['outside_thread_exchanges'],[])

    def test_chunking_and_code_fences(self):
        parts=c.chunks('explanation\n```python\n'+'print(1)\n'*600+'```\nend')
        self.assertTrue(all(len(x)<=1850 for x in parts))
        self.assertTrue(all(x.count('```')%2==0 for x in parts))
        self.assertTrue(all(x.count('```')%2==0 for x in c.chunks('```\n'+'x\n'*2000+'```')))

    def test_stop_cancels_pending_output_and_cannot_be_overwritten(self):
        c.publish(self.run,'progress','queued before cancellation')
        c.cancel_active();c.finish(self.run,'interrupted')
        self.assertEqual(c.run_info(self.run)['state'],'cancelled')
        with self.assertRaises(ValueError): c.publish(self.run,'late','late output')
        self.assertFalse(c.dispatch_one(lambda *a: self.fail('cancelled send')))

    def test_multipart_unknown_quarantines_only_same_publication(self):
        c.publish(self.run,'long','hello '*1000)
        c.publish(self.run,'independent','new answer')
        c.dispatch_one(lambda *a: None)
        sent=[]
        c.dispatch_one(lambda *a: sent.append(a[1]) or {'id':'new'})
        self.assertEqual(sent,['new answer'])

    def test_race_after_turn_end_leaves_input_for_next_run(self):
        c.finish(self.run)
        fork_state.enqueue([self.message('101','arrived after completion')])
        self.assertTrue(fork_state.queued('101'))
        self.assertEqual([x['id'] for x in fork_state.pending('dm')],['101'])

    def test_tools_require_owner_active_run_and_do_not_finish_on_publish(self):
        with patch.dict(os.environ,{'PROMINENCE_SOURCE':'workflow','MISTY_CONVERSATION_RUN':self.run}):
            with self.assertRaises(ValueError): tools.call_tool('publish_message',{'text':'no','idempotency_key':'x'})
        with patch.dict(os.environ,{'PROMINENCE_SOURCE':'owner','MISTY_CONVERSATION_RUN':self.run}):
            tools.call_tool('publish_message',{'text':'yes','idempotency_key':'x'})
            tools.call_tool('complete_task',{'task':'one','evidence':'test passed'})
            self.assertEqual(c.run_info(self.run)['state'],'running')

    def test_main_and_helpers_use_separate_paths(self):
        text=Path(__file__).with_name('bot.py').read_text()
        tree=ast.parse(text)
        owner=next(x for x in tree.body if isinstance(x,ast.FunctionDef) and x.name=='owner_turn')
        src=ast.get_source_segment(text,owner)
        self.assertIn('"--effort", OWNER_EFFORT',src)
        self.assertIn('MISTY_CONVERSATION_RUN',src)
        self.assertIn("if duplex:",src)
        params=agent.options(['--effort','high','--model','gpt-6.1-sol'])
        cmd=owner_loop.server_command(params)
        self.assertIn('model_reasoning_effort="high"',cmd)
        self.assertIn('app-server',cmd)
        self.assertNotIn('--ignore-user-config',cmd)

    def test_owner_turn_disables_tool_review_hooks(self):
        params=agent.options(['--effort','high','--model','gpt-6.1-sol'])
        self.assertIn('features.hooks=false',owner_loop.server_command(params))
        self.assertIn('Do not delete files',owner_loop.INSTRUCTIONS)
        self.assertIn('ask the owner for permission',' '.join(owner_loop.INSTRUCTIONS.split()))

    def test_vm_tool_review_approves_routine_call(self):
        event={'hook_event_name':'PreToolUse','tool_name':'Bash',
               'tool_input':{'command':'pwd'},'cwd':'/tmp'}
        with patch.dict(os.environ,{'PROMINENCE_SOURCE':'owner','MISTY_CONVERSATION_RUN':self.run}):
            result=vm_review.process(event,lambda request,call:(True,'routine read'))
        self.assertEqual(result['hookSpecificOutput']['permissionDecision'],'allow')
        with c.connection() as con:
            self.assertEqual(con.execute('SELECT decision FROM vm_tool_audit').fetchone()[0],
                             'auto_approved')

    def test_owner_conversation_tool_is_reviewed_and_approved(self):
        event={'hook_event_name':'PreToolUse',
               'tool_name':'mcp__misty_conversation__publish_message',
               'tool_input':{'text':'status','idempotency_key':'status'},'cwd':'/tmp'}
        with patch.dict(os.environ,{'PROMINENCE_SOURCE':'owner','MISTY_CONVERSATION_RUN':self.run}):
            result=vm_review.process(event,lambda request,call:(True,'verified owner reply'))
        self.assertEqual(result['hookSpecificOutput']['permissionDecision'],'allow')
        with c.connection() as con:
            self.assertEqual(con.execute('SELECT decision FROM vm_tool_audit').fetchone()[0],
                             'auto_approved')

    def test_vm_tool_review_requires_exact_later_owner_approval_once(self):
        event={'hook_event_name':'PreToolUse','tool_name':'Bash',
               'tool_input':{'command':'risky operation'},'cwd':'/tmp'}
        env={'PROMINENCE_SOURCE':'owner','MISTY_CONVERSATION_RUN':self.run}
        with patch.dict(os.environ,env):
            held=vm_review.process(event,lambda request,call:(False,'specific concern'))
            self.assertEqual(held['hookSpecificOutput']['permissionDecision'],'deny')
            with c.connection() as con:
                code=con.execute('SELECT code FROM vm_tool_reviews').fetchone()[0]
            self.assertEqual(vm_review.process(event,lambda *a:self.fail('review duplicated'))
                             ['hookSpecificOutput']['permissionDecision'],'deny')
            c.dispatch_one(lambda *a:{'id':'101'})
            c.finish(self.run)
            approval=self.message('102',f'approve vm {code}')
            fork_state.enqueue([approval]);fork_state.begin([approval])
            resumed=c.start('dm',self.owner,['102'])
        with patch.dict(os.environ,{'PROMINENCE_SOURCE':'owner','MISTY_CONVERSATION_RUN':resumed}):
            self.assertEqual(vm_review.process(event,lambda *a:self.fail('review duplicated'))
                             ['hookSpecificOutput']['permissionDecision'],'allow')
            self.assertEqual(vm_review.process(event,lambda *a:self.fail('review duplicated'))
                             ['hookSpecificOutput']['permissionDecision'],'deny')

    def test_legacy_dm_sender_uses_outbox_and_ask_cannot_block(self):
        import dm
        with patch.dict(os.environ,{'MISTY_CONVERSATION_RUN':self.run}),patch.object(dm,'SOURCE','owner'),patch.object(dm,'channel',side_effect=AssertionError('network')):
            self.assertTrue(dm.send('legacy message')['queued'])
            with self.assertRaises(ValueError): dm.ask('question',1)

    def test_responder_does_not_run_a_steered_message_twice(self):
        import misty
        text=Path(__file__).with_name('bot.py').read_text();tree=ast.parse(text)
        node=next(x for x in tree.body if isinstance(x,ast.FunctionDef) and x.name=='dm_responder')
        scope={'threading':threading,'dm_lock':threading.Lock(),'owner_turn_lock':threading.Lock(),
               'dm_pending':{'dm':[self.first]},'dm_busy':{'dm'},'config':config,
               'fork_state':fork_state,'name':lambda m:'owner'}
        with c.connection() as con: con.execute('UPDATE inbox SET state="queued" WHERE id="100"')
        calls=[]
        def owner_turn(channel,batch):
            calls.append(batch)
            msg=self.message('101','new input during work')
            fork_state.enqueue([msg]);scope['dm_pending']['dm']=[msg]
            c.offer(self.run,[msg]);c.accept(self.run,[msg],'turn');c.finish(self.run)
            return ''
        scope['owner_turn']=owner_turn
        exec(compile(ast.Module(body=[node],type_ignores=[]),'responder-test','exec'),scope)
        with patch.object(misty,'call',return_value={}),patch.object(config,'AGENT_BACKEND','codex'):
            scope['dm_responder']('dm')
        self.assertEqual(len(calls),1)
        self.assertFalse(scope['dm_busy'])


if __name__=='__main__': unittest.main()
