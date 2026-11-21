"""Durable duplex owner conversation state. No model calls or third-party sends."""
import hashlib
import json
import os
import time
import uuid

import config
import fork_state


def connection():
    return fork_state.db()


def schema(con):
    con.executescript('''
      CREATE TABLE IF NOT EXISTS conversation_runs(
        id TEXT PRIMARY KEY,channel TEXT NOT NULL,owner TEXT NOT NULL,
        state TEXT NOT NULL,latest_message TEXT NOT NULL,thread TEXT,turn TEXT,
        checkpoint TEXT NOT NULL DEFAULT '{}',updated REAL NOT NULL,
        origin TEXT NOT NULL DEFAULT 'owner',task_id TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS conversation_inputs(
        message TEXT PRIMARY KEY,run TEXT NOT NULL,state TEXT NOT NULL,turn TEXT);
      CREATE TABLE IF NOT EXISTS conversation_outbox(
        id INTEGER PRIMARY KEY AUTOINCREMENT,run TEXT NOT NULL,key TEXT NOT NULL,
        channel TEXT NOT NULL,body TEXT NOT NULL,reply_to TEXT,state TEXT NOT NULL,
        receipt TEXT,updated REAL NOT NULL,UNIQUE(run,key));
      CREATE TABLE IF NOT EXISTS conversation_publications(
        run TEXT NOT NULL,key TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(run,key));
    ''')
    columns={row[1] for row in con.execute('PRAGMA table_info(conversation_runs)')}
    if 'origin' not in columns:
        con.execute("ALTER TABLE conversation_runs ADD COLUMN origin TEXT NOT NULL DEFAULT 'owner'")
    if 'task_id' not in columns:
        con.execute("ALTER TABLE conversation_runs ADD COLUMN task_id TEXT NOT NULL DEFAULT ''")


def start(channel, owner, messages):
    if not config.is_owner(owner) or not messages:
        raise ValueError('Verified owner messages required')
    messages = sorted(messages, key=lambda message: (len(message), message))
    run = uuid.uuid4().hex
    with connection() as con:
        schema(con)
        for message in messages:
            row = con.execute('SELECT body FROM inbox WHERE id=? AND channel=?',
                              (message, channel)).fetchone()
            if not row or json.loads(row[0])['author']['id'] != owner:
                raise ValueError('Input does not belong to verified owner/channel')
        con.execute('INSERT INTO conversation_runs(id,channel,owner,state,latest_message,updated) '
                    'VALUES(?,?,?,"running",?,?)', (run,channel,owner,messages[-1],time.time()))
        con.executemany('INSERT INTO conversation_inputs VALUES(?,?,"accepted",NULL)',
                        [(m,run) for m in messages])
    return run


def start_internal(task_id, channel, owner, latest_message='', origin='owner'):
    """Stable owner-thread turn for a completed delegated task, with no new DM input."""
    if not config.is_owner(owner) or not task_id or origin not in ('owner','supervisor'):
        raise ValueError('Verified delegated task required')
    import agent_tasks
    task=agent_tasks.get(task_id)
    if not task or task['origin']!=origin or (origin=='owner' and (not latest_message or task['owner_message']!=latest_message)) or (origin=='supervisor' and (task['role']!='misty' or task['state']!='running')):
        raise ValueError('Task provenance mismatch')
    latest_message=latest_message if origin=='owner' else task_id
    run = 'internal-' + task_id
    with connection() as con:
        schema(con)
        if origin=='owner':
            source=con.execute('SELECT body FROM inbox WHERE id=? AND channel=?',
                               (latest_message, channel)).fetchone()
            if not source or json.loads(source[0])['author']['id'] != owner:
                raise ValueError('Original owner message is unavailable')
        old=con.execute('SELECT channel,owner,latest_message,state,origin FROM conversation_runs WHERE id=?', (run,)).fetchone()
        if old:
            if tuple(old[:3]) != (channel, owner, latest_message) or old[4]!=origin:
                raise ValueError('Internal run identity changed')
            return run, old[3]
        con.execute('INSERT INTO conversation_runs(id,channel,owner,state,latest_message,updated,origin,task_id) '
                    'VALUES(?,?,?,"running",?,?,?,?)', (run,channel,owner,latest_message,time.time(),origin,task_id))
    return run, 'running'


