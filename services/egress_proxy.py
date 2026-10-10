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
import shutil
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
SERVICE_CONNECTORS = ('gmail', 'drive', 'notion', 'slack')
# Services with named Google accounts; the bridge pins one per cell.
ACCOUNT_SERVICES = ('gmail', 'drive')
ACCOUNT = re.compile(r'^[a-z0-9][a-z0-9_-]{0,31}$')
SERVICE_SOCKET = '/run/secure-{}/api.sock'
SERVICE_MAX = 256 * 1024
# Writes held by the policy service return at once; this bounds a slow upstream.
SERVICE_TIMEOUT = 150
APPROVAL_TIMEOUT = 300
SETTINGS = Path(os.environ.get('ANCHI_EGRESS_STATE', '/var/lib/anchi-egress')) / 'settings.json'


def load_settings():
    try:
        value = json.loads(SETTINGS.read_text())
        known = {entry[0] for entry in rules.HIGH_RISK}
        return {'high_risk_disabled': [d for d in value.get('high_risk_disabled', []) if d in known]}
    except (OSError, ValueError, AttributeError):
        return {'high_risk_disabled': []}


CREDENTIAL_ALERTS_MAX = 20
APPROVALS_PENDING_MAX = 32
# Rate-limit and usage information that subscription responses carry, by injection rule. Only
# headers with these prefixes are kept; their values are numbers and times, never credentials.
QUOTA_HEADERS = {'codex': ('x-codex-',), 'anthropic': ('anthropic-ratelimit-',)}
QUOTA_MAX_HEADERS = 40
# Codex sends its plan's windows in the model stream (WebSocket), as one JSON message of this type.
CODEX_RATE_LIMITS = b'codex.rate_limits'
QUOTA_MESSAGE_MAX = 16 * 1024
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


def codex_windows(content):
    """Plan and windows from a `codex.rate_limits` message, or None if it is not one."""
    try:
        data = json.loads(content)
    except ValueError:
        return None
    limits = data.get('rate_limits') if isinstance(data, dict) else None
    if data.get('type') != 'codex.rate_limits' or not isinstance(limits, dict):
        return None
    windows = []
    for name in ('primary', 'secondary'):
        w = limits.get(name)
        if not isinstance(w, dict):
            continue
        number = lambda v: v if isinstance(v, (int, float)) and not isinstance(v, bool) else None  # noqa: E731
        windows.append(
            {
                'name': name,
                'used_percent': number(w.get('used_percent')),
                'window_minutes': number(w.get('window_minutes')),
                'reset_at': number(w.get('reset_at')),
            }
        )
    plan = data.get('plan_type')
    return {
        'plan': plan[:40] if isinstance(plan, str) else None,
        'limited': limits.get('limit_reached') is True or limits.get('allowed') is False,
        'windows': windows,
    }


