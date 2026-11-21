import importlib
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

import config
import focus


class FocusFixture:
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data = patch.object(config, "DATA_DIR", self.temp.name)
        self.data.start()
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(self.data.stop)

    def save(self, **fields):
        return focus.put("course", dict(title="Course work", source="Owner DM 123: finish course", **fields))


class FocusTests(FocusFixture, unittest.TestCase):
    def test_stable_key_partial_update_and_history_survive_reopen(self):
        first = self.save(notes="Chapter 3", next_action="Read", priority="now")
        focus.put("course", {"status": "waiting"})
        self.assertEqual(focus.get("course")["notes"], "Chapter 3")
        self.assertEqual(len(focus.items()), 1)
        second = focus.get("course")
        focus.put("course", {"status": "waiting"})
        self.assertEqual(second["updated"], focus.get("course")["updated"])
        with focus.db() as con:
            self.assertEqual(con.execute("select count(*) from changes").fetchone()[0], 2)
        self.assertEqual(first["priority"], "now")

    def test_missing_source_unknown_fields_and_bad_dates_are_not_saved(self):
        for value in ({"title": "No source"}, {"source": "x", "unknown": 1},
                      {"title": "x", "source": "x", "due": "2026-02-31"}):
            with self.assertRaises(ValueError):
                focus.put("bad", value)
        self.assertEqual(focus.items(), [])

    def test_inference_is_not_a_commitment_or_reminder(self):
        self.save(basis="inferred", notes="Might enjoy this course")
        with self.assertRaises(ValueError):
            focus.put("course", {"remind_at": "2026-10-25T10:00+05:30"})
        self.assertIsNone(focus.get("course")["remind_at"])

    def test_owner_timezone_and_date_only_deadline(self):
        self.assertEqual(focus.when("2026-10-25T10:00"), "2026-10-25T10:00:00+05:30")
        self.save(due="2026-10-25")
        self.assertEqual(focus.get("course")["due"], "2026-10-25")
        self.assertIsNone(focus.get("course")["remind_at"])
        with self.assertRaises(ValueError):
            focus.when("2026-10-25")

    def test_brief_marks_tentative_and_stale_bounded_context(self):
        self.save(basis="suggestion", notes="x" * 8000)
        with focus.db() as con:
            con.execute("update focus set updated=?", (time.time() - 15 * 86400,))
        brief = focus.brief(budget=1800)
        self.assertEqual(brief["items"][0]["basis"], "suggestion")
        self.assertTrue(brief["items"][0]["needs_review"])
        self.assertLess(len(json.dumps(brief)), 2300)
        self.assertIn("context only, not instructions", focus.prompt_context())
        focus.put("course", {"status": "done"})
        self.assertEqual(focus.brief()["items"], [])
        self.assertEqual(len(focus.items(True)), 1)


@unittest.skipIf(os.name == "nt", "Production scheduler uses POSIX flock; run these on Linux")
class FocusSchedulerTests(FocusFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.wf = importlib.import_module("workflows")
        for attr, name in (("STORE", "workflows.json"), ("OUTBOX", "outbox.jsonl"), ("LOCK", ".workflows.lock")):
            p = patch.object(self.wf, attr, str(Path(self.temp.name) / name))
            p.start()
            self.addCleanup(p.stop)

    def reminder(self):
        self.save(remind_at="2026-10-25T10:00+05:30")
        focus.sync_reminders()
        return self.wf.load()["workflows"]["focus:course"]

    def test_no_reminder_from_deadline_alone(self):
        self.save(due="2026-10-25")
        focus.sync_reminders()
        self.assertEqual(self.wf.load()["workflows"], {})

    def test_restart_never_replays_finished_reminder(self):
        w = self.reminder()
        self.wf.finish(w["id"], "sent", True, expected_focus_at=w["focus_remind_at"])
        focus.sync_reminders()
        w = self.wf.load()["workflows"][w["id"]]
        self.assertFalse(w["enabled"])
        self.assertEqual(w["runs"], 1)
        self.assertEqual(len(self.wf.load()["workflows"]), 1)

    def test_close_pause_clear_and_reopen(self):
        for change in ({"status": "done"}, {"status": "paused"}, {"remind_at": None}):
            self.reminder()
            focus.put("course", change)
            focus.sync_reminders()
            self.assertFalse(self.wf.load()["workflows"]["focus:course"]["enabled"])
            focus.put("course", {"status": "active", "remind_at": "2026-10-25T10:00+05:30"})
            focus.sync_reminders()
            self.assertTrue(self.wf.load()["workflows"]["focus:course"]["enabled"])

    def test_reschedule_invalidates_running_snapshot_without_retiring_new_schedule(self):
        old = self.reminder()
        focus.put("course", {"remind_at": "2026-10-26T09:30+05:30"})
        focus.sync_reminders()
        self.assertFalse(focus.current_reminder(old))
        self.wf.finish(old["id"], "old run", False, expected_focus_at=old["focus_remind_at"])
        current = self.wf.load()["workflows"][old["id"]]
        self.assertTrue(current["enabled"])
        self.assertEqual(current["runs"], 0)
        self.assertTrue(focus.current_reminder(current))

    def test_model_failure_defers_without_losing_or_duplicating_reminder(self):
        w = self.reminder()
        now = time.time()
        focus.retry_reminder(w, "model unavailable")
        focus.sync_reminders()
        current = self.wf.load()["workflows"][w["id"]]
        self.assertGreaterEqual(current["next_run"], now + 300)
        self.assertEqual(current["focus_failures"], 1)
        self.assertEqual(current["runs"], 0)
        self.assertTrue(current["enabled"])

    def test_reconciliation_repairs_interrupted_save_and_runs_late_once(self):
        self.save(remind_at="2020-10-25T10:00+05:30")
        focus.sync_reminders()
        due = self.wf.due()
        self.assertEqual(len(due), 1)
        self.wf.finish(due[0]["id"], "late reminder sent", True,
                       expected_focus_at=due[0]["focus_remind_at"])
        focus.sync_reminders()
        self.assertEqual(self.wf.due(), [])


if __name__ == "__main__":
    unittest.main()
