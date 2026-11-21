"""Moderation in the server, for the owner's agent (only when the owner explicitly asks for it).
Run with python3, from anywhere:

  mod.py find <name>                       look up a member (nickname, display name or username)
  mod.py timeout <member> <minutes> [reason]   time a member out (max 28 days)
  mod.py untimeout <member>                lift a timeout
  mod.py delete <channel id> <message id>  delete one message
  mod.py slowmode <channel id> <seconds>   set slowmode (0 turns it off)
  mod.py kick <member> [reason]            kick (only on the owner's explicit say-so)
  mod.py ban <member> [reason]             ban (only on the owner's explicit say-so)

<member> is a user id or a name (matched like `find`). Reasons go to the server's audit log.
Each action also posts a Claude Code-style command indicator in the main channel (--channel <id> for
another channel, --quiet for none); say your own line in the chat separately.
"""
import json, os, sys, urllib.error, urllib.parse, urllib.request
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config  # noqa: E402

GENERAL = config.MAIN_CHANNEL
OWNER = config.OWNER_ID


def api(method, path, body=None, reason=None):
    headers = {"Authorization": f"Bot {config.token()}", "User-Agent": "DiscordBot (https://claude.com, 1.0)",
               "Content-Type": "application/json"}
    if reason:
        headers["X-Audit-Log-Reason"] = urllib.parse.quote(reason[:500])
    req = urllib.request.Request("https://discord.com/api/v10" + path, method=method, headers=headers,
                                 data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        sys.exit(f"discord said {e.code}: {e.read()[:300].decode(errors='replace')}")


def guild():
    return api("GET", f"/channels/{GENERAL}")["guild_id"]


def find(g, query):
    if query.isdigit():
        return api("GET", f"/guilds/{g}/members/{query}")
    q = query.lower().lstrip("@")
    members = api("GET", f"/guilds/{g}/members?limit=1000")
    hits = [m for m in members if q in {(m.get("nick") or "").lower(), (m["user"].get("global_name") or "").lower(),
                                        m["user"]["username"].lower()}]
    hits = hits or [m for m in members if q in " ".join([(m.get("nick") or ""), m["user"].get("global_name") or "",
                                                          m["user"]["username"]]).lower()]
    if len(hits) != 1:
        sys.exit(f"{len(hits)} members match {query!r}: " + ", ".join(
            f"{m['user']['username']} ({m['user']['id']})" for m in hits[:10]))
    return hits[0]


def indicator(channel, command, result, memo=""):
    """Post a terminal-style line for the action, like the bot's slash-command replies, and note in
    the work log that it was real (chat mode sees that next to the message, so it doesn't call its
    own moderation fake)."""
    sent = api("POST", f"/channels/{channel}/messages", {
        "content": f"```\nâœ» {command}\n  âŽ¿ {result}\n```", "allowed_mentions": {"parse": []}})
    if sent and sent.get("id"):
        with open(config.data("work_log.jsonl"), "a") as f:
            f.write(json.dumps({"time": datetime.now(timezone.utc).timestamp(), "channel": channel,
                                "ids": [sent["id"]], "by": "the server", "request": command,
                                "memo": memo or f"real moderation, not a bit: {command} -> {result}. "
                                                "You can actually moderate this server."}) + "\n")
    return sent


def short(m):
    return m.get("nick") or m["user"].get("global_name") or m["user"]["username"]


def label(m):
    u = m["user"]
    return f"{m.get('nick') or u.get('global_name') or u['username']} ({u['username']}, {u['id']})"


def main(argv):
    if not argv:
        print(__doc__)
        return 1
    cmd, args = argv[0], argv[1:]
    quiet = "--quiet" in args
    args = [a for a in args if a != "--quiet"]
    channel = GENERAL
    if "--channel" in args:
        k = args.index("--channel")
        channel = args[k + 1]
        del args[k:k + 2]
    show = (lambda c, r: None) if quiet else (lambda c, r: indicator(channel, c, r))
    g = guild()
    if cmd == "find":
        print(label(find(g, args[0])))
    elif cmd in ("timeout", "untimeout", "kick", "ban"):
        m = find(g, args[0])
        if config.is_owner(m["user"]["id"]):
            sys.exit("not doing that to the owner")
        if cmd == "timeout":
            minutes = float(args[1])
            until = datetime.now(timezone.utc) + timedelta(minutes=min(minutes, 28 * 24 * 60))
            api("PATCH", f"/guilds/{g}/members/{m['user']['id']}",
                {"communication_disabled_until": until.isoformat()}, " ".join(args[2:]) or "timeout")
            print(f"timed out {label(m)} until {until.astimezone():%H:%M}")
            show(f"/timeout @{short(m)} {minutes:g}m", f"timed out until {until.astimezone():%-I:%M %p}")
        elif cmd == "untimeout":
            api("PATCH", f"/guilds/{g}/members/{m['user']['id']}", {"communication_disabled_until": None})
            print(f"lifted the timeout on {label(m)}")
            show(f"/untimeout @{short(m)}", "timeout lifted")
        elif cmd == "kick":
            api("DELETE", f"/guilds/{g}/members/{m['user']['id']}", reason=" ".join(args[1:]) or "kick")
            print(f"kicked {label(m)}")
            show(f"/kick @{short(m)}", "kicked")
        else:
            api("PUT", f"/guilds/{g}/bans/{m['user']['id']}", {}, " ".join(args[1:]) or "ban")
            print(f"banned {label(m)}")
            show(f"/ban @{short(m)}", "banned")
    elif cmd == "delete":
        api("DELETE", f"/channels/{args[0]}/messages/{args[1]}")
        print("deleted")
        show("/delete", "1 message deleted")
    elif cmd == "slowmode":
        api("PATCH", f"/channels/{args[0]}", {"rate_limit_per_user": int(args[1])})
        print(f"slowmode {args[1]}s")
        show(f"/slowmode {args[1]}s", "slowmode off" if args[1] == "0" else f"slowmode set to {args[1]}s")
    else:
        print(__doc__)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
