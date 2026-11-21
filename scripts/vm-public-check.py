"""Check production sign-in gates without requesting or printing chat data."""
import base64
import json
import pathlib
import re
import time
import urllib.error
import urllib.request

config = dict(line.split('=', 1) for line in pathlib.Path('/etc/archival/runtime.env').read_text().splitlines() if line and not line.startswith('#') and '=' in line)
issuer = config['CF_ACCESS_ISSUER']
audience = config['CF_ACCESS_AUD']
if not re.fullmatch(r'https://[-a-z0-9]+\.cloudflareaccess\.com', issuer):
    raise SystemExit('Invalid configured Access issuer')
with urllib.request.urlopen(issuer + '/cdn-cgi/access/certs', timeout=15) as response:
    keys = [key for key in json.load(response).get('keys', []) if key.get('kty') == 'RSA' and key.get('kid')]
if not keys:
    raise SystemExit('No Access signing keys available')
print('Access certificate endpoint: reachable;', len(keys), 'RSA signing keys')

def status(path, host='archival.example.com', assertion=None):
    headers = {'Host': host}
    if assertion:
        headers['Cf-Access-Jwt-Assertion'] = assertion
    request = urllib.request.Request('http://127.0.0.1:8787' + path, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return response.status
    except urllib.error.HTTPError as error:
        error.close()
        return error.code

for path in ['/', '/app.js', '/misty.js', '/misty.css', '/api/bootstrap', '/api/person?id=missing', '/api/room/people?id=missing']:
    result = status(path)
    print('Unauthenticated', path, result)
    if result != 401:
        raise SystemExit('Unauthenticated request was not rejected as expected')
if status('/', host='untrusted.example') != 403:
    raise SystemExit('Untrusted hostname was not rejected')
print('Untrusted hostname: rejected')

def encoded(value):
    return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip('=')

claims = {'iss': issuer, 'aud': [audience], 'email': 'user-17@example.com', 'type': 'app', 'iat': int(time.time()), 'exp': int(time.time()) + 60}
for algorithm, signature in [('RS256', base64.urlsafe_b64encode(bytes(256)).decode().rstrip('=')), ('none', '')]:
    assertion = encoded({'alg': algorithm, 'kid': keys[0]['kid']}) + '.' + encoded(claims) + '.' + signature
    result = status('/api/bootstrap', assertion=assertion)
    if result != 401:
        raise SystemExit('Forged Access assertion was not rejected')
    print('Forged', algorithm, 'assertion: rejected')
print('Analysis enabled:', config.get('ARCHIVAL_ANALYSIS') == 'on')
with urllib.request.urlopen('http://127.0.0.1:20241/ready', timeout=5) as response:
    print('Tunnel readiness:', response.status)
print('Production authentication gate checks passed')
