"""Install the authorized tunnel from data; never execute supplied shell text."""
import argparse
import base64
import grp
import json
import os
import pathlib
import pwd
import re
import shutil
import subprocess
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('--access-only', action='store_true')
args = parser.parse_args()
source = pathlib.Path('/tmp/archival-migration/cloudflare-install.txt')
raw = source.read_text(encoding='utf-8-sig')
issuer = re.search(r'^\s*CF_ACCESS_ISSUER=(https://[-a-z0-9]+\.cloudflareaccess\.com)/?\s*$', raw, re.M)
audience = re.search(r'^\s*CF_ACCESS_AUD=([a-fA-F0-9]{32,128})\s*$', raw, re.M)
os.umask(0o077)

if not args.access_only:
    command = re.search(r'^\s*(?:sudo\s+)?cloudflared\s+service\s+install\s+([A-Za-z0-9_=+/.\-]+)\s*$', raw, re.M)
    if not command:
        raise SystemExit('No valid connector command found; no shell text was executed.')
    token = command[1]
    decoded = json.loads(base64.b64decode(token, validate=True))
    uuid.UUID(decoded['t'])
    if not re.fullmatch(r'[a-fA-F0-9]{32}', decoded['a']) or not isinstance(decoded.get('s'), str) or len(decoded['s']) < 24:
        raise SystemExit('Invalid tunnel credentials.')
    existing = pathlib.Path('/etc/systemd/system/cloudflared.service')
    if existing.exists() and 'Description=Archival Cloudflare Tunnel' not in existing.read_text():
        raise SystemExit('An existing unmanaged connector service was preserved.')
    try:
        user = pwd.getpwnam('cloudflared')
    except KeyError:
        subprocess.run(['useradd', '--system', '--user-group', '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', 'cloudflared'], check=True)
        user = pwd.getpwnam('cloudflared')
    directory = pathlib.Path('/etc/cloudflared')
    directory.mkdir(exist_ok=True)
    os.chown(directory, 0, user.pw_gid)
    os.chmod(directory, 0o750)
    token_path = directory / 'archival-token'
    token_path.write_text(token + '\n')
    os.chown(token_path, 0, user.pw_gid)
    os.chmod(token_path, 0o640)
    shutil.copyfile('/tmp/archival-migration/cloudflared-archival.service', existing)
    os.chmod(existing, 0o644)
    subprocess.run(['systemd-analyze', 'verify', str(existing)], check=True)
    subprocess.run(['systemctl', 'daemon-reload'], check=True)
    subprocess.run(['systemctl', 'enable', '--now', 'cloudflared'], check=True)
    print('Tunnel connector enabled; token stored in a private file.')

if issuer and audience:
    runtime = pathlib.Path('/etc/archival/runtime.env')
    lines = runtime.read_text().splitlines() if runtime.exists() else []
    keys = ['ARCHIVAL_PUBLIC_ORIGIN', 'CF_ACCESS_ISSUER', 'CF_ACCESS_AUD']
    lines = [line for line in lines if not any(line.startswith(key + '=') for key in keys)]
    lines += ['ARCHIVAL_PUBLIC_ORIGIN=https://archival.example.com', 'CF_ACCESS_ISSUER=' + issuer[1], 'CF_ACCESS_AUD=' + audience[1]]
    temporary = runtime.with_suffix('.env.pending')
    temporary.write_text('\n'.join(lines) + '\n')
    os.chown(temporary, 0, grp.getgrnam('archival').gr_gid)
    os.chmod(temporary, 0o640)
    temporary.replace(runtime)
    subprocess.run(['systemctl', 'restart', 'archival'], check=True)
    print('Access issuer/audience configured; existing runtime options preserved.')
else:
    print('Access issuer/audience missing: public hostname remains rejected by the application.')
source.unlink()
