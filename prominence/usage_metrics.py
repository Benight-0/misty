"""Compact counters for otherwise ephemeral Codex runs. Never logs prompt/output text."""
import json
import os
import sys
import time
import config


def record(run_id, model, usage):
    if not isinstance(usage, dict) or 'input_tokens' not in usage:
        return False
    try:
        entry = dict(schema='misty-usage-v1', id=run_id, model=model, at=int(time.time() * 1000), tier=None,
                     tokens=dict(input=max(0, int(usage.get('input_tokens', 0))),
                                 cached=max(0, int(usage.get('cached_input_tokens', 0))),
                                 write=usage.get('cache_write_input_tokens'),
                                 output=max(0, int(usage.get('output_tokens', 0)))))
        data = (json.dumps(entry, separators=(',', ':')) + '\n').encode()
        fd = os.open(config.data('api-usage.jsonl'), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            os.write(fd, data)
        finally:
            os.close(fd)
        return True
    except (OSError, ValueError, TypeError):
        print('API usage counters unavailable; agent operation continues.', file=sys.stderr)
        return False
