import ast
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import config
import fork_state

PRIMARY = '100000000000000023'
ALIAS = '100000000000000034'


class OwnerAliases(unittest.TestCase):
    def config(self):
        return patch.object(config, 'get_list', return_value=[ALIAS])

    def test_verified_aliases_share_owner_access_but_others_and_bad_ids_do_not(self):
        with self.config(), patch.object(config, 'OWNER_ID', PRIMARY):
            self.assertTrue(config.is_owner(PRIMARY))
            self.assertTrue(config.is_owner(ALIAS))
            self.assertFalse(config.is_owner('100000000000000005'))
            self.assertFalse(config.is_owner(None))
        with patch.object(config, 'get_list', return_value=['username#0000']):
            with self.assertRaises(ValueError): config.owner_ids()

    def test_direct_tool_replies_follow_verified_account_and_workflows_stay_primary(self):
        with self.config(), patch.object(config, 'OWNER_ID', PRIMARY):
            with patch.dict(os.environ, {'PROMINENCE_SOURCE': 'owner', 'MISTY_OWNER_ACCOUNT_ID': ALIAS}):
                self.assertEqual(config.current_owner(), ALIAS)
            with patch.dict(os.environ, {'PROMINENCE_SOURCE': 'workflow reminder', 'MISTY_OWNER_ACCOUNT_ID': ALIAS}):
                self.assertEqual(config.current_owner(), PRIMARY)
            with patch.dict(os.environ, {'PROMINENCE_SOURCE': 'owner', 'MISTY_OWNER_ACCOUNT_ID': '100000000000000005'}):
                with self.assertRaises(ValueError): config.current_owner()

    def test_durable_inbox_keeps_actual_actor_and_channel_and_rejects_nonowners(self):
        with tempfile.TemporaryDirectory() as tmp, self.config(), patch.object(config, 'OWNER_ID', PRIMARY), patch.object(config, 'DATA_DIR', tmp):
            messages = [{'id': str(i), 'channel_id': 'alias-dm', 'author': {'id': actor}, 'content': 'task'}
                        for i, actor in enumerate([ALIAS, PRIMARY, '100000000000000005'], 1)]
            messages += [{'id': 'bot', 'channel_id': 'alias-dm', 'author': {'id': ALIAS, 'bot': True}, 'content': 'task'},
                         {'id': 'guild', 'channel_id': 'alias-dm', 'guild_id': 'guild', 'author': {'id': ALIAS}, 'content': 'task'}]
            fork_state.enqueue(messages)
            saved = fork_state.pending('alias-dm')
            self.assertEqual([m['author']['id'] for m in saved], [ALIAS, PRIMARY])
            self.assertEqual(saved[0]['channel_id'], 'alias-dm')

    def test_dm_helper_checks_the_verified_recipient_without_importing_bot_runtime(self):
        tree = ast.parse(Path(__file__).with_name('dm.py').read_text())
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'channel')
        namespace = {'config': config, 'api': lambda method, path, body: {'id': 'channel', 'type': 1, 'recipients': [{'id': body['recipient_id']}]}}
        exec(compile(ast.Module(body=[function], type_ignores=[]), 'dm.py', 'exec'), namespace)
        with self.config(), patch.object(config, 'OWNER_ID', PRIMARY), patch.dict(os.environ, {'PROMINENCE_SOURCE': 'owner', 'MISTY_OWNER_ACCOUNT_ID': ALIAS}):
            self.assertEqual(namespace['channel'](), 'channel')
            namespace['api'] = lambda *args: {'id': 'wrong', 'type': 1, 'recipients': [{'id': PRIMARY}]}
            with self.assertRaises(ValueError): namespace['channel']()

    def test_alias_recovery_does_not_mark_the_other_live_owner_turn_unknown(self):
        with tempfile.TemporaryDirectory() as tmp, self.config(), patch.object(config, 'OWNER_ID', PRIMARY), patch.object(config, 'DATA_DIR', tmp):
            primary = {'id': '1', 'channel_id': 'primary-dm', 'author': {'id': PRIMARY}, 'content': 'task'}
            alias = {'id': '2', 'channel_id': 'alias-dm', 'author': {'id': ALIAS}, 'content': 'task'}
            fork_state.enqueue([primary, alias]); fork_state.begin([primary])
            self.assertEqual(fork_state.pending('alias-dm'), [alias])
            with fork_state.db() as con:
                self.assertEqual(con.execute('SELECT state FROM inbox WHERE id="1"').fetchone()[0], 'running')

    def test_waiting_question_only_accepts_the_dm_that_received_the_question(self):
        tree = ast.parse(Path(__file__).with_name('bot.py').read_text(encoding='utf-8'))
        function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'waiting_question')
        import json
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'ask.json'
            path.write_text(json.dumps({'pid': os.getpid(), 'id': 'question', 'channel': 'alias-dm'}))
            ns = {'os': os, 'json': json, 'ASK_FILE': str(path), 'owner_dm_channel': 'primary-dm'}
            exec(compile(ast.Module(body=[function], type_ignores=[]), 'bot.py', 'exec'), ns)
            self.assertIsNone(ns['waiting_question']('primary-dm'))
            self.assertTrue(path.exists())
            self.assertEqual(ns['waiting_question']('alias-dm'), 'question')


if __name__ == '__main__': unittest.main()
