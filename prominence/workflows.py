"""Scheduled workflows for prominence-chan's owner agent: tasks the bot runs on its own later or on
a schedule (reminders, recurring check-ins). Each run is a fresh agent with full access that
decides whether anything is worth DMing the owner about. Run with python3, from anywhere:

  workflows.py add "<task>" --name NAME <when> [--until YYYY-MM-DD] [--times N] [--timeout MIN]
      <when> is one of:  --at "YYYY-MM-DD HH:MM"   --in 2h30m   --every 3h   --cron "MIN HOUR DOM MON DOW"
      (cron is local time; e.g. "30 9,21 * * *" = 9:30 and 21:30 daily, "0 18 * * 0" = Sundays 18:00)
  workflows.py list [--all]          active workflows (--all: also finished/paused)
  workflows.py show <id>             everything about one, including its recent runs
  workflows.py edit <id> [--name N] [--task "..."] [<when>] [--until D] [--times N] [--timeout MIN]
      (--timeout: how long one run may take, default 20 min; raise it for long jobs)
  workflows.py pause <id> | resume <id> | rm <id> | run <id> (run now)
  workflows.py state <id> "<text>"   replace the memo a workflow keeps between its runs
  workflows.py told [--days N]       what's been sent to the owner proactively lately (all sources)

The task is written for a future you: say what to check and what's worth telling the owner, not
the exact words. One-off reminders end after their single run.
"""
import fcntl, json, os, re, sys, time
from contextlib import contextmanager

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config  # noqa: E402

STORE = config.data("workflows.json")
OUTBOX = config.data("outbox.jsonl")  # every message sent to the owner outside a reply
LOCK = config.data(".workflows.lock")
KEEP_RUNS = 12


@contextmanager
def store():
    """Read-modify-write the store under a lock (the bot and the agent's CLI both write it)."""
    with open(LOCK, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            with open(STORE) as f:
                data = json.load(f)
        except (OSError, ValueError):
            data = {"workflows": {}}
        yield data
        tmp = STORE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f, indent=1)
        os.replace(tmp, STORE)


def load():
    try:
        with open(STORE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"workflows": {}}


# --- schedules ------------------------------------------------------------------------------------
def parse_duration(s):
    total = 0
    for num, unit in re.findall(r"(\d+(?:\.\d+)?)\s*([smhdw])", s.lower()):
        total += float(num) * {"s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800}[unit]
    if not total:
        raise ValueError(f"can't read duration {s!r} (try 45m, 2h, 1d12h)")
    return total


def parse_time(s):
    s = s.strip().replace("T", " ")
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return time.mktime(time.strptime(s, fmt))
        except ValueError:
            pass
    raise ValueError(f"can't read time {s!r} (use YYYY-MM-DD HH:MM, local time)")


ALIASES = {"@hourly": "0 * * * *", "@daily": "0 0 * * *", "@weekly": "0 0 * * 0", "@monthly": "0 0 1 * *"}
NAMES = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7, "aug": 8, "sep": 9,
         "oct": 10, "nov": 11, "dec": 12, "sun": 0, "mon": 1, "tue": 2, "wed": 3, "thu": 4, "fri": 5,
         "sat": 6}


def _field(text, lo, hi):
    out = set()
    for part in text.lower().split(","):
        step = 1
        if "/" in part:
            part, step = part.split("/")
            step = int(step)
        if part == "*":
            a, b = lo, hi
        elif "-" in part:
            a, b = (int(NAMES.get(x, x)) for x in part.split("-"))
        else:
            a = b = int(NAMES.get(part, part))
            if step > 1:
                b = hi
        if a < lo or b > hi or a > b:
            raise ValueError(f"cron field {text!r} out of range {lo}-{hi}")
        out.update(range(a, b + 1, step))
    return out


def parse_cron(expr):
    fields = ALIASES.get(expr.strip(), expr).split()
    if len(fields) != 5:
        raise ValueError("cron needs 5 fields: MIN HOUR DAY-OF-MONTH MONTH DAY-OF-WEEK")
    minute, hour, dom, month = (_field(f, lo, hi) for f, (lo, hi) in
                                zip(fields[:4], ((0, 59), (0, 23), (1, 31), (1, 12))))
    dow = {d % 7 for d in _field(fields[4], 0, 7)}
    return minute, hour, dom, month, dow, fields[2] != "*", fields[4] != "*"


