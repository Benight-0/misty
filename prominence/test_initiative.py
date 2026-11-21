import ast
import copy
from datetime import datetime
import json
import os
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import config
import initiative as it
import workflows as wf


def timestamp(hour=12, day=24):
    return datetime(2026, 10, day, hour, tzinfo=it.ZONE).timestamp()


class InitiativeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        for obj, key, value in [(config, 'DATA_DIR', self.temp.name), (wf, 'STORE', self.temp.name + '/workflows.json'),
                                (wf, 'LOCK', self.temp.name + '/.workflows.lock'), (wf, 'OUTBOX', self.temp.name + '/outbox.jsonl')]:
            p = patch.object(obj, key, value)
            p.start()
            self.addCleanup(p.stop)
        self.now = timestamp()
        self.context = {'focus': [{'id': 'essay', 'title': 'Essay', 'status': 'active', 'basis': 'owner', 'source': 'Owner DM',
                                  'due': '2026-11-01', 'updated': self.now, 'priority': 'now'}],
                        'ownerMessages': [{'id': 'owner', 'at': self.now - 3600, 'text': 'Working on essays'}],
                        'notes': [{'id': '1', 'body': 'Essay preference'}], 'recentProactive': [], 'reminders': []}
        self.sent = []
        self.prompts = []

    def decision(self, **changes):
        return {'send': True, 'body': 'how did that draft turn out?', 'kind': 'checkin', 'topic': 'essay',
                'focusId': '', 'reason': 'Useful follow-up', 'nextReviewMinutes': 180, 'followUps': [], **changes}

    def run_check(self, decision=None, now=None, **kwargs):
        def ask(prompt):
            self.prompts.append(prompt)
            return json.dumps(decision or self.decision())
        return it.run_check(ask=ask, notify=self.sent.append, context_loader=lambda n: copy.deepcopy(self.context),
                            now=self.now if now is None else now, **kwargs)

    def attempt(self, at=None, kind='checkin', topic='essay', body='earlier question', status='sent'):
        with it.database() as db:
            db.execute('INSERT INTO deliveries VALUES(?,?,?,?,?,?)', (str(at) + kind + topic, self.now if at is None else at, topic, kind, body, status))

    def test_scheduler_is_single_persistent_and_preserves_existing_pause_and_reminders(self):
        reminder = {'id': 'focus:essay', 'enabled': True, 'next_run': self.now + 60}
        with wf.store() as data:
            data['workflows'][reminder['id']] = reminder
        it.ensure_workflow(self.now)
        with wf.store() as data:
            data['workflows'][it.WORKFLOW_ID].update(enabled=False, runs=7)
        second = it.ensure_workflow(self.now + 1000)
        self.assertFalse(second['enabled'])
        self.assertEqual(second['runs'], 7)
        self.assertEqual(second['schedule'], {'every': 900})
        self.assertEqual(wf.load()['workflows'][reminder['id']], reminder)
        self.assertEqual(len(wf.load()['workflows']), 2)

    def test_context_and_voice_reach_tool_free_decision_and_repeated_runs_are_quiet(self):
        first = self.run_check(history=lambda: 'owner: draft is in progress')
        self.assertTrue(first['sent'])
        self.assertEqual(self.sent, ['how did that draft turn out?'])
        self.assertIn('draft is in progress', self.prompts[0])
        self.assertIn('Essay preference', self.prompts[0])
        self.assertIn('NO tools', self.prompts[0])
        self.assertIn('Never use guilt', self.prompts[0])
        self.assertEqual(self.run_check(now=self.now + 900)['reason'], 'review_not_due')
        self.assertEqual(len(self.prompts), 1)
        self.assertEqual(len(wf.told(since=0)), 1)

    def test_pause_survives_reopen_and_resume_does_not_touch_explicit_reminders(self):
        it.ensure_workflow(self.now)
        it.execute(['pause'])
        self.assertEqual(self.run_check()['reason'], 'paused')
        self.assertTrue(it.status()['paused'])
        self.assertEqual(it.execute(['resume'])['explicitReminders'], 'Independent; not paused by this control')
        self.assertTrue(self.run_check()['sent'])

    def test_nighttime_and_urgency_are_model_judgments_without_timing_windows(self):
        early = timestamp(2)
        self.assertTrue(self.run_check(now=early)['sent'])
        self.context['focus'][0]['due'] = datetime.fromtimestamp(early + 10 * 86400, it.ZONE).isoformat()
        self.assertEqual(len(it.deadline_evidence(self.context, early)), 1)
        self.assertTrue(self.run_check(self.decision(kind='urgent', focusId='essay'), now=early + 1)['sent'])
        self.context['focus'][0]['due'] = '2026-10-24'
        self.assertEqual(it.deadline_evidence(self.context, early), [])

    def test_no_daily_topic_recent_conversation_or_reminder_policy_caps(self):
        for i in range(12):
            self.attempt(at=self.now - i - 1, kind='urgent' if i % 2 else 'checkin')
        self.context['recentProactive'] = [{'time': self.now - 20, 'text': 'Activity comment'}]
        self.context['reminders'] = [{'id': 'focus:essay', 'focusId': 'essay', 'at': self.now + 60}]
        self.context['ownerMessages'][0]['at'] = self.now
        result = self.run_check()
        self.assertTrue(result['sent'])
        self.assertIn('Activity comment', self.prompts[0])
        self.assertIn('focus:essay', self.prompts[0])
        self.assertNotIn('quiet_hours', result['reason'])

    def test_model_can_choose_stable_followup_times_and_retime_without_duplicate_jobs(self):
        it.ensure_workflow(self.now)
        plan = {'key': 'essay-followup', 'source': 'focus:essay', 'task': 'Consider asking about the next draft',
                'at': datetime.fromtimestamp(self.now + 600, it.ZONE).isoformat()}
        result = self.run_check(self.decision(send=False, body='', followUps=[plan]))
        self.assertEqual(result['planned'], ['essay-followup'])
        self.assertFalse(self.sent)
        self.assertEqual(wf.load()['workflows'][it.WORKFLOW_ID]['next_run'], self.now + 600)
        plan['at'] = datetime.fromtimestamp(self.now + 3000, it.ZONE).isoformat()
        with it.database() as db:
            it.upsert_plan(db, it.validate_plan(plan['key'], {k: v for k, v in plan.items() if k != 'key'}, self.context, self.now))
            self.assertEqual(db.execute('SELECT count(*) FROM plans').fetchone()[0], 1)
        self.assertEqual(len(wf.load()['workflows']), 1)

    def test_plan_validation_has_no_count_or_horizon_cap_and_cancel_persists(self):
        good = {'task': 'A useful question', 'source': 'focus:essay', 'at': datetime.fromtimestamp(self.now + 90 * 86400, it.ZONE).isoformat()}
        for bad in [{**good, 'source': 'owner:invented'}, {**good, 'at': '2026-10-25T12:00'},
                    {**good, 'at': datetime.fromtimestamp(self.now - 1, it.ZONE).isoformat()}]:
            with self.assertRaises(ValueError):
                it.validate_plan('followup', bad, self.context, self.now)
        with it.database() as db:
            for i in range(20):
                it.upsert_plan(db, it.validate_plan('plan-' + str(i), good, self.context, self.now))
            self.assertEqual(db.execute("SELECT count(*) FROM plans WHERE state='active'").fetchone()[0], 20)
        self.assertTrue(it.execute(['cancel', 'plan-0'])['cancelled'])

    def test_plan_due_after_restart_runs_once_and_offline_has_no_catchup_burst(self):
        it.ensure_workflow(self.now)
        plan = {'task': 'Consider an essay question', 'source': 'focus:essay', 'at': datetime.fromtimestamp(self.now + 60, it.ZONE).isoformat()}
        with it.database() as db:
            it.upsert_plan(db, it.validate_plan('followup', plan, self.context, self.now))
        result = self.run_check(now=self.now + 3 * 3600)
        self.assertTrue(result['sent'])
        with it.database() as db:
            self.assertEqual(db.execute('SELECT state FROM plans').fetchone()[0], 'done')
        self.assertFalse(self.run_check(now=self.now + 3 * 3600 + 900)['sent'])
        self.assertEqual(len(self.sent), 1)

    def test_pause_or_completed_focus_while_model_thinks_wins(self):
        def pause(prompt):
            it.execute(['pause'])
            return json.dumps(self.decision())
        result = it.run_check(ask=pause, notify=self.sent.append, context_loader=lambda n: self.context, now=self.now)
        self.assertEqual(result['reason'], 'paused_before_delivery')
        it.execute(['resume'])
        calls = [0]
        def loader(now):
            calls[0] += 1
            return self.context if calls[0] == 1 else {**self.context, 'focus': []}
        result = it.run_check(ask=lambda p: json.dumps(self.decision()), notify=self.sent.append, context_loader=loader, now=self.now)
        self.assertEqual(result['reason'], 'focus_changed_before_delivery')
        self.assertFalse(self.sent)

    def test_unknown_delivery_survives_restart_and_is_not_retried(self):
        def unknown(text):
            raise RuntimeError('Discord might have sent it')
        result = it.run_check(ask=lambda p: json.dumps(self.decision()), notify=unknown, context_loader=lambda n: self.context, now=self.now)
        self.assertEqual(result['reason'], 'delivery_unconfirmed')
        self.assertFalse(self.run_check(now=self.now + 900)['modelCalled'])
        later = self.run_check(now=self.now + 7 * 3600)
        self.assertEqual(later['reason'], 'previous_delivery_uncertain')
        self.assertFalse(self.sent)

    def test_cancel_during_decision_suppresses_plan_message_and_self_reschedule_is_valid(self):
        it.ensure_workflow(self.now)
        plan = {'task': 'Ask about draft', 'source': 'focus:essay', 'at': datetime.fromtimestamp(self.now + 60, it.ZONE).isoformat()}
        with it.database() as db:
            it.upsert_plan(db, it.validate_plan('essay-plan', plan, self.context, self.now))
        def cancel(prompt):
            it.execute(['cancel', 'essay-plan'])
            return json.dumps(self.decision(topic='essay-plan'))
        result = it.run_check(ask=cancel, notify=self.sent.append, context_loader=lambda n: self.context, now=self.now + 900)
        self.assertEqual(result['reason'], 'plan_changed_before_delivery')
        self.assertFalse(self.sent)
        with it.database() as db:
            it.upsert_plan(db, it.validate_plan('essay-plan', plan, self.context, self.now))
        future = {'key': 'essay-plan', **plan, 'at': datetime.fromtimestamp(self.now + 3600, it.ZONE).isoformat()}
        result = self.run_check(self.decision(topic='essay-plan', followUps=[future]), now=self.now + 900)
        self.assertTrue(result['sent'])
        with it.database() as db:
            self.assertEqual(db.execute("SELECT state FROM plans WHERE key='essay-plan'").fetchone()[0], 'active')

    def test_model_review_can_be_earlier_than_poll_or_beyond_twelve_hours(self):
        it.ensure_workflow(self.now)
        for minutes in (0.1, 1, 1440, 10080):
            with it.database() as db:
                it.save_setting(db, 'contextSignature', '')
            result = self.run_check(self.decision(send=False, body='', nextReviewMinutes=minutes))
            self.assertTrue(result['modelCalled'])
            self.assertNotEqual(result['reason'], 'invalid_model_decision')
            self.assertEqual(it.status()['nextReviewAt'], self.now + minutes * 60)
        with it.database() as db:
            it.save_setting(db, 'nextReviewAt', self.now + 6)
        it.wake_for_plans(self.now)
        self.assertEqual(wf.load()['workflows'][it.WORKFLOW_ID]['next_run'], self.now + 6)

    def test_bad_json_or_mentions_fail_silent_and_dry_run_does_not_send_or_save_plans(self):
        for output in ['not json', json.dumps(self.decision(body='@everyone')), json.dumps(self.decision(nextReviewMinutes=0)), json.dumps(self.decision(nextReviewMinutes=float("inf")))]:
            result = it.run_check(ask=lambda p: output, notify=self.sent.append, context_loader=lambda n: self.context, now=self.now, dry_run=True)
            self.assertEqual(result['reason'], 'invalid_model_decision')
        result = self.run_check(dry_run=True)
        self.assertTrue(result['send'])
        self.assertFalse(result['sent'])
        self.assertFalse(self.sent)
        with it.database() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM deliveries').fetchone()[0], 0)

    def test_model_chosen_review_and_changed_owner_context_or_feedback(self):
        self.context['ownerMessages'][0]['at'] = self.now
        self.assertTrue(self.run_check(self.decision(send=False, body=''))['modelCalled'])
        self.assertEqual(self.run_check(now=self.now + 900)['reason'], 'review_not_due')
        self.context['ownerMessages'][0]['text'] = 'I would like to talk more now'
        self.assertTrue(self.run_check(now=self.now + 901)['modelCalled'])
        it.execute(['preference', 'Be more conversational; no fixed quotas.'])
        self.assertEqual(it.status()['talkingPreference'], 'Be more conversational; no fixed quotas.')
        self.assertIsNone(it.status()['frequencyLimits'])
        self.assertTrue(self.run_check(now=self.now + 902)['modelCalled'])
        self.assertIn('Be more conversational', self.prompts[-1])
        self.context.update(focus=[], notes=[], ownerMessages=[])
        self.assertEqual(self.run_check(now=self.now + 10800)['reason'], 'no_current_context')

    def test_many_followups_and_longer_text_are_not_checkin_policy_limited(self):
        plans = [{'key': 'plan-' + str(i), 'task': 'Consider an essay conversation', 'source': 'focus:essay',
                  'at': datetime.fromtimestamp(self.now + 30 + i, it.ZONE).isoformat()} for i in range(12)]
        result = self.run_check(self.decision(body='a' * 1200, followUps=plans, nextReviewMinutes=1))
        self.assertTrue(result['sent'])
        self.assertEqual(len(result['planned']), 12)
        self.assertEqual(len(self.sent[0]), 1200)
        # A model-selected early next review really permits another same-topic check-in.
        self.assertTrue(self.run_check(self.decision(body='a distinct thought', nextReviewMinutes=1), now=self.now + 61)['sent'])

    def test_model_uses_main_sol_high_and_no_tools_or_persistent_session(self):
        class Process:
            returncode = 0
            def communicate(self, prompt, timeout):
                return '{}', ''
        with patch('subprocess.Popen', return_value=Process()) as spawn:
            with patch.object(config, 'get', side_effect=lambda name, default=None: {'agent_model': 'gpt-6.1-sol', 'agent_effort': 'high'}.get(name, default)):
                it.model_ask('fixture')
        command = spawn.call_args.args[0]
        self.assertEqual(command[command.index('--model') + 1], 'gpt-6.1-sol')
        self.assertEqual(command[command.index('--effort') + 1], 'high')
        self.assertEqual(command[command.index('--tools') + 1], '')
        self.assertIn('--no-session-persistence', command)
        self.assertNotIn('--permission-mode', command)
        self.assertEqual(spawn.call_args.kwargs['env']['MISTY_OWNER_MESSAGE_ID'], '')

    def test_paused_checks_still_prune_expired_private_state_without_model_or_sends(self):
        old = self.now - 31 * 86400
        with it.database() as db:
            it.save_setting(db, 'paused', True)
            db.execute('INSERT INTO deliveries VALUES(?,?,?,?,?,?)', ('old', old, 'old', 'checkin', 'old text', 'unknown'))
            db.execute('INSERT INTO plans VALUES(?,?,?,?,?,?,?)', ('old', 'old task', 'focus:essay', old, old + 86400, 'active', old))
        self.assertEqual(self.run_check()['reason'], 'paused')
        self.assertFalse(self.prompts)
        with it.database() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM deliveries').fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT count(*) FROM plans WHERE state='active'").fetchone()[0], 1)

    def test_real_storage_context_excludes_expired_notes_and_non_owner_messages(self):
        with sqlite3.connect(config.data('focus.sqlite')) as db:
            db.execute('CREATE TABLE focus(id TEXT,body TEXT,updated REAL)')
            item = self.context['focus'][0]
            db.execute('INSERT INTO focus VALUES(?,?,?)', ('essay', json.dumps(item), self.now))
        with sqlite3.connect(config.data('inbox.sqlite')) as db:
            db.execute('CREATE TABLE inbox(id TEXT,body TEXT)')
            snowflake = str((int((self.now - 1000) * 1000) - 1420070400000) << 22)
            db.execute('INSERT INTO inbox VALUES(?,?)', (snowflake, json.dumps({'author': {'id': config.OWNER_ID}, 'content': 'essays'})))
            db.execute('INSERT INTO inbox VALUES(?,?)', (snowflake, json.dumps({'author': {'id': 'other'}, 'content': 'untrusted other'})))
        with sqlite3.connect(config.data('context.db')) as db:
            db.executescript('CREATE TABLE item(id INTEGER,kind TEXT,title TEXT,created REAL,expires REAL); CREATE TABLE fts(body TEXT);')
            db.execute("INSERT INTO item VALUES(1,'note','Essay',?,NULL)", (self.now,))
            db.execute("INSERT INTO fts VALUES('essay preference')")
            db.execute("INSERT INTO item VALUES(2,'note','Essay',?,?)", (self.now, self.now - 1))
            db.execute("INSERT INTO fts VALUES('expired essay preference')")
        context = it.load_context(self.now)
        self.assertEqual(context['storage'], {'focus': 'available', 'owner': 'available', 'notes': 'available'})
        self.assertEqual(len(context['ownerMessages']), 1)
        self.assertEqual([n['id'] for n in context['notes']], ['1'])

    def test_bot_routes_initiative_through_existing_worker_without_general_or_tools(self):
        tree = ast.parse(Path(__file__).with_name('bot.py').read_text())
        function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'run_workflow')
        branch = next(n for n in function.body if isinstance(n, ast.If) and "'initiative'" in ast.unparse(n.test))
        code = ast.unparse(branch)
        self.assertIn('initiative.run_check', code)
        self.assertIn('send_dm(owner_dm_channel, text)', code)
        self.assertNotIn('GENERAL:', code)
        self.assertNotIn('Popen', code)
        # Exercise the real branch without importing bot.py and starting its network loops.
        calls = []
        def run_check(**kwargs):
            calls.append(kwargs['history']())
            kwargs['notify']('fixture owner-only message')
            return {'reason': 'fixture', 'sent': True}
        fake = SimpleNamespace(run_check=run_check, model_ask=lambda *a: None,
                               wake_for_plans=lambda: calls.append('wake'))
        scope = {'initiative': fake, 'owner_dm_channel': 'fixture-owner',
                 'owner_dm_history': lambda: 'fixture DM context',
                 'send_dm': lambda channel, body: calls.append((channel, body)),
                 'wf': SimpleNamespace(finish=lambda *args: calls.append(args))}
        exec(compile(ast.Module(body=[function], type_ignores=[]), 'workflow-fixture', 'exec'), scope)
        scope['run_workflow']({'id': it.WORKFLOW_ID, 'kind': 'initiative'})
        self.assertEqual(calls, ['fixture DM context', ('fixture-owner', 'fixture owner-only message'),
                                 (it.WORKFLOW_ID, 'fixture', True), 'wake'])


if __name__ == '__main__':
    unittest.main()
