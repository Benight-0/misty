"""Read-only VM counters -> private ledger -> explicitly public aggregate snapshot.

No API credentials or network access needed. Never exports prompts, chat/room IDs,
request IDs, file paths, session IDs, names or message bodies.
"""
import argparse
from contextlib import closing
from datetime import datetime, timedelta
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import time
from zoneinfo import ZoneInfo

ZONE = ZoneInfo('Asia/Kolkata')
RATE_DATE = '2026-10-24'
# USD / million tokens, Standard. Catalog last updated on RATE_DATE.
RATES = {
    'gpt-5.4-mini': dict(input=.75, cached=.075, write=None, output=4.5, long=False),
    'gpt-5.6-luna': dict(input=.20, cached=.02, write=.25, output=1.2, long=True),
    # https://developers.openai.com/api/docs/models/gpt-6-luna (verified 2026-10-24)
    'gpt-6-luna': dict(input=.10, cached=.01, write=.125, output=.50, long=True),
    'gpt-6.1-sol': dict(input=2., cached=.10, write=2.5, output=10., long=True),
}
SOURCES = (
    ('analysis', '/var/lib/archival/data/archive.sqlite', 'openai_usage'),
    ('misty', '/var/lib/misty-bot/chat.sqlite', 'bot_usage'),
    ('apollo', '/var/lib/apollo-bot/chat.sqlite', 'bot_usage'),
)
CODEX_ROOT = Path('/var/lib/misty-prominence/.codex')
EPHEMERAL = Path('/var/lib/misty-prominence/api-usage.jsonl')
TASKS = {
    'summaries': ('Summaries & profile analysis',
                  'Chat summaries, history analysis and profile consolidation.'),
    'apollo': ('Apollo chat reviews & replies',
               'Server batches (50 messages or 15 minutes), DM/group checks and requested Apollo replies; recorded together.'),
    'misty': ('Misty conversations & agent work',
              'Owner conversations, tool-assisted work, lightweight helpers and background checks; recorded together.'),
    'other': ('Other / unclassified', 'Usage without a recognized task source.'),
}
TASK_SOURCE = {'analysis': 'summaries', 'apollo': 'apollo', 'misty': 'misty', 'misty-agent': 'misty'}
TASK_NOTE = ('Share of priced recorded spend, across all recorded history. These are broad task categories, '
             'not a per-action bill. Database searches have no separate API charge recorded here; '
             'the model calls that use them stay with their conversation or agent work. '
             'Unpriced records are excluded from cost shares. Historical logs do not support a finer reliable split.')


def number(value):
    return max(0, int(value or 0))


def estimate(model, tokens, tier='default', per_request=True):
    base = next((name for name in RATES if model == name or model.startswith(name + '-20')), None)
    if not base or tier not in ('default', 'standard', 'auto', '', None, 'flex', 'batch', 'priority', 'fast', 'ultrafast'):
        return None
    r = RATES[base]
    inp, out = number(tokens.get('input')), number(tokens.get('output'))
    cached = min(inp, number(tokens.get('cached')))
    write = min(inp - cached, number(tokens.get('write')))
    # Older Node records omit cache writes: those tokens retain the input rate.
    long = r['long'] and per_request and inp > 272000
    input_multiplier, output_multiplier = (2, 1.5) if long else (1, 1)
    tier_multiplier = {'flex': .5, 'batch': .5, 'priority': 2, 'fast': 2, 'ultrafast': 6}.get(tier, 1)
    return (((inp - cached - write) * r['input'] + cached * r['cached']
             + write * (r['write'] if r['write'] is not None else r['input'])) * input_multiplier
            + out * r['output'] * output_multiplier) * tier_multiplier / 1e6


def connect(path):
    con = sqlite3.connect(path, timeout=8)
    con.row_factory = sqlite3.Row
    con.executescript('''PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS usage(id TEXT PRIMARY KEY,source TEXT,model TEXT,at INTEGER,
        input INTEGER,cached INTEGER,write INTEGER,output INTEGER,cost REAL);
      CREATE INDEX IF NOT EXISTS usage_at ON usage(at);
      CREATE TABLE IF NOT EXISTS cursor(id TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE IF NOT EXISTS samples(at INTEGER PRIMARY KEY,cpu REAL,memory REAL,disk REAL);
    ''')
    return con


