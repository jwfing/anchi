"""Trusted macOS OAuth helper: code to VM over SSH; tokens never return to macOS."""
import argparse
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path
import secrets
import re
import subprocess
import time
from urllib.parse import parse_qs, urlsplit
import webbrowser

def admin(action, data=None):
    proc = subprocess.run(['limactl', 'shell', 'secure-vm', '--', 'sudo',
        '/usr/bin/python3', '/opt/secure-vm/services/admin.py', action],
        input=json.dumps(data) if data is not None else '', text=True, capture_output=True)
    if proc.returncode:
        # Only expose our static error codes, never arbitrary SSH/provider output.
        try:
            reason = json.loads(proc.stdout).get('error', '')
        except ValueError:
            reason = ''
        if not isinstance(reason, str) or not re.fullmatch('[A-Z_]{1,80}', reason):
            reason = 'CHECK_VM_AND_SERVICE_STATUS'
        raise RuntimeError('Guest admin operation failed: ' + reason)
    return json.loads(proc.stdout)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--client', type=Path, help='Google Desktop OAuth client JSON path')
    parser.add_argument('--status', action='store_true')
    parser.add_argument('--disconnect', action='store_true')
    args = parser.parse_args()
    if args.status or args.disconnect:
        print(json.dumps(admin('disconnect' if args.disconnect else 'status'), indent=2))
        return
    if args.client:
        if args.client.stat().st_size > 16384:
            raise RuntimeError('Client JSON too large')
        admin('import-client', json.loads(args.client.read_text()))
    if not admin('status')['client_configured']:
        raise RuntimeError('Provide --client /absolute/path/to/desktop-client.json first.')
    expected, callback = {}, {}
    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(5)
        def log_message(self, *args):
            pass  # Never log the authorization code in a callback URL.
        def do_GET(self):
            parsed = urlsplit(self.path)
            query = parse_qs(parsed.query)
            valid = (parsed.path == '/callback' and self.headers.get('Host') == expected['host']
                     and len(query.get('state', [])) == 1
                     and secrets.compare_digest(query['state'][0], expected['state']))
            if not valid:
                self.send_response(400)
                self.end_headers()
                return
            if 'error' in query:
                callback['error'] = True
            elif len(query.get('code', [])) == 1:
                callback.update(code=query['code'][0], state=query['state'][0])
            else:
                self.send_response(400)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.end_headers()
            self.wfile.write(b'Authorization response received. Return to your terminal for the connection result.')
    with HTTPServer(('127.0.0.1', 0), Handler) as server:
        server.timeout = 1
        expected['host'] = f'127.0.0.1:{server.server_port}'
        flow = admin('begin', {'redirect_uri': f"http://{expected['host']}/callback"})
        expected['state'] = flow['state']
        print('Authorize Gmail READ-ONLY access in your browser. No sending permission is requested.', flush=True)
        print(flow['url'], flush=True)
        webbrowser.open(flow['url'])
        deadline = time.monotonic() + 590
        while not callback and time.monotonic() < deadline:
            server.handle_request()
    if not callback or callback.get('error'):
        raise RuntimeError('Authorization cancelled or timed out. Run login again.')
    print(json.dumps(admin('complete', callback), indent=2))

if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, ValueError) as exc:
        raise SystemExit(str(exc)) from None
