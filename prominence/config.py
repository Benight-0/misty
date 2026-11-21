"""Settings shared by bot.py and its helper scripts.

Read from config.json next to this file (or the file named by PROMINENCE_CONFIG); an environment
variable PROMINENCE_<KEY> (e.g. PROMINENCE_OWNER_ID) overrides any key. The bot token comes from
DISCORD_TOKEN, else "token" in config.json, else a token.txt in the data dir. See
config.example.json for every key. Importing this module never touches the network.
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.environ.get("PROMINENCE_CONFIG") or os.path.join(HERE, "config.json")

try:
    with open(CONFIG_FILE) as _f:
        _cfg = json.load(_f)
except FileNotFoundError:
    _cfg = {}
except ValueError as _e:
    sys.exit(f"{CONFIG_FILE} isn't valid JSON: {_e}")


def get(key, default=None):
    """config.json's `key`, overridden by the environment variable PROMINENCE_<KEY>."""
    env = os.environ.get("PROMINENCE_" + key.upper())
    if env is not None and env != "":
        return env
    value = _cfg.get(key)
    return default if value in (None, "") else value


def get_list(key, default=()):
    """A list setting: a JSON list in config.json, or comma-separated in the env var."""
    value = get(key, list(default))
    if isinstance(value, str):
        value = value.split(",")
    return [str(v).strip() for v in value if str(v).strip()]


def enabled(key, default=False):
    value = get(key, default)
    return value is True or isinstance(value, str) and value.lower() in ('1', 'true', 'on', 'yes')


DATA_DIR = os.path.abspath(os.path.expanduser(get("data_dir") or HERE))  # state, logs, the index db


def data(name):
    """Path of a state file in the data dir (created on first use)."""
    os.makedirs(DATA_DIR, exist_ok=True)
    return os.path.join(DATA_DIR, name)


OWNER_ID = str(get("owner_id", ""))              # the Discord user who runs the bot (full work mode)


def owner_ids():
    """Canonical owner plus explicitly configured Discord account aliases."""
    aliases = get_list('owner_alias_ids')
    if any(not value.isascii() or not value.isdigit() or not 16 <= len(value) <= 22 for value in aliases):
        raise ValueError('owner_alias_ids must contain numeric Discord user IDs')
    return tuple(dict.fromkeys([OWNER_ID, *aliases]))


def is_owner(user_id):
    return bool(user_id) and str(user_id) in owner_ids()


def current_owner():
    """Direct replies follow the authenticated owner turn; workflows keep the primary DM."""
    if os.environ.get('PROMINENCE_SOURCE') in ('specialist', 'supervisor') and os.environ.get('MISTY_AGENT_TASK_ID'):
        import agent_tasks
        task = agent_tasks.active_from_environment()
        return task['owner_id'] if task['origin'] == 'owner' else OWNER_ID
    value = os.environ.get('MISTY_OWNER_ACCOUNT_ID', '')
    if os.environ.get('PROMINENCE_SOURCE') == 'owner' and value:
        if value == '__active__':
            from conversation import owner_run_info
            return owner_run_info(os.environ.get('MISTY_CONVERSATION_RUN', ''))['owner']
        if not is_owner(value):
            raise ValueError('Unrecognized owner account context')
        return value
    return OWNER_ID

MAIN_CHANNEL = str(get("main_channel_id", ""))   # the group chat the bot lives in ("#general" in prompts)
GUEST_CHANNELS = set(get_list("guest_channel_ids"))  # where anyone's "!" request gets web-only work mode
NAMES = {"dry texter": get("name", "prominence-chan"),      # server nickname per persona
         "anime girl": get("anime_name", "athena-chan")}
CLAUDE = os.path.expanduser(get("claude_bin", "claude"))
CLAUDE_MODEL = get("claude_model", "opus")
GATE_MODEL = get("gate_model", "gpt-6-luna")     # cheap model (via the Codex CLI) for yes/no decisions
# GPT-6 models are only served to recent Codex clients; an old npm `codex` on PATH may be refused,
# so prefer the copy bundled with the ChatGPT desktop app when it's there
_APP_CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"
CODEX = os.path.expanduser(get("codex_bin") or (_APP_CODEX if os.path.exists(_APP_CODEX) else "codex"))
DOC_ROOTS = [os.path.expanduser(p) for p in get_list("doc_roots", ["~/Desktop", "~/Documents"])]
PROJECT_ROOTS = [os.path.expanduser(p) for p in get_list("project_roots", ["~/Desktop/Development", "~/dev"])]


def token():
    """The bot token; exits with a clear message if there isn't one."""
    credential = get("token_file")
    tok = open(credential).read().strip() if credential else os.environ.get("DISCORD_TOKEN") or _cfg.get("token")
    if not tok:
        for path in (data("token.txt"), os.path.join(HERE, "token.txt")):
            if os.path.exists(path):
                tok = open(path).read().strip()
                break
    if not tok:
        sys.exit("no Discord bot token: set DISCORD_TOKEN, or \"token\" in config.json "
                 "(copy config.example.json to config.json)")
    return tok.strip()


def require(*keys):
    """Exit with a clear message unless these settings are present (for bot.py and the scripts)."""
    missing = [k for k in keys if not get(k)]
    if missing:
        sys.exit(f"missing setting(s): {', '.join(missing)}. Put them in {CONFIG_FILE} (copy "
                 "config.example.json) or set PROMINENCE_<KEY> environment variables")

# Misty fork: the upstream Claude agent can still be selected explicitly.
AGENT_BACKEND = get("agent_backend", "codex")
DM_ONLY = str(get("dm_only", "true")).lower() in ("true", "1", "yes")
OWNER_ONLY = str(get("owner_only", "true")).lower() in ("true", "1", "yes")
if AGENT_BACKEND == "codex":
    CLAUDE_MODEL = get("agent_model", "gpt-6.1-sol")
    GATE_MODEL = get("gate_model", "gpt-5.6-luna")
