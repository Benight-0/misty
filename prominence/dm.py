"""Text the owner in the bot's DM while you're still working (run with python3, from anywhere).

  dm.py say "<text>"                 send a message now and keep working
  dm.py ask "<question>" [--wait M]  send a question and wait up to M minutes (default 15) for the
                                     reply, which is printed; if none comes, carry on with your best call
  dm.py recent [N]                   the last N messages of your DM with the owner (default 20)

Your final message is still posted at the end as usual, so don't repeat what you said here.
"""
import fcntl, json, os, sys, time, urllib.request, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import config  # noqa: E402
import workflows  # noqa: E402  (shared outbox log)

OWNER = config.OWNER_ID
ASK_FILE = config.data("ask_pending.json")   # the bot routes the owner's next message here...
ANSWER_FILE = config.data("ask_answer.json")  # ...and writes it here
ASK_LOCK = config.data(".ask.lock")
SOURCE = os.environ.get("PROMINENCE_SOURCE", "owner")


def api(method, path, body=None):
    req = urllib.request.Request("https://discord.com/api/v10" + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None, headers={
                                     "Authorization": f"Bot {config.token()}", "Content-Type": "application/json",
                                     "User-Agent": "DiscordBot (https://claude.com, 1.0)"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)


def channel():
    owner = config.current_owner()
    data = api("POST", "/users/@me/channels", {"recipient_id": owner})
    if data.get('type') != 1 or [r.get('id') for r in data.get('recipients', [])] != [owner]:
        raise ValueError('Discord did not verify the current owner DM')
    return data['id']


def send(text):
    if SOURCE == 'owner' and os.environ.get('MISTY_CONVERSATION_RUN'):
        # Legacy dm.py calls from the duplex agent use the same durable channel.
        # Scheduled/background callers keep their independent delivery behavior.
        import hashlib
        import conversation
        run=conversation.owner_run_info(os.environ['MISTY_CONVERSATION_RUN'])['id']
        return conversation.publish(run,
                                    'dm-compat-'+hashlib.sha256(text.encode()).hexdigest(),text)
    ch = channel()
    last = None
    for piece in [text[k:k + 1900] for k in range(0, len(text), 1900)] or [""]:
        last = api("POST", f"/channels/{ch}/messages", {"content": piece, "allowed_mentions": {"parse": []}})
    workflows.log_sent(SOURCE, text)
    return last


def ask(question, wait_min):
    if SOURCE == 'owner' and os.environ.get('MISTY_CONVERSATION_RUN'):
        raise ValueError('Publish the question with publish_message, save a checkpoint and wait_for_input; do not block the duplex inbox')
    with open(ASK_LOCK, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)  # one open question at a time
        qid = str(uuid.uuid4())
        with open(ASK_FILE, "w") as f:
            json.dump({"id": qid, "pid": os.getpid(), "time": time.time(), "channel": channel()}, f)
        try:
            send(question)
            deadline = time.time() + wait_min * 60
            while time.time() < deadline:
                try:
                    ans = json.load(open(ANSWER_FILE))
                    if ans.get("id") == qid:
                        os.remove(ANSWER_FILE)
                        return ans["text"]
                except (OSError, ValueError):
                    pass
                time.sleep(2)
            return None
        finally:
            try:
                if json.load(open(ASK_FILE)).get("id") == qid:
                    os.remove(ASK_FILE)
            except (OSError, ValueError):
                pass


def main(argv):
    if not argv or argv[0] not in ("say", "ask", "recent"):
        print(__doc__)
        return 1
    cmd, args = argv[0], argv[1:]
    if cmd == "recent":
        n = int(args[0]) if args else 20
        msgs = api("GET", f"/channels/{channel()}/messages?limit={min(n, 100)}")
        for m in reversed(msgs):
            who = "you" if m["author"].get("bot") else "owner"
            ts = time.strftime("%m-%d %H:%M", time.localtime(((int(m["id"]) >> 22) + 1420070400000) / 1000))
            print(f"{ts} {who}: {m.get('content', '')}")
        return 0
    wait = 15.0
    if "--wait" in args:
        k = args.index("--wait")
        wait = float(args[k + 1])
        del args[k:k + 2]
    text = " ".join(args).strip() or sys.stdin.read().strip()
    if not text:
        print("nothing to send")
        return 1
    if cmd == "say":
        send(text)
        print("sent")
    else:
        ans = ask(text, wait)
        print(f"owner replied: {ans}" if ans is not None else
              f"(no reply after {wait:g} min; carry on with your best judgment and say what you assumed)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
