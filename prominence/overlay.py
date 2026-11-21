"""Private desktop bridge for the existing owner conversation.

The socket is reachable only by the misty-bot Unix account. The Windows app
reaches it through the existing authenticated SSH connection; no public port
or second agent session is created.
"""
import datetime
from contextlib import closing, contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import socketserver
import sqlite3
import stat
import subprocess
import threading
import time
import uuid
import urllib.request
import urllib.error
from urllib.parse import urlsplit

import config
import fork_state
import owner_progress


SNOWFLAKE_EPOCH = 1420070400000
ID = re.compile(r"^[0-9]{16,22}$")
THREAD_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


def _digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def node_call(operation, args):
    token = Path(config.get("misty_bridge_token_file",
                            "/run/credentials/misty-prominence.service/prominence-token")).read_text().strip()
    request = urllib.request.Request(
        "http://127.0.0.1:8792/call",
        data=json.dumps({"op": operation, "args": args}).encode("utf-8"),
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=45 if operation.startswith('overlay_gmail_') or operation.startswith('overlay_approval') or operation == 'overlay_email_preview' else 10) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        try:
            detail = json.load(error).get('error', 'Misty rejected the request')
        except (ValueError, TypeError):
            detail = 'Misty rejected the request'
        raise ValueError(str(detail)[:300]) from None


def record_owner(message):
    result = node_call("overlay_input", message)
    if not result.get("accepted"):
        raise RuntimeError("Misty bridge did not record owner input")


