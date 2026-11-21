"""Durable, provenance-bound work handed between Misty's agents."""
import json
import os
import sqlite3
import time
import uuid
from contextlib import contextmanager

import config

ROLES = {'coding', 'analysis', 'misty', 'supervisor'}
STATES = {'queued', 'running', 'waiting', 'completed', 'failed', 'interrupted', 'cancelled'}


@contextmanager
def database():
    con = sqlite3.connect(config.data('agent_tasks.sqlite'), timeout=10)
    con.row_factory = sqlite3.Row
    con.execute('PRAGMA journal_mode=WAL')
    con.execute('PRAGMA busy_timeout=10000')
    con.executescript('''
      CREATE TABLE IF NOT EXISTS tasks(
        id TEXT PRIMARY KEY, task_key TEXT UNIQUE NOT NULL, role TEXT NOT NULL,
        origin TEXT NOT NULL, owner_message TEXT NOT NULL DEFAULT '', owner_id TEXT NOT NULL DEFAULT '',
        parent_run TEXT NOT NULL DEFAULT '', project TEXT NOT NULL DEFAULT '',
        objective TEXT NOT NULL, success TEXT NOT NULL DEFAULT '', context_json TEXT NOT NULL DEFAULT '{}',
        authority TEXT NOT NULL, state TEXT NOT NULL, checkpoint TEXT NOT NULL DEFAULT '{}',
        result TEXT NOT NULL DEFAULT '', evidence TEXT NOT NULL DEFAULT '[]',
        thread TEXT NOT NULL DEFAULT '', turn TEXT NOT NULL DEFAULT '',
        lease_until REAL NOT NULL DEFAULT 0, created REAL NOT NULL, updated REAL NOT NULL,
        reported INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS tasks_state ON tasks(state,updated);
      CREATE TABLE IF NOT EXISTS task_events(
        seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, at REAL NOT NULL,
        kind TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS task_events_task ON task_events(task_id,seq);
      CREATE TABLE IF NOT EXISTS task_summaries(
        seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, at REAL NOT NULL,
        kind TEXT NOT NULL, detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_cursors(source TEXT PRIMARY KEY, value TEXT NOT NULL, updated REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS project_registry(
        root TEXT PRIMARY KEY, repository TEXT NOT NULL DEFAULT '', checks_json TEXT NOT NULL DEFAULT '[]',
        release_json TEXT NOT NULL DEFAULT '{}', updated REAL NOT NULL);
    ''')
    try:
        with con:
            yield con
    finally:
        con.close()


def _record(con, task_id, kind, detail=''):
    at=time.time();value=str(detail)[:12000]
    con.execute('INSERT INTO task_events(task_id,at,kind,detail) VALUES(?,?,?,?)',
                (task_id, at, kind, value))
    if kind in ('decision','completed','failed','interrupted','waiting','branch_prepared','branch_pushed',
                'release_receipt','rollback_receipt','rollback_failed'):
        con.execute('INSERT INTO task_summaries(task_id,at,kind,detail) VALUES(?,?,?,?)',
                    (task_id,at,kind,value[:4000]))


def record(task_id, kind, detail=''):
    with database() as con:
        if con.execute('SELECT 1 FROM tasks WHERE id=?', (task_id,)).fetchone():
            _record(con, task_id, kind, detail)


