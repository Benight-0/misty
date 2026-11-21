"""Verify public HTTPS redirects to the configured Access application."""
import pathlib
import email.parser
import subprocess
import urllib.parse

config = dict(line.split('=', 1) for line in pathlib.Path('/etc/archival/runtime.env').read_text().splitlines() if line and not line.startswith('#') and '=' in line)
issuer = config['CF_ACCESS_ISSUER']
audience = config['CF_ACCESS_AUD']
for path in ['/', '/api/bootstrap', '/app.js', '/misty.js', '/misty.css']:
    completed = subprocess.run(['curl', '--silent', '--show-error', '--max-time', '20', '--dump-header', '-', '--output', '/dev/null', 'https://archival.example.com' + path], capture_output=True, text=True, check=True)
    header_blocks = completed.stdout.strip().replace('\r\n', '\n').split('\n\n')
    lines = header_blocks[-1].split('\n', 1)
    status = int(lines[0].split()[1])
    headers = email.parser.Parser().parsestr(lines[1])
    location = urllib.parse.urlparse(headers.get('Location', ''))
    query = urllib.parse.parse_qs(location.query)
    if status != 302 or location.scheme + '://' + location.netloc != issuer or query.get('kid') != [audience]:
        print('Unexpected public authentication response:', path, status, location.netloc)
        raise SystemExit(1)
    print('Public HTTPS', path, ': 302 to configured Cloudflare Access issuer and AUD')
print('Public sign-in routing checks passed; owner sign-in remains to be completed in a browser.')
