import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import agent
import config
import fork_state
import misty


class ForkTests(unittest.TestCase):
    def test_owner_agent_has_high_effort_and_persistent_resume(self):
        args=agent.options(['-p','--model','gpt-6.1-sol','--effort','high','--permission-mode','bypassPermissions','--append-system-prompt','Exact instruction'])
        cmd=agent.command(args,'11111111-1111-1111-1111-111111111111')
        self.assertIn('--dangerously-bypass-approvals-and-sandbox',cmd)
        self.assertIn('model_reasoning_effort="high"',cmd)
        self.assertEqual(cmd[-2:],['resume','11111111-1111-1111-1111-111111111111'])
        self.assertIn('developer_instructions="Exact instruction"',cmd)

    def test_social_run_cannot_inherit_owner_shell_or_plugins(self):
        args=agent.options(['-p','--tools','','--no-session-persistence'])
        cmd=agent.command(args)
        self.assertNotIn('--dangerously-bypass-approvals-and-sandbox',cmd)
        for value in ('features.shell_tool=false','features.unified_exec=false','features.plugins=false','web_search="disabled"','--ephemeral'):
            self.assertIn(value,cmd)

    def test_draft_only_uses_current_owner_message(self):
        with patch.dict(os.environ,{'MISTY_OWNER_MESSAGE_ID':'100000000000000052'}):
            op,args=misty.request(['draft','chat-id','Exact\nprompt'])
        self.assertEqual(op,'draft');self.assertEqual(args['prompt'],'Exact\nprompt')
        self.assertEqual(args['ownerMessageId'],'100000000000000052')

    def test_archive_query_preserves_structured_arguments(self):
        op,args=misty.request(['archive','sql','{"sql":"SELECT ?","params":["a; b"]}'])
        self.assertEqual(args['args']['params'],['a; b']);self.assertEqual(op,'archive')

    def test_inbox_recovery_keeps_queued_and_quarantines_ambiguous_actions(self):
        with tempfile.TemporaryDirectory() as temp,patch.object(config,'DATA_DIR',temp),patch.object(config,'OWNER_ID','owner'):
            messages=[{'id':str(i),'channel_id':'dm','author':{'id':'owner'},'content':'task'} for i in range(1,4)]
            fork_state.enqueue(messages);fork_state.enqueue(messages)
            hidden={'id':'hidden','channel_id':'dm','author':{'id':'owner'},'content':'?private scratch'}
            fork_state.enqueue([hidden])
            with fork_state.db() as con:
                self.assertIsNone(con.execute('SELECT id FROM inbox WHERE id="hidden"').fetchone())
            fork_state.begin([messages[0]]);fork_state.ready([messages[1]],'answer')
            self.assertEqual([m['id'] for m in fork_state.pending('dm')],['3'])
            self.assertFalse(fork_state.queued('1'));self.assertFalse(fork_state.queued('2'))
            fork_state.ready([messages[2]],'Saved answer');fork_state.finish([messages[2]])
            with fork_state.db() as con:
                self.assertEqual(con.execute('SELECT reply FROM inbox WHERE id="3"').fetchone()[0],'Saved answer')
            fork_state.cursor('dm','3');self.assertEqual(fork_state.cursor('dm'),'3')

    def test_document_indexer_reads_docx_without_macos_tools(self):
        spec=importlib.util.spec_from_file_location('fork_context',Path(__file__).with_name('context.py'))
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as temp:
            doc=Path(temp)/'sample.docx'
            with zipfile.ZipFile(doc,'w') as z:
                z.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Retained source text</w:t></w:r></w:p></w:body></w:document>')
            self.assertEqual(module._read_doc(str(doc)),'Retained source text')

    def test_upstream_license_and_capabilities_are_present(self):
        root=Path(__file__).parent
        manifest=json.loads((root/'UPSTREAM.json').read_text())
        self.assertEqual(manifest['commit'],'2444dd36da25a1537aec98a4b817bfcea689fda9')
        self.assertIn('MIT License',(root/'LICENSE').read_text())
        for name in ('workflows.py','selfupdate.py','supervise.py','context.py','discord_read.py','discord_react.py','mod.py','dm.py'):
            self.assertTrue((root/name).is_file())


if __name__=='__main__':unittest.main()
