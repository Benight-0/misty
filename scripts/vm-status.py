import sqlite3,json
with sqlite3.connect('/var/lib/archival/data/archive.sqlite') as db:
    for key,value in db.execute("SELECT key,value FROM settings WHERE key LIKE 'native_%' OR key IN ('briefing_last_failure','briefing_worker_error')"):
        print(key,value)
    print('Private messages by platform:',db.execute("SELECT c.platform,count(*),sum(m.is_me) FROM messages m JOIN conversations c ON c.id=m.room_id WHERE (c.platform='discord' AND c.server_id='' AND c.kind IN ('dm','group')) OR (c.platform='whatsapp' AND c.kind='dm') GROUP BY c.platform").fetchall())
    print('Private chats:',db.execute("SELECT platform,kind,count(*) FROM conversations WHERE connected=1 GROUP BY platform,kind").fetchall())
    print('Catch-up checkpoints:',db.execute("SELECT count(*),max(updated_at) FROM native_discord_cursors").fetchone())
    print('OpenAI usage:',db.execute('SELECT count(*),coalesce(sum(input_tokens),0),coalesce(sum(output_tokens),0) FROM openai_usage').fetchone())
    print('Analysis checkpoints:',db.execute('SELECT count(*) FROM briefing_history_nodes').fetchone()[0])
    print('Analysis job states:',db.execute('SELECT status,count(*) FROM briefing_jobs GROUP BY status').fetchall())
with sqlite3.connect('/var/lib/archival/whatsapp.sqlite') as db:
    print('WhatsApp saved devices:',db.execute('SELECT count(*) FROM whatsmeow_device').fetchone()[0])
