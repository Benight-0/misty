"""Stacked owner-only work steps with two-second elapsed refreshes.

Steps stack until the whole turn ends, then only their recorded status messages
are deleted. Unknown POST deliveries are reconciled, never blindly retried.
"""
import hashlib
import json
import os
from pathlib import Path
import threading
import time

PREFIX = '> \u200bWorking · '


class OwnerProgress:
    def __init__(self, request, bot_id, clock=time.monotonic, wall=time.time, state_file=None):
        self.request, self.bot_id, self.clock, self.wall = request, bot_id, clock, wall
        self.lock = threading.RLock()
        self.wake = threading.Event()
        self.run = None
        self.channel = None
        self.label = ''
        self.since = 0
        self.worker = None
        self.steps = []
        self.counter = 0
        self.state_file = Path(state_file) if state_file else None
        if self.state_file and self.state_file.exists():
            try:
                saved = json.loads(self.state_file.read_text())
                self.steps = saved.get('steps', [])
                for step in self.steps:
                    step['cleanup'] = True
                    step['last'] = -100.0
            except (OSError, ValueError, TypeError):
                self.steps = []

    def _save(self):
        if self.state_file:
            temporary = self.state_file.with_suffix('.tmp')
            temporary.write_text(json.dumps({'steps':self.steps}))
            os.chmod(temporary, 0o600)
            os.replace(temporary, self.state_file)

    def _retire(self, run):
        for step in self.steps:
            if step['run'] == run:
                step['cleanup'] = True
        self._save()

    def start(self, channel):
        with self.lock:
            if self.worker:
                return
            self.channel = channel
            self.worker = threading.Thread(target=self._loop, daemon=True, name='owner-progress')
            self.worker.start()

    def _finish_step(self):
        if self.steps and self.steps[-1]['state'] == 'running':
            self.steps[-1].update(state='done', ended=int(self.wall()*1000))

    def _append(self, label):
        self.counter += 1
        self.label, self.since = label, int(self.wall()*1000)
        self.steps.append(dict(id=f'{self.run}:{self.counter}', run=self.run,
            label=label, since=self.since, ended=0, state='running', channel=self.channel,
            message=None, failed=False, rendered='', last=-100.0, cleanup=False))
        # Retain every active step ID until its Discord deletion is confirmed.
        self._save()

    def begin(self, run, channel):
        with self.lock:
            if self.run == run:
                return
            self._finish_step()
            if self.run:
                self._retire(self.run)
            self.run, self.channel = run, channel
            self._append('thinking')
        self.wake.set()

    def update(self, run, label):
        with self.lock:
            label = str(label or 'thinking').strip()[:80]
            if self.run != run or label == self.label:
                return
            self._finish_step()
            self._append(label)
        self.wake.set()

    def item(self, run, ident, label, completed=False):
        """Track actual operation IDs; equal labels still represent distinct work."""
        if not ident:
            return
        with self.lock:
            if self.run != run:
                return
            key=str(run)+':item:'+str(ident)
            found=next((row for row in self.steps if row['id']==key),None)
            if completed:
                if found and found['state']=='running':
                    found.update(state='done',ended=int(self.wall()*1000))
                if not any(row['run']==run and row['state']=='running' for row in self.steps):
                    self._append('thinking')
            elif not found:
                if self.steps and self.steps[-1]['label']=='thinking':
                    self._finish_step()
                self._append(str(label or 'working')[:80])
                self.steps[-1]['id']=key
        self.wake.set()

    def finish(self, run):
        with self.lock:
            if self.run != run:
                return
            for row in self.steps:
                if row['run']==run and row['state']=='running':
                    row.update(state='done',ended=int(self.wall()*1000))
            self._retire(run)
            self.run, self.label, self.since = None, '', 0
        self.wake.set()

    def snapshot(self):
        with self.lock:
            return {'active':bool(self.run), 'label':self.label, 'since':self.since,
                'run':self.run or '', 'items':[
                    {k:s[k] for k in ('id','run','label','since','ended','state')}
                    for s in self.steps if s['run']==self.run and not s.get('cleanup')]}

    def _loop(self):
        while True:
            self.wake.wait(0.5)
            self.wake.clear()
            try:
                self.pump()
            except Exception:
                pass  # Status transport never stops an owner turn.

    def _cleanup(self, step):
        if self.clock()-step['last'] < 2:
            return
        step['last'] = self.clock()
        if not step['message'] and step['failed']:
            # Only a nonce from one of our recorded attempts can recover a lost
            # receipt. Never delete an arbitrary message matching visible text.
            nonce = hashlib.sha256(step['id'].encode()).hexdigest()[:24]
            before = ''
            for _ in range(20):
                url=f'https://discord.com/api/v10/channels/{step["channel"]}/messages?limit=100'+before
                rows=self.request('GET',url,None)
                if not isinstance(rows,list):
                    return
                match=next((row for row in rows if str(row.get('nonce',''))==nonce and
                    str((row.get('author') or {}).get('id',''))==str(self.bot_id) and
                    str(row.get('content','')).startswith(PREFIX)),None)
                if match:
                    step['message']=str(match['id'])
                    break
                if not rows:
                    break
                last=str(rows[-1].get('id',''))
                if not last.isdigit() or ((int(last)>>22)+1420070400000)<step['since']:
                    break
                before='&before='+last
            if not step['message']:
                return
        if step['message']:
            result=self.request('DELETE',f'https://discord.com/api/v10/channels/{step["channel"]}/messages/{step["message"]}',None)
            if result is None:
                return
        with self.lock:
            self.steps=[row for row in self.steps if row['id']!=step['id']]
            self._save()

    def pump(self):
        with self.lock:
            pending = list(self.steps)
        for step in pending:
            if step.get('cleanup'):
                self._cleanup(step)
                continue
            with self.lock:
                elapsed = max(0, ((step['ended'] or int(self.wall()*1000))-step['since'])//1000)
                content = PREFIX + step['label'] + f' · {elapsed}s' + (' · done' if step['state']=='done' else '')
                if step['failed'] or content == step['rendered'] or self.clock()-step['last'] < 2:
                    continue
                message, channel = step['message'], step['channel']
                # Reserve this attempt before transport; exceptions can't duplicate POSTs.
                step['last'] = self.clock()
                if not message:
                    step['failed'] = True
                self._save()
            payload = {'content':content, 'allowed_mentions':{'parse':[]}}
            if message:
                result = self.request('PATCH',f'https://discord.com/api/v10/channels/{channel}/messages/{message}',payload)
            else:
                payload.update(nonce=hashlib.sha256(step['id'].encode()).hexdigest()[:24], enforce_nonce=True)
                result = self.request('POST',f'https://discord.com/api/v10/channels/{channel}/messages',payload)
            with self.lock:
                if not message and isinstance(result,dict) and result.get('id'):
                    step['message'], step['failed'] = str(result['id']), False
                if result is not None:
                    step['rendered'] = content
                self._save()