def state(con, key, default=None):
    r = con.execute('SELECT value FROM cursor WHERE id=?', (key,)).fetchone()
    return json.loads(r[0]) if r else default


def save(con, key, value):
    con.execute('INSERT INTO cursor VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
                (key, json.dumps(value)))


def record(con, key, source, model, at, tokens, tier='default', per_request=True):
    if not isinstance(model, str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}', model):
        model = 'unidentified'
    cost = estimate(model, tokens, tier, per_request)
    con.execute('INSERT OR IGNORE INTO usage VALUES(?,?,?,?,?,?,?,?,?)',
                (key, source, model, number(at), number(tokens.get('input')), number(tokens.get('cached')),
                 tokens.get('write'), number(tokens.get('output')), cost))


def read_database(con, source, path, table):
    previous = state(con, 'db:' + source, 0)
    with closing(sqlite3.connect('file:' + str(path) + '?mode=ro', uri=True, timeout=2)) as remote:
        # Fixed, developer-owned table names; no user-controlled SQL.
        maximum = remote.execute(f'SELECT max(rowid) FROM {table}').fetchone()[0] or 0
        if maximum < previous:
            previous = 0  # Restored/compacted source: IDs still deduplicate globally.
        rows = remote.execute(f'SELECT rowid,request_id,model,input_tokens,output_tokens,cached_tokens,at FROM {table} WHERE rowid>? ORDER BY rowid', (previous,))
        for rowid, rid, model, inp, out, cached, at in rows:
            key = 'response:' + rid if rid else f'{source}:row:{rowid}'
            record(con, key, source, model, at, dict(input=inp, output=out, cached=cached, write=None))
            previous = rowid
    save(con, 'db:' + source, previous)


def price_saved_luna(con):
    """Fill missing Luna costs from saved per-response counters; never replay imports.

    These Node sources omit tier/write metadata and already use the documented
    Standard-rate assumption. Do not guess discarded tiers of ephemeral agent runs.
    Existing prices, counters, response IDs and cursors remain untouched.
    """
    changed = 0
    for row in con.execute("SELECT id,model,input,cached,write,output FROM usage WHERE cost IS NULL "
                           "AND source IN ('analysis','misty','apollo') "
                           "AND (model='gpt-6-luna' OR model GLOB 'gpt-6-luna-20*')").fetchall():
        cost = estimate(row['model'], dict(input=row['input'], cached=row['cached'],
                                          write=row['write'], output=row['output']))
        if cost is not None:
            changed += con.execute('UPDATE usage SET cost=? WHERE id=? AND cost IS NULL', (cost, row['id'])).rowcount
    return changed


def read_log(con, path, ephemeral=False):
    cursor_key = 'log:' + str(path)
    saved = state(con, cursor_key, dict(offset=0, total={}, model='unidentified', session=path.stem))
    if path.stat().st_size < saved['offset']:
        saved['offset'], saved['total'] = 0, {}
    with path.open('rb') as f:
        f.seek(saved['offset'])
        while True:
            start = f.tell()
            line = f.readline()
            if not line:
                break
            if not line.endswith(b'\n'):
                f.seek(start)  # A writer has not finished this JSON line yet.
                break
            try:
                event = json.loads(line)
            except (ValueError, UnicodeError):
                continue
            if ephemeral:
                if event.get('schema') != 'misty-usage-v1':
                    continue
                record(con, 'ephemeral:' + event['id'], 'misty-agent', event['model'], event['at'],
                       event['tokens'], event.get('tier'), per_request=False)
                continue
            payload = event.get('payload') or {}
            if event.get('type') == 'session_meta':
                saved['session'] = payload.get('id') or saved['session']
            elif event.get('type') == 'turn_context':
                saved['model'] = payload.get('model') or saved['model']
            elif event.get('type') == 'event_msg' and payload.get('type') == 'token_count':
                info = payload.get('info') or {}
                total = info.get('total_token_usage') or {}
                if not total or total == saved['total']:
                    continue
                keys = dict(input='input_tokens', cached='cached_input_tokens', write='cache_write_input_tokens', output='output_tokens')
                previous = saved['total']
                reset = any(number(total.get(k)) < number(previous.get(k)) for k in keys.values())
                tokens = {name: (number((info.get('last_token_usage') or {}).get(k)) if reset else
                                 number(total.get(k)) - number(previous.get(k))) for name, k in keys.items()}
                if 'cache_write_input_tokens' not in total:
                    tokens['write'] = None
                stamp = datetime.fromisoformat(event['timestamp'].replace('Z', '+00:00')).timestamp() * 1000
                signature = hashlib.sha256(json.dumps(total, sort_keys=True).encode()).hexdigest()[:32]
                record(con, 'codex:' + saved['session'] + ':' + signature, 'misty-agent', saved['model'], stamp, tokens)
                saved['total'] = total
        saved['offset'] = f.tell()
    save(con, cursor_key, saved)


