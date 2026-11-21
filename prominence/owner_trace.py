"""Bounded, owner-only diagnostics for the latest Codex conversation turns."""
import datetime
import os
import sqlite3
import threading
import time
from contextlib import contextmanager

import config

_pending = {}
_pending_lock = threading.Lock()
_last_flush = 0.0


@contextmanager
def _database():
    path = config.data('owner_trace.sqlite')
    new = not os.path.exists(path)
    db = sqlite3.connect(path, timeout=5)
    if new:
        os.chmod(path, 0o600)
    try:
        with db:
            yield db
    finally:
        db.close()


def _schema(db):
    db.execute('PRAGMA journal_mode=WAL')
    db.executescript('''
      CREATE TABLE IF NOT EXISTS trace_runs(
        run TEXT PRIMARY KEY, trigger_at INTEGER NOT NULL, handler_at INTEGER NOT NULL,
        input_id TEXT NOT NULL, input_text TEXT NOT NULL, input_count INTEGER NOT NULL,
        model TEXT NOT NULL, effort TEXT NOT NULL, state TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'misty', task_id TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS trace_events(
        id INTEGER PRIMARY KEY AUTOINCREMENT, run TEXT NOT NULL, at INTEGER NOT NULL,
        updated INTEGER NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '', item_key TEXT,
        UNIQUE(run,kind,item_key));
      CREATE INDEX IF NOT EXISTS trace_events_run ON trace_events(run,id);
      CREATE TABLE IF NOT EXISTS trace_sequence(
        seq INTEGER PRIMARY KEY AUTOINCREMENT, run TEXT UNIQUE NOT NULL);
    ''')
    # On the first upgrade, keep the old rowid cursor positions so a running
    # supervisor does not skip traces that arrived before this migration.
    if not db.execute("SELECT 1 FROM sqlite_sequence WHERE name='trace_sequence'").fetchone():
        db.execute('INSERT INTO trace_sequence(seq,run) '
                   'SELECT r.rowid,r.run FROM trace_runs r '
                   'WHERE NOT EXISTS (SELECT 1 FROM trace_sequence s WHERE s.run=r.run) ORDER BY r.rowid')
    else:
        db.execute('INSERT INTO trace_sequence(run) '
                   'SELECT r.run FROM trace_runs r '
                   'WHERE NOT EXISTS (SELECT 1 FROM trace_sequence s WHERE s.run=r.run) '
                   'ORDER BY r.handler_at,r.rowid')
    db.execute('''CREATE TRIGGER IF NOT EXISTS trace_runs_sequence
      AFTER INSERT ON trace_runs BEGIN
        INSERT INTO trace_sequence(run) VALUES(NEW.run);
      END''')
    columns={r[1] for r in db.execute('PRAGMA table_info(trace_runs)')}
    if 'role' not in columns:
        db.execute("ALTER TABLE trace_runs ADD COLUMN role TEXT NOT NULL DEFAULT 'misty'")
    if 'task_id' not in columns:
        db.execute("ALTER TABLE trace_runs ADD COLUMN task_id TEXT NOT NULL DEFAULT ''")


def _millis():
    return time.time_ns() // 1_000_000


def _trigger(message):
    try:
        value = datetime.datetime.fromisoformat(message['timestamp'].replace('Z', '+00:00'))
        return int(value.timestamp() * 1000)
    except (KeyError, TypeError, ValueError, AttributeError):
        return _millis()


def prune(days=30):
    cutoff=_millis()-days*86400000
    with _database() as db:
        _schema(db)
        db.execute('DELETE FROM trace_sequence WHERE run IN '
                   '(SELECT run FROM trace_runs WHERE handler_at<?)',(cutoff,))
        db.execute('DELETE FROM trace_events WHERE run IN (SELECT run FROM trace_runs WHERE handler_at<?)',(cutoff,))
        db.execute('DELETE FROM trace_runs WHERE handler_at<?',(cutoff,))


def begin(run, message, count, model, effort, role='misty', task_id=''):
    """Record the verified owner input before starting the model."""
    with _database() as db:
        _schema(db)
        db.execute('INSERT INTO trace_runs(run,trigger_at,handler_at,input_id,input_text,input_count,model,effort,state,role,task_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                   (run, _trigger(message), _millis(), str(message['id']),
                    str(message.get('content') or '')[:6000], count, model, effort, 'running',role,task_id))
        old = [r[0] for r in db.execute('SELECT run FROM trace_runs WHERE handler_at<?',
                                        (_millis()-30*86400000,))]
        if old:
            db.executemany('DELETE FROM trace_events WHERE run=?', [(r,) for r in old])
            db.executemany('DELETE FROM trace_sequence WHERE run=?', [(r,) for r in old])
            db.executemany('DELETE FROM trace_runs WHERE run=?', [(r,) for r in old])
    record(run, 'handler', 'Misty received the message')


