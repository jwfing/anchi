"""Agent-team egress proxy: a mitmproxy addon run as the `anchi-egress` user.

Each task cell gets its own Unix socket, bound only into that cell. A trusted bridge in this
process accepts on the cell's socket and connects to mitmproxy's loopback listener; the local
port of that connection identifies the cell. Connections to the listener from anything other
than a bridge are refused.

The guest-root cell manager registers and unregisters cells over a root-only control socket.
Credentials come from secure-auth over its socket (the kernel UID selects what this service
may read) and never from the environment. The audit log never contains header values.

Run:  mitmdump -s egress_proxy.py --listen-host 127.0.0.1 --listen-port 18080
"""

import asyncio
import json
import logging
import os
import re
import socket
import struct
import time
from pathlib import Path

import egress_rules as rules

RUN = Path(os.environ.get('ANCHI_EGRESS_RUN', '/run/anchi-egress'))
CONTROL = RUN / 'control.sock'
CELLS = RUN / 'cells'
AUDIT = Path(os.environ.get('ANCHI_EGRESS_AUDIT', '/var/log/anchi-egress/audit.jsonl'))
AUDIT_MAX_BYTES = 50 * 1024 * 1024
AUTH_SOCKET = os.environ.get('ANCHI_EGRESS_AUTH', '/run/secure-auth/token.sock')
CREDENTIAL_TTL = 60
NAME = re.compile(r'^[a-z0-9][a-z0-9-]{0,39}$')
CONTROL_MAX = 4096
log = logging.getLogger('anchi-egress')


def audit(entry):
    entry['ts'] = round(time.time(), 3)
    AUDIT.parent.mkdir(parents=True, exist_ok=True)
    try:
        if AUDIT.stat().st_size > AUDIT_MAX_BYTES:
            os.replace(AUDIT, AUDIT.with_suffix('.jsonl.1'))
    except FileNotFoundError:
        pass
    with AUDIT.open('a', encoding='utf-8') as file:
        file.write(json.dumps(entry, sort_keys=True) + '\n')


def auth_rpc(request):
    """One request to secure-auth; it answers one JSON line per connection."""
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
        conn.settimeout(10)
        conn.connect(AUTH_SOCKET)
        conn.sendall(json.dumps(request).encode() + b'\n')
        data = b''
        while not data.endswith(b'\n'):
            block = conn.recv(65536)
            if not block:
                break
            data += block
    response = json.loads(data)
    if not response.get('ok'):
        raise LookupError(response.get('error', 'AUTH_ERROR'))
    return response['result']


class Credentials:
    """Short-lived in-memory cache so a busy cell does not hit the auth service's rate limit."""

    def __init__(self, fetch=auth_rpc, clock=time.monotonic):
        self.fetch, self.clock, self.cache = fetch, clock, {}

    def get(self, grant):
        hit = self.cache.get(grant)
        if hit and hit[0] > self.clock():
            return hit[1]
        if grant == 'codex':
            value = self.fetch({'op': 'codex_token'})
            if value.get('expires_at', 0) <= time.time() + 30:
                raise LookupError('CODEX_TOKEN_EXPIRED_REIMPORT_ON_HOST')
            value = {'token': value['access_token'], 'account_id': value['account_id']}
        else:
            value = self.fetch({'op': 'egress_credential', 'connector': grant})
        self.cache[grant] = (self.clock() + CREDENTIAL_TTL, value)
        return value


class Cell:
    def __init__(self, task, agent, grants):
        self.task, self.agent, self.grants = task, agent, frozenset(grants)
        self.server = None
        self.writers = set()

    @property
    def directory(self):
        return CELLS / self.task


