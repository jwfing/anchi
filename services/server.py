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
from common import CELL_AGENT_HOST_UID, Denied, peer_uid, recv_json, send_json

MODES = ('gmail', 'auth', 'inference', 'policy')
HANDLERS = {'gmail': gmail.handle, 'auth': auth.handle, 'inference': inference.handle, 'policy': policy.handle}
# Which credential operations each trusted service identity may request from auth.
CREDENTIAL_OPS = {'gmail': ('status', 'access_token'), 'inference': ('model_key', 'codex_token')}
RATE_LIMIT, RATE_WINDOW = 60, 60


class Service:
    def __init__(self, mode, service_uids, cell_uid=CELL_AGENT_HOST_UID, clock=time.monotonic, peer=peer_uid):
        if mode not in MODES:
            raise ValueError('Unknown service')
        self.mode, self.service_uids, self.clock, self.peer = mode, service_uids, clock, peer
        self.allowed_uids = set(service_uids) if mode in ('auth', 'policy') else {cell_uid}
        self.handler = HANDLERS[mode]
        self.recent = deque()

    def throttle(self):
        now = self.clock()
        while self.recent and self.recent[0] < now - RATE_WINDOW:
            self.recent.popleft()
        if len(self.recent) >= RATE_LIMIT:
            raise Denied('RATE_LIMITED')
        self.recent.append(now)

    def process(self, conn):
        """One request per connection. Errors never carry provider details or tracebacks."""
        try:
            uid = self.peer(conn)
            if uid not in self.allowed_uids:
                raise Denied('CALLER_DENIED')
            self.throttle()
            request = recv_json(conn)
            caller = self.service_uids.get(uid)
            if self.mode == 'auth' and request.get('op') not in CREDENTIAL_OPS[caller]:
                raise Denied('CREDENTIAL_SCOPE_DENIED')
            result = self.handler(request, caller) if self.mode == 'policy' else self.handler(request)
            send_json(conn, {'ok': True, 'result': result})
        except Denied as exc:
            self.reply_error(conn, str(exc))
        except Exception:
            self.reply_error(conn, 'SERVICE_UNAVAILABLE')

    @staticmethod
    def reply_error(conn, code):
        try:
            send_json(conn, {'ok': False, 'error': code})
        except OSError:
            pass


def main():
    mode = sys.argv[1]
    if mode not in MODES:
        raise SystemExit('Unknown service')
    service_uids = {pwd.getpwnam('secure-gmail').pw_uid: 'gmail', pwd.getpwnam('secure-inference').pw_uid: 'inference'}
    if os.environ.get('LISTEN_PID') != str(os.getpid()) or os.environ.get('LISTEN_FDS') != '1':
        raise SystemExit('Socket activation required')
    listener = socket.socket(fileno=3)
    if mode == 'inference':
        inference.recover()
    service = Service(mode, service_uids)
    while True:
        conn, _ = listener.accept()
        with conn:
            conn.settimeout(3)
            service.process(conn)


if __name__ == '__main__':
    main()
