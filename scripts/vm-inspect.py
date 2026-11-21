import sqlite3
with sqlite3.connect('/var/lib/archival/whatsapp.sqlite') as db:
    print('WhatsApp identifier format:',db.execute('SELECT id,room_id,sender_id FROM message LIMIT 2').fetchall())
