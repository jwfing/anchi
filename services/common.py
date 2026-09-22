"""Bounded local RPC and fixed-destination HTTPS; no third-party dependencies."""

import http.client
import ipaddress
import json
import re
import socket
import ssl
import struct
from pathlib import Path
import time

# Shared with pi/limits.mjs and desktop/src/shared/protocol.cjs; a test keeps them identical.
LIMITS = {'rpc_bytes': 65536, 'prompt_chars': 8000, 'host_file_text_bytes': 24000}
MAX_RPC = LIMITS['rpc_bytes']
TARGETS_FILE = Path('/run/secure-egress/targets.json')
CELL_ENV_PATHS = (Path('/opt/secure-vm/cell.env'), Path(__file__).resolve().parents[1] / 'guest/cell.env')


def load_cell_env(paths=CELL_ENV_PATHS):
    """KEY=VALUE file shared with the guest shell scripts; fail closed when absent."""
    for path in paths:
        try:
            text = path.read_text()
        except OSError:
            continue
        values = {}
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            key, separator, value = line.partition('=')
            if separator and key.strip():
                values[key.strip()] = value.strip()
        return values
    raise RuntimeError('cell.env not installed; run guest/bootstrap.sh')


CELL = load_cell_env()
CELL_UID_BASE = int(CELL['SECURE_CELL_UID_BASE'])
CELL_UID_COUNT = int(CELL['SECURE_CELL_UID_COUNT'])
CELL_AGENT_UID = int(CELL['SECURE_CELL_AGENT_UID'])
CELL_AGENT_HOST_UID = CELL_UID_BASE + CELL_AGENT_UID
PI_VERSION = CELL['SECURE_PI_VERSION']


class Denied(Exception):
    pass


def recv_json(conn):
    data = bytearray()
    while b'\n' not in data:
        block = conn.recv(min(4096, MAX_RPC + 1 - len(data)))
        if not block:
            raise Denied('BAD_REQUEST')
        data.extend(block)
        if len(data) > MAX_RPC:
            raise Denied('REQUEST_TOO_LARGE')
    line, rest = data.split(b'\n', 1)
    if rest:
        raise Denied('BAD_REQUEST')
    try:
        value = json.loads(line)
    except (ValueError, UnicodeError):
        raise Denied('BAD_REQUEST') from None
    if not isinstance(value, dict):
        raise Denied('BAD_REQUEST')
    return value


def send_json(conn, value):
    data = json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode() + b'\n'
    if len(data) > MAX_RPC:
        raise Denied('RESPONSE_TOO_LARGE')
    conn.sendall(data)


def rpc(path, request, timeout=30):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
        conn.settimeout(timeout)
        conn.connect(path)
        send_json(conn, request)
        response = recv_json(conn)
    if not response.get('ok'):
        raise Denied(response.get('error', 'SERVICE_ERROR'))
    return response['result']


