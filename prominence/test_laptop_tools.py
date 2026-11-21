import json
import os
from pathlib import Path
import types
import unittest
from unittest.mock import patch

import agent
import laptop_tools


class LaptopToolsTest(unittest.TestCase):
    def test_same_agent_model_effort_session_and_owner_only_registration(self):
        args = agent.options(['--model', 'gpt-6.1-sol', '--effort', 'low', '--permission-mode', 'bypassPermissions'])
        original = agent.config.get
        with patch.dict(os.environ, {'PROMINENCE_SOURCE': 'owner'}), patch.object(agent.config, 'get', side_effect=lambda key, default=None: True if key == 'laptop_tools_enabled' else original(key, default)):
            cmd = agent.command(args, 'existing-session')
        self.assertIn('mcp_servers.misty_laptop.command=', ' '.join(cmd))
        self.assertIn('existing-session', cmd)
        self.assertEqual(cmd[cmd.index('-m') + 1], 'gpt-6.1-sol')
        self.assertIn('model_reasoning_effort="low"', cmd)
        with patch.dict(os.environ, {'PROMINENCE_SOURCE': 'workflow activity'}):
            self.assertNotIn('mcp_servers.misty_laptop', ' '.join(agent.command(args)))
        args.tools = ''
        with patch.dict(os.environ, {'PROMINENCE_SOURCE': 'owner'}):
            self.assertNotIn('mcp_servers.misty_laptop', ' '.join(agent.command(args)))

    def test_mcp_schema_listing_and_protocol(self):
        result = laptop_tools.dispatch({'method': 'initialize', 'params': {'protocolVersion': '2024-11-05'}})
        self.assertEqual(result['protocolVersion'], '2024-11-05')
        tools = laptop_tools.dispatch({'method': 'tools/list'})['tools']
        self.assertEqual(len(tools), 14)
        self.assertTrue(all('inputSchema' in t for t in tools))
        self.assertFalse(any('message' in t['name'] or 'codex' in t['name'] for t in tools))

    def test_controls_and_followup_result_do_not_submit_another_operation(self):
        with patch.object(laptop_tools, 'request', return_value={}) as call:
            laptop_tools.call_tool('laptop_task', {'action': 'control', 'action_name': 'pause'})
            call.assert_called_once_with('control', {'action': 'pause'})
        with patch.object(laptop_tools, 'request', return_value={'state': 'unknown'}) as call:
            laptop_tools.call_tool('laptop_result', {'id': 'existing-operation'})
            call.assert_called_once_with('result', {'id': 'existing-operation'})

    def test_shared_session_mapping_and_screenshot_content(self):
        with patch.object(laptop_tools, 'request', return_value=[]) as call:
            self.assertEqual(laptop_tools.call_tool('laptop_session', {'action':'assigned'}), [])
            call.assert_called_once_with('session_assigned', {})
        receipt={'id':'op-1','state':'succeeded','result':{'state':'succeeded',
                 'output':{'page':{'url':'https://example.com'},'image':'aGVsbG8=',
                           'mimeType':'image/jpeg'}}}
        with patch.object(laptop_tools, 'call_tool', return_value=receipt):
            value=laptop_tools.dispatch({'method':'tools/call','params':{'name':'laptop_browser_inspect'}})
        self.assertEqual(value['content'][1],{'type':'image','mimeType':'image/jpeg','data':'aGVsbG8='})
        self.assertNotIn('aGVsbG8=',value['content'][0]['text'])

    def test_tool_error_is_an_error_not_invented_success(self):
        with patch.object(laptop_tools, 'call_tool', side_effect=ValueError('offline')):
            r = laptop_tools.dispatch({'method': 'tools/call', 'params': {'name': 'laptop_status'}})
        self.assertTrue(r['isError'])
        self.assertIn('offline', r['content'][0]['text'])


if __name__ == '__main__':
    unittest.main()