class PushInspector:
    """The body filter of a streamed git push. Nothing of the body leaves until the ref updates at
    its start have been read and checked; then all of it goes, or none of it. A refused push
    reaches upstream with its headers (and credential) but an empty body, which changes nothing,
    and git gets a report of the rejected refs. A high-risk push cannot wait for approval here:
    holding would stall the upload, so it is refused."""

    def __init__(self, proxy, flow, cell, decision, entry):
        self.proxy, self.flow, self.cell, self.decision, self.entry = proxy, flow, cell, decision, entry
        self.buffer = bytearray()
        self.forwarding = None  # None while reading the updates, then True or False

    def __call__(self, data):
        if self.forwarding is True:
            return data
        if self.forwarding is False:
            return []
        self.buffer += data
        head = bytes(self.buffer[: rules.GIT_COMMANDS_MAX])
        try:
            parsed = rules.git_push_commands(head)
            if parsed is None and (not data or len(self.buffer) >= rules.GIT_COMMANDS_MAX):
                raise ValueError('the push ended before its ref updates')
        except ValueError as exc:
            return self.refuse([], frozenset(), ('github-push-unreadable', str(exc)))
        if parsed is None:
            return []
        risk = rules.high_risk(
            self.decision, 'POST', self.entry['path'], head, self.proxy.settings['high_risk_disabled']
        )
        if risk:
            return self.refuse(*parsed, risk)
        self.forwarding = True
        audit(self.row(parsed[0], 'inject'))
        body, self.buffer = bytes(self.buffer), bytearray()
        return [body] if body else []

    def row(self, updates, decision, **extra):
        refs = [rules.git_update_subject(*u) for u in updates[:50]]
        return {
            'event': 'push',
            'task': self.cell.task,
            'agent': self.cell.agent,
            'host': self.entry['host'],
            'path': self.entry['path'],
            'op': ('git push: ' + ', '.join(refs))[:500],
            'decision': decision,
            **extra,
        }

    def refuse(self, updates, caps, risk):
        self.forwarding, self.buffer = False, bytearray()
        reason = (
            f'{risk[1]}: a push this large cannot wait for approval; push to another branch and open a pull request'
        )
        audit(self.row(updates, 'deny', risk=risk[0], reason=reason[:200]))
        self.flow.metadata['anchi-push-refused'] = ([u[2] for u in updates], caps, reason)
        self.proxy.approvals.broadcast(
            {
                'type': 'notice',
                'task': self.cell.task,
                'text': f'⛔ git push refused: {self.row(updates, "deny")["op"][10:] or "unreadable ref updates"} ({reason})'[
                    :500
                ],
            }
        )
        return []


def git_rejection(refs, caps, reason):
    """(status, body, headers) that git shows as `! [remote rejected] REF (anchi: reason)`."""
    message = f'anchi: {reason}'.encode('ascii', 'replace')
    if not refs or not caps & {b'report-status', b'report-status-v2'}:
        return 403, message + b'\n', {'content-type': 'text/plain'}
    report = git_pkt(b'unpack ok\n') + b''.join(git_pkt(b'ng %s %s\n' % (ref, message)) for ref in refs) + b'0000'
    if caps & {b'side-band-64k', b'side-band'}:
        size = 65515 if b'side-band-64k' in caps else 995
        report = b''.join(git_pkt(b'\x01' + report[i : i + size]) for i in range(0, len(report), size)) + b'0000'
    return 200, report, {'content-type': 'application/x-git-receive-pack-result', 'cache-control': 'no-cache'}