class Registry:
    """Cells, bridge connections and mitmproxy client connections, all in this process."""

    def __init__(self, listen):
        self.listen = listen
        self.cells = {}
        self.ports = {}
        self.clients = {}

    def validate(self, request):
        task, agent, connectors = request.get('task'), request.get('agent'), request.get('connectors')
        if not isinstance(task, str) or not NAME.fullmatch(task):
            raise ValueError('BAD_TASK')
        if not isinstance(agent, str) or not NAME.fullmatch(agent):
            raise ValueError('BAD_AGENT')
        if not isinstance(connectors, list) or not all(c in rules.CONNECTORS for c in connectors):
            raise ValueError('BAD_CONNECTORS')
        if task in self.cells:
            raise ValueError('CELL_EXISTS')
        return task, agent, set(connectors) | set(rules.RUNTIMES)

    async def register(self, request):
        task, agent, grants = self.validate(request)
        cell = Cell(task, agent, grants)
        cell.directory.mkdir(parents=True, exist_ok=False)
        # The service runs with UMask=0077; the cell's agent user must traverse this directory.
        os.chmod(cell.directory, 0o755)
        path = cell.directory / 'proxy.sock'
        cell.server = await asyncio.start_unix_server(lambda r, w: self.bridge(cell, r, w), path=str(path))
        # Only this cell has the directory bound in; the agent user must be able to connect.
        os.chmod(path, 0o666)
        self.cells[task] = cell
        audit({'event': 'register', 'task': task, 'agent': agent, 'grants': sorted(grants)})
        return {'directory': str(cell.directory)}

    async def unregister(self, task):
        cell = self.cells.pop(task, None)
        if cell is None:
            return {'removed': False}
        cell.server.close()
        for writer in list(cell.writers):
            writer.close()
        for path in cell.directory.glob('*'):
            path.unlink(missing_ok=True)
        cell.directory.rmdir()
        audit({'event': 'unregister', 'task': task, 'agent': cell.agent})
        return {'removed': True}

    async def bridge(self, cell, reader, writer):
        # Bind first and map the local port before connecting: mitmproxy runs its client_connected
        # hook as soon as it accepts, possibly before this coroutine resumes.
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        port = None
        try:
            sock.bind((self.listen[0], 0))
            port = sock.getsockname()[1]
            self.ports[port] = cell
            sock.setblocking(False)
            await asyncio.get_running_loop().sock_connect(sock, self.listen)
            up_reader, up_writer = await asyncio.open_connection(sock=sock)
        except OSError:
            self.ports.pop(port, None)
            sock.close()
            writer.close()
            return
        cell.writers.update((writer, up_writer))
        try:
            await asyncio.gather(pipe(reader, up_writer), pipe(up_reader, writer))
        finally:
            self.ports.pop(port, None)
            cell.writers.difference_update((writer, up_writer))

    def client_cell(self, client):
        return self.clients.get(client.id)


async def pipe(reader, writer):
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except (ConnectionError, asyncio.IncompleteReadError):
        pass
    finally:
        writer.close()


