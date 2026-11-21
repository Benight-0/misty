"""Warm owner app-server lifecycle and current-run authorization."""
import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import config
import conversation as c
import conversation_tools
import fork_state
import owner_loop


class FakeClient:
    created = []

    def __init__(self, command, env=None):
        self.calls = []
        self.env = env
        self.closed = False
        self.next_turn = 0
        self.current_turn = None
        self.proc = self
        self.created.append(self)

    def poll(self):
        return 0 if self.closed else None

    def request(self, method, params, timeout=90):
        self.calls.append(method)
        if method == 'initialize':
            return {}
        if method in ('thread/start', 'thread/resume'):
            return {'thread': {'id': 'saved-thread'}}
        if method == 'turn/start':
            self.next_turn += 1
            self.current_turn = str(self.next_turn)
            return {'turn': {'id': self.current_turn}}
        raise AssertionError(method)

    def send(self, message):
        pass

    def event(self):
        return {'method': 'turn/completed',
                'params': {'turn': {'id': self.current_turn, 'status': 'completed'}}}

    def close(self):
        self.closed = True


class PersistentOwnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data = patch.object(config, 'DATA_DIR', self.temp.name)
        self.owner = patch.object(config, 'OWNER_ID', '100000000000000005')
        self.data.start()
        self.owner.start()
        FakeClient.created = []

    def tearDown(self):
        self.owner.stop()
        self.data.stop()
        self.temp.cleanup()

    def start(self, ident):
        message = {'id': ident, 'channel_id': 'dm',
                   'author': {'id': config.OWNER_ID}, 'content': 'hello'}
        fork_state.enqueue([message])
        fork_state.begin([message])
        return c.start('dm', config.OWNER_ID, [ident])

    def test_two_turns_reuse_one_initialized_and_resumed_process(self):
        worker = owner_loop.PersistentOwner()
        options = SimpleNamespace(model='test-model', effort='high')
        with patch.object(owner_loop, 'Client', FakeClient):
            worker.turn(self.start('100'), options, 'alias', 'instructions', 'first')
            worker.turn(self.start('101'), options, 'alias', 'instructions', 'second')
        self.assertEqual(len(FakeClient.created), 1)
        client = FakeClient.created[0]
        self.assertEqual(client.calls.count('initialize'), 1)
        self.assertEqual(client.calls.count('thread/start'), 1)
        self.assertEqual(client.calls.count('turn/start'), 2)
        self.assertEqual(client.env['MISTY_CONVERSATION_RUN'], '__active__')
        self.assertFalse(client.closed)
        worker.close()
        self.assertTrue(client.closed)

    def test_warm_tools_use_only_the_current_verified_run(self):
        env = {'PROMINENCE_SOURCE': 'owner', 'MISTY_CONVERSATION_RUN': '__active__',
               'MISTY_OWNER_ACCOUNT_ID': '__active__'}
        with patch.dict(os.environ, env):
            first = self.start('100')
            self.assertEqual(c.current_owner_message('old'), '100')
            self.assertEqual(config.current_owner(), config.OWNER_ID)
            conversation_tools.call_tool('publish_message', {'idempotency_key': 'a', 'text': 'one'})
            c.finish(first)
            with self.assertRaises(ValueError):
                c.current_owner_message('old')
            with self.assertRaises(ValueError):
                conversation_tools.call_tool('publish_message', {'idempotency_key': 'b', 'text': 'bad'})
            second = self.start('101')
            self.assertEqual(c.current_owner_message('old'), '101')
            conversation_tools.call_tool('publish_message', {'idempotency_key': 'b', 'text': 'two'})
            self.assertEqual(c.run_info(second)['state'], 'running')

    def test_stop_closes_only_active_worker(self):
        worker = owner_loop.PersistentOwner()
        client = FakeClient([], env={})
        worker.client = client
        self.assertFalse(worker.stop_active())
        self.assertFalse(client.closed)
        worker.busy = True
        self.assertTrue(worker.stop_active())
        self.assertTrue(client.closed)

    def test_owner_activity_tracks_started_and_finished_work(self):
        class EventClient(FakeClient):
            def request(self, method, params, timeout=90):
                result = super().request(method, params, timeout)
                if method == 'turn/start':
                    item = {'id': 'command-1', 'type': 'commandExecution',
                            'command': 'python3 misty.py email-accounts'}
                    self.progress_events = [
                        {'method': 'item/started', 'params': {'item': item}},
                        {'method': 'item/completed', 'params': {'item': {**item, 'status': 'completed'}}}]
                return result

            def event(self):
                return self.progress_events.pop(0) if self.progress_events else super().event()

        labels = []
        worker = owner_loop.PersistentOwner()
        with patch.object(owner_loop, 'Client', EventClient):
            worker.turn(self.start('102'), SimpleNamespace(model='test-model', effort='high'),
                        'alias', 'instructions', 'check mail', labels.append)
        self.assertEqual(labels, ['checking Gmail', 'thinking'])
        worker.close()
