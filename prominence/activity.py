"""Map actual Codex events to fixed, public-safe Discord activity labels."""
import re

LABELS = {'thinking', 'searching the database', 'searching the web', 'reading files',
          'reading Codex history', 'talking to Codex', 'running commands', 'editing files',
          'waiting for Codex', 'waiting for the laptop', 'waiting for a new message',
          'checking Gmail', 'checking current tasks', 'sending an update'}


def label(item):
    kind = item.get('type', '')
    kind = {'commandExecution':'command_execution','fileChange':'file_change',
            'mcpToolCall':'mcp_tool_call','webSearch':'web_search'}.get(kind,kind)
    command = str(item.get('command', ''))
    if kind in ('web_search', 'web_search_call'):
        return 'searching the web'
    if kind in ('file_change', 'apply_patch'):
        return 'editing files'
    if kind == 'command_execution':
        if re.search(r'\bmisty\.py\s+email[-\w]*\b|\bgmail\b', command, re.I):
            return 'checking Gmail'
        if re.search(r'\bfocus\.py\b', command):
            return 'checking current tasks'
        if re.search(r'misty\.py[\s\"\x27]+(?:send|draft)\b', command):
            return 'talking to Codex'
        if re.search(r'misty\.py[\s\"\x27]+(?:chats|code|read|result)\b', command):
            return 'reading Codex history'
        if 'misty.py' in command and 'archive' in command or re.search(r'\b(sqlite3?|archive_search|context\.py)\b', command):
            return 'searching the database'
        if re.search(r'\b(rg|cat|head|tail|Get-Content)\b', command):
            return 'reading files'
        return 'running commands'
    if kind == 'mcp_tool_call':
        tool = str(item.get('tool', '')).lower()
        if tool == 'publish_message':
            return 'sending an update'
        if 'web' in tool or 'browse' in tool:
            return 'searching the web'
        if 'search' in tool or 'archive' in tool:
            return 'searching the database'
    return 'thinking'
