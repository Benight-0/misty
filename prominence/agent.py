"""Codex backend for the fork; accepts the small Claude CLI subset used by bot.py.

Preserves upstream session aliases and streamed progress. Native Codex sessions
live in the fork's CODEX_HOME, separate from the laptop's existing conversations.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import uuid

import config
import usage_metrics
import activity


def command(options, session=None):
    full = options.permission_mode == 'bypassPermissions' and options.tools is None
    cmd = [config.CODEX, 'exec', '--ignore-user-config', '--skip-git-repo-check',
           '--json', '--color', 'never', '-m', options.model or config.CLAUDE_MODEL,
           '-c', 'model_reasoning_effort=' + json.dumps(options.effort),
           '-c', 'web_search=' + json.dumps('live' if full or options.tools else 'disabled')]
    if options.append_system_prompt:
        cmd += ['-c', 'developer_instructions=' + json.dumps(options.append_system_prompt)]
    if full:
        cmd += ['--dangerously-bypass-approvals-and-sandbox']
        # Tools belong to this same owner agent, not a new Cline/delegated model.
        # Workflows/guest/social runs never receive the laptop MCP server.
        if os.environ.get('PROMINENCE_SOURCE') == 'owner' and config.get('laptop_tools_enabled', False):
            cmd += ['-c', 'mcp_servers.misty_laptop.command=' + json.dumps(sys.executable),
                    '-c', 'mcp_servers.misty_laptop.args=' + json.dumps([str(Path(__file__).with_name('laptop_tools.py'))]),
                    '-c', 'mcp_servers.misty_laptop.env_vars=' + json.dumps(['PROMINENCE_SOURCE', 'MISTY_OWNER_MESSAGE_ID', 'PROMINENCE_CONFIG']),
                    '-c', 'mcp_servers.misty_laptop.tool_timeout_sec=70']
    else:
        # Guest/social runs have no shell, local image reader, plugins or MCP.
        cmd += ['--sandbox', 'read-only', '-c', 'features.shell_tool=false',
                '-c', 'features.unified_exec=false', '-c', 'features.view_image=false',
                '-c', 'features.plugins=false']
    if options.no_session_persistence and not session:
        cmd += ['--ephemeral']
    if session:
        cmd += ['resume', session]
    return cmd


def options(argv):
    p = argparse.ArgumentParser()
    p.add_argument('-p', action='store_true')
    p.add_argument('--model', default=config.CLAUDE_MODEL)
    p.add_argument('--effort', default='high')
    p.add_argument('--permission-mode')
    p.add_argument('--tools', default=None)
    p.add_argument('--append-system-prompt', default='')
    p.add_argument('--session-id')
    p.add_argument('--resume')
    p.add_argument('--output-format')
    p.add_argument('--input-format')
    p.add_argument('--no-session-persistence', action='store_true')
    p.add_argument('--strict-mcp-config', action='store_true')
    p.add_argument('--disable-slash-commands', action='store_true')
    p.add_argument('--no-chrome', action='store_true')
    p.add_argument('--verbose', action='store_true')
    return p.parse_args(argv)


def main(argv):
    args = options(argv)
    alias = args.resume or args.session_id
    if alias and not re.fullmatch(r'[a-fA-F0-9-]{36}', alias):
        raise ValueError('Invalid session alias')
    mapping = Path(config.data('agent_sessions'))
    mapping.mkdir(exist_ok=True)
    state = mapping / (alias + '.json') if alias else None
    sid = json.loads(state.read_text())['thread'] if args.resume and state and state.exists() else None
    if args.resume and not sid:
        print('The saved conversation is unavailable.', file=sys.stderr)
        return 1
    prompt = sys.stdin.read()
    if os.environ.get('PROMINENCE_SOURCE') == 'owner' and os.environ.get('MISTY_CONVERSATION_RUN'):
        import owner_loop
        return owner_loop.execute(args, sid, prompt, state)
    with tempfile.TemporaryDirectory(prefix='misty-agent-') as temp:
        image_paths = []
        if args.input_format == 'stream-json':
            content = json.loads(prompt)['message']['content']
            prompt = '\n'.join(c['text'] for c in content if c['type'] == 'text')
            for i, c in enumerate(content):
                if c['type'] == 'image':
                    img = Path(temp) / (str(i) + '.jpg')
                    img.write_bytes(base64.b64decode(c['source']['data'], validate=True))
                    image_paths.append(str(img))
        output = Path(temp) / 'answer.txt'
        cmd = command(args, sid) + ['--output-last-message', str(output)]
        cmd += [x for image in image_paths for x in ('-i', image)] + ['-']
        # Parent and Codex share the upstream task's process group. /stop and the
        # task watchdog terminate the whole task, not just this translator.
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, text=True, encoding='utf-8')
        def stop(signum, frame):
            proc.terminate()
            raise SystemExit(128 + signum)
        signal.signal(signal.SIGTERM, stop)
        try:
            proc.stdin.write(prompt)
            proc.stdin.close()
            answer = ''
            metrics_run, metrics_turn = uuid.uuid4().hex, 0
            for line in proc.stdout:
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if args.no_session_persistence and event.get('type') == 'turn.completed':
                    metrics_turn += 1
                    usage_metrics.record(metrics_run + ':' + str(metrics_turn), args.model, event.get('usage'))
                if event.get('type') == 'thread.started' and state:
                    actual = event.get('thread_id')
                    if not isinstance(actual, str) or not re.fullmatch(r'[a-fA-F0-9-]{36}', actual):
                        raise ValueError('Invalid backend session receipt')
                    tmp = state.with_suffix('.tmp')
                    tmp.write_text(json.dumps({'thread': actual}))
                    tmp.replace(state)
                item = event.get('item') or {}
                if args.output_format == 'stream-json':
                    if event.get('type') == 'item.started':
                        print(json.dumps({'type':'activity','label':activity.label(item)}), flush=True)
                    elif event.get('type') == 'item.completed' or event.get('type') == 'turn.started':
                        print(json.dumps({'type':'activity','label':'thinking'}), flush=True)
                if item.get('type') == 'agent_message':
                    answer = item.get('text', '')
            code = proc.wait()
            if output.exists():
                answer = output.read_text(encoding='utf-8').strip()
            if code:
                print('Codex agent failed; no successful completion was confirmed.', file=sys.stderr)
                return code
            if args.output_format == 'stream-json':
                print(json.dumps({'type':'result','result':answer}), flush=True)
            else:
                print(answer, flush=True)
            return 0
        finally:
            if proc.poll() is None:
                proc.terminate()


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