def cpu_counters():
    fields = [int(v) for v in Path('/proc/stat').read_text().splitlines()[0].split()[1:9]]
    return [sum(fields), fields[3] + fields[4]]


def cpu_delta(before, after):
    elapsed = after[0] - before[0]
    return round(max(0, min(100, 100 * (1 - (after[1] - before[1]) / elapsed))), 1) if elapsed > 0 else None


def host_snapshot(con, now):
    previous = state(con, 'cpu')
    counters = cpu_counters()
    if previous is None:
        previous = counters
        time.sleep(.3)
        counters = cpu_counters()
    cpu = cpu_delta(previous, counters)
    save(con, 'cpu', counters)
    memory = {k: int(v.split()[0]) * 1024 for k, v in (line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())}
    total, used = memory['MemTotal'], memory['MemTotal'] - memory['MemAvailable']
    disk = os.statvfs('/')
    disk_total, disk_used = disk.f_blocks * disk.f_frsize, (disk.f_blocks - disk.f_bfree) * disk.f_frsize
    host = dict(cpuPercent=cpu, memoryUsedBytes=used, memoryTotalBytes=total,
                memoryPercent=round(used / total * 100, 1), diskUsedBytes=disk_used,
                diskTotalBytes=disk_total, diskAvailableBytes=disk.f_bavail * disk.f_frsize,
                diskPercent=round(disk_used / disk_total * 100, 1),
                swapUsedBytes=memory['SwapTotal'] - memory['SwapFree'], swapTotalBytes=memory['SwapTotal'])
    con.execute('INSERT OR REPLACE INTO samples VALUES(?,?,?,?)', (now, cpu, host['memoryPercent'], host['diskPercent']))
    con.execute('DELETE FROM samples WHERE at<?', (now - 30 * 86400000,))
    return host


