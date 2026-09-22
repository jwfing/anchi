"""Socket-activated, single-request connections; kernel UID is authoritative."""

import os
import pwd
import socket
import sys
import time
from collections import deque

import importlib

import auth
import connectors
import inference
import policy
from common import CELL_AGENT_HOST_UID, Denied, peer_uid, recv_json, send_json

MODES = ('auth', 'inference', 'policy', *connectors.CONNECTORS)
RATE_LIMIT, RATE_WINDOW = 60, 60


def handler_for(mode):
    """Connector handlers are imported lazily so one broken connector cannot take the others down."""
    if mode == 'auth':
        return auth.handle
    if mode == 'inference':
        return inference.handle
    if mode == 'policy':
        return policy.handle
    return importlib.import_module(connectors.CONNECTORS[mode].module).handle


def credential_ops(caller):
    """Which auth operations a trusted service identity may request; the kernel UID picks the caller."""
    if caller == 'inference':
        return ('model_key', 'codex_token')
    connector = connectors.CONNECTORS.get(caller)
    if connector is None:
        return ()
    return ('status', 'access_token') if connector.credential.startswith('google:') else ('status', 'token')


class Service:
    def __init__(self, mode, service_uids, cell_uid=CELL_AGENT_HOST_UID, clock=time.monotonic, peer=peer_uid):
        if mode not in MODES:
            raise ValueError('Unknown service')
        self.mode, self.service_uids, self.clock, self.peer = mode, service_uids, clock, peer
        self.allowed_uids = set(service_uids) if mode in ('auth', 'policy') else {cell_uid}
        self._handler = None
        self.recent = deque()

    @property
    def handler(self):
        if self._handler is None:
            self._handler = handler_for(self.mode)
        return self._handler

    @handler.setter
    def handler(self, value):
        self._handler = value

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
            if self.mode == 'auth' and request.get('op') not in credential_ops(caller):
                raise Denied('CREDENTIAL_SCOPE_DENIED')
            result = self.handler(request, caller) if self.mode in ('auth', 'policy') else self.handler(request)
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
    service_uids = {pwd.getpwnam(c.user).pw_uid: c.id for c in connectors.CONNECTORS.values()}
    service_uids[pwd.getpwnam('secure-inference').pw_uid] = 'inference'
    if os.environ.get('LISTEN_PID') != str(os.getpid()) or os.environ.get('LISTEN_FDS') != '1':
        raise SystemExit('Socket activation required')
    listener = socket.socket(fileno=3)
    if mode == 'inference':
        inference.recover()
    elif mode in connectors.CONNECTORS:
        import connector_base

        connector_base.ledger(connectors.CONNECTORS[mode]).recover()
    service = Service(mode, service_uids)
    while True:
        conn, _ = listener.accept()
        with conn:
            conn.settimeout(3)
            service.process(conn)


if __name__ == '__main__':
    main()
