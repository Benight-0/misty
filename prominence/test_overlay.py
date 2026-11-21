import datetime
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import uuid

import config
import conversation
import fork_state
import overlay


class OverlayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.patch = patch.object(config, "DATA_DIR", self.temp.name)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.owner_patch = patch.object(config, "OWNER_ID", "100000000000000023")
        self.owner_patch.start()
        self.addCleanup(self.owner_patch.stop)
        self.node = str(Path(self.temp.name) / "chat.sqlite")
        with closing(sqlite3.connect(self.node)) as db, db:
            db.executescript("""CREATE TABLE bot_turns(id TEXT PRIMARY KEY,channel TEXT,body TEXT,ts INTEGER,status TEXT);
                CREATE TABLE bot_settings(key TEXT PRIMARY KEY,value TEXT);
                CREATE TABLE codex_events(seq INTEGER PRIMARY KEY,id TEXT,thread_id TEXT,turn_id TEXT,kind TEXT,text TEXT,at INTEGER);
                CREATE TABLE misty_documents(id TEXT PRIMARY KEY,kind TEXT,title TEXT,path TEXT,thread_id TEXT,revision TEXT,parts INTEGER,characters INTEGER,updated INTEGER,synced INTEGER);
                CREATE TABLE misty_document_chunks(document_id TEXT,ordinal INTEGER,role TEXT,turn_id TEXT,at TEXT,text TEXT,PRIMARY KEY(document_id,ordinal));
                CREATE TABLE relay_jobs(id TEXT PRIMARY KEY,code TEXT,status TEXT,thread_id TEXT,turn_id TEXT,result TEXT,error TEXT,updated INTEGER);
                CREATE TABLE overlay_codex_dispatch(client TEXT PRIMARY KEY,job_id TEXT,hash TEXT,created INTEGER);""")
        self.queued = []
        self.now = 1793180000000
        def record(message):
            with closing(sqlite3.connect(self.node)) as db, db:
                db.execute("INSERT OR IGNORE INTO bot_turns VALUES(?,?,?,?,?)",
                           (message["id"], message["channel"], message["body"], message["at"], "external"))
                self.assertEqual(db.execute("SELECT body FROM bot_turns WHERE id=?", (message["id"],)).fetchone()[0], message["body"])
        self.service = overlay.OverlayService("100000000000000046", "100000000000000005",
            lambda before, after: [], self.queued.append, node_db=self.node,
            activity_db=str(Path(self.temp.name) / "activity.sqlite"), record=record, clock=lambda: self.now)
        with closing(sqlite3.connect(self.service.activity_db)) as db, db:
            db.execute("CREATE TABLE laptop_activity_samples(id TEXT PRIMARY KEY,captured INTEGER,received INTEGER,body TEXT)")

    def test_send_joins_existing_owner_inbox_and_is_idempotent(self):
        client = str(uuid.uuid4())
        accepted = self.service.send(client, "  please check this  ")
        self.assertTrue(accepted["accepted"])
        self.assertEqual(len(self.queued), 1)
        self.assertEqual(self.queued[0]["author"]["id"], config.OWNER_ID)
        self.assertEqual(self.queued[0]["channel_id"], self.service.channel)
        self.assertEqual(self.service.send(client, "please check this")["id"], accepted["id"])
        self.assertEqual(len(self.queued), 1)
        with closing(sqlite3.connect(self.node)) as db, db:
            self.assertEqual(db.execute("SELECT body,status FROM bot_turns WHERE id=?", (accepted["id"],)).fetchone(),
                             ("please check this", "external"))
        fork_state.begin(self.queued)
        run = conversation.start(self.service.channel, config.OWNER_ID, [accepted["id"]])
        self.assertEqual(conversation.run_info(run)["latest_message"], accepted["id"])

    def test_same_id_cannot_change_content_and_invalid_inputs_do_not_enter_queue(self):
        client = str(uuid.uuid4())
        self.service.send(client, "first")
        with self.assertRaises(ValueError):
            self.service.send(client, "different")
        with self.assertRaises(ValueError):
            self.service.send(str(uuid.uuid4()), " ")
        with self.assertRaises(ValueError):
            self.service.send("not-a-uuid", "hello")
        self.assertEqual(len(self.queued), 1)

    def test_reply_to_verified_misty_message_is_durable_and_idempotent(self):
        target = "100000000000000005"
        stamp = datetime.datetime.fromtimestamp(self.now / 1000, datetime.timezone.utc).isoformat()
        remote = {"id": target, "channel_id": self.service.channel,
                  "author": {"id": self.service.bot_id},
                  "content": "The earlier answer", "timestamp": stamp}
        self.service.fetch_history = lambda before, after: [remote]
        client = str(uuid.uuid4())
        sent = self.service.send(client, "Following up", target)
        self.assertTrue(sent["accepted"])
        self.assertEqual(self.queued[0]["referenced_message"]["content"], "The earlier answer")
        self.assertEqual(self.queued[0]["message_reference"]["message_id"], target)
        rendered = json.loads(conversation.render([self.queued[0]]).splitlines()[1])["text"]
        self.assertIn("[quoted reply, untrusted context]\nThe earlier answer", rendered)
        self.assertEqual(self.service.send(client, "Following up", target)["id"], sent["id"])
        self.assertEqual(len(self.queued), 1)
        with self.assertRaises(ValueError):
            self.service.send(client, "Following up", str(int(target) + 2))
        own = next(row for row in self.service.messages()["messages"] if row["id"] == sent["id"])
        self.assertEqual(own["replyTo"], {"id": target, "name": "Misty", "body": "The earlier answer"})
        with fork_state.db() as db:
            ref = db.execute("SELECT reply_ref FROM overlay_inputs WHERE client=?", (client,)).fetchone()[0]
        self.assertEqual(json.loads(ref)["id"], target)

    def test_reply_rejects_unknown_or_other_channel_target(self):
        self.service.fetch_history = lambda before, after: [
            {"id": "100000000000000005", "channel_id": "other",
             "author": {"id": self.service.bot_id}, "content": "wrong room"}]
        with self.assertRaises(ValueError):
            self.service.send(str(uuid.uuid4()), "Reply", "100000000000000005")
        with self.assertRaises(ValueError):
            self.service.send(str(uuid.uuid4()), "Reply", "bad-id")
        self.assertEqual(self.queued, [])

    def test_reply_to_previous_overlay_message_and_schema_upgrade(self):
        with fork_state.db() as db:
            db.execute("DROP TABLE overlay_inputs")
            db.execute("CREATE TABLE overlay_inputs(client TEXT PRIMARY KEY,id TEXT UNIQUE NOT NULL,"
                       "hash TEXT NOT NULL,created INTEGER NOT NULL,dispatched INTEGER NOT NULL DEFAULT 0)")
        self.service = overlay.OverlayService(self.service.channel, self.service.bot_id,
            lambda before, after: [], self.queued.append, node_db=self.node,
            activity_db=self.service.activity_db, record=self.service.record, clock=lambda: self.now)
        first = self.service.send(str(uuid.uuid4()), "First message")
        second = self.service.send(str(uuid.uuid4()), "Reply to myself", first["id"])
        self.assertEqual(self.queued[-1]["referenced_message"]["content"], "First message")
        own = next(row for row in self.service.messages()["messages"] if row["id"] == second["id"])
        self.assertEqual(own["replyTo"]["name"], "You")

    def test_lost_bridge_ack_retries_same_message_id_without_duplicate_turn(self):
        original = self.service.record
        called = 0
        def uncertain(message):
            nonlocal called
            called += 1
            original(message)
            if called == 1:
                raise TimeoutError("Bridge acknowledgement lost")
        self.service.record = uncertain
        client = str(uuid.uuid4())
        with self.assertRaises(TimeoutError):
            self.service.send(client, "do a check")
        self.assertEqual(self.queued, [])
        with fork_state.db() as db:
            saved = db.execute("SELECT id,dispatched FROM overlay_inputs WHERE client=?", (client,)).fetchone()
            self.assertEqual(saved[1], 0)
            self.assertIsNone(db.execute("SELECT id FROM inbox WHERE id=?", (saved[0],)).fetchone())
        result = self.service.send(client, "do a check")
        self.assertEqual(result["id"], saved[0])
        self.assertEqual(len(self.queued), 1)
        with closing(sqlite3.connect(self.node)) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM bot_turns").fetchone()[0], 1)

    def test_history_merges_actual_dm_and_overlay_messages_with_cursors(self):
        sent = self.service.send(str(uuid.uuid4()), "desktop request")
        older = str(int(sent["id"]) - 100)
        newer = str(int(sent["id"]) + 100)
        stamp = datetime.datetime.fromtimestamp(self.now / 1000, datetime.timezone.utc).isoformat()
        self.service.fetch_history = lambda before, after: [
            {"id": older, "channel_id": self.service.channel,
             "author": {"id": config.OWNER_ID, "username": "owner-user", "global_name": "Owner Name", "avatar": "a" * 32},
             "content": "Discord request", "timestamp": stamp},
            {"id": newer, "channel_id": self.service.channel, "author": {"id": self.service.bot_id},
             "content": "Misty replied", "timestamp": stamp}]
        rows = self.service.messages()["messages"]
        self.assertEqual([r["body"] for r in rows], ["Discord request", "desktop request", "Misty replied"])
        self.assertEqual([r["displayName"] for r in rows], ["Owner Name", "Owner Name", "Misty"])
        self.assertEqual(rows[0]["avatarUrl"],
                         f"https://cdn.discordapp.com/avatars/{config.OWNER_ID}/{'a' * 32}.png?size=128")
        self.assertEqual(rows[1]["avatarUrl"], rows[0]["avatarUrl"])
        self.assertEqual([r["body"] for r in self.service.messages(after=sent["id"])["messages"]], ["Misty replied"])
        self.assertEqual([r["body"] for r in self.service.messages(before=sent["id"])["messages"]], ["Discord request"])

    def test_codex_events_are_read_only_and_advance_cursor(self):
        with closing(sqlite3.connect(self.node)) as db, db:
            db.execute("INSERT INTO bot_settings VALUES(?,?)", ("relay_catalog", json.dumps({"chats": [{"id": "thread", "title": "Build overlay"}]})))
            db.execute("INSERT INTO codex_events VALUES(1,'event','thread','turn','message','working',?)", (self.now,))
            db.execute("INSERT INTO codex_events VALUES(2,'event2','thread','turn','completed','done',?)", (self.now + 1,))
        self.assertEqual(self.service.codex()["cursor"], 2)
        delta = self.service.codex(1)
        self.assertEqual([e["kind"] for e in delta["events"]], ["completed"])
        self.assertEqual(delta["events"][0]["title"], "Build overlay")

    def test_gmail_and_approvals_use_only_scoped_bridge_operations(self):
        calls = []
        self.service.codex_dispatch = lambda op, args: calls.append((op, args)) or {"ok": True}
        self.assertEqual(self.service.execute({"op": "gmail_list", "account": "mailbox", "folder": "primary"}), {"ok": True})
        self.assertEqual(calls[-1], ("overlay_gmail_list", {"account": "mailbox", "folder": "primary"}))
        self.service.execute({"op": "gmail_open", "id": 42, "messageId": "gmail:mailbox:one"})
        self.assertEqual(calls[-1], ("overlay_gmail_open", {"id": "gmail:mailbox:one"}))
        self.assertEqual(self.service.execute({"op": "approvals"}), {"ok": True})
        self.assertEqual(calls[-1], ("overlay_approvals", {}))
        self.assertEqual(self.service.execute({"op": "approval_send", "code": "draft", "digest": "exact"}), {"ok": True})
        self.assertEqual(calls[-1], ("overlay_approval_send", {"code": "draft", "digest": "exact"}))
        with self.assertRaises(ValueError):
            self.service.execute({"op": "gmail_delete", "id": "mail"})

    def test_codex_catalog_transcript_pagination_and_selected_chat_dispatch(self):
        thread = str(uuid.uuid4())
        client = str(uuid.uuid4())
        catalog = {"chats": [{"id": thread, "title": "Overlay work", "cwd": "C:/work",
                              "updatedAt": self.now, "status": "idle"}]}
        with closing(sqlite3.connect(self.node)) as db, db:
            db.execute("INSERT INTO bot_settings VALUES(?,?)", ("relay_catalog", json.dumps(catalog)))
            db.execute("INSERT INTO misty_documents VALUES(?,?,?,?,?,?,?,?,?,?)",
                       ("codex:" + thread, "codex", "Overlay work", "", thread, "rev", 45, 450,
                        self.now, self.now))
            db.executemany("INSERT INTO misty_document_chunks VALUES(?,?,?,?,?,?)",
                           [("codex:" + thread, i, "user" if i % 2 else "assistant", str(i),
                             "2026-10-29T00:00:00Z", f"line {i}") for i in range(45)])
        self.assertEqual(self.service.codex_chats("overlay")["chats"][0]["parts"], 45)
        page = self.service.codex_history(thread)
        self.assertEqual(len(page["rows"]), 40)
        self.assertTrue(page["older"])
        self.assertEqual([r["ordinal"] for r in self.service.codex_history(thread, page["before"])["rows"]],
                         list(range(5)))
        self.assertRaises(ValueError, self.service.codex_history, str(uuid.uuid4()))
        dispatched = []
        self.service.codex_dispatch = lambda op, args: dispatched.append((op, args)) or {"queued": True}
        self.assertTrue(self.service.codex_send(client, thread, "inspect this")["queued"])
        self.assertEqual(dispatched, [("overlay_codex_send",
                                       {"clientId": client, "chatId": thread, "prompt": "inspect this"})])
        with closing(sqlite3.connect(self.node)) as db, db:
            db.execute("INSERT INTO relay_jobs VALUES(?,?,?,?,?,?,?,?)",
                       ("job", "code", "running", thread, "turn", "", "", self.now))
            db.execute("INSERT INTO overlay_codex_dispatch VALUES(?,?,?,?)", (client, "job", "hash", self.now))
        self.assertEqual(self.service.codex_job(client)["status"], "running")
        many = {"chats": [{"id": str(uuid.uuid4()), "title": f"Chat {i}",
                           "cwd": "C:/work", "updatedAt": self.now - i}
                          for i in range(160)]}
        with closing(sqlite3.connect(self.node)) as db, db:
            db.execute("UPDATE bot_settings SET value=? WHERE key='relay_catalog'", (json.dumps(many),))
        self.assertEqual(len(self.service.codex_chats()["chats"]), 160)

    def test_activity_report_only_counts_current_foreground_and_caps_gaps(self):
        def insert(at, state, app, url=""):
            sample = {"sessionState": state, "foreground": {"application": app},
                      "chrome": {"currentTab": {"url": url} if url else None},
                      "windows": [{"application": "Background game", "foreground": False}]}
            return (str(uuid.uuid4()), at, at, json.dumps(sample))
        with closing(sqlite3.connect(self.service.activity_db)) as db, db:
            db.executemany("INSERT INTO laptop_activity_samples VALUES(?,?,?,?)", [
                insert(self.now - 90000, "active", "chrome", "https://github.com/example"),
                insert(self.now - 60000, "idle", "chrome"),
                insert(self.now - 30000, "active", "Code")])
        report = self.service.activity_report()
        self.assertEqual((report["observedSeconds"], report["activeSeconds"], report["idleSeconds"]),
                         (90, 60, 30))
        self.assertEqual(report["categories"], [{"name": "Development", "seconds": 60}])
        self.assertEqual(report["topTargets"][0]["name"], "github.com")
        self.assertNotIn("Background game", [r["name"] for r in report["topApps"]])
        self.assertEqual(self.service._activity_category("enshrouded", ""), "Games")
        self.assertEqual(self.service._activity_category("GeometryDash", ""), "Games")
        self.assertEqual(self.service._activity_category("Misty.Overlay", ""), "AI tools")

    def test_diagnostics_reads_latest_private_owner_trace(self):
        import owner_trace
        owner_trace.begin('diagnostic-run', {'id': 'owner-message', 'content': 'Show timing'}, 1,
                          'test-model', 'high')
        owner_trace.record('diagnostic-run', 'turn_started', 'Model turn accepted')
        result = self.service.execute({'op': 'diagnostics'})
        self.assertEqual(result['run']['input_id'], 'owner-message')
        self.assertEqual(result['events'][-1]['kind'], 'turn_started')

    def test_transient_status_is_separate_from_conversation_history(self):
        import owner_progress
        stamp = datetime.datetime.fromtimestamp(self.now / 1000, datetime.timezone.utc).isoformat()
        self.service.fetch_history = lambda before, after: [
            {'id': '100000000000000003', 'channel_id': self.service.channel,
             'author': {'id': self.service.bot_id}, 'content': owner_progress.PREFIX + 'checking Gmail',
             'timestamp': stamp},
            {'id': '100000000000000004', 'channel_id': self.service.channel,
             'author': {'id': self.service.bot_id}, 'content': 'Published answer', 'timestamp': stamp}]
        self.service.progress = lambda: {'active': True, 'label': 'checking Gmail', 'since': self.now}
        result = self.service.messages()
        self.assertEqual([m['body'] for m in result['messages']], ['Published answer'])
        self.assertEqual(result['working']['label'], 'checking Gmail')
        self.assertEqual(self.service.execute({'op': 'working'})['label'], 'checking Gmail')


if __name__ == "__main__":
    unittest.main()