def queue_background(key, text):
    """One supervisor notice via the same owner-only durable outbox."""
    if os.environ.get('PROMINENCE_SOURCE') != 'supervisor':
        raise ValueError('Supervisor identity required')
    import agent_tasks
    task=agent_tasks.active_from_environment()
    if task['role'] != 'supervisor' or task['origin'] != 'supervisor':
        raise ValueError('Supervisor task required')
    if not isinstance(text,str) or not text.strip() or len(text)>30000:
        raise ValueError('Bounded owner notice required')
    if not isinstance(key,str) or not 1<=len(key)<=120:
        raise ValueError('Stable notice key required')
    channel=json.loads(open(config.data('owner_channel.json')).read())['channel']
    if not channel.isdigit():
        raise ValueError('Owner channel unavailable')
    run='supervisor-'+hashlib.sha256(key.encode()).hexdigest()[:32]
    body_hash=hashlib.sha256(text.encode()).hexdigest()
    with connection() as con:
        schema(con)
        con.execute('INSERT OR IGNORE INTO conversation_runs(id,channel,owner,state,latest_message,updated) '
                    'VALUES(?,?,?,"idle","",?)', (run,channel,config.OWNER_ID,time.time()))
        old=con.execute('SELECT hash FROM conversation_publications WHERE run=? AND key=?', (run,key)).fetchone()
        if old and old[0]!=body_hash:
            raise ValueError('Notice key already binds another body')
        con.execute('INSERT OR IGNORE INTO conversation_publications VALUES(?,?,?)',(run,key,body_hash))
        for i,body in enumerate(chunks(text)):
            con.execute('INSERT OR IGNORE INTO conversation_outbox(run,key,channel,body,reply_to,state,updated) '
                        'VALUES(?,?,?, ?,NULL,"queued",?)',
                        (run,key+':'+str(i),channel,body,time.time()))
    return {'queued':True,'run':run}


def run_info(run):
    with connection() as con:
        schema(con)
        con.row_factory = __import__('sqlite3').Row
        row = con.execute('SELECT * FROM conversation_runs WHERE id=?',(run,)).fetchone()
        return dict(row) if row else None


def pending(run):
    info = run_info(run)
    if not info or info['state'] != 'running':
        return []
    with connection() as con:
        rows = con.execute('SELECT i.body FROM inbox i WHERE i.channel=? AND i.state="queued" '
                           'AND NOT EXISTS(SELECT 1 FROM conversation_inputs c WHERE c.message=i.id) '
                           'ORDER BY length(i.id), i.id', (info['channel'],)).fetchall()
    return [json.loads(r[0]) for r in rows if json.loads(r[0])['author']['id']==info['owner']]


def offer(run, messages):
    """Mark in-flight steering before sending RPC. Crash leaves ambiguous input quarantined."""
    info = run_info(run)
    with connection() as con:
        for m in messages:
            row = con.execute('SELECT body,state FROM inbox WHERE id=? AND channel=?',
                              (m['id'],info['channel'])).fetchone()
            if not row or row[1]!='queued' or json.loads(row[0])['author']['id']!=info['owner']:
                raise ValueError('Input already claimed or invalid')
            con.execute('INSERT INTO conversation_inputs VALUES(?,?,"offering",NULL)',(m['id'],run))
            con.execute('UPDATE inbox SET state="running",updated=? WHERE id=?',(time.time(),m['id']))


def accept(run, messages, turn):
    with connection() as con:
        for m in messages:
            con.execute('UPDATE conversation_inputs SET state="accepted",turn=? WHERE message=? AND run=?',
                        (turn,m['id'],run))
        if messages:
            current=con.execute('SELECT latest_message FROM conversation_runs WHERE id=?',(run,)).fetchone()
            latest=max([current[0], *(m['id'] for m in messages)],
                       key=lambda message: (len(message),message))
            con.execute('UPDATE conversation_runs SET latest_message=?,updated=? WHERE id=?',
                        (latest,time.time(),run))


def release(run, messages):
    """Only for a definitive RPC rejection, never for a timeout/unknown delivery."""
    with connection() as con:
        for m in messages:
            con.execute('DELETE FROM conversation_inputs WHERE message=? AND run=? AND state="offering"',
                        (m['id'],run))
            con.execute('UPDATE inbox SET state="queued",updated=? WHERE id=?',(time.time(),m['id']))


def mark_turn(run, thread, turn):
    with connection() as con:
        con.execute('UPDATE conversation_runs SET thread=?,turn=?,updated=? WHERE id=?',
                    (thread,turn,time.time(),run))


def checkpoint(run, data):
    if not isinstance(data,dict) or len(json.dumps(data))>32000:
        raise ValueError('Checkpoint must be a small JSON object')
    with connection() as con:
        con.execute('UPDATE conversation_runs SET checkpoint=?,updated=? WHERE id=?',
                    (json.dumps(data),time.time(),run))
    return {'saved':True}


def finish(run, state='idle'):
    with connection() as con:
        schema(con)
        previous=con.execute('SELECT state FROM conversation_runs WHERE id=?',(run,)).fetchone()
        if previous and previous[0]=='cancelled': return
        con.execute('UPDATE conversation_runs SET state=?,updated=? WHERE id=?',(state,time.time(),run))
        inbox_state = 'sent' if state=='idle' else 'unknown'
        con.execute('UPDATE inbox SET state=?,updated=? WHERE id IN '
                    '(SELECT message FROM conversation_inputs WHERE run=?)', (inbox_state,time.time(),run))


