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
from common import Denied, peer_uid, recv_json, send_json

def main():
    mode = sys.argv[1]
    if mode not in ('gmail', 'auth', 'inference'):
        raise SystemExit('Unknown service')
    allowed_uid = pwd.getpwnam('secure-gmail').pw_uid if mode == 'auth' else 525288
    handler = {'gmail': gmail.handle, 'auth': auth.handle, 'inference': inference.handle}[mode]
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
                if peer_uid(conn) != allowed_uid:
                    raise Denied('CALLER_DENIED')
                now = time.monotonic()
                while recent and recent[0] < now - 60:
                    recent.popleft()
                if len(recent) >= 60:
                    raise Denied('RATE_LIMITED')
                recent.append(now)
                result = handler(recv_json(conn))
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
