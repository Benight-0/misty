import os
import unittest
from unittest.mock import patch
import activity
import misty

class ActivityTests(unittest.TestCase):
    def test_tool_labels_are_fixed_and_hide_private_command_contents(self):
        self.assertEqual(activity.label(dict(type='web_search')), 'searching the web')
        self.assertEqual(activity.label(dict(type='command_execution',command="python3 misty.py archive search 'PRIVATE_NAME'")), 'searching the database')
        self.assertEqual(activity.label(dict(type='command_execution',command='python3 misty.py send ID PRIVATE_PROMPT')), 'talking to Codex')
        self.assertEqual(activity.label(dict(type='command_execution',command='python3 misty.py read codex:ID')), 'reading Codex history')
        self.assertEqual(activity.label(dict(type='file_change')), 'editing files')
        self.assertTrue(activity.label(dict(type='unknown',command='SECRET')) in activity.LABELS)

    def test_direct_send_is_bound_to_current_owner_and_explicit_followthrough(self):
        with patch.dict(os.environ,{'MISTY_OWNER_MESSAGE_ID':'owner'}):
            op,args=misty.request(['send','chat','Exact prompt','--follow-through'])
        self.assertEqual(op,'send');self.assertEqual(args['ownerMessageId'],'owner')
        self.assertTrue(args['followThrough']);self.assertEqual(args['prompt'],'Exact prompt')
        op,args=misty.request(['codex','project history'])
        self.assertEqual(args['kind'],'codex')

if __name__=='__main__':unittest.main()
