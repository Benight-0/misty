import copy
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import time
import unittest
from unittest.mock import patch
import config
import workflows as wf
import laptop_activity as activity


def evidence():
    return {'status':{'state':'active','paused':False,'captureAgeMs':1000,'receiptAgeMs':500,'capturedAt':1000},
            'current':{'sessionState':'active','foreground':{'application':'Code','title':'essay'},
                       'windows':[{'application':'MinecraftBackgroundOnly'}],
                       'chrome':{'currentTab':None,'tabs':[{'title':'INACTIVE_TAB_ONLY','activeInWindow':False}]}},
            'interval':{'samples':30,'activeSeconds':850,'foregroundObservations':[{'application':'Code','title':'essay','observedSeconds':850}]}}


class LaptopActivityTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);folder=self.temp.name
        for target,name,value in [(config,'DATA_DIR',folder),(wf,'STORE',folder+'/workflows.json'),(wf,'OUTBOX',folder+'/outbox.jsonl'),(wf,'LOCK',folder+'/.workflows.lock')]:
            p=patch.object(target,name,value);p.start();self.addCleanup(p.stop)
        self.context={'focus':[{'title':'Essay','basis':'owner','priority':'now','due':'2026-11-01'}],'relevantNotes':[{'body':'notes are evidence'}]}
        self.calls=[]

    def ask(self,prompt):
        self.calls.append(prompt);return json.dumps({'send':True,'body':'Essay time, apparently.','reason':'synthetic support'})

    def test_foreground_only_decision_has_focus_and_notes_without_inactive_windows_or_tabs(self):
        result=activity.decide(evidence(),self.context,{},self.ask,now=10000)
        self.assertTrue(result['send']);self.assertEqual(result['body'],'essay time, apparently.')
        self.assertIn('2026-11-01',self.calls[0]);self.assertIn('notes are evidence',self.calls[0])
        self.assertNotIn('MinecraftBackgroundOnly',self.calls[0]);self.assertNotIn('INACTIVE_TAB_ONLY',self.calls[0])
        self.assertIn('untrusted',self.calls[0].lower());self.assertIn('NO tools/actions',self.calls[0])

    def test_pause_idle_lock_offline_stale_and_missing_foreground_skip_without_model(self):
        for state in ['paused','idle','locked_or_secure_desktop','offline_or_stale','unavailable']:
            data=evidence();data['status']['state']=state
            self.assertFalse(activity.decide(data,self.context,{},self.ask,10000)['modelCalled'])
        data=evidence();data['status']['captureAgeMs']=90001
        self.assertEqual(activity.decide(data,self.context,{},self.ask,10000)['reason'],'stale')
        data=evidence();data['current']['foreground']=None
        self.assertFalse(activity.decide(data,self.context,{},self.ask,10000)['modelCalled']);self.assertFalse(self.calls)

    def test_no_change_cooldown_and_existing_deadline_reminder_are_silent(self):
        data=evidence()
        self.assertEqual(activity.decide(data,self.context,{'lastSignature':activity.signature(data)},self.ask,10000)['reason'],'no_change')
        self.assertEqual(activity.decide(data,self.context,{'lastSentAt':9999},self.ask,10000)['reason'],'comment_cooldown')
        ctx={**self.context,'nearbyFocusReminders':[{'id':'existing','next_run':10000}]}
        self.assertEqual(activity.decide(data,ctx,{},self.ask,10000)['reason'],'existing_deadline_reminder_nearby');self.assertFalse(self.calls)

    def test_invalid_or_unsafe_output_cannot_become_notification(self):
        for output in ['not json',json.dumps({'send':'yes','body':'text'}),json.dumps({'send':True,'body':'https://evil.invalid'}),json.dumps({'send':True,'body':'x'*401})]:
            self.assertFalse(activity.decide(evidence(),self.context,{},lambda p:output,10000)['send'])

    def test_returning_to_same_foreground_does_not_hide_changed_interval(self):
        before=evidence();after=copy.deepcopy(before)
        after['interval']['foregroundObservations']=[{'application':'Code','title':'essay','observedSeconds':250},
                                                    {'application':'OBSERVED_GAME','title':'game','observedSeconds':600}]
        result=activity.decide(after,self.context,{'lastSignature':activity.signature(before)},self.ask,10000)
        self.assertTrue(result['modelCalled']);self.assertIn('OBSERVED_GAME',self.calls[0])
        unchanged=copy.deepcopy(after);unchanged['interval']['samples']=31
        unchanged['interval']['foregroundObservations'][0]['observedSeconds']=260
        self.assertEqual(activity.signature(after),activity.signature(unchanged))

    def test_scheduler_identity_and_existing_reminder_survive_restarts(self):
        existing={'id':'focus:existing','focus_id':'existing','enabled':True,'schedule':{'at':10001},'next_run':10001}
        with wf.store() as data:data['workflows'][existing['id']]=copy.deepcopy(existing)
        a=activity.ensure_workflow(10000)
        with wf.store() as data:data['workflows'][a['id']]['runs']=3;data['workflows'][a['id']]['enabled']=False
        b=activity.ensure_workflow(11000)
        self.assertEqual(b['id'],'laptop-activity-15m');self.assertEqual(b['schedule'],{'every':900});self.assertEqual(b['runs'],3);self.assertFalse(b['enabled'])
        self.assertEqual(wf.load()['workflows'][existing['id']],existing);self.assertEqual(len(wf.load()['workflows']),2)

    def test_context_reads_focus_and_relevant_unexpired_notes_without_mutation(self):
        focus=Path(config.data('focus.sqlite'));notes=Path(config.data('context.db'))
        with sqlite3.connect(focus) as db:
            db.execute('CREATE TABLE focus(id TEXT,body TEXT,updated REAL)');db.execute('INSERT INTO focus VALUES(?,?,?)',('essay',json.dumps({'title':'Essay','status':'active','priority':'now','basis':'owner','due':'2026-11-01'}),100))
        with sqlite3.connect(notes) as db:
            db.executescript('CREATE TABLE item(id INTEGER,kind TEXT,title TEXT,tags TEXT,created REAL,expires REAL);CREATE TABLE fts(body TEXT);')
            db.execute("INSERT INTO item VALUES(1,'note','Essay preference','',1,NULL)");db.execute("INSERT INTO fts VALUES('Essay notes')")
        before=focus.read_bytes(),notes.read_bytes();ctx=activity.load_context(evidence(),10000)
        self.assertEqual(ctx['focus'][0]['due'],'2026-11-01');self.assertEqual(ctx['relevantNotes'][0]['body'],'Essay notes')
        self.assertEqual(before,(focus.read_bytes(),notes.read_bytes()))

    def test_real_check_path_is_durable_and_duplicate_safe_without_actual_dm(self):
        sent=[];read=lambda op:evidence() if op=='read' else evidence()['status']
        result=activity.run_check(self.ask,notify=sent.append,read=read,context_loader=lambda a,n:self.context,now=10000)
        self.assertTrue(result['sent']);self.assertEqual(sent,['essay time, apparently.'])
        again=activity.run_check(self.ask,notify=sent.append,read=read,context_loader=lambda a,n:self.context,now=10001)
        self.assertEqual(again['reason'],'no_change');self.assertEqual(len(sent),1);self.assertEqual(len(self.calls),1)
        self.assertEqual(len(wf.told(since=0)),1)

    def test_dry_run_never_sends_or_commits_decision(self):
        sent=[];r=activity.run_check(self.ask,notify=sent.append,dry_run=True,read=lambda op:evidence(),context_loader=lambda a,n:self.context,now=10000)
        self.assertFalse(r['sent']);self.assertFalse(sent);self.assertFalse(Path(config.data('laptop_activity_state.json')).exists())

    def test_pause_while_model_thinks_suppresses_send(self):
        sent=[];read=lambda op:evidence() if op=='read' else {'state':'paused','paused':True}
        r=activity.run_check(self.ask,notify=sent.append,read=read,context_loader=lambda a,n:self.context,now=10000)
        self.assertEqual(r['reason'],'changed_before_delivery');self.assertFalse(sent)

    def test_ambiguous_discord_delivery_is_not_replayed(self):
        def unknown(text):raise RuntimeError('uncertain')
        read=lambda op:evidence() if op=='read' else evidence()['status']
        r=activity.run_check(self.ask,notify=unknown,read=read,context_loader=lambda a,n:self.context,now=10000)
        self.assertEqual(r['reason'],'delivery_unconfirmed')
        again=activity.run_check(self.ask,notify=unknown,read=read,context_loader=lambda a,n:self.context,now=10001)
        self.assertFalse(again['modelCalled']);self.assertEqual(len(self.calls),1)


if __name__=='__main__':unittest.main()
