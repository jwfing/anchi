"""Socket-activated, single-request connections; kernel UID is authoritative."""
import os
import pwd
import socket
import sys
import time
from collections import deque

import auth
import gmail
import inference
import policy
from common import Denied, peer_uid, recv_json, send_json

def main():
    mode = sys.argv[1]
    if mode not in ('gmail', 'auth', 'inference', 'policy'):
        raise SystemExit('Unknown service')
    service_uids = {pwd.getpwnam('secure-gmail').pw_uid: 'gmail', pwd.getpwnam('secure-inference').pw_uid: 'inference'}
    allowed_uids = set(service_uids) if mode in ('auth', 'policy') else {525288}
    handler = {'gmail': gmail.handle, 'auth': auth.handle, 'inference': inference.handle, 'policy': policy.handle}[mode]
    if os.environ.get('LISTEN_PID') != str(os.getpid()) or os.environ.get('LISTEN_FDS') != '1':
        raise SystemExit('Socket activation required')
    listener = socket.socket(fileno=3)
    if mode == 'inference':
        inference.recover()
    recent = deque()
    while True:
        conn, _ = listener.accept()
        with conn:
            conn.settimeout(3)
            try:
                uid = peer_uid(conn)
                if uid not in allowed_uids:
                    raise Denied('CALLER_DENIED')
                now = time.monotonic()
                while recent and recent[0] < now - 60:
                    recent.popleft()
                if len(recent) >= 60:
                    raise Denied('RATE_LIMITED')
                recent.append(now)
                request = recv_json(conn)
                if mode == 'auth':
                    ops = {'gmail': ('status', 'access_token'), 'inference': ('model_key', 'codex_token')}[service_uids[uid]]
                    if request.get('op') not in ops:
                        raise Denied('CREDENTIAL_SCOPE_DENIED')
                result = handler(request, service_uids[uid]) if mode == 'policy' else handler(request)
                send_json(conn, {'ok': True, 'result': result})
            except Denied as exc:
                try:
                    send_json(conn, {'ok': False, 'error': str(exc)})
                except OSError:
                    pass
            except Exception:
                # No traceback or provider exception details: these may contain secrets.
                try:
                    send_json(conn, {'ok': False, 'error': 'SERVICE_UNAVAILABLE'})
                except OSError:
                    pass

if __name__ == '__main__':
    main()