class OverlayService:
    def __init__(self, channel, bot_id, fetch_history, enqueue,
                 node_db="/var/lib/misty-bot/chat.sqlite",
                 activity_db="/var/lib/misty-bot/laptop-activity.sqlite",
                 record=record_owner,
                 codex_dispatch=node_call,
                 progress=lambda: {'active': False, 'label': '', 'since': 0},
                 clock=lambda: int(time.time() * 1000)):
        self.channel = channel
        self.owner = config.OWNER_ID
        self.bot_id = bot_id
        self.fetch_history = fetch_history
        self.enqueue = enqueue
        self.node_db = node_db
        self.activity_db = activity_db
        self.record = record
        self.codex_dispatch = codex_dispatch
        self.progress = progress
        self.clock = clock
        self.lock = threading.Lock()
        self.owner_profile = {"displayName": "You", "avatarUrl": ""}
        self.owner_profile_at = 0
        with fork_state.db() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS overlay_inputs(
                client TEXT PRIMARY KEY,id TEXT UNIQUE NOT NULL,hash TEXT NOT NULL,
                created INTEGER NOT NULL,dispatched INTEGER NOT NULL DEFAULT 0,
                reply_ref TEXT NOT NULL DEFAULT '')""")
            if "reply_ref" not in {row[1] for row in db.execute("PRAGMA table_info(overlay_inputs)")}:
                db.execute("ALTER TABLE overlay_inputs ADD COLUMN reply_ref TEXT NOT NULL DEFAULT ''")

    @contextmanager
    def _node(self):
        db = sqlite3.connect("file:" + self.node_db + "?mode=ro", uri=True, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def _reply_reference(self, ident):
        with fork_state.db() as db:
            row = db.execute("SELECT i.body FROM overlay_inputs o JOIN inbox i ON i.id=o.id "
                             "WHERE o.id=? AND i.channel=?", (ident, self.channel)).fetchone()
        if row:
            saved = json.loads(row[0])
            return {"id": ident, "channel_id": self.channel,
                    "author": {"id": self.owner}, "content": str(saved.get("content") or "")[:6000]}
        remote = self.fetch_history(str(int(ident) + 1), "")
        if not isinstance(remote, list):
            raise RuntimeError("Owner conversation is unavailable")
        for message in remote:
            if (str(message.get("id")) == ident and message.get("channel_id") == self.channel
                    and (message.get("author") or {}).get("id") in (self.owner, self.bot_id)):
                return {"id": ident, "channel_id": self.channel,
                        "author": {"id": message["author"]["id"]},
                        "content": str(message.get("content") or "")[:6000]}
        raise ValueError("Reply target is no longer available in the verified owner conversation")

    @staticmethod
    def _reply_summary(ref, bot_id):
        if not isinstance(ref, dict) or not ID.fullmatch(str(ref.get("id", ""))):
            return None
        return {"id": str(ref["id"]),
                "name": "Misty" if (ref.get("author") or {}).get("id") == bot_id else "You",
                "body": " ".join(str(ref.get("content") or "").split())[:140]}

    def send(self, client, text, reply_to=""):
        if not isinstance(client, str) or str(uuid.UUID(client)) != client:
            raise ValueError("A stable request ID is required")
        if not isinstance(text, str) or not text.strip() or len(text) > 16000:
            raise ValueError("Enter a message of at most 16,000 characters")
        text = text.strip()
        reply_to = str(reply_to or "")
        if reply_to and not ID.fullmatch(reply_to):
            raise ValueError("Invalid reply target")
        digest = _digest(json.dumps([text, reply_to])) if reply_to else _digest(text)
        with self.lock:
            with fork_state.db() as db:
                old = db.execute("SELECT id,hash,created,dispatched,reply_ref FROM overlay_inputs WHERE client=?", (client,)).fetchone()
                if old and old[1] != digest:
                    raise ValueError("Request ID already belongs to another message")
                if old:
                    ident, now = old[0], old[2]
                    reference = json.loads(old[4]) if old[4] else None
                    created = False
                else:
                    reference = self._reply_reference(reply_to) if reply_to else None
                    now = self.clock()
                    if now < SNOWFLAKE_EPOCH or now > SNOWFLAKE_EPOCH + (1 << 41) - 1:
                        raise RuntimeError("Clock is outside the message ID range")
                    # Discord snowflake time ordering lets active owner steering
                    # merge desktop and Discord inputs in the same session.
                    for _ in range(12):
                        ident = str(((now - SNOWFLAKE_EPOCH) << 22) | secrets.randbits(22))
                        with self._node() as node:
                            exists = node.execute("SELECT 1 FROM bot_turns WHERE id=?", (ident,)).fetchone()
                            if exists:
                                continue
                        break
                    else:
                        raise RuntimeError("Could not allocate a unique message ID")
                    db.execute("INSERT INTO overlay_inputs(client,id,hash,created,dispatched,reply_ref) "
                               "VALUES(?,?,?,?,0,?)",
                               (client, ident, digest, now, json.dumps(reference) if reference else ""))
                    created = True
            message = {"id": ident, "channel_id": self.channel,
                       "author": {"id": self.owner, "username": "Owner", "bot": False},
                       "content": text, "timestamp": datetime.datetime.fromtimestamp(
                           now / 1000, datetime.timezone.utc).isoformat(),
                       "attachments": [], "_overlay": True}
            if reference:
                message["referenced_message"] = reference
                message["message_reference"] = {"message_id": reference["id"]}
            # Record in the existing tool bridge before making the input runnable.
            # If the bridge acknowledgement is lost, this UUID retains the same
            # ID and the next attempt safely checks the idempotent bridge record.
            self.record({"id": ident, "channel": self.channel, "owner": self.owner,
                         "body": text, "at": now})
            with fork_state.db() as db:
                row = db.execute("SELECT body FROM inbox WHERE id=?", (ident,)).fetchone()
                if row and json.loads(row[0]) != message:
                    raise RuntimeError("Saved overlay input changed")
                if not row:
                    db.execute("INSERT INTO inbox(id,channel,body,state,updated) VALUES(?,?,?,\"queued\",?)",
                               (ident, self.channel, json.dumps(message), time.time()))
                dispatched = db.execute("SELECT dispatched FROM overlay_inputs WHERE client=?", (client,)).fetchone()[0]
                if not dispatched:
                    db.execute("UPDATE overlay_inputs SET dispatched=1 WHERE client=?", (client,))
                    dispatch = True
                else:
                    dispatch = False
            if dispatch:
                self.enqueue(message)
        return {"id": message["id"], "accepted": True, "reused": not created}

    def messages(self, before="", after=""):
        if before and (not ID.fullmatch(str(before)) or after):
            raise ValueError("Invalid history cursor")
        if after and not ID.fullmatch(str(after)):
            raise ValueError("Invalid history cursor")
        before, after = str(before), str(after)
        remote = self.fetch_history(before, after)
        if not isinstance(remote, list):
            raise RuntimeError("Owner conversation is unavailable")
        result = []
        for m in remote:
            if (not isinstance(m, dict) or not ID.fullmatch(str(m.get("id", "")))
                    or m.get("channel_id") != self.channel):
                continue
            profile = m.get("author") if isinstance(m.get("author"), dict) else {}
            author = profile.get("id")
            if author != self.bot_id and not config.is_owner(author):
                continue
            if author == self.bot_id and str(m.get("content") or "").startswith(owner_progress.PREFIX):
                continue
            owner = author != self.bot_id
            try:
                at = int(datetime.datetime.fromisoformat(m["timestamp"].replace("Z", "+00:00")).timestamp() * 1000)
            except (KeyError, TypeError, ValueError):
                continue
            if owner and at >= self.owner_profile_at:
                avatar = profile.get("avatar")
                avatar_url = (f"https://cdn.discordapp.com/avatars/{author}/{avatar}.png?size=128"
                              if isinstance(avatar, str) and re.fullmatch(r"(?:a_)?[0-9a-f]{32}", avatar) else "")
                self.owner_profile = {"displayName": str(profile.get("global_name") or profile.get("username") or "You")[:80],
                                      "avatarUrl": avatar_url}
                self.owner_profile_at = at
            if before and int(m["id"]) >= int(before) or after and int(m["id"]) <= int(after):
                continue
            body = str(m.get("content") or "")
            interactive = bool(m.get("components"))
            if not body and (interactive or m.get("embeds")):
                parts = []
                for embed in m.get("embeds", [])[:3]:
                    if isinstance(embed, dict):
                        parts += [str(embed.get(key) or "") for key in ("title", "description")]
                        parts += [str(field.get("name") or "") + ": " + str(field.get("value") or "")
                                  for field in embed.get("fields", [])[:8] if isinstance(field, dict)]
                body = "\n".join(part for part in parts if part) or "Interactive Misty card"
            result.append({"id": m["id"], "role": "owner" if owner else "misty",
                           "body": body[:50000], "at": at, "source": "discord", "interactive": interactive,
                           "discordUrl": f"https://discord.com/channels/@me/{self.channel}/{m['id']}" if interactive else "",
                           "replyTo": self._reply_summary(m.get("referenced_message"), self.bot_id),
                           **(self.owner_profile if owner else {"displayName": "Misty", "avatarUrl": ""})})
        with fork_state.db() as db:
            rows = db.execute("SELECT i.id,i.body,o.created FROM overlay_inputs o JOIN inbox i ON i.id=o.id "
                              "ORDER BY o.created DESC LIMIT 300").fetchall()
        for ident, body, at in rows:
            if before and int(ident) >= int(before) or after and int(ident) <= int(after):
                continue
            saved = json.loads(body)
            result.append({"id": ident, "role": "owner", "body": saved["content"],
                           "replyTo": self._reply_summary(saved.get("referenced_message"), self.bot_id),
                           "at": at, "source": "overlay", **self.owner_profile})
        result.sort(key=lambda m: int(m["id"]))
        result = result[:100] if after else result[-60:]
        return {"messages": result, "cursor": result[-1]["id"] if result else after,
                "older": bool(result) and not after, "working": self.progress()}

    def codex(self, after=None):
        with self._node() as db:
            if after is None:
                rows = db.execute("SELECT seq,thread_id,kind,text,at FROM codex_events ORDER BY seq DESC LIMIT 30").fetchall()[::-1]
            else:
                if not isinstance(after, int) or after < 0:
                    raise ValueError("Invalid Codex cursor")
                rows = db.execute("SELECT seq,thread_id,kind,text,at FROM codex_events WHERE seq>? ORDER BY seq LIMIT 100", (after,)).fetchall()
            setting = db.execute("SELECT value FROM bot_settings WHERE key='relay_catalog'").fetchone()
        try:
            catalog = {c["id"]: c["title"] for c in json.loads(setting[0]).get("chats", [])} if setting else {}
        except (ValueError, TypeError, KeyError):
            catalog = {}
        events = [{"seq": r[0], "threadId": r[1], "title": catalog.get(r[1], "Codex chat"),
                   "kind": r[2], "text": r[3], "at": r[4]} for r in rows]
        return {"events": events, "cursor": events[-1]["seq"] if events else after or 0}

    def _codex_catalog(self):
        with self._node() as db:
            row = db.execute("SELECT value FROM bot_settings WHERE key='relay_catalog'").fetchone()
        try:
            catalog = json.loads(row[0]) if row else {}
            return catalog.get("chats", []) if isinstance(catalog, dict) and isinstance(catalog.get("chats"), list) else []
        except (ValueError, TypeError, KeyError):
            return []

    def codex_chats(self, query=""):
        if not isinstance(query, str) or len(query) > 150:
            raise ValueError("Invalid chat search")
        query = query.strip().casefold()
        chats = [c for c in self._codex_catalog() if isinstance(c, dict) and
                 THREAD_ID.fullmatch(str(c.get("id", ""))) and
                 query in (str(c.get("title", "")) + " " + str(c.get("cwd", ""))).casefold()]
        chats.sort(key=lambda c: str(c.get("updatedAt") or ""), reverse=True)
        with self._node() as db:
            documents = {row[0]: {"syncedAt": row[1], "parts": row[2]}
                         for row in db.execute("SELECT thread_id,synced,parts FROM misty_documents WHERE kind='codex'")}
        return {"chats": [{"id": c["id"], "title": str(c.get("title") or "Untitled chat")[:150],
                           "workspace": str(c.get("cwd") or "")[:500], "updatedAt": c.get("updatedAt"),
                           "status": str(c.get("status") or "unknown")[:40],
                           **documents.get(c["id"], {"syncedAt": None, "parts": 0})}
                          for c in chats], "total": len(chats)}

    def codex_history(self, thread_id, before=None):
        if not isinstance(thread_id, str) or not THREAD_ID.fullmatch(thread_id):
            raise ValueError("Invalid Codex chat ID")
        if not any(c.get("id") == thread_id for c in self._codex_catalog() if isinstance(c, dict)):
            raise ValueError("Codex chat is not in the current owner catalog")
        if before is not None and (not isinstance(before, int) or before < 0):
            raise ValueError("Invalid transcript cursor")
        with self._node() as db:
            doc = db.execute("SELECT title,parts,updated,synced FROM misty_documents WHERE id=? AND kind='codex'",
                             ("codex:" + thread_id,)).fetchone()
            if not doc:
                return {"available": False, "threadId": thread_id, "rows": [], "older": False}
            rows = db.execute("SELECT ordinal,role,turn_id,at,text FROM misty_document_chunks "
                              "WHERE document_id=? AND ordinal<? ORDER BY ordinal DESC LIMIT 40",
                              ("codex:" + thread_id, before if before is not None else doc[1])).fetchall()
        selected = []
        size = 0
        for row in rows:
            encoded = len(row[4].encode("utf-8"))
            if selected and size + encoded > 65000:
                break
            selected.append({"ordinal": row[0], "role": row[1], "turnId": row[2],
                             "at": row[3], "text": row[4]})
            size += encoded
        selected.reverse()
        return {"available": True, "threadId": thread_id, "title": doc[0], "parts": doc[1],
                "updatedAt": doc[2], "syncedAt": doc[3], "rows": selected,
                "older": bool(selected and selected[0]["ordinal"] > 0),
                "before": selected[0]["ordinal"] if selected else None,
                "coverage": "Visible saved user and assistant text; no hidden reasoning, tool logs, or attachment bytes."}

    def codex_send(self, client_id, thread_id, prompt):
        if not isinstance(client_id, str) or not THREAD_ID.fullmatch(client_id):
            raise ValueError("A stable request ID is required")
        if not isinstance(thread_id, str) or not THREAD_ID.fullmatch(thread_id):
            raise ValueError("Invalid Codex chat ID")
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 10000:
            raise ValueError("Enter a Codex prompt of at most 10,000 characters")
        return self.codex_dispatch("overlay_codex_send", {"clientId": client_id,
                                                            "chatId": thread_id, "prompt": prompt.strip()})

    def codex_job(self, client_id, offset=0):
        if not isinstance(client_id, str) or not THREAD_ID.fullmatch(client_id):
            raise ValueError("Invalid Codex request ID")
        if not isinstance(offset, int) or offset < 0:
            raise ValueError("Invalid result cursor")
        with self._node() as db:
            row = db.execute("SELECT j.code,j.status,j.thread_id,j.turn_id,j.result,j.error,j.updated "
                             "FROM overlay_codex_dispatch d JOIN relay_jobs j ON j.id=d.job_id WHERE d.client=?",
                             (client_id,)).fetchone()
        if not row:
            return {"available": False}
        result = row[4] or ""
        return {"available": True, "code": row[0], "status": row[1], "threadId": row[2],
                "turnId": row[3], "text": result[offset:offset + 60000],
                "nextOffset": offset + 60000 if offset + 60000 < len(result) else None,
                "error": (row[5] or "")[:500], "updatedAt": row[6]}

    @staticmethod
    def _activity_category(application, host):
        app = application.casefold()
        host = host.casefold()
        if any(part in host for part in ("chatgpt.com", "openai.com", "claude.ai", "perplexity.ai")) or \
                any(part in app for part in ("chatgpt", "codex", "claude", "misty.overlay")):
            return "AI tools"
        if any(part in host for part in ("github.com", "gitlab.com", "stackoverflow.com", "developer.", "docs.python.org")) or \
                any(part in app for part in ("code", "visual studio", "terminal", "powershell", "windows terminal")):
            return "Development"
        if any(part in host for part in ("discord.com", "web.whatsapp.com", "mail.google.com", "slack.com", "teams.microsoft.com")) or \
                any(part in app for part in ("discord", "whatsapp", "slack", "teams", "telegram", "outlook")):
            return "Communication"
        if any(part in app for part in ("enshrouded", "geometrydash", "roblox", "minecraft",
                                       "tlauncher", "valorant", "riotclient", "steam",
                                       "bluestacks", "hd-player", "genshin", "game")):
            return "Games"
        if any(part in host for part in ("youtube.com", "netflix.com", "spotify.com", "twitch.tv", "reddit.com")) or \
                any(part in app for part in ("spotify", "youtube", "netflix")):
            return "Entertainment"
        if any(part in app for part in ("word", "excel", "powerpoint", "onenote", "notion", "obsidian")) or \
                any(part in host for part in ("docs.google.com", "drive.google.com", "notion.so", "figma.com")):
            return "Productivity"
        if host or any(part in app for part in ("chrome", "firefox", "edge", "browser")):
            return "Web & research"
        return "Other"

    def activity_report(self):
        now = self.clock()
        start = now - 24 * 3600000
        with closing(sqlite3.connect("file:" + self.activity_db + "?mode=ro", uri=True, timeout=5)) as db:
            rows = db.execute("SELECT captured,body FROM laptop_activity_samples WHERE captured>=? "
                              "ORDER BY captured", (start,)).fetchall()
        categories, targets, apps = {}, {}, {}
        observed = active = idle = 0.0
        for index, (captured, body) in enumerate(rows):
            until = min(rows[index + 1][0] if index + 1 < len(rows) else now, now)
            seconds = max(0.0, min(45.0, (until - max(captured, start)) / 1000))
            if seconds <= 0:
                continue
            observed += seconds
            sample = json.loads(body)
            if sample.get("sessionState") == "idle":
                idle += seconds
            if sample.get("sessionState") != "active" or not isinstance(sample.get("foreground"), dict):
                continue
            active += seconds
            app = str(sample["foreground"].get("application") or "Unknown")[:80]
            apps[app] = apps.get(app, 0) + seconds
            tab = (sample.get("chrome") or {}).get("currentTab") if app.casefold() in ("chrome", "chrome.exe") else None
            try:
                host = urlsplit(str(tab.get("url") or "")).hostname or "" if isinstance(tab, dict) else ""
            except ValueError:
                host = ""
            host = host.removeprefix("www.")[:100]
            category = self._activity_category(app, host)
            categories[category] = categories.get(category, 0) + seconds
            target = host or app
            targets[(target, category)] = targets.get((target, category), 0) + seconds
        return {"from": start, "to": now, "sampleCount": len(rows),
                "observedSeconds": round(observed), "activeSeconds": round(active),
                "idleSeconds": round(idle), "unobservedSeconds": round(max(0, 86400 - observed)),
                "categories": [{"name": name, "seconds": round(seconds)} for name, seconds in
                               sorted(categories.items(), key=lambda item: item[1], reverse=True)],
                "topTargets": [{"name": name, "category": category, "seconds": round(seconds)}
                               for (name, category), seconds in sorted(targets.items(), key=lambda item: item[1], reverse=True)[:12]],
                "topApps": [{"name": name, "seconds": round(seconds)} for name, seconds in
                            sorted(apps.items(), key=lambda item: item[1], reverse=True)[:8]],
                "method": "24-hour 30-second foreground samples. Each gap counts at most 45 seconds. "
                          "Times are estimates; background windows and inactive tabs are excluded."}

    @staticmethod
    def status_page():
        try:
            with urllib.request.urlopen("http://127.0.0.1:8793/metrics.json", timeout=3) as response:
                metrics = json.load(response)
            with urllib.request.urlopen("http://127.0.0.1:8793/resources.json", timeout=3) as response:
                resources = json.load(response)
            host = resources.get("host") or metrics.get("host") or {}
            usage = metrics.get("usage") or {}
            return {"available": True, "url": "https://status.example.com/",
                    "updatedAt": metrics.get("updatedAt"), "resourcesAt": resources.get("updatedAt"),
                    "cpuPercent": host.get("cpuPercent"), "memoryPercent": host.get("memoryPercent"),
                    "diskPercent": host.get("diskPercent"),
                    "estimatedUsd": usage.get("estimatedUsd"),
                    "todayEstimatedUsd": usage.get("todayEstimatedUsd"),
                    "tokens": usage.get("tokens"), "records": usage.get("records"),
                    "cpuSevenDayP95": (metrics.get("cpuSevenDays") or {}).get("p95Percent")}
        except (OSError, ValueError, KeyError, TypeError):
            return {"available": False, "url": "https://status.example.com/"}

    def status(self):
        services = {}
        for name in ("misty-prominence", "misty-bot", "misty-activity", "misty-metrics", "archival"):
            result = subprocess.run(("systemctl", "is-active", name + ".service"),
                                    capture_output=True, text=True, timeout=3, check=False)
            services[name] = result.stdout.strip() or "unavailable"
        with self._node() as db:
            heartbeat = db.execute("SELECT value FROM bot_settings WHERE key='relay_heartbeat'").fetchone()
        try:
            beat = int(json.loads(heartbeat[0])) if heartbeat else 0
        except (ValueError, TypeError):
            beat = 0
        activity = {"state": "unavailable", "captureAgeSeconds": None, "paused": False}
        try:
            with closing(sqlite3.connect("file:" + self.activity_db + "?mode=ro", uri=True, timeout=3)) as db:
                row = db.execute("SELECT captured,received FROM laptop_activity_samples ORDER BY captured DESC LIMIT 1").fetchone()
                paused = db.execute("SELECT value FROM laptop_activity_settings WHERE key='paused'").fetchone()
            age = max(0, self.clock() - row[0]) if row else None
            activity = {"state": "paused" if paused and json.loads(paused[0]) else
                        "unavailable" if not row else "fresh" if age <= 90000 and self.clock() - row[1] <= 90000 else "stale",
                        "captureAgeSeconds": round(age / 1000) if age is not None else None,
                        "paused": bool(paused and json.loads(paused[0]))}
        except (OSError, sqlite3.Error, ValueError):
            pass
        return {"at": self.clock(), "services": services, "codexRelayOnline": self.clock() - beat < 45000,
                "laptopActivity": activity, "statusPage": self.status_page(), "ownerConversation": "online"}

    def execute(self, request):
        if not isinstance(request, dict):
            raise ValueError("Invalid overlay request")
        op = request.get("op")
        gmail_ops = {"gmail_accounts", "gmail_navigation", "gmail_list", "gmail_open",
                     "gmail_category_save", "gmail_category_delete", "gmail_action", "gmail_attachment_chunk"}
        approval_ops = {"approvals", "approval_send", "approval_cancel", "approval_edit", "email_preview"}
        if op in gmail_ops or op in approval_ops:
            args = {key: value for key, value in request.items() if key not in ("op", "id")}
            if op in ("gmail_open", "gmail_action", "gmail_attachment_chunk"):
                args["id"] = args.pop("messageId", "")
            if op in ("gmail_category_save", "gmail_category_delete"):
                args["id"] = args.pop("categoryId", "")
            if op == "approvals":
                return self.codex_dispatch("overlay_approvals", {})
            if op in approval_ops:
                return self.codex_dispatch("overlay_" + op, args)
            return self.codex_dispatch("overlay_" + op, args)
        if op == "send":
            return self.send(request.get("clientId"), request.get("text"), request.get("replyTo", ""))
        if op == "messages":
            return self.messages(request.get("before", ""), request.get("after", ""))
        if op == "working":
            return self.progress()
        if op == "codex":
            return self.codex(request.get("after"))
        if op == "codex_chats":
            return self.codex_chats(request.get("query", ""))
        if op == "codex_history":
            return self.codex_history(request.get("threadId"), request.get("before"))
        if op == "codex_send":
            return self.codex_send(request.get("clientId"), request.get("threadId"), request.get("prompt"))
        if op == "codex_job":
            return self.codex_job(request.get("clientId"), request.get("offset", 0))
        if op == "activity_report":
            return self.activity_report()
        if op == "status":
            return self.status()
        if op == "diagnostics":
            import owner_trace
            import agent_tasks
            import initiative
            return {**owner_trace.latest(), "agentTasks": [
                {key: task[key] for key in ('id','role','origin','objective','state','project','updated','result','events','summaries')}
                for task in agent_tasks.list_tasks(15)],
                "supervisorPaused": bool(agent_tasks.setting('supervisor_paused', False) or initiative.status()['paused']),
                "supervisorEnabled": config.enabled('supervisor_enabled')}
        if op == 'supervisor_control':
            import agent_tasks
            import initiative
            if not config.enabled('supervisor_enabled'):
                raise ValueError('Supervisor is not enabled')
            action = request.get('action')
            if action not in ('pause', 'resume'):
                raise ValueError('Use pause or resume')
            agent_tasks.set_setting('supervisor_paused', action == 'pause')
            initiative.execute([action])
            return {'paused': action == 'pause'}
        if op == 'task_stop':
            import agent_tasks
            task_id = request.get('taskId', '')
            if not isinstance(task_id, str) or not re.fullmatch(r'[a-f0-9]{32}', task_id):
                raise ValueError('Invalid task ID')
            task = agent_tasks.stop(task_id)
            if task['role']=='misty' and task['state']=='cancelled':
                import conversation
                import owner_loop
                run=conversation.run_info('internal-'+task_id)
                if run and run['state']=='running' and owner_loop.OWNER.active_run=='internal-'+task_id:
                    owner_loop.OWNER.stop_active()
            return {'taskId': task['id'], 'state': task['state']}
        raise ValueError("Unsupported overlay request")


class _SocketHandler(socketserver.StreamRequestHandler):
    def handle(self):
        line = self.rfile.readline(65537)
        if len(line) > 65536:
            return
        try:
            result = self.server.overlay.execute(json.loads(line))
            response = {"result": result}
        except Exception as error:
            response = {"error": str(error)[:300]}
        self.wfile.write((json.dumps(response, ensure_ascii=False) + "\n").encode("utf-8"))


class _SocketServer(socketserver.ThreadingMixIn,
                    getattr(socketserver, "UnixStreamServer", socketserver.TCPServer)):
    daemon_threads = True


def serve(service):
    path = config.data("overlay.sock")
    if os.path.lexists(path):
        if not stat.S_ISSOCK(os.lstat(path).st_mode):
            raise RuntimeError("Overlay socket path is occupied")
        os.unlink(path)
    server = _SocketServer(path, _SocketHandler)
    server.overlay = service
    os.chmod(path, 0o600)
    threading.Thread(target=server.serve_forever, daemon=True, name="overlay-socket").start()
    return server
