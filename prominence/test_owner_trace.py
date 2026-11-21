"""Latest-turn timing and bounded visible trace storage."""
import os
import tempfile
import unittest
from contextlib import closing
from unittest.mock import patch

import config
import owner_trace


class OwnerTraceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        data = patch.object(config, 'DATA_DIR', self.temp.name)
        data.start()
        self.addCleanup(data.stop)

    def test_latest_run_has_trigger_timing_and_coalesced_visible_text(self):
        self.assertIsNone(owner_trace.latest()['run'])
        owner_trace.begin('run-1', {'id': 'message-1', 'content': 'Where is the delay?',
                      'timestamp': '2026-11-02T12:00:00.000Z'}, 1, 'model', 'high')
        owner_trace.record('run-1', 'agent_ready', 'Codex ready', 'Reused the warm app-server')
        owner_trace.append_text('run-1', 'reasoning_summary', 'Reasoning summary', 'item-1:0', 'Check ')
        owner_trace.append_text('run-1', 'reasoning_summary', 'Reasoning summary', 'item-1:0', 'latency.')
        owner_trace.append_text('run-1', 'visible_text', 'Visible model text', 'item-2', 'Here is the answer.')
        owner_trace.finish('run-1', 'complete')
        latest = owner_trace.latest()
        self.assertEqual(latest['run']['trigger_at'], 1793620800000)
        self.assertEqual(latest['run']['state'], 'complete')
        self.assertEqual(latest['run']['input_text'], 'Where is the delay?')
        self.assertEqual([e['detail'] for e in latest['events'] if e['kind'] == 'reasoning_summary'],
                         ['Check latency.'])
        self.assertIn('Raw private reasoning', latest['coverage'])
        if os.name != 'nt':
            self.assertEqual(os.stat(config.data('owner_trace.sqlite')).st_mode & 0o777, 0o600)

    def test_thirty_day_retention_and_bounded_visible_events(self):
        for index in range(7):
            owner_trace.begin(f'run-{index}', {'id': str(index), 'content': 'x'}, 1, 'model', 'low')
            owner_trace.append_text(f'run-{index}', 'visible_text', 'Visible model text', 'item', 'a' * 14000)
            owner_trace.finish(f'run-{index}', 'complete')
        latest = owner_trace.latest()
        self.assertEqual(latest['run']['run'], 'run-6')
        self.assertEqual(len(next(e['detail'] for e in latest['events'] if e['kind'] == 'visible_text')), 12000)
        import sqlite3
        with closing(sqlite3.connect(config.data('owner_trace.sqlite'))) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM trace_runs').fetchone()[0], 7)
            db.execute('UPDATE trace_runs SET handler_at=handler_at-31*86400000 WHERE run="run-0"')
            db.commit()
        owner_trace.prune()
        with closing(sqlite3.connect(config.data('owner_trace.sqlite'))) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM trace_runs').fetchone()[0], 6)
            self.assertEqual(db.execute('SELECT count(*) FROM trace_events WHERE run="run-0"').fetchone()[0], 0)

    def test_cursor_does_not_repeat_after_every_old_trace_is_pruned(self):
        import sqlite3
        owner_trace.begin('old', {'id': 'old', 'content': 'old'}, 1, 'model', 'low')
        cursor = owner_trace.read_since(0)['highWater']
        with closing(sqlite3.connect(config.data('owner_trace.sqlite'))) as db:
            db.execute('UPDATE trace_runs SET handler_at=handler_at-31*86400000')
            db.commit()
        owner_trace.prune()
        self.assertEqual(owner_trace.read_since(cursor)['rows'], [])
        owner_trace.begin('new', {'id': 'new', 'content': 'new'}, 1, 'model', 'low')
        fresh = owner_trace.read_since(cursor)
        self.assertEqual([row['run'] for row in fresh['rows']], ['new'])
        self.assertGreater(fresh['highWater'], cursor)
        self.assertEqual(owner_trace.read_since(fresh['highWater'])['highWater'], fresh['highWater'])

    def test_legacy_rowid_cursor_survives_sequence_upgrade(self):
        import sqlite3
        for index in range(3):
            owner_trace.begin(f'old-{index}', {'id': str(index), 'content': 'x'}, 1, 'model', 'low')
        with closing(sqlite3.connect(config.data('owner_trace.sqlite'))) as db:
            db.execute('DROP TRIGGER trace_runs_sequence')
            db.execute('DROP TABLE trace_sequence')
            db.execute("DELETE FROM trace_runs WHERE run IN ('old-0','old-1')")
            db.commit()
        upgraded = owner_trace.read_since(2)
        self.assertEqual([row['run'] for row in upgraded['rows']], ['old-2'])
        self.assertEqual(upgraded['highWater'], 3)
