"""Keeps bot.py running, and makes self-updates safe.

  QUIET_BOOT=1 nohup nice python3 supervise.py >> bot.log 2>&1 &

- bot.py exits with code 75 when it restarts itself (selfupdate.py restart): start it again right away.
- If it dies within TRIAL_SECONDS of such a restart, the update broke it: put the snapshot taken
  before the update back, tell the owner, and start again.
- Any other crash: start again after a pause, but give up (and say so) if it keeps crashing.
- A clean exit (0, e.g. someone killed bot.py on purpose) or SIGTERM to this process stops both.
"""
import json, os, shutil, signal, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import config  # noqa: E402

TRIAL_FILE = config.data("restart_trial.json")  # written by bot.py as it exits for an update
RESTART_CODE = 75
TRIAL_SECONDS = 10 * 60
CRASH_LIMIT = (5, 30 * 60)  # this many unexpected crashes within this many seconds: give up

child = None


def log(text):
    print(f"supervisor {time.strftime('%m-%d %H:%M:%S')}: {text}", flush=True)


def tell(text):
    try:
        import dm
        dm.send(text)
    except Exception as e:
        log(f"couldn't DM the owner: {e!r}")


def rollback(trial):
    snap = trial.get("snapshot")
    if not snap or not os.path.isdir(snap):
        return False
    for name in os.listdir(snap):
        if name.endswith(".py"):
            shutil.copy2(os.path.join(snap, name), os.path.join(HERE, name))
    return True


def stop(signum, frame):
    if child and child.poll() is None:
        child.send_signal(signal.SIGTERM)
        try:
            child.wait(15)
        except subprocess.TimeoutExpired:
            child.kill()
    sys.exit(0)


def main():
    global child
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    crashes = []
    env = {**os.environ, "PROMINENCE_SUPERVISED": "1"}
    while True:
        started = time.time()
        log("starting bot.py")
        child = subprocess.Popen([sys.executable, os.path.join(HERE, "bot.py")], cwd=HERE, env=env)
        try:
            code = child.wait(TRIAL_SECONDS)
        except subprocess.TimeoutExpired:
            if os.path.exists(TRIAL_FILE):  # survived the trial period: the update is good
                os.remove(TRIAL_FILE)
                log("update passed its trial period")
            code = child.wait()
        lived = time.time() - started
        try:
            with open(TRIAL_FILE) as f:
                trial = json.load(f)
        except (OSError, ValueError):
            trial = None
        if code == RESTART_CODE:
            log(f"bot.py restarting for an update: {(trial or {}).get('why', '?')}")
            continue
        if trial and lived < TRIAL_SECONDS:
            # it died during the trial period after an update: undo the update
            os.remove(TRIAL_FILE)
            if rollback(trial):
                log(f"bot.py died {lived:.0f}s after an update (exit {code}); rolled back to {trial['snapshot']}")
                tell(f"my update broke me (\"{trial.get('why', '')}\"), so i rolled myself back. "
                     "details in bot.log")
                continue
        if code == 0:
            log("bot.py exited cleanly; stopping")
            return
        now = time.time()
        crashes = [t for t in crashes if now - t < CRASH_LIMIT[1]] + [now]
        if len(crashes) >= CRASH_LIMIT[0]:
            log(f"bot.py crashed {len(crashes)} times in {CRASH_LIMIT[1] // 60} min; giving up")
            tell("i keep crashing so i stopped trying to restart. check bot.log when you can")
            return
        log(f"bot.py crashed (exit {code}) after {lived:.0f}s; restarting in 10s")
        time.sleep(10)


if __name__ == "__main__":
    main()
