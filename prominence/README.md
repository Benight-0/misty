# prominence-chan

A Discord group-chat bot driven by the [Claude Code](https://claude.com/claude-code) and Codex CLIs.
It plays "Fable 6.7", a made-up model with a deadpan dry-texter persona (or, after `/toggle`, a
bubbly anime-girl one), and lives in one main channel of a friend-group server.

- **Chat**: a cheap Codex model gates every new message (reply or stay quiet); Claude writes the
  replies. Pings and messages starting with `!` always get an answer. It can react with emoji,
  set its own custom status, show fake "Playing"/"Listening" activities, and remember older chat
  through a local search index.
- **Fake slash commands**: `/help`, `/model`, ... are parodied Claude Code output. Real ones:
  `/imitate <user>` (talks as that person, learned from their messages), `/reset`, `/toggle`,
  `/clear`, `/logout` / `/login`, and `/admin`, `/op`, `/unop` for standing admin instructions.
- **Owner work mode**: the owner (the Discord user in `owner_id`) gets a full Claude Code agent,
  in DMs and when they ask for real work with `!` in the server. It has scheduled workflows
  (`workflows.py`), long-term memory and a search index over local docs and past Claude Code /
  Codex sessions (`context.py`), can text the owner mid-task (`dm.py`), read the server
  (`discord_read.py`), react (`discord_react.py`) and moderate on request (`mod.py`).
- **Guest work mode**: in the channels listed in `guest_channel_ids`, anyone's `!` request gets a
  web-only agent (WebSearch/WebFetch, nothing else), rate-limited.
- **DMs**: anyone can DM it for a one-on-one chat in the current persona (no tools).
- **Self-updating**: the owner's agent may edit its own code with `selfupdate.py` (snapshot,
  check, changelog, queued restart); `supervise.py` restarts it and rolls back to the snapshot if
  the new code dies within 10 minutes.

> **Warning:** owner work mode runs `claude -p --permission-mode bypassPermissions` in your home
> directory. The model gets **full, unsupervised access to the host machine**: any command, any
> file, your logged-in CLIs. Only the account in `owner_id` can trigger it, but anyone who controls
> that Discord account (or the bot token) controls your machine. Run it on a machine or user
> account you're comfortable handing over, and keep the token secret.

## Requirements

- macOS (image handling uses `sips`, doc indexing uses `textutil`; `tools/mouse.py` needs Quartz)
- Python 3.10+ with `websockets` (`pip install -r requirements.txt`)
- The `claude` CLI, logged in
- The `codex` CLI, logged in, with access to the gate model (default `gpt-6-luna`)
- Optional: `pyflakes` (used by `selfupdate.py check`)

## Setup

1. Create a bot at <https://discord.com/developers/applications>, enable the **Message Content**
   and **Server Members** intents, and invite it to your server with permission to read and send
   messages, add reactions, manage nicknames (for `/imitate`), manage channel permissions (the
   short mute during `/imitate`) and, if you want the moderation features, moderate members.
2. `cp config.example.json config.json` and fill it in (Discord developer mode gives you ids
   with right click > Copy ID):

   | key | meaning |
   | --- | --- |
   | `token` | bot token (or set `DISCORD_TOKEN`) |
   | `owner_id` | your Discord user id: the only account with work mode, `/op` and `/unop` |
   | `main_channel_id` | the channel the bot lives in (called "#general" in its prompts) |
   | `guest_channel_ids` | channels where anyone's `!` request gets web-only work mode |
   | `name`, `anime_name` | the bot's server nickname in each persona |
   | `claude_bin`, `claude_model` | path to the Claude Code CLI and the model it uses |
   | `codex_bin`, `gate_model` | path to the Codex CLI and the cheap gate model |
   | `data_dir` | where state, logs and the index db go (default: this folder) |
   | `doc_roots`, `project_roots` | folders `context.py` indexes for docs and projects |

   Any key can also be set as an environment variable `PROMINENCE_<KEY>` (lists comma-separated),
   and `PROMINENCE_CONFIG` points to a different config file.
3. Start it under the supervisor (it restarts the bot after self-updates and crashes):

   ```sh
   pip install -r requirements.txt
   QUIET_BOOT=1 nohup python3 supervise.py >> bot.log 2>&1 &
   ```

   `python3 bot.py` runs it directly, without restarts. Leave out `QUIET_BOOT=1` to post a boot
   banner in the main channel.

In the owner's DM, `/stop` kills the running agent, `/new` starts fresh agent sessions and
`/workflows` lists scheduled workflows. Messages starting with `?` are invisible to the bot.

## License

MIT
