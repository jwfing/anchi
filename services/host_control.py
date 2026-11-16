"""The daemon's guest commands on a host placement: what `anchi-cell` answers in the VM, for a
machine without cells. Everything here is a thin client of the egress proxy's control socket
under `ANCHI_HOST_STATE`; it runs as the user, like the proxy. Output is one JSON line, as
guest/anchi_cell.py prints it, so the daemon parses both the same way.

  host_control.py version | list | reap [task...] | quota | verify <connector> | poll
  host_control.py egress-settings            {"high_risk_disabled": [...], ...} on stdin
  host_control.py register                   {"connectors": [...], "listen_port": N, ...} on stdin
  host_control.py unregister
  host_control.py approvals watch | approvals decide <id> allow|deny
"""

import json
import re
import socket
import sys
from pathlib import Path

import placement

# The one principal a host placement registers with its proxy: the user's own sessions.
PRINCIPAL = 'host'
PROXY_CONNECTORS = ('github', 'aws', 'linear', 'posthog', 'sentry', 'firecrawl', 'figma', 'discord')
VERSION_FILE = Path(__file__).resolve().parents[1] / 'anchi' / 'package.json'


class Failure(Exception):
    pass


def control_socket():
    if not placement.HOST:
        raise Failure('HOST_STATE_REQUIRED')
    return placement.ROOT / 'run' / 'egress' / 'control.sock'


def emit(value):
    print(json.dumps(value))


def egress(request, timeout=15):
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
            conn.settimeout(timeout)
            conn.connect(str(control_socket()))
            conn.sendall(json.dumps(request).encode() + b'\n')
            data = b''
            while not data.endswith(b'\n'):
                block = conn.recv(65536)
                if not block:
                    break
                data += block
    except OSError:
        raise Failure('EGRESS_UNAVAILABLE') from None
    response = json.loads(data or b'{}')
    if not response.get('ok'):
        raise Failure(response.get('error', 'EGRESS_ERROR'))
    return response['result']


def stdin_json(limit):
    raw = sys.stdin.read(limit + 1)
    if len(raw) > limit:
        raise Failure('INPUT_TOO_LARGE')
    value = json.loads(raw or '{}')
    if not isinstance(value, dict):
        raise Failure('BAD_REQUEST')
    return value


def version():
    """The Anchi version that installed the host side (scripts/host-install.sh writes
    installed.json), in the shape of `anchi-cell version`; the checkout's own version without it."""
    files = [placement.ROOT.parent / 'installed.json'] if placement.HOST else []
    files += [VERSION_FILE.parents[1] / 'manifest.json', VERSION_FILE]
    for file in files:
        try:
            data = json.loads(file.read_text())
        except (OSError, ValueError):
            continue
        value = data.get('version') if isinstance(data, dict) else None
        if isinstance(value, str) and value:
            installed_at = data.get('installed_at')
            return {
                'runtime_version': value[:40],
                'installed_at': str(installed_at)[:40] if isinstance(installed_at, (int, float, str)) else None,
            }
    return {'runtime_version': 'unknown', 'installed_at': None}


def register():
    """Registers the host principal: the connectors the user connected, what waits for approval,
    and the loopback port the user's runtimes are pointed at. The proxy validates every field."""
    spec = stdin_json(16384)
    connectors = spec.get('connectors', [])
    if not isinstance(connectors, list) or not all(c in PROXY_CONNECTORS for c in connectors):
        raise Failure('BAD_CONNECTORS')
    request = {
        'op': 'register',
        'task': PRINCIPAL,
        'agent': PRINCIPAL,
        'runtime': 'codex',
        'connectors': connectors,
        'ask': spec.get('ask', []),
        'high_risk_disabled': spec.get('high_risk_disabled', []),
        'egress': spec.get('egress'),
        'listen_port': spec.get('listen_port'),
    }
    try:
        return egress(request)
    except Failure as exc:
        if str(exc) != 'CELL_EXISTS':
            raise
        # Settings changed: the principal is registered again with them.
        egress({'op': 'unregister', 'task': PRINCIPAL})
        return egress(request)


def approvals_watch():
    """Relays the proxy's approval stream to stdout (the daemon's watcher) until it ends."""
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
            conn.settimeout(60)
            conn.connect(str(control_socket()))
            conn.sendall(b'{"op": "approvals.watch"}\n')
            while block := conn.recv(65536):
                sys.stdout.buffer.write(block)
                sys.stdout.buffer.flush()
    except OSError:
        raise Failure('EGRESS_UNAVAILABLE') from None


def main(argv):
    args = argv[1:]
    if not args:
        raise Failure('USAGE')
    command, rest = args[0], args[1:]
    if command == 'version' and not rest:
        return emit(version())
    if command == 'list' and not rest:
        return emit({'cells': []})
    if command == 'reap':
        return emit({'reaped': []})
    if command == 'quota' and not rest:
        return emit(egress({'op': 'quota'}))
    if command == 'verify' and len(rest) == 1 and rest[0] in PROXY_CONNECTORS:
        return emit(egress({'op': 'verify', 'connector': rest[0]}, timeout=40))
    if command == 'poll' and not rest:
        spec = stdin_json(4096)
        return emit(egress({'op': 'poll', 'kind': spec.get('kind'), 'params': spec.get('params')}, timeout=40))
    if command == 'egress-settings' and not rest:
        return emit(egress({'op': 'settings.set', 'settings': stdin_json(65536)}))
    if command == 'register' and not rest:
        return emit(register())
    if command == 'unregister' and not rest:
        return emit(egress({'op': 'unregister', 'task': PRINCIPAL}))
    if command == 'approvals' and rest == ['watch']:
        return approvals_watch()
    if command == 'approvals' and len(rest) == 3 and rest[0] == 'decide':
        if not re.fullmatch(r'[0-9a-f]{16}', rest[1]) or rest[2] not in ('allow', 'deny'):
            raise Failure('USAGE')
        return emit(egress({'op': 'approvals.decide', 'id': rest[1], 'allow': rest[2] == 'allow'}))
    raise Failure('USAGE')


if __name__ == '__main__':
    try:
        main(sys.argv)
    except Failure as exc:
        emit({'error': str(exc)})
        sys.exit(1)
    except (OSError, ValueError) as exc:
        emit({'error': 'HOST_OPERATION_FAILED', 'detail': type(exc).__name__})
        sys.exit(1)
