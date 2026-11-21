"""Run only in Linux with the WhatsApp /data bind mount read-only."""
import json
import sqlite3

with sqlite3.connect('file:/data/bridge.db?mode=ro', uri=True) as db:
    mappings = db.execute("SELECT lid,pn FROM whatsmeow_lid_map WHERE pn IN (?,?)", ('910000000001', '110000000000005@s.whatsapp.net')).fetchall()
    devices = db.execute("SELECT jid,lid FROM whatsmeow_device WHERE jid LIKE ?", ('910000000001%',)).fetchall()
    print(json.dumps({'phone_lid_mappings': mappings, 'own_device_identity': devices}))
