"""Print ingestion/analysis metadata without chat text or account secrets."""
import json
import pathlib
import sqlite3

with sqlite3.connect('/var/lib/archival/data/archive.sqlite') as db:
    print('Analysis failures:', db.execute("SELECT error,count(*) FROM briefing_jobs WHERE status='error' GROUP BY error").fetchall())
    print('WhatsApp raw records:', db.execute('SELECT count(*) FROM native_whatsapp_raw').fetchone()[0])
    print('WhatsApp message links:', db.execute("SELECT count(*),count(DISTINCT message_id) FROM native_message_links WHERE platform='whatsapp'").fetchone())
    print('WhatsApp duplicate remote IDs:', db.execute("SELECT count(*) FROM (SELECT n.remote_id FROM native_message_links n JOIN messages m ON m.id=n.message_id WHERE n.platform='whatsapp' GROUP BY n.remote_id HAVING count(DISTINCT n.message_id)>1)").fetchone()[0])
    print('WhatsApp owner messages:', db.execute("SELECT count(*) FROM messages m JOIN conversations c ON c.id=m.room_id WHERE c.platform='whatsapp' AND c.kind='dm' AND m.is_me=1").fetchone()[0])
    print('Discord history jobs:', db.execute('SELECT complete,count(*) FROM discord_history_jobs GROUP BY complete').fetchall())
    print('Analysis batches:', db.execute('SELECT sum(completed_batches),sum(total_batches),sum(completed_texts),sum(texts) FROM briefing_history_progress').fetchone())
    print('Latest API usage:', db.execute('SELECT count(*),max(at) FROM openai_usage').fetchone())
    print('Analysis jobs:', db.execute('SELECT status,count(*),max(generated_at) FROM briefing_jobs GROUP BY status').fetchall())
for path in pathlib.Path('/var/backups/archival').glob('.staging-*/*'):
    if path.is_file():
        print('Backup staging:', path.name, path.stat().st_size)