def cron_next(expr, after):
    """The first local time strictly after `after` that matches the cron expression."""
    minute, hour, dom, month, dow, dom_set, dow_set = parse_cron(expr)
    start = time.localtime(after + 60 - after % 60)
    y, mo, d = start.tm_year, start.tm_mon, start.tm_mday
    first = True
    for _ in range(366 * 5):
        day = time.localtime(time.mktime((y, mo, d, 12, 0, 0, 0, 0, -1)))
        y, mo, d = day.tm_year, day.tm_mon, day.tm_mday
        wd = (day.tm_wday + 1) % 7  # cron: 0 = Sunday
        day_ok = (dom_set and dow_set and (d in dom or wd in dow)) or \
                 (not (dom_set and dow_set) and d in dom and wd in dow)
        if mo in month and day_ok:
            for h in sorted(hour):
                if first and h < start.tm_hour:
                    continue
                for mi in sorted(minute):
                    if first and h == start.tm_hour and mi < start.tm_min:
                        continue
                    t = time.mktime((y, mo, d, h, mi, 0, 0, 0, -1))
                    if t > after:
                        return t
        first = False
        d += 1
    return None


def describe(s):
    if "at" in s:
        return "once at " + fmt(s["at"])
    if "every" in s:
        return "every " + human(s["every"])
    return f"cron {s['cron']!r}"


def human(seconds):
    for unit, n in (("d", 86400), ("h", 3600), ("m", 60)):
        if seconds >= n and seconds % n == 0:
            return f"{int(seconds // n)}{unit}"
    return f"{int(seconds // 60)}m"


def fmt(ts):
    return time.strftime("%a %m-%d %H:%M", time.localtime(ts)) if ts else "-"


def next_after(w, after):
    s = w["schedule"]
    if "at" in s:
        t = s["at"] if not w.get("runs") else None
    elif "every" in s:
        t = (w.get("last_run") or w["created"]) + s["every"]
        while t <= after:
            t += s["every"]
    else:
        t = cron_next(s["cron"], after)
    if t and w.get("until") and t > w["until"]:
        return None
    if w.get("times") and w.get("runs", 0) >= w["times"]:
        return None
    return t


# --- used by the bot ------------------------------------------------------------------------------
def due(now=None):
    """Workflows whose time has come (oldest first). A run missed while the bot was down happens
    once, late, rather than once per missed slot."""
    now = now or time.time()
    ws = [w for w in load()["workflows"].values()
          if w.get("enabled", True) and w.get("next_run") and w["next_run"] <= now]
    return sorted(ws, key=lambda w: w["next_run"])


def finish(wid, note, sent, now=None, expected_focus_at=None):
    """Record a run and schedule the next one (or retire the workflow)."""
    now = now or time.time()
    with store() as data:
        w = data["workflows"].get(wid)
        if not w:
            return
        if expected_focus_at is not None and (not w.get("enabled") or w.get("focus_remind_at") != expected_focus_at):
            return  # A newer/closed focus reminder must not be retired by an older running agent.
        w["runs"] = w.get("runs", 0) + 1
        w["last_run"] = now
        w.setdefault("history", []).append({"time": now, "sent": sent, "note": note})
        w["history"] = w["history"][-KEEP_RUNS:]
        w["next_run"] = next_after(w, now)
        if not w["next_run"]:
            w["enabled"] = False
            w["finished"] = now


def log_sent(source, text):
    with open(OUTBOX, "a") as f:
        f.write(json.dumps({"time": time.time(), "source": source, "text": text}) + "\n")


def told(days=7, since=None):
    cutoff = since if since is not None else time.time() - days * 86400
    out = []
    try:
        for line in open(OUTBOX):
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if e["time"] > cutoff:
                out.append(e)
    except OSError:
        pass
    return out


def slug(name, taken):
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:30] or "workflow"
    s, k = base, 2
    while s in taken:
        s, k = f"{base}-{k}", k + 1
    return s


# --- CLI ------------------------------------------------------------------------------------------
def _schedule_from(opts):
    now = time.time()
    if opts.get("at"):
        return {"at": parse_time(opts["at"])}
    if opts.get("in"):
        return {"at": now + parse_duration(opts["in"])}
    if opts.get("every"):
        every = parse_duration(opts["every"])
        if every < 600:
            raise ValueError("--every must be at least 10m")
        return {"every": every}
    if opts.get("cron"):
        cron_next(opts["cron"], now)  # validates
        return {"cron": opts["cron"]}
    return None


def _parse(args, flags=("name", "task", "at", "in", "every", "cron", "until", "times", "days", "timeout")):
    opts, rest = {}, []
    k = 0
    while k < len(args):
        a = args[k]
        if a.startswith("--") and a[2:] in flags and k + 1 < len(args):
            opts[a[2:]] = args[k + 1]
            k += 2
        elif a.startswith("--"):
            opts[a[2:]] = True
            k += 1
        else:
            rest.append(a)
            k += 1
    return opts, rest