def submit(role, objective, *, origin, task_key, project='', success='', context=None,
           owner_message='', owner_id='', parent_run=''):
    if role not in ROLES or origin not in ('owner', 'supervisor'):
        raise ValueError('Unknown task role or origin')
    if not isinstance(objective, str) or not 1 <= len(objective.strip()) <= 10000:
        raise ValueError('A bounded objective is required')
    if not isinstance(task_key, str) or not 1 <= len(task_key) <= 160:
        raise ValueError('Stable task key required')
    if origin == 'owner':
        import conversation
        run = conversation.owner_run_info(parent_run)
        if run['owner'] != owner_id or run['latest_message'] != owner_message:
            raise ValueError('Task must be bound to the current verified owner input')
    elif owner_message or owner_id or parent_run:
        raise ValueError('Scheduled work cannot impersonate an owner turn')
    if origin == 'supervisor' and role == 'coding' and not project_registered(project):
        raise ValueError('Autonomous coding requires a registered owned project')
    packet_data=dict(context or {})
    if origin=='owner':
        import conversation
        with conversation.connection() as con:
            conversation.schema(con)
            channel=conversation.run_info(parent_run)['channel']
            inbox=con.execute('SELECT id,body FROM inbox WHERE channel=? ORDER BY length(id) DESC,id DESC LIMIT 10',(channel,)).fetchall()
            outbound=con.execute('SELECT id,body,receipt FROM conversation_outbox WHERE channel=? AND state="sent" ORDER BY id DESC LIMIT 10',(channel,)).fetchall()
        packet_data['verifiedOwnerInput']={'id':owner_message,
            'text':next((json.loads(body).get('content','')[:6000] for ident,body in inbox if ident==owner_message),'')}
        packet_data['recentConversation']={
            'owner':[{'id':ident,'text':str(json.loads(body).get('content') or '')[:900]}
                     for ident,body in reversed(inbox) if json.loads(body).get('author',{}).get('id')==owner_id],
            'misty':[{'outboxId':ident,'text':body[:900],'receipt':receipt}
                     for ident,body,receipt in reversed(outbound)]}
    packet = json.dumps(packet_data, ensure_ascii=False)
    if len(packet) > 64000:
        raise ValueError('Context packet too large; use source references')
    authority = 'owner_request' if origin == 'owner' else 'supervisor_standing'
    now = time.time()
    with database() as con:
        old = con.execute('SELECT * FROM tasks WHERE task_key=?', (task_key,)).fetchone()
        if old:
            if old['objective'] != objective.strip() or old['role'] != role or old['origin'] != origin:
                raise ValueError('Task key already binds a different objective')
            return dict(old)
        task_id = uuid.uuid4().hex
        con.execute('''INSERT INTO tasks(id,task_key,role,origin,owner_message,owner_id,parent_run,
          project,objective,success,context_json,authority,state,created,updated)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
          (task_id, task_key, role, origin, owner_message, owner_id, parent_run,
           project, objective.strip(), success[:4000], packet, authority, 'queued', now, now))
        _record(con, task_id, 'queued', role)
        return dict(con.execute('SELECT * FROM tasks WHERE id=?', (task_id,)).fetchone())


def get(task_id):
    with database() as con:
        row = con.execute('SELECT * FROM tasks WHERE id=?', (task_id,)).fetchone()
        return dict(row) if row else None


def project_registered(root):
    if not isinstance(root,str) or not root:
        return False
    with database() as con:
        return bool(con.execute('SELECT 1 FROM project_registry WHERE root=?',(root,)).fetchone())


def bind_project(task_id, root):
    if not project_registered(root):
        raise ValueError('Project is not registered')
    with database() as con:
        row=con.execute('SELECT * FROM tasks WHERE id=?',(task_id,)).fetchone()
        if not row or row['role']!='supervisor' or row['origin']!='supervisor' or row['state']!='running':
            raise ValueError('Active supervisor task required')
        if row['project'] and row['project']!=root:
            raise ValueError('Supervisor task is already bound to another project')
        if not row['project']:
            con.execute('UPDATE tasks SET project=?,updated=? WHERE id=?',(root,time.time(),task_id))
            _record(con,task_id,'project_bound',root)
        return dict(con.execute('SELECT * FROM tasks WHERE id=?',(task_id,)).fetchone())


def active_from_environment():
    task_id = os.environ.get('MISTY_AGENT_TASK_ID', '')
    if os.environ.get('PROMINENCE_SOURCE') not in ('specialist', 'supervisor') or not task_id:
        raise ValueError('Active delegated task required')
    task = get(task_id)
    if not task or task['state'] != 'running' or task['lease_until'] < time.time():
        raise ValueError('Delegated task is not active')
    if os.environ['PROMINENCE_SOURCE'] == 'supervisor' and task['origin'] != 'supervisor':
        raise ValueError('Supervisor task identity mismatch')
    if os.environ['PROMINENCE_SOURCE'] == 'specialist' and task['role'] not in ('coding', 'analysis'):
        raise ValueError('Specialist task identity mismatch')
    return task


def claim(role, lease_seconds=900):
    if role not in ROLES:
        raise ValueError('Unknown role')
    with database() as con:
        con.execute('BEGIN IMMEDIATE')
        # Unknown partial tool effects must be reconciled, never replayed blindly.
        con.execute("UPDATE tasks SET state='interrupted',updated=? WHERE state='running' AND lease_until<?",
                    (time.time(), time.time()))
        row = con.execute("SELECT * FROM tasks WHERE role=? AND state='queued' ORDER BY created LIMIT 1", (role,)).fetchone()
        if not row:
            return None
        now = time.time()
        con.execute("UPDATE tasks SET state='running',lease_until=?,updated=? WHERE id=?",
                    (now + lease_seconds, now, row['id']))
        _record(con, row['id'], 'started')
        return dict(con.execute('SELECT * FROM tasks WHERE id=?', (row['id'],)).fetchone())


def has_queued(role):
    with database() as con:
        return bool(con.execute('SELECT 1 FROM tasks WHERE role=? AND state="queued" LIMIT 1',(role,)).fetchone())


def heartbeat(task_id, lease_seconds=900):
    with database() as con:
        con.execute("UPDATE tasks SET lease_until=?,updated=? WHERE id=? AND state='running'",
                    (time.time() + lease_seconds, time.time(), task_id))


def checkpoint(task_id, state):
    if not isinstance(state, dict) or len(json.dumps(state)) > 32000:
        raise ValueError('Small JSON checkpoint required')
    with database() as con:
        if not con.execute("SELECT 1 FROM tasks WHERE id=? AND state='running'", (task_id,)).fetchone():
            raise ValueError('Task is not running')
        con.execute('UPDATE tasks SET checkpoint=?,updated=? WHERE id=?',
                    (json.dumps(state), time.time(), task_id))
        _record(con, task_id, 'checkpoint')


def set_thread(task_id, thread, turn=''):
    with database() as con:
        con.execute('UPDATE tasks SET thread=?,turn=?,updated=? WHERE id=? AND state="running"',
                    (thread, turn, time.time(), task_id))


def finish(task_id, state, result='', evidence=None):
    if state not in ('completed', 'failed', 'interrupted', 'waiting', 'cancelled'):
        raise ValueError('Invalid completion state')
    if not isinstance(result, str) or len(result) > 50000:
        raise ValueError('Result is too large')
    evidence = evidence or []
    if not isinstance(evidence, list) or len(json.dumps(evidence)) > 16000:
        raise ValueError('Evidence must be a bounded list')
    with database() as con:
        old = con.execute('SELECT state FROM tasks WHERE id=?', (task_id,)).fetchone()
        if not old or old['state'] not in ('running', 'waiting'):
            raise ValueError('Task is not active')
        con.execute('UPDATE tasks SET state=?,result=?,evidence=?,lease_until=0,updated=? WHERE id=?',
                    (state, result, json.dumps(evidence), time.time(), task_id))
        _record(con, task_id, state, result[:1200])


def stop(task_id):
    with database() as con:
        row = con.execute('SELECT state FROM tasks WHERE id=?', (task_id,)).fetchone()
        if not row:
            raise ValueError('No such task')
        if row['state'] in ('queued', 'running', 'waiting', 'interrupted'):
            con.execute("UPDATE tasks SET state='cancelled',lease_until=0,updated=? WHERE id=?", (time.time(), task_id))
            _record(con, task_id, 'cancelled')
    return get(task_id)


def pending_results(limit=12, origin=None):
    with database() as con:
        query = "SELECT * FROM tasks WHERE state IN ('completed','failed','interrupted','waiting') AND reported=0 AND role<>'supervisor'"
        if origin:
            query += ' AND origin=?'
        query += ' ORDER BY updated LIMIT ?'
        params = (origin, limit) if origin else (limit,)
        return [dict(row) for row in con.execute(query, params)]


def mark_reported(task_id):
    with database() as con:
        con.execute('UPDATE tasks SET reported=1 WHERE id=? AND state IN ("completed","failed","interrupted","waiting")', (task_id,))


def list_tasks(limit=30):
    with database() as con:
        tasks=[dict(row) for row in con.execute('SELECT * FROM tasks ORDER BY updated DESC LIMIT ?', (min(limit, 100),))]
        for task in tasks:
            task['events']=[dict(row) for row in con.execute(
                'SELECT at,kind,substr(detail,1,1200) detail FROM task_events WHERE task_id=? ORDER BY seq DESC LIMIT 8',
                (task['id'],))]
            task['events'].reverse()
            task['summaries']=[dict(row) for row in con.execute(
                'SELECT at,kind,substr(detail,1,1200) detail FROM task_summaries WHERE task_id=? ORDER BY seq DESC LIMIT 8',
                (task['id'],))]
            task['summaries'].reverse()
        return tasks


def setting(key, default=None):
    with database() as con:
        row = con.execute('SELECT value FROM task_settings WHERE key=?', (key,)).fetchone()
        return json.loads(row['value']) if row else default


def set_setting(key, value):
    with database() as con:
        con.execute('INSERT INTO task_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                    (key, json.dumps(value)))


def cursor(source):
    with database() as con:
        row = con.execute('SELECT value FROM task_cursors WHERE source=?', (source,)).fetchone()
        return row['value'] if row else ''


def advance_cursor(source, value):
    with database() as con:
        old=con.execute('SELECT value FROM task_cursors WHERE source=?',(source,)).fetchone()
        if old and old['value'].isdigit() and str(value).isdigit() and int(value)<int(old['value']):
            return
        con.execute('INSERT INTO task_cursors VALUES(?,?,?) ON CONFLICT(source) DO UPDATE SET value=excluded.value,updated=excluded.updated',
                    (source, str(value), time.time()))


def prune_events(days=30):
    with database() as con:
        con.execute('DELETE FROM task_events WHERE at<?', (time.time() - days * 86400,))
