"""Package only reviewed owner-alias source; credentials/state never enter the bundle."""
import json
from pathlib import Path
import tarfile
import subprocess

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'data/deployment/misty-owner-alias-20261025'
REMOTE = '/tmp/archival-migration/misty-owner-alias-20261025'
baseline = json.loads((OUT / 'baseline.json').read_text())
files = set(baseline['files']) | {'app/owner-routing.mjs', 'app/tests/owner-aliases.test.mjs',
    'docs/misty-owner-accounts.md', 'scripts/deploy-misty-owner-alias.py', 'deploy/misty-owner-accounts.conf'}
files |= {str(p.relative_to(ROOT)).replace('\\', '/') for p in (ROOT / 'prominence').glob('*.py')}
files |= {'prominence/UPSTREAM.json', 'prominence/LICENSE', 'prominence/laptop-tool-schemas.json'}
files |= {str(p.relative_to(ROOT)).replace('\\', '/') for p in (ROOT / 'collector/cmd/misty-bot-gateway').iterdir() if p.suffix in ('.go', '.mod', '.sum')}
with tarfile.open(OUT / 'candidate.tar.gz', 'w:gz') as archive:
    for name in sorted(files): archive.add(ROOT / name, arcname='candidate/' + name)
    archive.add(OUT / 'baseline.json', arcname='baseline.json')
subprocess.run(['ssh', '-F', str(ROOT / 'data/deployment/ssh_config'), 'archival-vm', 'mkdir', '-p', REMOTE], check=True)
subprocess.run(['scp', '-F', str(ROOT / 'data/deployment/ssh_config'), str(OUT / 'candidate.tar.gz'), 'archival-vm:' + REMOTE + '/candidate.tar.gz'], check=True)
print(REMOTE)
