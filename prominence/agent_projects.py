"""Registered project worktrees and explicit reversible publication recipes."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys

import agent_tasks
import config

BRANCH = re.compile(r'^misty/task-[a-f0-9]{32}$')
MISTY_CONTROL_PATHS = {
    'prominence/config.py', 'prominence/owner_loop.py', 'prominence/conversation.py',
    'prominence/conversation_tools.py', 'prominence/laptop_tools.py',
    'prominence/agent_tasks.py', 'prominence/agent_projects.py',
    'prominence/task_tools.py', 'prominence/bot.py',
    'app/laptop-tools-broker.mjs', 'app/misty-direct.mjs',
    'app/misty-messages.mjs', 'app/gmail.mjs', 'app/gmail-overlay.mjs',
    'scripts/misty-laptop-tools-server.mjs',
}


def command(argv, cwd, timeout=180):
    if not isinstance(argv, list) or not argv or any(not isinstance(x,str) or not x or len(x)>1000 for x in argv):
        raise ValueError('Command must be a bounded argv list')
    result=subprocess.run(argv,cwd=cwd,timeout=timeout,text=True,capture_output=True,check=False)
    if result.returncode:
        raise RuntimeError('Command failed ('+str(result.returncode)+'): '+(result.stderr or result.stdout)[-1200:])
    return result.stdout.strip()[-4000:]


def register(manifest, verify=False):
    """Local owner maintenance command; model tools cannot register projects."""
    root=Path(manifest['root']).expanduser().resolve(strict=True)
    if not root.is_dir() or not root.is_absolute(): raise ValueError('Canonical project directory required')
    top=Path(command(['git','rev-parse','--show-toplevel'],str(root))).resolve()
    if top!=root: raise ValueError('Project root must be the Git repository root')
    remote=command(['git','remote','get-url','origin'],str(root))
    if remote!=manifest.get('repository'): raise ValueError('Repository remote does not match manifest')
    checks=manifest.get('checks')
    if not isinstance(checks,list) or not checks: raise ValueError('At least one check is required')
    for argv in checks: command_shape(argv)
    recipe=manifest.get('release') or {}
    if recipe:
        if set(recipe)!= {'deploy','health','rollback','protectedPaths'}:
            raise ValueError('Release needs deploy, health, rollback and protectedPaths')
        for name in ('deploy','health','rollback'): command_shape(recipe[name])
        if not isinstance(recipe['protectedPaths'],list) or not recipe['protectedPaths'] or any(not isinstance(p,str) or not p for p in recipe['protectedPaths']):
            raise ValueError('Protected path patterns required')
        if not verify: raise ValueError('Verify checks and health before registering an automatic release')
    if verify:
        for argv in checks: command(argv,str(root),timeout=600)
        if recipe: command(recipe['health'],str(root),timeout=120)
    with agent_tasks.database() as db:
        db.execute('INSERT INTO project_registry(root,repository,checks_json,release_json,updated) VALUES(?,?,?,?,strftime("%s","now")) '
                   'ON CONFLICT(root) DO UPDATE SET repository=excluded.repository,checks_json=excluded.checks_json,release_json=excluded.release_json,updated=excluded.updated',
                   (str(root),remote,json.dumps(checks),json.dumps(recipe)))
    return {'root':str(root),'repository':remote,'automaticRelease':bool(recipe)}


def command_shape(argv):
    if not isinstance(argv,list) or not argv or any(not isinstance(x,str) or not x or len(x)>1000 for x in argv):
        raise ValueError('Expected an argv array; shell commands are not accepted')


def registered(root):
    with agent_tasks.database() as db:
        row=db.execute('SELECT * FROM project_registry WHERE root=?',(root,)).fetchone()
    return dict(row) if row else None


def task_project(task):
    if task['origin']!='supervisor' or task['role'] not in ('coding','supervisor'):
        raise ValueError('Registered autonomous project task required')
    row=registered(task['project'])
    if not row: raise ValueError('Project is not registered')
    return row


def worktree(task):
    return Path(config.data('agent_worktrees')) / task['id']


def prepare(task):
    row=task_project(task)
    tree=worktree(task);branch='misty/task-'+task['id']
    if not BRANCH.fullmatch(branch): raise ValueError('Invalid task branch')
    with agent_tasks.database() as db:
        previous=db.execute('SELECT detail FROM task_summaries WHERE task_id=? AND kind="branch_prepared" ORDER BY seq LIMIT 1',(task['id'],)).fetchone()
    if tree.exists():
        actual=command(['git','branch','--show-current'],str(tree))
        if actual!=branch: raise ValueError('Existing worktree belongs to another branch')
        if not previous: raise ValueError('Existing worktree has no recorded base')
        base=json.loads(previous[0])['base']
    else:
        base=command(['git','rev-parse','HEAD'],row['root'])
        tree.parent.mkdir(parents=True,exist_ok=True)
        command(['git','worktree','add','-b',branch,str(tree),'HEAD'],row['root'])
    if not previous:
        agent_tasks.record(task['id'],'branch_prepared',json.dumps({'branch':branch,'worktree':str(tree),'base':base}))
    return {'branch':branch,'worktree':str(tree),'repository':row['repository'],'base':base}


def _prepared(task):
    row=task_project(task);tree=worktree(task);branch='misty/task-'+task['id']
    if not tree.is_dir() or command(['git','branch','--show-current'],str(tree))!=branch:
        raise ValueError('Prepare the isolated task branch first')
    return row,tree,branch


def publish(task):
    row,tree,branch=_prepared(task)
    if command(['git','status','--porcelain'],str(tree)):
        raise ValueError('Commit and review all task changes before publication')
    with agent_tasks.database() as db:
        prepared=db.execute('SELECT detail FROM task_summaries WHERE task_id=? AND kind="branch_prepared" ORDER BY seq LIMIT 1',(task['id'],)).fetchone()
    if not prepared: raise ValueError('Missing branch base receipt')
    base=json.loads(prepared[0])['base']
    changed=command(['git','diff','--name-only',base+'..HEAD'],str(tree)).splitlines()
    if not changed: raise ValueError('No committed changes to publish')
    recipe=json.loads(row['release_json'])
    protected=recipe.get('protectedPaths',[])
    if any(name.replace('\\','/') in MISTY_CONTROL_PATHS or
           any(Path(name).match(pattern) for pattern in protected) for name in changed):
        raise ValueError('Authority or confirmation file changed; owner decision required')
    for argv in json.loads(row['checks_json']): command(argv,str(tree),timeout=600)
    commit=command(['git','rev-parse','HEAD'],str(tree))
    command(['git','push','origin','HEAD:refs/heads/'+branch],str(tree),timeout=180)
    receipt={'branch':branch,'commit':commit,'tests':'passed','remote':row['repository']}
    agent_tasks.record(task['id'],'branch_pushed',json.dumps(receipt))
    return {**receipt,'automaticReleaseAvailable':bool(recipe)}


def release(task):
    row,tree,branch=_prepared(task)
    recipe=json.loads(row['release_json'])
    if not recipe: raise ValueError('No verified reversible release pipeline; leave a pushed branch')
    with agent_tasks.database() as db:
        published=db.execute('SELECT detail FROM task_summaries WHERE task_id=? AND kind="branch_pushed" ORDER BY seq DESC LIMIT 1',(task['id'],)).fetchone()
    if not published: raise ValueError('Publish and test the task branch first')
    receipt=json.loads(published[0])
    if command(['git','rev-parse','HEAD'],str(tree))!=receipt['commit']:
        raise ValueError('Commit changed after checks; publish again')
    def expand(argv):
        return [part.replace('{branch}',branch).replace('{worktree}',str(tree)).replace('{commit}',receipt['commit']) for part in argv]
    try:
        command(expand(recipe['deploy']),str(tree),timeout=600)
        health=command(expand(recipe['health']),str(tree),timeout=120)
        result={**receipt,'released':True,'health':health[-1000:]}
        agent_tasks.record(task['id'],'release_receipt',json.dumps(result))
        return result
    except Exception as error:
        try:
            rollback=command(expand(recipe['rollback']),str(tree),timeout=600)
            agent_tasks.record(task['id'],'rollback_receipt',rollback)
        except Exception as rollback_error:
            agent_tasks.record(task['id'],'rollback_failed',type(rollback_error).__name__)
        raise RuntimeError('Release failed; inspect release and rollback receipts') from error


if __name__=='__main__':
    if len(sys.argv) not in (3,4) or sys.argv[1]!='register':
        raise SystemExit('Usage: agent_projects.py register manifest.json [--verify]')
    print(json.dumps(register(json.loads(Path(sys.argv[2]).read_text()),len(sys.argv)==4 and sys.argv[3]=='--verify')))
