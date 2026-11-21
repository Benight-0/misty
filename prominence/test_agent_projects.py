import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import agent_projects
import agent_tasks
import agent_worker
import config
import task_tools


class ProjectPipelineTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name)
        self.project=self.root/'project';self.project.mkdir()
        self.remote=self.root/'remote.git'
        self.git(['git','init','--bare',str(self.remote)],self.root)
        self.git(['git','init',str(self.project)],self.root)
        self.git(['git','remote','add','origin',str(self.remote)],self.project)
        (self.project/'work.txt').write_text('base')
        self.git(['git','add','.'],self.project)
        self.git(['git','-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','base'],self.project)
        self.git(['git','push','-u','origin','HEAD'],self.project)
        self.data=patch.object(config,'DATA_DIR',str(self.root/'state'));self.data.start()

    def tearDown(self):
        self.data.stop();self.temp.cleanup()

    def git(self,args,cwd):
        result=subprocess.run(args,cwd=cwd,text=True,capture_output=True)
        if result.returncode: self.fail(result.stderr)
        return result.stdout.strip()

    def test_registered_project_uses_isolated_checked_branch(self):
        manifest={'root':str(self.project),'repository':str(self.remote),
                  'checks':[['git','diff','--exit-code']], 'release':{}}
        agent_projects.register(manifest)
        task=agent_tasks.submit('coding','Edit work',origin='supervisor',task_key='project-edit',project=str(self.project))
        agent_tasks.claim('coding')
        tree=agent_worker.workspace_for(task)
        self.assertNotEqual(tree,self.project)
        branch=agent_projects.prepare(task)
        self.assertEqual(tree,Path(branch['worktree']))
        (tree/'work.txt').write_text('changed')
        self.git(['git','add','.'],tree)
        self.git(['git','-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','change'],tree)
        receipt=agent_projects.publish(task)
        self.assertFalse(receipt['automaticReleaseAvailable'])
        self.assertEqual((self.project/'work.txt').read_text(),'base')
        self.assertTrue(self.git(['git','show-ref','--verify','refs/heads/'+receipt['branch']],self.remote))
        with self.assertRaisesRegex(ValueError,'No verified reversible'):
            agent_projects.release(task)

    def test_control_files_cannot_be_published_without_owner_decision(self):
        manifest={'root':str(self.project),'repository':str(self.remote),
                  'checks':[['git','diff','--exit-code']], 'release':{}}
        agent_projects.register(manifest)
        task=agent_tasks.submit('coding','Edit control rules',origin='supervisor',
                                task_key='control-edit',project=str(self.project))
        agent_tasks.claim('coding')
        tree=Path(agent_projects.prepare(task)['worktree'])
        (tree/'prominence').mkdir()
        (tree/'prominence'/'owner_loop.py').write_text('change')
        self.git(['git','add','.'],tree)
        self.git(['git','-c','user.name=Test','-c','user.email=test@example.invalid',
                  'commit','-m','control change'],tree)
        with self.assertRaisesRegex(ValueError,'owner decision required'):
            agent_projects.publish(task)

    def test_supervisor_can_bind_only_a_registered_project_for_direct_work(self):
        agent_projects.register({'root':str(self.project),'repository':str(self.remote),
                                 'checks':[['git','diff','--exit-code']]})
        task=agent_tasks.submit('supervisor','Small code fix',origin='supervisor',task_key='direct-code')
        agent_tasks.claim('supervisor')
        with patch.dict(os.environ,{'PROMINENCE_SOURCE':'supervisor',
                                    'MISTY_AGENT_TASK_ID':task['id'],
                                    'PROMINENCE_SUPERVISOR_READ_ONLY':'false'}):
            prepared=task_tools.call_tool('project_prepare',{'project':str(self.project)})
        bound=agent_tasks.get(task['id'])
        self.assertEqual(bound['project'],str(self.project))
        self.assertNotEqual(Path(prepared['worktree']),self.project)
        with self.assertRaisesRegex(ValueError,'not registered'):
            agent_tasks.bind_project(task['id'],str(self.root/'other'))


if __name__=='__main__': unittest.main()