def peer_uid(conn):
    return struct.unpack('3i', conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[1]


def fields(request, allowed, required=()):
    if set(request) - set(allowed) or not set(required) <= set(request):
        raise Denied('BAD_REQUEST')


def target_ips(host):
    try:
        value = json.loads(TARGETS_FILE.read_text())[host]
        addresses = value['addresses']
        if (
            value['expires_at'] <= time.time()
            or not addresses
            or any(not ipaddress.ip_address(a).is_global for a in addresses)
        ):
            raise ValueError()
        return addresses
    except (OSError, ValueError, KeyError, TypeError):
        raise Denied('EGRESS_TARGETS_UNAVAILABLE') from None


def google_json(host, method, path, body=None, token=None):
    if (
        (host, method) not in {('gmail.googleapis.com', 'GET'), ('oauth2.googleapis.com', 'POST')}
        or not path.startswith('/')
        or path.startswith('//')
    ):
        raise Denied('DESTINATION_DENIED')
    if host == 'oauth2.googleapis.com' and path not in ('/token', '/revoke'):
        raise Denied('DESTINATION_DENIED')
    if host == 'gmail.googleapis.com' and not path.startswith('/gmail/v1/users/me/messages'):
        raise Denied('DESTINATION_DENIED')
    # Services cannot use DNS. A root-maintained, expiring allowlist pins the address.
    addresses = target_ips(host)
    conn = http.client.HTTPSConnection(host, timeout=10)
    raw = socket.create_connection((addresses[0], 443), timeout=10)
    try:
        conn.sock = ssl.create_default_context().wrap_socket(raw, server_hostname=host)
        headers = {'Accept': 'application/json'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        if body is not None:
            headers['Content-Type'] = 'application/x-www-form-urlencoded'
        conn.request(method, path, body=body, headers=headers)
        response = conn.getresponse()
        if response.status != 200:
            # Never reflect provider error bodies, request URLs, or tokens to logs/cell.
            # Token-endpoint 400 means invalid_grant/invalid_client: the user must re-authorize.
            auth_failure = response.status in (401, 403) or (host == 'oauth2.googleapis.com' and response.status == 400)
            code = 'GOOGLE_AUTH_REQUIRED' if auth_failure else 'GOOGLE_REQUEST_FAILED'
            raise Denied(code)
        payload = response.read(2 * 1024 * 1024 + 1)
        if len(payload) > 2 * 1024 * 1024:
            raise Denied('GOOGLE_RESPONSE_TOO_LARGE')
        return json.loads(payload) if payload else {}
    finally:
        conn.close()
        raw.close()


def https_transport(host, method, path, headers, body):
    """Fixed-IP HTTPS with hostname verification; no redirects, no proxies, bounded read."""
    addresses = target_ips(host)
    conn = http.client.HTTPSConnection(host, timeout=30)
    raw = socket.create_connection((addresses[0], 443), timeout=10)
    try:
        raw.settimeout(30)
        conn.sock = ssl.create_default_context().wrap_socket(raw, server_hostname=host)
        conn.request(method, path, body=body, headers=headers)
        response = conn.getresponse()
        return response.status, response.read(2 * 1024 * 1024 + 1)
    finally:
        conn.close()
        raw.close()


TRANSPORT = https_transport
PROVIDER_METHODS = ('GET', 'POST', 'PATCH')


def provider_request(
    connector,
    method,
    path,
    *,
    token=None,
    headers=None,
    body=None,
    content_type=None,
    raw=False,
    max_bytes=2 * 1024 * 1024,
):
    """One request to a connector's single host; the path must match the connector's allowlist."""
    if (
        method not in PROVIDER_METHODS
        or not isinstance(path, str)
        or not path.startswith('/')
        or path.startswith('//')
        or '..' in path
    ):
        raise Denied('DESTINATION_DENIED')
    if not any(re.fullmatch(pattern, path) for pattern in connector.paths):
        raise Denied('DESTINATION_DENIED')
    request_headers = {'Accept': 'application/json', **(headers or {})}
    if token:
        request_headers['Authorization'] = 'Bearer ' + token
    if body is not None:
        request_headers['Content-Type'] = content_type or 'application/json; charset=utf-8'
    status, payload = TRANSPORT(connector.hosts[0], method, path, request_headers, body)
    if status != 200:
        # Never reflect provider error bodies: they can echo tokens or private content.
        if status in (401, 403):
            raise Denied('PROVIDER_AUTH_REQUIRED')
        raise Denied('PROVIDER_RATE_LIMITED' if status == 429 else 'PROVIDER_REQUEST_FAILED')
    if len(payload) > max_bytes:
        raise Denied('PROVIDER_RESPONSE_TOO_LARGE')
    if raw:
        return payload
    try:
        return json.loads(payload) if payload else {}
    except ValueError:
        raise Denied('PROVIDER_RESPONSE_INVALID') from None
