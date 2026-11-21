"""Read-only VM deployment evidence, with no chat bodies or credentials."""
import json
from pathlib import Path
import sqlite3
import subprocess

def connect(path):
    db=sqlite3.connect(Path(path).resolve().as_uri()+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
    return db

def main():
    db=connect('/var/lib/archival/data/archive.sqlite')
    rows=lambda sql,args=():[dict(r) for r in db.execute(sql,args)]
    setting=lambda key:json.loads(db.execute('SELECT value FROM settings WHERE key=?',(key,)).fetchone()[0]) if db.execute('SELECT 1 FROM settings WHERE key=?',(key,)).fetchone() else None
    output={'services':subprocess.check_output(['systemctl','is-active','archival','misty-bot','misty-prominence'],text=True).splitlines(),
      'classification':setting('discord_server_classification'),
      'policies':rows('SELECT treatment,count(*) servers FROM discord_server_policies GROUP BY treatment'),
      'channels':rows("SELECT p.treatment,count(*) channels,sum(c.message_count) messages FROM conversations c JOIN discord_server_policies p ON p.server_id=c.server_id WHERE c.platform='discord' AND c.kind='channel' AND c.connected=1 AND c.tracked=1 GROUP BY p.treatment"),
      'privateSelections':rows("SELECT platform,kind,count(*) chats FROM conversations WHERE connected=1 AND tracked=1 AND ((platform='discord' AND server_id='') OR platform='whatsapp') GROUP BY platform,kind"),
      'history':rows("SELECT p.name,c.name channel,j.complete,j.fetched,j.error,c.message_count,j.updated_at,b.status analysis,b.completed_revision,b.revision FROM conversations c JOIN discord_server_policies p ON p.server_id=c.server_id JOIN discord_history_jobs j ON j.room_id=c.id LEFT JOIN briefing_jobs b ON b.room_id=c.id WHERE c.platform='discord' AND c.connected=1 AND c.tracked=1 AND p.treatment IN ('G','GP') ORDER BY p.name,c.name"),
      'collector':{'discord':setting('native_discord'),'whatsapp':setting('native_whatsapp'),'error':setting('native_collector_error')},
      'summaries':{'runtime':setting('misty_server_summary_runtime'),'channels':rows("SELECT c.platform,count(*) enabled FROM misty_server_channels s JOIN conversations c ON c.id=s.room_id WHERE s.enabled=1 GROUP BY c.platform"),'pending':rows("SELECT c.platform,count(*) messages FROM misty_server_pending p JOIN conversations c ON c.id=p.room_id GROUP BY c.platform")},
      'unexpectedActive':rows("SELECT count(*) n FROM conversations c LEFT JOIN discord_server_policies p ON p.server_id=c.server_id WHERE c.platform='discord' AND c.server_id<>'' AND c.connected=1 AND c.tracked=1 AND coalesce(p.treatment,'I') NOT IN ('S','SP','G','GP')"),
      'preActivationNewRaw':rows("SELECT count(*) n FROM discord_remote d JOIN conversations c ON c.id=d.room_id JOIN discord_server_policies p ON p.server_id=c.server_id JOIN messages m ON m.id=d.message_id WHERE p.treatment IN ('S','SP') AND d.fetched_at>=p.from_ts AND m.ts<p.from_ts"),
      'postActivationIncoming':rows("SELECT p.treatment,count(*) n,min(m.ts) first,max(m.ts) latest FROM messages m JOIN conversations c ON c.id=m.room_id JOIN discord_server_policies p ON p.server_id=c.server_id WHERE c.platform='discord' AND m.ts>=p.from_ts GROUP BY p.treatment"),
      'latestEvents':rows("SELECT max(seq) seq,max(at) at FROM misty_message_events")}
    with connect('/var/lib/misty-bot/chat.sqlite') as bot:
        output['notifications']={'jobs':[dict(r) for r in bot.execute('SELECT kind,state,count(*) n FROM misty_watch_jobs GROUP BY kind,state')],'buffers':dict(bot.execute("SELECT count(*) channels,coalesce(sum(json_array_length(events)),0) messages FROM misty_watch_buffers").fetchone())}
        output['notifications']['settings']=[dict(r) for r in bot.execute("SELECT key,value FROM bot_settings WHERE key IN ('misty_notifications_paused','misty_watch_cursor','misty_watch_last_poll')")]
    print(json.dumps(output,ensure_ascii=False))

if __name__=='__main__':main()