def git_pkt(data):
    return b'%04x' % (len(data) + 4) + data


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
    def __init__(self, task, agent, grants, ask=(), egress=None):
        self.task, self.agent, self.grants = task, agent, frozenset(grants)
        # Connectors whose writes wait for the user's approval.
        self.ask = frozenset(ask)
        # Hosts the cell may reach; None is open egress.
        self.egress = rules.egress_allowlist(egress, self.grants)
        self.server = None
        self.writers = set()
        # Connector services this cell reaches through the bridge, and their sockets.
        self.services = frozenset()
        # The Google account per service; `default` when the agent names none.
        self.accounts = {}
        self.service_servers = []
        # Hosts the cell sent a credential of its own to, already reported to the daemon.
        self.credential_alerts = set()
        # Hosts refused by the egress list, already noted in the task.
        self.egress_notices = set()

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
        services = request.get('services', [])
        if not isinstance(services, list) or not all(s in SERVICE_CONNECTORS for s in services):
            raise ValueError('BAD_SERVICES')
        accounts = request.get('accounts', {})
        if not isinstance(accounts, dict) or not all(
            s in services and s in ACCOUNT_SERVICES and isinstance(a, str) and ACCOUNT.fullmatch(a)
            for s, a in accounts.items()
        ):
            raise ValueError('BAD_ACCOUNTS')
        egress = request.get('egress')
        if egress is not None and (
            not isinstance(egress, list)
            or len(egress) > 100
            or not all(isinstance(p, str) and rules.EGRESS_PATTERN.fullmatch(p) for p in egress)
        ):
            raise ValueError('BAD_EGRESS')
        if task in self.cells:
            raise ValueError('CELL_EXISTS')
        # The cell gets its own runtime's credential only.
        return task, agent, set(connectors) | {runtime}

    async def register(self, request):
        task, agent, grants = self.validate(request)
        cell = Cell(task, agent, grants, request.get('ask', []), request.get('egress'))
        cell.directory.mkdir(parents=True, exist_ok=False)
        # The service runs with UMask=0077; the cell's agent user must traverse this directory.
        os.chmod(cell.directory, 0o755)
        path = cell.directory / 'proxy.sock'
        cell.server = await asyncio.start_unix_server(lambda r, w: self.bridge(cell, r, w), path=str(path))
        # Only this cell has the directory bound in; the agent user must be able to connect.
        os.chmod(path, 0o666)
        cell.services = frozenset(request.get('services', []))
        cell.accounts = {
            s: request.get('accounts', {}).get(s, 'default') for s in cell.services if s in ACCOUNT_SERVICES
        }
        for service in sorted(cell.services):
            directory = cell.directory / 'connectors' / service
            directory.mkdir(parents=True)
            os.chmod(directory.parent, 0o755)
            os.chmod(directory, 0o755)
            server = await asyncio.start_unix_server(
                lambda r, w, s=service: self.service_bridge(cell, s, r, w),
                path=str(directory / 'api.sock'),
                limit=SERVICE_MAX,
            )
            os.chmod(directory / 'api.sock', 0o666)
            cell.service_servers.append(server)
        self.cells[task] = cell
        audit(
            {
                'event': 'register',
                'task': task,
                'agent': agent,
                'grants': sorted(grants),
                'ask': sorted(cell.ask),
                'egress': None if cell.egress is None else sorted(cell.egress),
                'services': sorted(cell.services),
                'accounts': cell.accounts,
            }
        )
        return {'directory': str(cell.directory)}

    async def service_bridge(self, cell, service, reader, writer):
        """One request from the cell to a connector service, naming the cell's agent and, for
        Google services, its account. The service accepts both only from this UID; the cell's own
        `agent` and `account` fields are replaced or dropped."""
        try:
            line = await asyncio.wait_for(reader.readline(), 30)
            request = json.loads(line) if line.endswith(b'\n') else None
            if not isinstance(request, dict):
                raise ValueError('BAD_REQUEST')
            request['agent'] = cell.agent
            request.pop('account', None)
            if service in cell.accounts:
                request['account'] = cell.accounts[service]
            up_reader, up_writer = await asyncio.open_unix_connection(SERVICE_SOCKET.format(service), limit=SERVICE_MAX)
            try:
                up_writer.write(json.dumps(request, ensure_ascii=False).encode() + b'\n')
                await up_writer.drain()
                answer = await asyncio.wait_for(up_reader.readline(), SERVICE_TIMEOUT)
            finally:
                up_writer.close()
            audit(
                {
                    'event': 'service',
                    'service': service,
                    'op': str(request.get('op'))[:40],
                    'task': cell.task,
                    'agent': cell.agent,
                    **({'account': cell.accounts[service]} if service in cell.accounts else {}),
                }
            )
            writer.write(answer if answer.endswith(b'\n') else b'{"ok":false,"error":"SERVICE_UNAVAILABLE"}\n')
        except (ValueError, asyncio.LimitOverrunError, asyncio.IncompleteReadError):
            writer.write(b'{"ok":false,"error":"BAD_REQUEST"}\n')
        except (OSError, TimeoutError):
            writer.write(b'{"ok":false,"error":"SERVICE_UNAVAILABLE"}\n')
        try:
            await writer.drain()
        except ConnectionError:
            pass
        writer.close()

    async def unregister(self, task):
        cell = self.cells.pop(task, None)
        if cell is None:
            return {'removed': False}
        cell.server.close()
        for server in cell.service_servers:
            server.close()
        for writer in list(cell.writers):
            writer.close()
        shutil.rmtree(cell.directory, ignore_errors=True)
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
        self.settings = load_settings()
        self.call = call
        self.control = None
        # Latest quota headers per runtime rule: {rule: {ts, status, headers}}.
        self.quota = {}
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
            elif op == 'settings.set':
                result = self.set_settings(request.get('settings'))
            elif op == 'poll':
                result = await self.poll(request.get('kind'), request.get('params'))
            elif op == 'quota':
                result = self.quota
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

    def set_settings(self, value):
        """Settings the daemon owns (the user's high-risk exceptions), kept across restarts."""
        if not isinstance(value, dict):
            raise ValueError('BAD_SETTINGS')
        known = {entry[0] for entry in rules.HIGH_RISK}
        disabled = value.get('high_risk_disabled', [])
        if not isinstance(disabled, list) or not all(d in known for d in disabled):
            raise ValueError('BAD_SETTINGS')
        self.settings = {'high_risk_disabled': sorted(set(disabled))}
        SETTINGS.parent.mkdir(parents=True, exist_ok=True)
        temporary = SETTINGS.with_suffix('.tmp')
        temporary.write_text(json.dumps(self.settings))
        os.replace(temporary, SETTINGS)
        audit({'event': 'settings', 'high_risk_disabled': self.settings['high_risk_disabled']})
        return self.settings

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

    def note_egress_denied(self, cell, host):
        """A note in the task once per refused host and cell, so the user sees it while it runs."""
        if host in cell.egress_notices or len(cell.egress_notices) >= CREDENTIAL_ALERTS_MAX:
            return
        cell.egress_notices.add(host)
        self.approvals.broadcast(
            {
                'type': 'notice',
                'task': cell.task,
                'text': f'⛔ {host} is not in the egress list; the connection was refused. To allow it, '
                f'press a on the task, then e (or anchi agents allow-host {cell.agent} {host})',
            }
        )

    async def server_connect(self, data):
        """Resolve once, refuse non-public destinations and connect to the checked address."""
        host, port = data.server.address
        cell = self.registry.client_cell(data.client)
        if cell is not None and not rules.egress_allowed(cell.egress, str(host).lower().rstrip('.')):
            data.server.error = f'anchi: {host} is not in this agent\'s egress list'
            audit({'decision': 'egress-denied', 'host': str(host)[:200], 'task': cell.task, 'agent': cell.agent})
            self.note_egress_denied(cell, str(host).lower().rstrip('.')[:200])
            return
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

    async def requestheaders(self, flow):
        """A streamed body (over 8 MiB) follows its headers upstream before `request` runs, so
        streamed requests are decided here. Only S3 calls are injected on this path: their
        operation and risk come from the method and path. Other streamed requests leave without
        injection. A refusal here can only drop the connection."""
        req = flow.request
        cell = None
        if not req.stream:
            # A git push without a length (git sends one above http.postBuffer, 1 MiB) streams from
            # here, so its ref updates can be checked before any of it leaves (PushInspector).
            cell = self.registry.client_cell(flow.client_conn) if self.chunked_push(req) else None
            if cell is None or not self.streams_push(req, cell):
                return
            flow.metadata['anchi-push'] = True
        flow.metadata['anchi-streamed'] = True
        cell = cell or self.registry.client_cell(flow.client_conn)
        if cell is None:
            return flow.kill()
        refusal = await self.handle(flow, cell, b'', streamed=True)
        if refusal is not None:
            flow.kill()

    @staticmethod
    def chunked_push(req):
        headers = req.headers
        return (
            req.method == 'POST'
            and req.path.split('?', 1)[0].endswith('/git-receive-pack')
            # Chunked over HTTP/1.1; over HTTP/2 a body of unknown length has no length header.
            and 'content-length' not in headers
            and 'content-encoding' not in headers
        )

    @staticmethod
    def streams_push(req, cell):
        """Whether a chunked push streams. Not when the agent's GitHub writes ask: those wait
        for the user with the whole body, up to 8 MiB."""
        if 'github' in cell.ask:
            return False
        headers = {k.lower(): v for k, v in req.headers.items()}
        decision = rules.decide(req.method, req.pretty_host, req.path, headers, b'', cell.grants)
        return decision.action == 'inject' and decision.rule.name == 'github-git'

    def response(self, flow):
        """A refused streamed push left upstream empty; git gets the rejection instead."""
        refused = flow.metadata.get('anchi-push-refused')
        if refused is not None:
            self.respond(flow, *git_rejection(*refused))

    async def request(self, flow):
        if flow.metadata.get('anchi-streamed'):
            return
        cell = self.registry.client_cell(flow.client_conn)
        if cell is None:
            return self.respond(flow, 403, b'anchi: unknown cell\n')
        # A body without a length that grew past 8 MiB switched to streaming after
        # `requestheaders`: its headers have left unchanged, and only the audit remains.
        late = bool(flow.request.stream)
        body = b'' if late else (flow.request.get_content(strict=False) or b'')
        refusal = await self.handle(flow, cell, body, streamed=late, late=late)
        if refusal is not None:
            self.respond(flow, *refusal)

    def responseheaders(self, flow):
        """Keeps the quota information of a runtime's response (and notes a 429), so the user can
        see how much of a subscription is used without trusting what runs in the cells."""
        rule = flow.metadata.get('anchi-quota')
        if rule is None or flow.response is None:
            return
        prefixes = QUOTA_HEADERS[rule]
        headers = {}
        for name, value in flow.response.headers.items():
            key = name.lower()
            if key.startswith(prefixes) and len(value) <= 200 and value.isprintable():
                headers[key] = value
                if len(headers) >= QUOTA_MAX_HEADERS:
                    break
        status = flow.response.status_code
        if headers or status == 429:
            if status == 429 and 'retry-after' in flow.response.headers:
                headers['retry-after'] = flow.response.headers['retry-after'][:40]
            self.quota[rule] = {
                **self.quota.get(rule, {}),
                'ts': round(time.time(), 3),
                'status': status,
                'headers': headers,
            }

    def websocket_message(self, flow):
        """Codex's rate-limit message in the model stream: its plan and usage windows. Only this
        message type is parsed; model output passes untouched."""
        if flow.metadata.get('anchi-quota') != 'codex' or flow.websocket is None:
            return
        message = flow.websocket.messages[-1]
        content = message.content
        if message.from_client or len(content) > QUOTA_MESSAGE_MAX or CODEX_RATE_LIMITS not in content:
            return
        windows = codex_windows(content)
        if windows is not None:
            self.quota['codex'] = {
                **self.quota.get('codex', {'headers': {}}),
                'ts': round(time.time(), 3),
                'status': 200,
                **windows,
            }

    def alert_credential(self, cell, entry):
        """Tells the daemon at once that a cell sent a credential that is not a placeholder: Anchi's
        own never enter a cell, so it came from elsewhere. Once per host and cell; the audit log
        has every request."""
        if entry['host'] in cell.credential_alerts or len(cell.credential_alerts) >= CREDENTIAL_ALERTS_MAX:
            return
        cell.credential_alerts.add(entry['host'])
        self.approvals.broadcast(
            {
                'type': 'credential',
                'task': cell.task,
                'agent': cell.agent,
                'method': entry['method'],
                'host': entry['host'][:200],
                'path': entry['path'][:200],
            }
        )

    async def handle(self, flow, cell, body, streamed, late=False):
        """Decide, hold for approval and inject. Returns None, or (status, content, headers) to refuse."""
        req = flow.request
        req.headers.pop('proxy-authorization', None)
        headers = {k.lower(): v for k, v in req.headers.items()}
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
        if entry['client_cred'] == 'other':
            self.alert_credential(cell, entry)
        # Checked again when the connection opens; refusing here keeps the request off the
        # upstream path, so it is never audited as reaching the host.
        if not rules.egress_allowed(cell.egress, host.lower().rstrip('.')):
            entry['decision'] = 'egress-denied'
            audit(entry)
            self.note_egress_denied(cell, host.lower().rstrip('.')[:200])
            return 403, f"anchi: {host} is not in this agent's egress list\n".encode(), None
        if late and decision.action != 'pass':
            entry['decision'] = 'pass:streamed'
            audit(entry)
            return None
        if decision.action == 'deny':
            audit(entry)
            return rules.deny_response(decision, headers)
        if decision.action == 'pass':
            audit(entry)
            return None
        # A streamed git push is checked by its ref updates on the way (PushInspector).
        push = streamed and not late and flow.metadata.get('anchi-push') is True
        if streamed and not push and not (decision.rule.kind == 'aws_sigv4' and (decision.op or '').startswith('s3:')):
            entry['decision'] = 'pass:streamed'
            audit(entry)
            return None
        # High-risk operations wait for the user for every agent (phase 3, F1); other writes
        # wait when the agent's approvals ask for its connector.
        risk = (
            None if push else rules.high_risk(decision, req.method, req.path, body, self.settings['high_risk_disabled'])
        )
        if not push and (
            risk or (decision.rule.grant in cell.ask and rules.is_write(decision, req.method, req.path, body))
        ):
            entry['risk'] = risk[0] if risk else None
            outcome = await self.approvals.ask(
                {
                    'task': cell.task,
                    'agent': cell.agent,
                    'connector': decision.rule.grant,
                    'operation': entry['op'],
                    'host': host,
                    'summary': write_summary(decision, req.method, path, body),
                    'reason': f'high-risk: {risk[1]}' if risk else f'approvals: {decision.rule.grant} asks',
                }
            )
            entry['approval'] = outcome
            if outcome != 'approved':
                entry['decision'] = 'held-' + outcome
                audit(entry)
                reason = 'timed out' if outcome == 'timeout' else 'was denied'
                return 403, f'anchi: approval for this write {reason}\n'.encode(), None
        try:
            credential = await asyncio.get_running_loop().run_in_executor(
                None, self.credentials.get, decision.rule.grant
            )
            new = rules.apply(decision, req.method, req.url, headers, body, credential)
            resigner = rules.aws_chunk_resigner(new, credential) if decision.rule.kind == 'aws_sigv4' else None
            if resigner is not None and not streamed:
                req.raw_content = resigner.feed(req.raw_content or b'') + resigner.feed(b'')
        except LookupError as exc:
            entry['decision'] = 'missing-credential'
            entry['reason'] = str(exc)[:100]
            audit(entry)
            return 502, f'anchi: credential unavailable ({exc})\n'.encode(), None
        except ValueError as exc:
            entry['decision'] = 'rejected'
            entry['reason'] = str(exc)[:200]
            audit(entry)
            return 403, f'anchi: {exc}\n'.encode(), None
        if resigner is not None and streamed:

            def stream(data):
                # Raising ends the connection, so upstream gets a truncated body, never a forged one.
                try:
                    return resigner.feed(data)
                except ValueError as exc:
                    audit({**entry, 'decision': 'rejected', 'reason': str(exc)[:200]})
                    raise

            req.stream = stream
        if push:
            entry['push'] = 'streamed'
            req.stream = PushInspector(self, flow, cell, decision, entry)
        req.headers.clear()
        for key, value in new.items():
            req.headers[key] = value
        if decision.rule.name in QUOTA_HEADERS:
            flow.metadata['anchi-quota'] = decision.rule.name
        audit(entry)
        return None

    @staticmethod
    def respond(flow, status, content, headers=None):
        from mitmproxy import http

        flow.response = http.Response.make(status, content, headers or {'content-type': 'text/plain'})


addons = [EgressProxy()]