def cpu_seven_days(con, now):
    """Nearest-rank p95 of recorded minute samples, not graph-bucket averages."""
    start = now - 7 * 86400000
    rows = con.execute('SELECT at,cpu FROM samples WHERE at>=? AND at<=? '
                       'AND typeof(cpu) IN (\'real\',\'integer\') AND cpu BETWEEN 0 AND 100',
                       (start, now)).fetchall()
    values = sorted(row['cpu'] for row in rows)
    count = len(values)
    return dict(p95Percent=values[(95 * count + 99) // 100 - 1] if count else None,
                sampleCount=count, firstAt=min((row['at'] for row in rows), default=None),
                lastAt=max((row['at'] for row in rows), default=None),
                windowStartAt=start, windowEndAt=now, method='nearest-rank',
                nominalIntervalSeconds=60)


def task_breakdown(con):
    """Group existing counters only; never classify using prompts, rooms or chat text."""
    groups = {}
    for row in con.execute('SELECT source,count(*) records,sum(input+output) tokens,sum(cost) cost,'
                           'sum(cost IS NULL) unpriced FROM usage GROUP BY source'):
        key = TASK_SOURCE.get(row['source'], 'other')
        group = groups.setdefault(key, dict(task=key, label=TASKS[key][0], note=TASKS[key][1],
                                           records=0, tokens=0, estimatedUsd=None, unpricedRecords=0))
        group['records'] += row['records']
        group['tokens'] += row['tokens'] or 0
        group['unpricedRecords'] += row['unpriced'] or 0
        if row['cost'] is not None:
            group['estimatedUsd'] = (group['estimatedUsd'] or 0) + row['cost']
    total = sum(g['estimatedUsd'] or 0 for g in groups.values())
    for group in groups.values():
        group['shareOfPricedCostPercent'] = ((group['estimatedUsd'] or 0) / total * 100
                                           if total > 0 and group['estimatedUsd'] is not None else None)
    return sorted(groups.values(), key=lambda g: (-(g['estimatedUsd'] or 0), g['task']))


def snapshot(con, host, now, warnings):
    models = []
    for r in con.execute('SELECT model,count(*) records,sum(input) input,sum(cached) cached,sum(output) output,sum(cost) cost,sum(cost IS NULL) unpriced FROM usage GROUP BY model ORDER BY sum(input+output) DESC'):
        models.append(dict(model=r['model'], records=r['records'], inputTokens=r['input'],
                           cachedTokens=r['cached'], outputTokens=r['output'], estimatedUsd=r['cost'], unpricedRecords=r['unpriced']))
    day = datetime.fromtimestamp(now / 1000, ZONE).date()
    totals = con.execute('SELECT count(*) records,sum(input+output) tokens,sum(cost) cost,min(at) first,max(at) last,sum(cost IS NULL) unpriced FROM usage').fetchone()
    days = {str(day - timedelta(days=i)): dict(date=str(day - timedelta(days=i)), estimatedUsd=0, records=0) for i in range(6, -1, -1)}
    for r in con.execute('SELECT at,cost FROM usage WHERE at>=?', (int(datetime.combine(day - timedelta(days=6), datetime.min.time(), ZONE).timestamp() * 1000),)):
        key = str(datetime.fromtimestamp(r['at'] / 1000, ZONE).date())
        if key in days:
            days[key]['estimatedUsd'] += r['cost'] or 0
            days[key]['records'] += 1
    # Five-minute averages, at most 289 points for the past day.
    history = [dict(at=r[0] * 300000, cpuPercent=round(r[1], 1) if r[1] is not None else None,
                    memoryPercent=round(r[2], 1), diskPercent=round(r[3], 1)) for r in con.execute(
        'SELECT CAST(at/300000 AS INTEGER) bucket,avg(cpu),avg(memory),avg(disk) FROM samples WHERE at>=? GROUP BY bucket ORDER BY bucket', (now - 86400000,))]
    return dict(schema=1, updatedAt=now, timezone='Asia/Kolkata', refreshSeconds=60, host=host,
                usage=dict(estimatedUsd=totals['cost'], todayEstimatedUsd=days[str(day)]['estimatedUsd'],
                           records=totals['records'], tokens=totals['tokens'] or 0, firstAt=totals['first'], lastAt=totals['last'],
                           unpricedRecords=totals['unpriced'] or 0, models=models, daily=list(days.values()),
                           tasks=task_breakdown(con), taskBreakdownNote=TASK_NOTE),
                history=history, cpuSevenDays=cpu_seven_days(con, now),
                coverage=dict(kind='estimate', ratesChecked=RATE_DATE, warnings=warnings,
                    note='Recorded VM usage only, not an OpenAI invoice. Earlier missing/ephemeral calls, laptop usage, tools, taxes and unreported cache-write charges may be absent. Standard rates assumed where the original record omits its service tier.'))


def collect(state_dir):
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    con = connect(state_dir / 'metrics.sqlite')
    warnings = []
    try:
        with con:
            for name, path, table in SOURCES:
                try:
                    read_database(con, name, path, table)
                except (sqlite3.Error, OSError):
                    warnings.append(name + ' usage temporarily unavailable; saved totals retained.')
            for path in [*CODEX_ROOT.glob('sessions/**/*.jsonl'), *CODEX_ROOT.glob('archived_sessions/**/*.jsonl')]:
                try:
                    read_log(con, path)
                except (OSError, ValueError, KeyError):
                    warnings.append('Some agent usage could not be refreshed; saved totals retained.')
            if EPHEMERAL.exists():
                read_log(con, EPHEMERAL, ephemeral=True)
            price_saved_luna(con)
            now = int(time.time() * 1000)
            result = snapshot(con, host_snapshot(con, now), now, sorted(set(warnings)))
        public = state_dir / 'public'
        public.mkdir(mode=0o755, exist_ok=True)
        public.chmod(0o755)
        pending = public / 'metrics.json.pending'
        pending.write_text(json.dumps(result, separators=(',', ':')), encoding='utf-8')
        pending.chmod(0o644)
        os.replace(pending, public / 'metrics.json')
        return result
    finally:
        con.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--state', type=Path, default=Path('/var/lib/misty-metrics'))
    args = parser.parse_args()
    result = collect(args.state)
    print(json.dumps(dict(records=result['usage']['records'], estimatedUsd=result['usage']['estimatedUsd'], warnings=result['coverage']['warnings'])))