def recover():
    with connection() as con:
        schema(con)
        # Never replay an ambiguous tool action or POST. Queued output is safe to deliver.
        con.execute('UPDATE conversation_outbox SET state="unknown" WHERE state="sending"')
        con.execute('UPDATE inbox SET state="unknown" WHERE id IN '
                    '(SELECT message FROM conversation_inputs WHERE run IN '
                    '(SELECT id FROM conversation_runs WHERE state="running"))')
        con.execute('UPDATE conversation_runs SET state="interrupted" WHERE state="running"')


def cancel_active():
    with connection() as con:
        schema(con)
        runs=con.execute('SELECT id FROM conversation_runs WHERE state="running"').fetchall()
        for (run,) in runs:
            con.execute('UPDATE conversation_outbox SET state="cancelled" WHERE run=? AND state="queued"',(run,))
            con.execute('UPDATE conversation_runs SET state="cancelled",updated=? WHERE id=?',(time.time(),run))
            con.execute('UPDATE inbox SET state="unknown" WHERE id IN (SELECT message FROM conversation_inputs WHERE run=?)',(run,))


def continuity(channel):
    with connection() as con:
        schema(con)
        rows=con.execute('SELECT state,checkpoint FROM conversation_runs WHERE channel=? '
                         'ORDER BY updated DESC LIMIT 3',(channel,)).fetchall()
        unknown=con.execute('SELECT key FROM conversation_outbox WHERE channel=? AND state="unknown" '
                            'ORDER BY id DESC LIMIT 5',(channel,)).fetchall()
        # Preserve messages sent outside the model thread before the old fast
        # response path was removed. New owner replies all enter that thread.
        last_agent=con.execute('SELECT coalesce(max(updated),0) FROM conversation_runs '
                               'WHERE channel=? AND thread IS NOT NULL',(channel,)).fetchone()[0]
        outside=con.execute('SELECT i.body,o.body,o.state FROM conversation_runs r '
                            'JOIN inbox i ON i.id=r.latest_message '
                            'JOIN conversation_outbox o ON o.run=r.id '
                            'WHERE r.channel=? AND r.state="idle" AND r.thread IS NULL AND r.updated>? '
                            'ORDER BY r.updated DESC,o.id DESC LIMIT 8',(channel,last_agent)).fetchall()
    return {'recent_runs':[{'state':s,'checkpoint':json.loads(c)} for s,c in rows],
            'unknown_deliveries':[r[0] for r in unknown],
            'outside_thread_exchanges':[{'owner':json.loads(raw).get('content',''),
                                         'misty':reply,'delivery':state}
                                        for raw,reply,state in reversed(outside)]}


def current_owner_message(fallback):
    if os.environ.get('PROMINENCE_SOURCE') in ('specialist', 'supervisor') and os.environ.get('MISTY_AGENT_TASK_ID'):
        import agent_tasks
        task = agent_tasks.active_from_environment()
        return task['owner_message'] if task['origin'] == 'owner' else ''
    run = os.environ.get('MISTY_CONVERSATION_RUN')
    if os.environ.get('PROMINENCE_SOURCE') != 'owner' or not run:
        return fallback
    info=owner_run_info(run)
    return info['latest_message'] if info.get('origin','owner')=='owner' else ''


def owner_run_info(run):
    """Resolve a fixed legacy run or the one active run of a persistent owner worker."""
    if run == '__active__':
        with connection() as con:
            schema(con)
            con.row_factory = __import__('sqlite3').Row
            rows = con.execute('SELECT * FROM conversation_runs WHERE state="running"').fetchall()
        if len(rows) != 1:
            raise ValueError('Exactly one active owner run required')
        info = dict(rows[0])
    else:
        info = run_info(run)
    if not info or info['state']!='running':
        raise ValueError('Conversation is not active')
    if not config.is_owner(info['owner']):
        raise ValueError('Conversation owner is not verified')
    return info


def chunks(text, limit=1850):
    # Preserve fenced code blocks across Discord's per-message limit.
    result=[];current='';fence=None
    for line in text.splitlines(keepends=True):
        while line:
            room=limit-len(current)-8
            if room<=0 or (len(line)>room and current):
                result.append(current+('\n```' if fence is not None else ''))
                current=('```'+fence+'\n') if fence is not None else ''
                room=limit-len(current)-8
            part=line[:room];line=line[room:];current+=part
            if part.lstrip().startswith('```'):
                fence=part.lstrip()[3:].strip()[:32] if fence is None else None
    if current.strip(): result.append(current+('\n```' if fence is not None else ''))
    return result