def record(run, kind, label, detail='', item_key=None):
    """Keep trace failures from affecting the owner conversation."""
    try:
        now = _millis()
        with _database() as db:
            db.execute('INSERT OR IGNORE INTO trace_events(run,at,updated,kind,label,detail,item_key) '
                       'SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM trace_runs WHERE run=?)',
                       (run, now, now, str(kind)[:50], str(label)[:140],
                        str(detail)[:8000], item_key, run))
    except (OSError, sqlite3.Error):
        pass


def append_text(run, kind, label, item_key, delta):
    """Coalesce model-visible text deltas into one bounded timeline row."""
    if not delta or not item_key:
        return
    global _last_flush
    key = (run, str(kind)[:50], str(item_key)[:180])
    with _pending_lock:
        previous = _pending.get(key)
        if previous:
            _pending[key] = (label, (previous[1] + str(delta))[:12000], previous[2])
        else:
            _pending[key] = (label, str(delta)[:12000], _millis())
        due = time.monotonic() - _last_flush >= 0.4
    if due:
        flush()


def flush():
    """Write streamed text in small batches so token events do not stall the model."""
    global _last_flush
    with _pending_lock:
        batch = list(_pending.items())
        _pending.clear()
        _last_flush = time.monotonic()
    if not batch:
        return
    try:
        now = _millis()
        with _database() as db:
            db.executemany('INSERT INTO trace_events(run,at,updated,kind,label,detail,item_key) '
                           'SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM trace_runs WHERE run=?) '
                           'ON CONFLICT(run,kind,item_key) DO UPDATE SET '
                           'detail=substr(trace_events.detail || excluded.detail,1,12000),updated=excluded.updated',
                           [(run, at, now, kind, str(label)[:140], detail, item_key, run)
                            for (run, kind, item_key), (label, detail, at) in batch])
    except (OSError, sqlite3.Error):
        pass


def finish(run, state):
    try:
        flush()
        with _database() as db:
            db.execute('UPDATE trace_runs SET state=? WHERE run=?', (state, run))
        record(run, 'finished', 'Turn ' + state)
    except (OSError, sqlite3.Error):
        pass


def item_label(item):
    kind = str(item.get('type') or 'work')
    if kind == 'mcpToolCall':
        server = str(item.get('server') or item.get('serverName') or '')
        tool = str(item.get('tool') or item.get('name') or 'tool')
        return 'Tool: ' + (server + ' / ' if server else '') + tool
    return {
        'commandExecution': 'Command',
        'fileChange': 'File change',
        'webSearch': 'Web search',
        'agentMessage': 'Visible model message',
        'reasoning': 'Reasoning summary',
        'plan': 'Plan',
        'collabToolCall': 'Agent coordination',
    }.get(kind, kind)


def latest():
    """Read only the newest owner run; no model call or Discord request."""
    try:
        flush()
        with _database() as db:
            if not db.execute("SELECT 1 FROM sqlite_master WHERE name='trace_runs'").fetchone():
                _schema(db)
            db.row_factory = sqlite3.Row
            run = db.execute('SELECT * FROM trace_runs ORDER BY handler_at DESC LIMIT 1').fetchone()
            if not run:
                return {'run': None, 'now': _millis(), 'events': []}
            events = db.execute('SELECT at,updated,kind,label,detail FROM trace_events '
                                'WHERE run=? ORDER BY at DESC,id DESC LIMIT 250', (run['run'],)).fetchall()
        return {'run': dict(run), 'now': _millis(),
                'events': [dict(row) for row in reversed(events)],
                'coverage': 'Visible progress, reasoning summaries, tool names and outcomes, and owner messages. '
                            'Raw private reasoning and arbitrary tool output are not recorded.'}
    except (OSError, sqlite3.Error):
        return {'run': None, 'now': _millis(), 'events': [], 'error': 'Trace is unavailable'}


def recent(limit=12):
    """Bounded multi-agent runs for the supervisor and overlay."""
    flush()
    with _database() as db:
        _schema(db)
        db.row_factory=sqlite3.Row
        runs=[dict(r) for r in db.execute('SELECT * FROM trace_runs ORDER BY handler_at DESC LIMIT ?',
                                          (min(max(int(limit),1),30),))]
        for run in runs:
            run['events']=[dict(e) for e in db.execute(
                'SELECT at,updated,kind,label,detail FROM trace_events WHERE run=? ORDER BY id DESC LIMIT 250',
                (run['run'],))]
            run['events'].reverse()
    return runs


def read_since(after=0, limit=40):
    """Incremental bounded visible trace for the supervisor."""
    flush()
    with _database() as db:
        _schema(db)
        db.row_factory=sqlite3.Row
        rows=[dict(r) for r in db.execute('SELECT s.seq,r.* FROM trace_sequence s JOIN trace_runs r ON r.run=s.run '
                                          'WHERE s.seq>? ORDER BY s.seq LIMIT ?',
                                          (max(0,int(after)),min(max(int(limit),1),100)))]
        for row in rows:
            row['events']=[dict(e) for e in db.execute(
                'SELECT kind,label,substr(detail,1,1800) detail,at FROM trace_events WHERE run=? ORDER BY id LIMIT 100',
                (row['run'],))]
        high=db.execute("SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name='trace_sequence'),0)").fetchone()[0]
    return {'rows':rows,'highWater':high}