def peer_uid(sock):
    return struct.unpack('3i', sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[1]


class EgressProxy:
    def __init__(self, registry=None, credentials=None):
        self.registry = registry or Registry(('127.0.0.1', 18080))
        self.credentials = credentials or Credentials()
        self.control = None

    # ── lifecycle ────────────────────────────────────────────

    async def running(self):
        from mitmproxy import ctx

        self.registry.listen = (ctx.options.listen_host or '127.0.0.1', ctx.options.listen_port)
        CELLS.mkdir(parents=True, exist_ok=True)
        os.chmod(CELLS, 0o755)
        for stale in CELLS.glob('*'):
            for path in stale.glob('*'):
                path.unlink(missing_ok=True)
            stale.rmdir()
        CONTROL.unlink(missing_ok=True)
        self.control = await asyncio.start_unix_server(self.handle_control, path=str(CONTROL))
        os.chmod(CONTROL, 0o600)
        audit({'event': 'start'})

    async def done(self):
        if self.control:
            self.control.close()
        for task in list(self.registry.cells):
            await self.registry.unregister(task)

    async def handle_control(self, reader, writer):
        try:
            if peer_uid(writer.get_extra_info('socket')) != 0:
                raise ValueError('CALLER_DENIED')
            line = await reader.readline()
            if len(line) > CONTROL_MAX or not line.endswith(b'\n'):
                raise ValueError('BAD_REQUEST')
            request = json.loads(line)
            op = request.get('op') if isinstance(request, dict) else None
            if op == 'register':
                result = await self.registry.register(request)
                result['identifiers'] = self.identifiers(set(request.get('connectors', [])))
            elif op == 'unregister':
                task = request.get('task')
                if not isinstance(task, str) or not NAME.fullmatch(task):
                    raise ValueError('BAD_TASK')
                result = await self.registry.unregister(task)
            elif op == 'list':
                result = {t: {'agent': c.agent, 'grants': sorted(c.grants)} for t, c in self.registry.cells.items()}
            else:
                raise ValueError('UNKNOWN_OP')
            response = {'ok': True, 'result': result}
        except (ValueError, OSError) as exc:
            response = {'ok': False, 'error': str(exc) if isinstance(exc, ValueError) else 'CONTROL_FAILED'}
        writer.write(json.dumps(response).encode() + b'\n')
        await writer.drain()
        writer.close()

    def identifiers(self, grants):
        """Non-secret values a cell needs locally, such as the Codex account id."""
        out = {}
        try:
            out['codex_account_id'] = self.credentials.fetch({'op': 'codex_account'})['account_id']
        except (LookupError, OSError, ValueError, KeyError):
            pass
        if 'aws' in grants:
            try:
                out['aws_region'] = self.credentials.get('aws')['region']
            except (LookupError, OSError, ValueError, KeyError):
                pass
        return out

    # ── mitmproxy hooks ─────────────────────────────────────

    def client_connected(self, client):
        cell = self.registry.ports.get(client.peername[1]) if client.peername else None
        if cell is None:
            client.error = 'connection not from a cell bridge'
            audit({'event': 'refused-client'})
            return
        self.registry.clients[client.id] = cell

    def client_disconnected(self, client):
        self.registry.clients.pop(client.id, None)

    async def server_connect(self, data):
        """Resolve once, refuse non-public destinations and connect to the checked address."""
        host, port = data.server.address
        cell = self.registry.client_cell(data.client)
        try:
            infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
        except OSError as exc:
            data.server.error = f'cannot resolve {host}: {exc}'
            return
        address, reason = rules.public_address(infos)
        if address is None:
            data.server.error = f'anchi: {reason}'
            audit(
                {
                    'decision': 'blocked-destination',
                    'host': host,
                    'reason': reason,
                    'task': cell and cell.task,
                    'agent': cell and cell.agent,
                }
            )
            return
        if not data.server.sni and not host.replace('.', '').isdigit():
            data.server.sni = host
        data.server.address = (address, port)

    def server_connect_error(self, data):
        """Upstream failures (DNS, refused, timeout) are otherwise only a bare 502 in the cell."""
        cell = self.registry.client_cell(data.client)
        if cell is None or str(data.server.error or '').startswith('anchi: '):
            return
        audit(
            {
                'decision': 'upstream-error',
                'host': data.server.sni or str(data.server.address and data.server.address[0]),
                'reason': str(data.server.error)[:200],
                'task': cell.task,
                'agent': cell.agent,
            }
        )

    def http_connect(self, flow):
        cell = self.registry.client_cell(flow.client_conn)
        if cell is None:
            self.respond(flow, 403, b'anchi: unknown cell\n')

    async def request(self, flow):
        req = flow.request
        cell = self.registry.client_cell(flow.client_conn)
        if cell is None:
            return self.respond(flow, 403, b'anchi: unknown cell\n')
        req.headers.pop('proxy-authorization', None)
        headers = {k.lower(): v for k, v in req.headers.items()}
        body = b'' if req.stream else (req.get_content(strict=False) or b'')
        host = req.pretty_host
        path = req.path.split('?', 1)[0]
        decision = rules.decide(req.method, host, req.path, headers, body, cell.grants)
        entry = {
            'task': cell.task,
            'agent': cell.agent,
            'method': req.method,
            'host': host,
            'path': path[:500],
            'client_cred': rules.classify_credential(headers),
            'rule': decision.rule.name if decision.rule else None,
            'op': decision.op,
            'decision': decision.action if decision.reason is None else f'{decision.action}:{decision.reason}',
        }
        if decision.action == 'deny':
            audit(entry)
            status, content, extra = rules.deny_response(decision, headers)
            return self.respond(flow, status, content, extra)
        if decision.action == 'pass':
            audit(entry)
            return
        try:
            credential = await asyncio.get_running_loop().run_in_executor(
                None, self.credentials.get, decision.rule.grant
            )
            new = rules.apply(decision, req.method, req.url, headers, body, credential)
        except LookupError as exc:
            entry['decision'] = 'missing-credential'
            entry['reason'] = str(exc)[:100]
            audit(entry)
            return self.respond(flow, 502, f'anchi: credential unavailable ({exc})\n'.encode())
        except ValueError as exc:
            entry['decision'] = 'rejected'
            entry['reason'] = str(exc)[:200]
            audit(entry)
            return self.respond(flow, 403, f'anchi: {exc}\n'.encode())
        req.headers.clear()
        for key, value in new.items():
            req.headers[key] = value
        audit(entry)

    @staticmethod
    def respond(flow, status, content, headers=None):
        from mitmproxy import http

        flow.response = http.Response.make(status, content, headers or {'content-type': 'text/plain'})


addons = [EgressProxy()]
