"""Durable owner inbox. Ambiguous agent execution/delivery is never replayed."""
import json
from contextlib import contextmanager
import sqlite3
import time
import config


@contextmanager
def db():
    con = sqlite3.connect(config.data('inbox.sqlite'), timeout=10)
    con.execute('CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY,channel TEXT,body TEXT,state TEXT,reply TEXT DEFAULT "",updated REAL)')
    con.execute('CREATE TABLE IF NOT EXISTS cursor(channel TEXT PRIMARY KEY,id TEXT)')
    try:
        with con:
            yield con
    finally:
        con.close()


def enqueue(messages):
    with db() as con:
        for m in messages:
            if m.get('guild_id') or not config.is_owner(m['author']['id']) or m['author'].get('bot'):
                continue
            if (m.get('content') or '').lstrip().startswith('?'):
                continue
            con.execute('INSERT OR IGNORE INTO inbox(id,channel,body,state,updated) VALUES(?,?,?,"queued",?)',
                        (m['id'],m['channel_id'],json.dumps(m),time.time()))


def queued(message_id):
    with db() as con:
        r = con.execute('SELECT state FROM inbox WHERE id=?',(message_id,)).fetchone()
    return not r or r[0]=='queued'


def transition(messages, state, reply=None):
    with db() as con:
        for m in messages:
            con.execute('UPDATE inbox SET state=?,reply=coalesce(?,reply),updated=? WHERE id=?',(state,reply,time.time(),m['id']))


def begin(messages): transition(messages,'running')
def ready(messages, reply): transition(messages,'delivering',reply)
def finish(messages): transition(messages,'sent')
def unknown(messages): transition(messages,'unknown')


def pending(channel):
    with db() as con:
        # A crash may have happened after a tool action or a Discord send.
        con.execute('UPDATE inbox SET state="unknown" WHERE channel=? AND state IN ("running","delivering")', (channel,))
        rows = con.execute('SELECT body FROM inbox WHERE channel=? AND state="queued" ORDER BY length(id),id',(channel,)).fetchall()
    return [json.loads(r[0]) for r in rows]


def cursor(channel, value=None):
    with db() as con:
        if value is not None:
            con.execute('INSERT INTO cursor VALUES(?,?) ON CONFLICT(channel) DO UPDATE SET id=excluded.id',(channel,value))
            return value
        row = con.execute('SELECT id FROM cursor WHERE channel=?',(channel,)).fetchone()
        return row[0] if row else None
