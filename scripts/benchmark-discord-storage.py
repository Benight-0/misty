"""Benchmark disposable files, never the live bridge database."""
import json, os, sqlite3, time
for folder in ['/out', '/native']:
    path = folder + '/storage-benchmark.sqlite'
    db = sqlite3.connect(path)
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('PRAGMA synchronous=FULL')
    db.execute('CREATE TABLE IF NOT EXISTS sample (id INTEGER PRIMARY KEY, value TEXT)')
    started = time.perf_counter()
    for i in range(25):
        db.execute('INSERT OR REPLACE INTO sample VALUES (?, ?)', (i, 'x' * 100))
        db.commit()
    elapsed = time.perf_counter() - started
    db.close()
    print(json.dumps({'storage': folder, 'transactions': 25, 'elapsed_ms': round(elapsed * 1000), 'ms_per_commit': round(elapsed * 1000 / 25, 2)}), flush=True)
    for suffix in ['', '-wal', '-shm']:
        if os.path.exists(path + suffix): os.remove(path + suffix)
