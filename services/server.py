"""Single-request connections. In the VM the services are socket-activated and the kernel UID of
the caller is authoritative. On a host placement (no VM, one user) `--listen <role>=<path>` binds
one socket per caller role: the role comes from the socket the client chose, the kernel UID must
be this process's own, and what keeps a session away from these sockets is its sandbox."""

import os
import pwd
import re
import selectors
import socket
import sqlite3
import sys
import time
from collections import deque

import importlib

import auth
import connector_base
import connectors
import policy_client
import policy
from common import CELL_AGENT_HOST_UID, Denied, peer_uid, recv_json, send_json

MODES = ('auth', 'policy', *connectors.CONNECTORS)
RATE_LIMIT, RATE_WINDOW = 60, 60
# Caller roles a host listener may be bound to; the cell user has no listener (no cells there).
HOST_ROLES = ('egress', *connectors.CONNECTORS)
LISTENER = re.compile(r'^([a-z0-9-]{1,40})=(/\S+)$')


def handler_for(mode):
    """Connector handlers are imported lazily so one broken connector cannot take the others down."""
    if mode == 'auth':
        return auth.handle
    if mode == 'policy':
        return policy.handle
    return importlib.import_module(connectors.CONNECTORS[mode].module).handle


def credential_ops(caller):
    """Which auth operations a trusted service identity may request; the kernel UID picks the caller."""
    if caller == 'egress':
        return ('egress_credential', 'codex_token', 'codex_account', 'claude_token', 'hermes_credential')
    connector = connectors.CONNECTORS.get(caller)
    if connector is None:
        return ()
    return ('status', 'access_token') if connector.credential.startswith(('google:', 'oauth:')) else ('status', 'token')


def recover_connector(mode):
    connector = connectors.CONNECTORS.get(mode)
    if connector is None or connectors.WRITE not in connector.ops.values():
        return True
    try:
        connector_base.ledger(connector).recover()
        return True
    except (OSError, sqlite3.Error):
        # Keep reads/status available, but never execute writes without recovery.
        print('CONNECTOR_LEDGER_UNAVAILABLE', file=sys.stderr)
        return False


class Service:
    def __init__(
        self,
        mode,
        service_uids,
        cell_uid=CELL_AGENT_HOST_UID,
        clock=time.monotonic,
        peer=peer_uid,
        own_uid=None,
    ):
        if mode not in MODES:
            raise ValueError('Unknown service')
        self.mode, self.service_uids, self.clock, self.peer = mode, service_uids, clock, peer
        self.allowed_uids = set(service_uids) if mode in ('auth', 'policy') else {cell_uid}
        # Agent cells reach connector services through the egress bridge, which names the agent.
        self.bridge_uids = {uid for uid, name in service_uids.items() if name == 'egress'}
        if mode in connectors.CONNECTORS:
            self.allowed_uids |= self.bridge_uids
        # Host listeners: the roles this service answers, and the only UID that may connect.
        self.allowed_roles = set(HOST_ROLES) if mode in ('auth', 'policy') else {'egress'}
        self.own_uid = os.getuid() if own_uid is None else own_uid
        self.writes_ready = True
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

    def identify(self, conn, role=None):
        """The caller: a service name, or None for the cell user. From the kernel UID in the VM.
        On a host listener (`role` is the socket's) the UID must be this process's own and the
        role one this service answers; a role is never taken from the request."""
        uid = self.peer(conn)
        if role is not None:
            if uid != self.own_uid or role not in self.allowed_roles:
                raise Denied('CALLER_DENIED')
            return role
        if uid not in self.allowed_uids:
            raise Denied('CALLER_DENIED')
        return self.service_uids.get(uid)

    def process(self, conn, role=None):
        """One request per connection. Errors never carry provider details or tracebacks."""
        try:
            caller = self.identify(conn, role)
            self.throttle()
            request = recv_json(conn)
            agent, account = None, 'default'
            connector = connectors.CONNECTORS.get(self.mode)
            if caller == 'egress' and connector and isinstance(request, dict):
                agent = request.pop('agent', None)
                if not isinstance(agent, str) or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,39}', agent):
                    raise Denied('BAD_AGENT')
                # The bridge pins the cell's Google account; from anyone else the field is refused
                # by the handler's strict request fields.
                if connector.credential.startswith('google:'):
                    account = request.pop('account', None)
                    if not isinstance(account, str) or not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,31}', account):
                        raise Denied('BAD_ACCOUNT')
            if (
                connector
                and not self.writes_ready
                and connector.ops.get(self.mode + '.' + str(request.get('op'))) == connectors.WRITE
            ):
                raise Denied('LEDGER_UNAVAILABLE')
            if self.mode == 'auth' and request.get('op') not in credential_ops(caller):
                raise Denied('CREDENTIAL_SCOPE_DENIED')
            policy_client.AGENT = agent
            connector_base.ACCOUNT = account
            try:
                result = self.handler(request, caller) if self.mode in ('auth', 'policy') else self.handler(request)
            finally:
                policy_client.AGENT = None
                connector_base.ACCOUNT = 'default'
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


