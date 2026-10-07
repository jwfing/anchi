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
import secrets
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
APPROVAL_TIMEOUT = 300
APPROVALS_PENDING_MAX = 32
GIT_REF_UPDATE = re.compile(rb'[0-9a-f]{40} [0-9a-f]{40} (refs/[^\x00\s]{1,200})')
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
        if grant == 'claude':
            value = self.fetch({'op': 'claude_token'})
        elif grant == 'codex':
            value = self.fetch({'op': 'codex_token'})
            if value.get('expires_at', 0) <= time.time() + 30:
                raise LookupError('CODEX_TOKEN_EXPIRED_REIMPORT_ON_HOST')
            value = {'token': value['access_token'], 'account_id': value['account_id']}
        else:
            value = self.fetch({'op': 'egress_credential', 'connector': grant})
        self.cache[grant] = (self.clock() + CREDENTIAL_TTL, value)
        return value

    def invalidate(self, grant):
        self.cache.pop(grant, None)


def https_call(method, url, headers, body):
    """(status, body) of one request to a fixed public endpoint; used only for verification."""
    import urllib.error
    import urllib.request

    request = urllib.request.Request(url, data=body or None, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return response.status, response.read(65536)
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(65536)


def write_summary(decision, method, path, body):
    """What the user approves: the git refs a push updates, or the start of the request body."""
    if decision.rule.name == 'github-git':
        refs = [r.decode() for r in GIT_REF_UPDATE.findall(body[:65536])]
        return 'git push: ' + (', '.join(refs) if refs else 'no ref updates found')
    if not body:
        return f'{method} {path[:300]}'
    if b'\x00' in body[:4096]:
        return f'{method} {path[:300]} (binary body, {len(body)} bytes)'
    return f'{method} {path[:300]}\n' + body[:2000].decode('utf-8', 'replace')


class Approvals:
    """Writes held for the user. The daemon watches this queue over the control socket and
    answers; an unanswered request is refused after APPROVAL_TIMEOUT seconds."""

    def __init__(self, timeout=APPROVAL_TIMEOUT):
        self.timeout = timeout
        self.pending = {}
        self.watchers = set()

    def broadcast(self, event):
        line = json.dumps(event).encode() + b'\n'
        for writer in list(self.watchers):
            try:
                writer.write(line)
            except (ConnectionError, RuntimeError):
                self.watchers.discard(writer)

    async def ask(self, item):
        """'approved', 'denied' or 'timeout'."""
        if len(self.pending) >= APPROVALS_PENDING_MAX:
            return 'denied'
        item = {**item, 'id': secrets.token_hex(8), 'created_at': time.time(), 'timeout': self.timeout}
        future = asyncio.get_running_loop().create_future()
        self.pending[item['id']] = (item, future)
        self.broadcast({'type': 'pending', 'approval': item})
        try:
            return 'approved' if await asyncio.wait_for(future, self.timeout) else 'denied'
        except TimeoutError:
            return 'timeout'
        finally:
            self.pending.pop(item['id'], None)
            self.broadcast({'type': 'resolved', 'id': item['id']})

    def decide(self, approval_id, allow):
        entry = self.pending.get(approval_id)
        if entry is None or entry[1].done():
            raise ValueError('UNKNOWN_APPROVAL')
        entry[1].set_result(bool(allow))
        return {'id': approval_id, 'allowed': bool(allow)}

    async def watch(self, writer):
        """Streams pending approvals and changes until the watcher disconnects."""
        for item, _ in self.pending.values():
            writer.write(json.dumps({'type': 'pending', 'approval': item}).encode() + b'\n')
        self.watchers.add(writer)
        try:
            while not writer.is_closing():
                writer.write(b'{"type": "ping"}\n')
                await writer.drain()
                await asyncio.sleep(15)
        except (ConnectionError, RuntimeError):
            pass
        finally:
            self.watchers.discard(writer)


class Cell:
    def __init__(self, task, agent, grants, ask=()):
        self.task, self.agent, self.grants = task, agent, frozenset(grants)
        # Connectors whose writes wait for the user's approval.
        self.ask = frozenset(ask)
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
        runtime = request.get('runtime', 'codex')
        if runtime not in rules.RUNTIMES:
            raise ValueError('BAD_RUNTIME')
        if not isinstance(task, str) or not NAME.fullmatch(task):
            raise ValueError('BAD_TASK')
        if not isinstance(agent, str) or not NAME.fullmatch(agent):
            raise ValueError('BAD_AGENT')
        if not isinstance(connectors, list) or not all(c in rules.CONNECTORS for c in connectors):
            raise ValueError('BAD_CONNECTORS')
        ask = request.get('ask', [])
        if not isinstance(ask, list) or not all(c in connectors for c in ask):
            raise ValueError('BAD_APPROVALS')
        if task in self.cells:
            raise ValueError('CELL_EXISTS')
        # The cell gets its own runtime's credential only.
        return task, agent, set(connectors) | {runtime}

    async def register(self, request):
        task, agent, grants = self.validate(request)
        cell = Cell(task, agent, grants, request.get('ask', []))
        cell.directory.mkdir(parents=True, exist_ok=False)
        # The service runs with UMask=0077; the cell's agent user must traverse this directory.
        os.chmod(cell.directory, 0o755)
        path = cell.directory / 'proxy.sock'
        cell.server = await asyncio.start_unix_server(lambda r, w: self.bridge(cell, r, w), path=str(path))
        # Only this cell has the directory bound in; the agent user must be able to connect.
        os.chmod(path, 0o666)
        self.cells[task] = cell
        audit({'event': 'register', 'task': task, 'agent': agent, 'grants': sorted(grants), 'ask': sorted(cell.ask)})
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
    def __init__(self, registry=None, credentials=None, call=https_call):
        self.registry = registry or Registry(('127.0.0.1', 18080))
        self.credentials = credentials or Credentials()
        self.approvals = Approvals()
        self.call = call
        self.control = None
        # Server connection id → the (host, port) the client asked for, while it is being opened.
        self.requested = {}

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
            if op == 'approvals.watch':
                # A stream, not a request: it stays open while the daemon watches.
                return await self.approvals.watch(writer)
            if op == 'approvals.decide':
                result = self.approvals.decide(str(request.get('id', '')), request.get('allow') is True)
            elif op == 'register':
                result = await self.registry.register(request)
                result['identifiers'] = self.identifiers(self.registry.cells[request['task']].grants)
            elif op == 'unregister':
                task = request.get('task')
                if not isinstance(task, str) or not NAME.fullmatch(task):
                    raise ValueError('BAD_TASK')
                result = await self.registry.unregister(task)
            elif op == 'verify':
                result = await self.verify(request.get('connector'))
            elif op == 'poll':
                result = await self.poll(request.get('kind'), request.get('params'))
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

    async def verify(self, connector):
        """Calls the connector's identity endpoint with the stored credential, read afresh."""
        if connector not in rules.CONNECTORS:
            raise ValueError('BAD_CONNECTOR')
        self.credentials.invalidate(connector)
        loop = asyncio.get_running_loop()
        try:
            credential = await loop.run_in_executor(None, self.credentials.get, connector)
        except LookupError as exc:
            raise ValueError(f'NO_CREDENTIAL:{exc}') from None
        method, url, headers, body = rules.verify_request(connector, credential)
        try:
            status, content = await loop.run_in_executor(None, self.call, method, url, headers, body)
        except OSError:
            raise ValueError('VERIFY_UNREACHABLE') from None
        audit({'event': 'verify', 'connector': connector, 'status': status})
        return {'connector': connector, 'account': rules.verify_account(connector, status, content)}

    async def poll(self, kind, params):
        """One fixed read-only query for a polling trigger, with the connector's credential."""
        connector = rules.POLL_CONNECTOR.get(kind)
        if connector is None or not isinstance(params, dict):
            raise ValueError('BAD_POLL')
        loop = asyncio.get_running_loop()
        try:
            credential = await loop.run_in_executor(None, self.credentials.get, connector)
        except LookupError as exc:
            raise ValueError(f'NO_CREDENTIAL:{exc}') from None
        method, url, headers, body = rules.poll_request(kind, params, credential)
        try:
            status, content = await loop.run_in_executor(None, self.call, method, url, headers, body)
        except OSError:
            raise ValueError('POLL_UNREACHABLE') from None
        items = rules.poll_items(kind, status, content)
        audit({'event': 'poll', 'kind': kind, 'status': status, 'items': len(items)})
        return {'items': items}

    def identifiers(self, grants):
        """Non-secret values a cell needs locally, such as the Codex account id."""
        out = {}
        try:
            out['codex_account_id'] = self.credentials.fetch({'op': 'codex_account'})['account_id']
        except (LookupError, OSError, ValueError, KeyError):
            pass
        if 'claude' in grants:
            try:
                out['claude_kind'] = self.credentials.get('claude')['kind']
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
        self.requested[data.server.id] = data.server.address
        data.server.address = (address, port)

    def server_connected(self, data):
        """Name the connection by the requested host again once it is open to the checked address.

        mitmproxy reuses a server connection only when its address equals the request's (host,
        port), and allows five connections per address. Left as the IP, every keep-alive request
        would open a new connection, and the sixth would wait for one of the five to time out.
        The socket stays connected to the address checked in server_connect (`peername`).

        mitmproxy's Server.__setattr__ refuses address changes on open connections to protect
        addons from rerouting one; here the route is already fixed, so the guard is bypassed for
        this single field. Pinned mitmproxy version; `make verify-anchi` checks keep-alive reuse.
        """
        requested = self.requested.pop(data.server.id, None)
        if requested is not None:
            object.__setattr__(data.server, 'address', requested)

    def server_connect_error(self, data):
        """Upstream failures (DNS, refused, timeout) are otherwise only a bare 502 in the cell."""
        self.requested.pop(data.server.id, None)
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
        if decision.rule.grant in cell.ask and rules.is_write(decision, req.method, req.path, body):
            outcome = await self.approvals.ask(
                {
                    'task': cell.task,
                    'agent': cell.agent,
                    'connector': decision.rule.grant,
                    'operation': entry['op'],
                    'host': host,
                    'summary': write_summary(decision, req.method, path, body),
                }
            )
            entry['approval'] = outcome
            if outcome != 'approved':
                entry['decision'] = 'held-' + outcome
                audit(entry)
                reason = 'timed out' if outcome == 'timeout' else 'was denied'
                return self.respond(flow, 403, f'anchi: approval for this write {reason}\n'.encode())
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