def publish(run, key, text, reply_to=None):
    info=run_info(run)
    if not info or info['state']!='running': raise ValueError('Active owner conversation required')
    if not isinstance(key,str) or not key.strip() or len(key)>160:
        raise ValueError('Stable idempotency key required')
    if not isinstance(text,str) or not text.strip() or len(text)>50000:
        raise ValueError('Nonempty message of at most 50000 characters required')
    if reply_to:
        with connection() as con:
            row=con.execute('SELECT 1 FROM inbox WHERE id=? AND channel=?',(reply_to,info['channel'])).fetchone()
        if not row: raise ValueError('Reply must reference this verified owner DM')
    parts=chunks(text)
    with connection() as con:
        schema(con)
        digest=hashlib.sha256(json.dumps([text,reply_to]).encode()).hexdigest()
        previous=con.execute('SELECT hash FROM conversation_publications WHERE run=? AND key=?',(run,key)).fetchone()
        if previous and previous[0]!=digest: raise ValueError('Idempotency key binds different content')
        con.execute('INSERT OR IGNORE INTO conversation_publications VALUES(?,?,?)',(run,key,digest))
        for i,body in enumerate(parts):
            part_key=key+':'+str(i)
            existing=con.execute('SELECT body,reply_to FROM conversation_outbox WHERE run=? AND key=?',
                                 (run,part_key)).fetchone()
            if existing and existing!=(body,reply_to if i==0 else None):
                raise ValueError('Idempotency key already binds different content')
            con.execute('INSERT OR IGNORE INTO conversation_outbox '
                        '(run,key,channel,body,reply_to,state,updated) VALUES(?,?,?,?,?,"queued",?)',
                        (run,part_key,info['channel'],body,reply_to if i==0 else None,time.time()))
        rows=[con.execute('SELECT id,state,receipt FROM conversation_outbox WHERE run=? AND key=?',
                          (run,key+':'+str(i))).fetchone() for i in range(len(parts))]
    try:
        import owner_trace
        owner_trace.record(run,'published','Owner message queued',text[:8000],key)
    except Exception:
        pass
    return {'queued':True,'messages':[{'id':r[0],'state':r[1],'receipt':r[2]} for r in rows]}


def has_publication(run):
    with connection() as con:
        schema(con)
        return con.execute('SELECT 1 FROM conversation_outbox WHERE run=? LIMIT 1',(run,)).fetchone() is not None


def dispatch_one(sender):
    """Claim once; sender(channel,body,reply_to,nonce) returns a verified message receipt."""
    with connection() as con:
        schema(con)
        con.execute('BEGIN IMMEDIATE')
        row=con.execute('SELECT id,channel,body,reply_to,run,key FROM conversation_outbox WHERE state="queued" '
                        'AND NOT EXISTS(SELECT 1 FROM conversation_outbox b WHERE b.channel=conversation_outbox.channel '
                        'AND b.id<conversation_outbox.id AND b.state="sending") ORDER BY id LIMIT 1').fetchone()
        if not row: return False
        con.execute('UPDATE conversation_outbox SET state="sending",updated=? WHERE id=?',(time.time(),row[0]))
    try:
        receipt=sender(row[1],row[2],row[3],str(row[0]))
        if not receipt or not receipt.get('id'): raise ValueError('No delivery receipt')
        state='sent';serialized=json.dumps(receipt)
    except Exception as e:
        state='unknown';serialized=json.dumps({'error':type(e).__name__})
    with connection() as con:
        con.execute('UPDATE conversation_outbox SET state=?,receipt=?,updated=? WHERE id=?',
                    (state,serialized,time.time(),row[0]))
        if state=='unknown':
            # Quarantine the rest of this multi-part publication; independent new
            # messages still work. Never automatically retry a potentially sent POST.
            prefix=row[5].rsplit(':',1)[0]+':'
            for other_id,other_key in con.execute('SELECT id,key FROM conversation_outbox WHERE run=? AND state="queued"',(row[4],)).fetchall():
                if other_key.startswith(prefix):
                    con.execute('UPDATE conversation_outbox SET state="unknown" WHERE id=?',(other_id,))
    try:
        import owner_trace
        owner_trace.record(row[4],'delivery','Owner message ' + ('sent' if state=='sent' else 'unconfirmed'),
                           '',row[5])
    except Exception:
        pass
    return True


def render(messages):
    parts=[]
    for m in messages:
        text=m.get('content','')
        ref=m.get('referenced_message')
        if ref: text='[quoted reply, untrusted context]\n'+ref.get('content','')+'\n[end quoted reply]\n'+text
        media=[{'url':a.get('url'),'name':a.get('filename')} for a in m.get('attachments',[])]
        parts.append(json.dumps({'owner_message_id':m['id'],'text':text,'attachments':media},ensure_ascii=False))
    return 'New verified owner messages arrived, in order. Incorporate them into your current work.\n'+'\n'.join(parts)