def parse_listeners(args):
    """`--listen <role>=<absolute path>` pairs: one socket per host caller role, no duplicates."""
    listeners = {}
    while args:
        if len(args) < 2 or args[0] != '--listen':
            raise ValueError('USAGE')
        match = LISTENER.fullmatch(args[1])
        if match is None or match.group(1) not in HOST_ROLES or match.group(1) in listeners:
            raise ValueError('BAD_LISTENER')
        listeners[match.group(1)] = match.group(2)
        args = args[2:]
    if not listeners:
        raise ValueError('USAGE')
    return listeners


def bind_listeners(listeners):
    """Fresh sockets reachable by this user only; their directory is the daemon's (mode 0700)."""
    sockets = {}
    for role, path in listeners.items():
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
        sock.bind(path)
        os.chmod(path, 0o600)
        sock.listen(16)
        sockets[sock] = role
    return sockets


def serve_host(service, listeners, stop=None):
    """Accepts on every role socket in turn until `stop` (a threading.Event) is set."""
    sockets = bind_listeners(listeners)
    selector = selectors.DefaultSelector()
    for sock, role in sockets.items():
        selector.register(sock, selectors.EVENT_READ, role)
    try:
        while stop is None or not stop.is_set():
            for key, _ in selector.select(0.2):
                conn, _ = key.fileobj.accept()
                with conn:
                    conn.settimeout(3)
                    service.process(conn, role=key.data)
    finally:
        selector.close()
        for sock in sockets:
            sock.close()


def main():
    mode = sys.argv[1]
    if mode not in MODES:
        raise SystemExit('Unknown service')
    if len(sys.argv) > 2:
        try:
            listeners = parse_listeners(sys.argv[2:])
        except ValueError as exc:
            raise SystemExit(f'{exc}: server.py <mode> --listen <role>=<socket path> ...') from None
        # The VM's units run with UMask=0077; the daemon's children inherit the user's.
        os.umask(0o077)
        service = Service(mode, {})
        service.writes_ready = recover_connector(mode)
        return serve_host(service, listeners)
    service_uids = {pwd.getpwnam(c.user).pw_uid: c.id for c in connectors.CONNECTORS.values()}
    try:
        service_uids[pwd.getpwnam('anchi-egress').pw_uid] = 'egress'
    except KeyError:
        pass  # Agent-team egress proxy not installed.
    if os.environ.get('LISTEN_PID') != str(os.getpid()) or os.environ.get('LISTEN_FDS') != '1':
        raise SystemExit('Socket activation required')
    listener = socket.socket(fileno=3)
    service = Service(mode, service_uids)
    service.writes_ready = recover_connector(mode)
    while True:
        conn, _ = listener.accept()
        with conn:
            conn.settimeout(3)
            service.process(conn)


if __name__ == '__main__':
    main()
