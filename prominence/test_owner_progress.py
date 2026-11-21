"""Disposable owner status must never alter durable replies."""
import unittest

import owner_progress


class OwnerProgressTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.now = 100.0
        def request(method, url, body=None):
            self.calls.append((method, url, body))
            if method == 'POST':
                return {'id': 'status-1'}
            return {} if method in ('PATCH', 'DELETE') else []
        self.progress = owner_progress.OwnerProgress(request, 'bot', clock=lambda: self.now)

    def test_one_marked_message_is_edited_then_removed(self):
        self.progress.begin('run', 'dm')
        self.progress.pump()
        self.assertEqual(self.calls[0][0], 'POST')
        self.assertTrue(self.calls[0][2]['content'].startswith('> '))
        self.assertEqual(self.progress.snapshot()['label'], 'thinking')
        self.progress.update('run', 'checking Gmail')
        self.now += 2
        self.progress.pump()
        self.assertEqual(self.calls[1][0], 'PATCH')
        self.assertEqual(self.calls[1][2]['content'], owner_progress.PREFIX + 'checking Gmail')
        self.progress.finish('run')
        self.progress.pump()
        self.assertEqual([call[0] for call in self.calls], ['POST', 'PATCH', 'DELETE'])
        self.assertIn('/status-1', self.calls[2][1])
        self.assertFalse(self.progress.snapshot()['active'])

    def test_uncertain_post_is_not_repeated(self):
        def uncertain(method, url, body=None):
            self.calls.append((method, url, body))
            return None
        progress = owner_progress.OwnerProgress(uncertain, 'bot', clock=lambda: self.now)
        progress.begin('run', 'dm')
        progress.pump()
        progress.update('run', 'reading files')
        self.now += 2
        progress.pump()
        self.assertEqual(len(self.calls), 1)

    def test_new_turn_does_not_reuse_previous_turn_status(self):
        self.progress.begin('first', 'dm')
        self.progress.pump()
        self.progress.finish('first')
        self.progress.begin('second', 'dm')
        self.progress.pump()
        self.assertEqual([call[0] for call in self.calls], ['POST', 'DELETE'])
        self.progress.pump()
        self.assertEqual([call[0] for call in self.calls], ['POST', 'DELETE', 'POST'])

    def test_restart_cleanup_only_deletes_marked_bot_status(self):
        def request(method, url, body=None):
            self.calls.append((method, url, body))
            if method == 'GET':
                return [{'id': 'one', 'author': {'id': 'bot'},
                         'content': owner_progress.PREFIX + 'thinking'},
                        {'id': 'two', 'author': {'id': 'bot'}, 'content': 'Published answer'},
                        {'id': 'three', 'author': {'id': 'owner'},
                         'content': owner_progress.PREFIX + 'thinking'}]
            return {}
        progress = owner_progress.OwnerProgress(request, 'bot')
        progress._cleanup('dm')
        self.assertEqual([call[1].rsplit('/', 1)[-1] for call in self.calls if call[0] == 'DELETE'], ['one'])
