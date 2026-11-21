"""Scoped VM install for Misty's native desktop bridge. Run as root on the VM."""
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import sys
import time
import urllib.request


STAGE = Path(sys.argv[1]).resolve()
FORK = Path("/opt/misty-prominence")
BOT = Path("/opt/misty-bot")
STATE = Path("/var/lib/misty-prominence")
TARGETS = {
    FORK / "bot.py": STAGE / "prominence/bot.py",
    FORK / "overlay.py": STAGE / "prominence/overlay.py",
    FORK / "overlay_agent.py": STAGE / "prominence/overlay_agent.py",
    BOT / "app/misty-prominence-bridge.mjs": STAGE / "app/misty-prominence-bridge.mjs",
}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, capture_output=True, **kwargs)


def fork(*args):
    return run("runuser", "-u", "misty-bot", "--", "env",
               "PROMINENCE_CONFIG=/etc/misty-prominence/config.json",
               str(FORK / "venv/bin/python"), *args)


def bridge_status():
    token = Path("/etc/misty-bot/prominence-token").read_text().strip()
    request = urllib.request.Request(
        "http://127.0.0.1:8792/call", data=b'{"op":"status"}',
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.load(response)


if os.geteuid() != 0:
    raise SystemExit("Run with VM maintenance root access")
manifest = json.loads((STAGE / "manifest.json").read_text(encoding="utf-8-sig"))
if set(manifest["baseline"]) != {str(path) for path in TARGETS} or set(manifest["source"]) != {str(path) for path in TARGETS}:
    raise RuntimeError("Unexpected target manifest")
for destination, source in TARGETS.items():
    if digest(destination) != manifest["baseline"][str(destination)]:
        raise RuntimeError("Live file changed; inspect before deploying: " + str(destination))
    if digest(source) != manifest["source"][str(destination)]:
        raise RuntimeError("Staged file differs from canonical: " + str(source))
if (STATE / "restart_request.json").exists():
    raise RuntimeError("A Misty restart is already pending")
with __import__("sqlite3").connect("file:" + str(STATE / "inbox.sqlite") + "?mode=ro", uri=True) as db:
    active = db.execute("SELECT count(*) FROM conversation_runs WHERE state='running'").fetchone()[0]
if active:
    raise RuntimeError("An owner conversation is active; retry after it finishes")
run(str(BOT / "bin/node"), "--check", str(STAGE / "app/misty-prominence-bridge.mjs"))
for name in ("bot.py", "overlay.py", "overlay_agent.py"):
    run(str(FORK / "venv/bin/python"), "-m", "py_compile", str(STAGE / "prominence" / name))
run("runuser", "-u", "misty-bot", "--", "env",
    "PROMINENCE_CONFIG=/etc/misty-prominence/config.json",
    "PYTHONPATH=/opt/misty-prominence",
    str(FORK / "venv/bin/python"), "-m", "unittest", "-q", "test_overlay",
    cwd=str(STAGE / "prominence"))

stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
backup_dir = Path("/var/backups/misty") / ("overlay-before-" + stamp)
backup_dir.mkdir(parents=True, mode=0o700)
for destination in TARGETS:
    if destination.exists():
        saved = backup_dir / str(destination).lstrip("/")
        saved.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(destination, saved)

# Match the fork's supported snapshot format without pruning any older snapshot.
user = pwd.getpwnam("misty-bot")
snapshot = STATE / "versions" / time.strftime("%Y%m%d-%H%M%S", time.gmtime())
snapshot.mkdir(parents=True, mode=0o700)
os.chown(snapshot, user.pw_uid, user.pw_gid)
for source in FORK.glob("*.py"):
    target = snapshot / source.name
    shutil.copy2(source, target)
    os.chown(target, user.pw_uid, user.pw_gid)
(snapshot / "WHY.txt").write_text("Native Misty desktop overlay bridge\n")
os.chown(snapshot / "WHY.txt", user.pw_uid, user.pw_gid)

installed = []
try:
    for destination, source in TARGETS.items():
        temp = destination.with_name(destination.name + ".overlay-new")
        shutil.copy2(source, temp)
        if destination.is_relative_to(FORK):
            os.chown(temp, user.pw_uid, user.pw_gid)
            temp.chmod(0o640)
        else:
            temp.chmod(0o644)
        os.replace(temp, destination)
        installed.append(destination)
    if fork(str(FORK / "selfupdate.py"), "check").stdout.strip() != "ok":
        raise RuntimeError("Fork self-check failed")
    run("systemctl", "restart", "misty-bot.service")
    for attempt in range(20):
        try:
            bridge_status()
            break
        except OSError:
            if attempt == 19:
                raise
            time.sleep(1)
    restart = fork(str(FORK / "selfupdate.py"), "restart", "Native desktop overlay bridge")
except Exception:
    for destination in reversed(installed):
        old = backup_dir / str(destination).lstrip("/")
        if old.exists():
            shutil.copy2(old, destination)
        else:
            destination.unlink(missing_ok=True)
    subprocess.run(("systemctl", "restart", "misty-bot.service"), check=False)
    raise

receipt = {"at": stamp, "backup": str(backup_dir), "snapshot": str(snapshot),
           "targets": {str(path): digest(path) for path in TARGETS},
           "mistyBot": run("systemctl", "is-active", "misty-bot.service").stdout.strip(),
           "forkRestart": restart.stdout.strip()}
(backup_dir / "deployment-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps(receipt))
