"""Read-only Discord lookups for the owner's DM agent (run with python3, from anywhere).

  discord_read.py general [N]            last N messages in the main channel (default 50)
  discord_read.py channel <id> [N]       last N messages in any channel or DM the bot can see
  discord_read.py channels               the server's text channels (id, name)
  discord_read.py search <text> [N]      search the crawled index of the server's public channels
  discord_read.py dms [N]                the bot's recent DM conversations with other people
"""
import json, os, sys, time, urllib.error, urllib.parse, urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config  # noqa: E402

GENERAL = config.MAIN_CHANNEL


def get(path):
    req = urllib.request.Request("https://discord.com/api/v10" + path, headers={
        "Authorization": f"Bot {config.token()}", "User-Agent": "DiscordBot (https://claude.com, 1.0)"})
    for attempt in range(5):  # the running bot shares this token's rate limit: wait out 429s
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code != 429 or attempt == 4:
                raise
            try:
                wait = float(json.load(e).get("retry_after", 1))
            except ValueError:
                wait = 1
            time.sleep(min(wait, 10) + 0.5)


def when(snowflake):
    ts = ((int(snowflake) >> 22) + 1420070400000) / 1000
    return datetime.fromtimestamp(ts, timezone.utc).astimezone().strftime("%m-%d %H:%M")


def show(channel, n):
    msgs, before = [], ""
    while len(msgs) < n:
        batch = get(f"/channels/{channel}/messages?limit={min(100, n - len(msgs))}{before}")
        if not batch:
            break
        msgs += batch
        before = f"&before={batch[-1]['id']}"
    for m in reversed(msgs):
        a = m["author"]
        who = a.get("global_name") or a["username"]
        files = " ".join(f"[file: {x['url']}]" for x in m.get("attachments", []))
        print(f"{when(m['id'])} {who} ({a['username']}): {m.get('content', '')} {files}".rstrip())


def main(args):
    cmd = args[0] if args else "general"
    if cmd == "general":
        show(GENERAL, int(args[1]) if len(args) > 1 else 50)
    elif cmd == "channel":
        show(args[1], int(args[2]) if len(args) > 2 else 50)
    elif cmd == "channels":
        guild = get(f"/channels/{GENERAL}")["guild_id"]
        for c in get(f"/guilds/{guild}/channels"):
            if c["type"] in (0, 5):
                print(c["id"], "#" + c["name"])
    elif cmd == "search":
        text, n = args[1].lower(), int(args[2]) if len(args) > 2 else 30
        index = json.load(open(config.data("message_index.json")))
        hits = [m for m in index["messages"].values() if text in (m[3] or "").lower()]
        for mid, channel, author, body in sorted(hits, key=lambda m: int(m[0]))[-n:]:
            print(f"{when(mid)} <#{channel}> {author}: {body}")
    elif cmd == "dms":
        n = int(args[1]) if len(args) > 1 else 50
        try:
            lines = open(config.data("dm_log.jsonl")).read().splitlines()[-n:]
        except OSError:
            lines = []
        for line in lines:
            e = json.loads(line)
            print(f"{e['time']} [{e['channel']}] {e['user']}: {e['said']!r} -> bot: {e['reply']!r}")
    else:
        print(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
