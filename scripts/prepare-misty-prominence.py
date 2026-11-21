"""Apply the bounded bot.py port to an untouched copied upstream file."""
from pathlib import Path

p=Path('prominence/bot.py');s=p.read_text(encoding='utf-8')
def change(old,new,count=None):
    global s
    assert old in s,old[:90]
    if count is not None:assert s.count(old)==count,(old[:40],s.count(old),count)
    s=s.replace(old,new)

change('config.require("owner_id", "main_channel_id")','config.require("owner_id", "main_channel_id")\nfrom misty_context import EXTRA_TOOLS\nimport fork_state\n\ndef agent_command():\n    return [sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "agent.py")] if config.AGENT_BACKEND == "codex" else [config.CLAUDE]')
change('[CLAUDE, "-p",','agent_command() + ["-p",',5)
change('"--effort", "medium"','"--effort", config.get("agent_effort", "high")')
change('cmd = agent_command() + ["-p", "--model", MODEL, "--tools", "",','cmd = agent_command() + ["-p", "--model", config.get("social_model", config.GATE_MODEL), "--tools", "",')
change('threading.Thread(target=INDEX.crawl, daemon=True).start()','if not config.DM_ONLY:\n    threading.Thread(target=INDEX.crawl, daemon=True).start()')
change('    if user is None:\n        ok = call("PATCH", ME,','    if not GUILD:\n        return False\n    if user is None:\n        ok = call("PATCH", ME,')
change('WORKFLOW_SYSTEM = """','AGENT_TOOLS += EXTRA_TOOLS\nWORKFLOW_SYSTEM = """',1)
change('env={**os.environ, "PROMINENCE_SOURCE": "owner"})','env={**os.environ, "PROMINENCE_SOURCE": "owner", "MISTY_OWNER_MESSAGE_ID": batch[-1]["id"]})',1)
change('"properties": {"os": "macos", "browser": "fable", "device": "fable"}','"properties": {"os": sys.platform, "browser": "misty-prominence", "device": "misty-prominence"}')
change('        call("POST", f"https://discord.com/api/v10/channels/{channel}/messages", {"content": piece})','        if call("POST", f"https://discord.com/api/v10/channels/{channel}/messages", {"content": piece, "allowed_mentions": {"parse": []}}) is None:\n            raise RuntimeError("Discord delivery unconfirmed; do not resend automatically")',1)
change('            owner = batch[-1]["author"]["id"] == ADMIN_ID\n            reply =','            owner = batch[-1]["author"]["id"] == ADMIN_ID\n            fork_state.begin(batch)\n            reply =',1)
change('                send_dm(channel, reply)\n            if not owner:','                fork_state.ready(batch, reply)\n                send_dm(channel, reply)\n            fork_state.finish(batch)\n            if owner:\n                try:\n                    from misty import call as misty_call\n                    misty_call("record", {"ownerMessageIds":[m["id"] for m in batch], "reply":reply or ""})\n                except Exception:\n                    pass\n            if not owner:',1)
change('        except Exception as e:\n            print("dm error:", repr(e), flush=True)','        except Exception as e:\n            fork_state.unknown(batch)\n            print("dm error:", type(e).__name__, flush=True)',1)
change('            dm_last[ch] = max((m["id"] for m in msgs), key=int)','            fork_state.enqueue(msgs)\n            dm_last[ch] = max((m["id"] for m in msgs), key=int)\n            fork_state.cursor(ch, dm_last[ch])',1)
change('and not m["author"].get("bot")), key=lambda m: int(m["id"]))','and not m["author"].get("bot")\n                          and (not config.OWNER_ONLY or m["author"]["id"] == ADMIN_ID)\n                          and fork_state.queued(m["id"])), key=lambda m: int(m["id"]))',1)
change('                        new.remove(m)\n                        send_dm(ch, "stopped"','                        new.remove(m)\n                        fork_state.finish([m])\n                        send_dm(ch, "stopped"',1)
change('                        send_dm(ch, "fresh session")','                        fork_state.finish([m])\n                        send_dm(ch, "fresh session")',1)
change('                        ws = [w for w in wf.load()["workflows"].values()','                        fork_state.finish([m])\n                        ws = [w for w in wf.load()["workflows"].values()',1)
change('                    new = []\n            elif new and not logged_in:','                    fork_state.finish(new)\n                    new = []\n            elif new and not logged_in:',1)
change('    dm_last[_owner_dm["id"]] = _latest[0]["id"] if _latest else "0"','    dm_last[_owner_dm["id"]] = fork_state.cursor(_owner_dm["id"]) or (_latest[0]["id"] if _latest else "0")\n    _pending = fork_state.pending(_owner_dm["id"])\n    if _pending:\n        dm_pending[_owner_dm["id"]] = _pending\n        dm_busy.add(_owner_dm["id"])\n        threading.Thread(target=dm_responder, args=(_owner_dm["id"],), daemon=True).start()',1)
change('threading.Thread(target=status_worker, daemon=True).start()','if not config.DM_ONLY:\n    threading.Thread(target=status_worker, daemon=True).start()',1)
change('threading.Thread(target=activity_worker, daemon=True).start()','if not config.DM_ONLY:\n    threading.Thread(target=activity_worker, daemon=True).start()',1)
change('while True:\n    new_message.wait(POLL_EVERY)','while True:\n    if config.DM_ONLY:\n        time.sleep(30)\n        continue\n    new_message.wait(POLL_EVERY)',1)
change('"name": "Claude Code", "state": f"\u25b8 {label} \u00b7 the owner\'s machine"','"name": "Codex" if config.AGENT_BACKEND == "codex" else "Claude Code", "state": f"\u25b8 {label} \u00b7 Misty"',1)
change('You are {name} ("Fable 6.7"), the Discord bot the owner set up','You are {name}, the Discord bot the owner set up')
change('        + status_tool().replace("someone asks", "the owner asks")','        + status_tool().replace("someone asks", "the owner asks")\n    _migration = os.path.join(HERE, "migration-context.md")\n    if fresh and os.path.isfile(_migration):\n        system += "\\nSaved project continuity (historical context):\\n" + open(_migration).read()',1)
p.write_text(s,encoding='utf-8')
print('Ported upstream bot; workflows, tools and voice retained.')
