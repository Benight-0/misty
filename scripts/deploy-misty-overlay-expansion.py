"""Deploy only the overlay transcript/activity endpoint and Codex dispatch sources.

Run as root on the paired VM with a staged manifest. No database is replaced.
"""
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import sqlite3
import socket
import subprocess
import sys
import time


STAGE = Path(sys.argv[1]).resolve()
FORK = Path("/opt/misty-prominence")
BOT = Path("/opt/misty-bot")
STATE = Path("/var/lib/misty-prominence")
SOURCES = {
    FORK / "overlay.py": STAGE / "prominence/overlay.py",
    BOT / "app/misty-direct.mjs": STAGE / "app/misty-direct.mjs",
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


if os.geteuid() != 0:
    raise SystemExit("VM maintenance root access is required")
manifest = json.loads((STAGE / "manifest.json").read_text(encoding="utf-8-sig"))
selected = set(manifest["baseline"])
if not selected or selected != set(manifest["source"]) or not selected <= {str(path) for path in SOURCES}:
    raise RuntimeError("Unexpected scoped manifest")
targets = {destination: source for destination, source in SOURCES.items() if str(destination) in selected}
fork_changed = any(destination.is_relative_to(FORK) for destination in targets)
bot_changed = any(destination.is_relative_to(BOT) for destination in targets)
run("chgrp", "-R", "misty-bot", str(STAGE))
run("chmod", "-R", "g+rX,o-rwx", str(STAGE))
for destination, source in targets.items():
    if digest(destination) != manifest["baseline"][str(destination)]:
        raise RuntimeError("Live file changed: " + str(destination))
    if digest(source) != manifest["source"][str(destination)]:
        raise RuntimeError("Staged source changed: " + str(source))
if (STATE / "restart_request.json").exists():
    raise RuntimeError("Another Misty restart is pending")
with sqlite3.connect("file:" + str(STATE / "inbox.sqlite") + "?mode=ro", uri=True) as db:
    if db.execute("SELECT count(*) FROM conversation_runs WHERE state='running'").fetchone()[0]:
        raise RuntimeError("An owner conversation is running")
if fork_changed:
    run(str(FORK / "venv/bin/python"), "-m", "py_compile", str(STAGE / "prominence/overlay.py"))
for name in ("misty-direct.mjs", "misty-prominence-bridge.mjs"):
    if BOT / "app" / name in targets:
        run(str(BOT / "bin/node"), "--check", str(STAGE / "app" / name))
if fork_changed:
    run("runuser", "-u", "misty-bot", "--", "env",
        "PROMINENCE_CONFIG=/etc/misty-prominence/config.json",
        "PYTHONPATH=/opt/misty-prominence",
        str(FORK / "venv/bin/python"), "-m", "unittest", "-q", "test_overlay",
        cwd=str(STAGE / "prominence"))

stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
backup = Path("/var/backups/misty") / ("overlay-expansion-before-" + stamp)
backup.mkdir(parents=True, mode=0o700)
for destination in targets:
    saved = backup / str(destination).lstrip("/")
    saved.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(destination, saved)

user = pwd.getpwnam("misty-bot")
snapshot = None
if fork_changed:
    snapshot = STATE / "versions" / time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    snapshot.mkdir(parents=True, mode=0o700)
    os.chown(snapshot, user.pw_uid, user.pw_gid)
    for source in FORK.glob("*.py"):
        target = snapshot / source.name
        shutil.copy2(source, target)
        os.chown(target, user.pw_uid, user.pw_gid)
    (snapshot / "WHY.txt").write_text("Native overlay Codex transcripts, activity and status metrics\n")
    os.chown(snapshot / "WHY.txt", user.pw_uid, user.pw_gid)

installed = []
try:
    for destination, source in targets.items():
        temporary = destination.with_name(destination.name + ".overlay-expansion-new")
        shutil.copy2(source, temporary)
        if destination.is_relative_to(FORK):
            os.chown(temporary, user.pw_uid, user.pw_gid)
            temporary.chmod(0o640)
        else:
            temporary.chmod(0o644)
        os.replace(temporary, destination)
        installed.append(destination)
    if fork_changed and fork(str(FORK / "selfupdate.py"), "check").stdout.strip() != "ok":
        raise RuntimeError("Misty fork self-check failed")
    if bot_changed:
        run("systemctl", "restart", "misty-bot.service")
    if fork_changed:
        socket_path = STATE / "overlay.sock"
        previous_socket = ((socket_path.stat().st_ino, socket_path.stat().st_ctime_ns)
                           if socket_path.exists() else None)
        fork(str(FORK / "selfupdate.py"), "restart", "Native overlay Codex and activity update")
    for attempt in range(30):
        if all(run("systemctl", "is-active", name + ".service").stdout.strip() == "active"
               for name in ("misty-bot", "misty-prominence")):
            break
        time.sleep(1)
    else:
        raise RuntimeError("Misty services did not become active")
    if fork_changed:
        for attempt in range(45):
            try:
                current_socket = (socket_path.stat().st_ino, socket_path.stat().st_ctime_ns)
                if current_socket == previous_socket:
                    raise OSError("Waiting for the new overlay socket")
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                    client.settimeout(2)
                    client.connect(str(socket_path))
                    break
            except OSError:
                if attempt == 44:
                    raise RuntimeError("Misty overlay socket did not become ready")
                time.sleep(1)
    if any(digest(destination) != manifest["source"][str(destination)] for destination in targets):
        raise RuntimeError("Deployed source digest mismatch")
except Exception:
    for destination in reversed(installed):
        shutil.copy2(backup / str(destination).lstrip("/"), destination)
    if bot_changed:
        subprocess.run(("systemctl", "restart", "misty-bot.service"), check=False)
    if fork_changed:
        try:
            fork(str(FORK / "selfupdate.py"), "restart", "Rollback overlay expansion")
        except Exception:
            pass
    raise

receipt = {"at": stamp, "backup": str(backup), "snapshot": str(snapshot) if snapshot else None,
           "targets": {str(path): digest(path) for path in targets},
           "mistyBot": run("systemctl", "is-active", "misty-bot.service").stdout.strip(),
           "mistyFork": run("systemctl", "is-active", "misty-prominence.service").stdout.strip()}
(backup / "deployment-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps(receipt))