def _line(w):
    status = "paused" if not w.get("enabled", True) and not w.get("finished") else \
        "done" if w.get("finished") else "next " + fmt(w.get("next_run"))
    return f"{w['id']}: {w['name']} — {describe(w['schedule'])}, {status}, {w.get('runs', 0)} runs"


def main(argv):
    if not argv:
        print(__doc__)
        return 1
    cmd, (opts, rest) = argv[0], _parse(argv[1:])
    try:
        if cmd == "add":
            task = opts.get("task") or " ".join(rest) or (sys.stdin.read() if not sys.stdin.isatty() else "")
            sched = _schedule_from(opts)
            if not task.strip() or not sched:
                print("need a task and one of --at/--in/--every/--cron")
                return 1
            with store() as data:
                wid = slug(opts.get("name") or task[:30], data["workflows"])
                w = {"id": wid, "name": opts.get("name") or task.strip()[:40], "task": task.strip(),
                     "schedule": sched, "created": time.time(), "runs": 0, "enabled": True,
                     "until": parse_time(opts["until"]) + 86399 if opts.get("until") else None,
                     "times": int(opts["times"]) if opts.get("times") else None, "state": "",
                     "timeout": int(opts["timeout"]) * 60 if opts.get("timeout") else None,
                     "history": []}
                w["next_run"] = next_after(w, time.time())
                data["workflows"][wid] = w
            print("added " + _line(w))
        elif cmd == "list":
            ws = list(load()["workflows"].values())
            ws = [w for w in ws if opts.get("all") or (w.get("enabled", True) and not w.get("finished"))
                  or (not w.get("enabled", True) and not w.get("finished"))]
            print("\n".join(_line(w) for w in sorted(ws, key=lambda w: w.get("next_run") or 9e12))
                  or "no workflows")
        elif cmd == "show":
            w = load()["workflows"].get(rest[0])
            if not w:
                print("no such workflow")
                return 1
            print(_line(w))
            print(f"task: {w['task']}")
            if w.get("until") or w.get("times"):
                print(f"ends: {fmt(w.get('until')) if w.get('until') else ''} "
                      f"{str(w['times']) + ' runs' if w.get('times') else ''}")
            print(f"state: {w.get('state') or '-'}")
            for h in w.get("history", []):
                print(f"  {fmt(h['time'])} {'SENT' if h['sent'] else 'quiet'}: {h.get('note') or ''}")
        elif cmd == "edit":
            with store() as data:
                w = data["workflows"].get(rest[0])
                if not w:
                    print("no such workflow")
                    return 1
                if opts.get("name"):
                    w["name"] = opts["name"]
                if opts.get("task"):
                    w["task"] = opts["task"]
                sched = _schedule_from(opts)
                if sched:
                    w["schedule"], w["runs"], w["finished"], w["enabled"] = sched, 0, None, True
                if opts.get("until"):
                    w["until"] = parse_time(opts["until"]) + 86399
                if opts.get("times"):
                    w["times"] = int(opts["times"])
                if opts.get("timeout"):
                    w["timeout"] = int(opts["timeout"]) * 60
                if sched or opts.get("until") or opts.get("times"):
                    w["next_run"] = next_after(w, time.time())
            print("updated " + _line(w))
        elif cmd in ("pause", "resume", "rm", "run", "state"):
            with store() as data:
                w = data["workflows"].get(rest[0]) if rest else None
                if not w:
                    print("no such workflow")
                    return 1
                if cmd == "pause":
                    w["enabled"] = False
                elif cmd == "resume":
                    w["enabled"], w["finished"] = True, None
                    w["next_run"] = next_after(w, time.time()) or time.time()
                elif cmd == "rm":
                    del data["workflows"][rest[0]]
                elif cmd == "run":
                    w["enabled"], w["next_run"] = True, time.time()
                else:
                    w["state"] = " ".join(rest[1:]) or (sys.stdin.read() if not sys.stdin.isatty() else "")
            print("removed" if cmd == "rm" else _line(w) if cmd != "state" else "state saved")
        elif cmd == "told":
            for e in told(float(opts.get("days", 7))):
                print(f"{fmt(e['time'])} [{e['source']}] {' '.join(e['text'].split())[:400]}")
        else:
            print(__doc__)
            return 1
    except ValueError as e:
        print("error:", e)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
