"""Static aggregate-only dashboard. This unprivileged process cannot read archives."""
import argparse
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlsplit
from resources import Sampler

PUBLIC = Path(__file__).parent / 'public'
SNAPSHOT = Path('/var/lib/misty-metrics/public/metrics.json')
RESOURCES = None
ROUTES = {'/': ('index.html', 'text/html; charset=utf-8'),
          '/index.html': ('index.html', 'text/html; charset=utf-8'),
          '/style.css': ('style.css', 'text/css; charset=utf-8'),
          '/dashboard.js': ('dashboard.js', 'text/javascript; charset=utf-8'),
          '/favicon.svg': ('favicon.svg', 'image/svg+xml')}


class Handler(BaseHTTPRequestHandler):
    server_version = 'MistyMetrics'
    sys_version = ''

    def log_message(self, *args):
        pass  # Public traffic never becomes a query-string or request-header log.

    def do_GET(self):
        path = urlsplit(self.path).path
        code, cache = 200, 'public, max-age=300'
        if path == '/healthz':
            body, kind, cache = b'{"ok":true}', 'application/json', 'no-store'
        elif path == '/resources.json':
            value = RESOURCES.snapshot() if RESOURCES else None
            code = 200 if value else 503
            body = json.dumps(value or {'error': 'Host metrics are warming up'}, separators=(',', ':')).encode()
            kind, cache = 'application/json', 'no-store'
        elif path == '/metrics.json':
            try:
                body = SNAPSHOT.read_bytes()
                kind, cache = 'application/json', 'no-store'
            except OSError:
                code, body, kind, cache = 503, b'{"error":"Metrics are warming up"}', 'application/json', 'no-store'
        elif path in ROUTES:
            name, kind = ROUTES[path]
            body = (PUBLIC / name).read_bytes()
        elif path == '/robots.txt':
            body, kind = b'User-agent: *\nDisallow: /\n', 'text/plain'
        else:
            code, body, kind = 404, b'Not found\n', 'text/plain'
        self.send_response(code)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', cache)
        self.send_header('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Robots-Tag', 'noindex, nofollow')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    do_HEAD = do_GET


class Server(HTTPServer):
    def get_request(self):
        sock, address = super().get_request()
        sock.settimeout(4)
        return sock, address


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8793)
    parser.add_argument('--snapshot', type=Path)
    args = parser.parse_args()
    if args.snapshot:
        SNAPSHOT = args.snapshot
    server = Server(('127.0.0.1', args.port), Handler)
    RESOURCES = Sampler()
    RESOURCES.start()
    try:
        server.serve_forever()
    finally:
        RESOURCES.close()
        server.server_close()
