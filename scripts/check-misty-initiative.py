"""Run inside Misty's existing credential namespace. Fictional context, no DMs."""
from datetime import datetime
import json
import os
from pathlib import Path
import sys
import tempfile
import time

sys.path.insert(0, '/opt/misty-prominence')
import config  # noqa: E402
import initiative as it  # noqa: E402
import workflows as wf  # noqa: E402

assert config.get('agent_model') == 'gpt-6.1-sol'
assert config.get('agent_effort') == 'high'
now = time.time()
# Isolated fictional instant; no quiet-hours policy is applied.
fixture_time = datetime.fromtimestamp(now, it.ZONE).replace(hour=12, minute=0, second=0).timestamp()
context = {'focus': [{'id': 'fixture-essay', 'title': 'Fictional scholarship essay', 'status': 'active',
                     'basis': 'owner', 'priority': 'now', 'source': 'Fictional owner statement for this isolated test',
                     'due': None, 'updated': fixture_time}],
           'ownerMessages': [{'id': 'fixture-owner-message', 'at': fixture_time - 4 * 3600,
                              'text': 'Fictional test: I am working on an essay draft today. You can check in later if useful.'}],
           'notes': [], 'recentProactive': [], 'reminders': []}
with tempfile.TemporaryDirectory(prefix='misty-initiative-fixture-') as temp:
    config.DATA_DIR = temp
    wf.STORE, wf.LOCK, wf.OUTBOX = temp + '/workflows.json', temp + '/.workflows.lock', temp + '/outbox.jsonl'
    os.environ['PROMINENCE_DATA_DIR'] = temp
    forbidden = []
    result = it.run_check(ask=it.model_ask, notify=forbidden.append, context_loader=lambda n: context,
                          history=lambda: 'Fictional private conversation: owner is working on a draft.',
                          now=fixture_time, dry_run=True)
    assert result['modelCalled'] and result['reason'] != 'invalid_model_decision', result
    assert not result['sent'] and not forbidden
    with it.database() as db:
        assert db.execute('SELECT count(*) FROM deliveries').fetchone()[0] == 0
        assert db.execute('SELECT count(*) FROM plans').fetchone()[0] == 0
    usage = [json.loads(line) for line in Path(temp + '/api-usage.jsonl').read_text().splitlines()]
    assert len(usage) == 1 and usage[0]['model'] == 'gpt-6.1-sol'
    print(json.dumps({'ok': True, 'requestedModel': 'gpt-6.1-sol', 'reasoningEffort': 'high',
                      'decisionValid': True, 'decisionKind': result.get('kind'), 'sendCandidate': result['send'],
                      'followUpsProposed': len(result['planned']), 'usage': usage[0]['tokens'],
                      'realDiscordSends': 0, 'productionPlansOrReceiptsWritten': 0, 'toolAccess': False}, indent=2))
