"""Bounded local RPC and fixed-destination HTTPS; no third-party dependencies."""
import http.client
import ipaddress
import json
import socket
import ssl
import struct

MAX_RPC = 65536

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
    data = json.dumps(value, ensure_ascii=True, separators=(',', ':')).encode() + b'\n'
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

def google_json(host, method, path, body=None, token=None):
    if (host, method) not in {
        ('gmail.googleapis.com', 'GET'), ('oauth2.googleapis.com', 'POST')
    } or not path.startswith('/') or path.startswith('//'):
        raise Denied('DESTINATION_DENIED')
    # Resolve once, reject non-public addresses, connect that exact IP with hostname TLS.
    addresses = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
        raise Denied('DESTINATION_DENIED')
    conn = http.client.HTTPSConnection(host, timeout=10)
    raw = socket.create_connection((addresses[0][4][0], 443), timeout=10)
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
            code = 'GOOGLE_AUTH_REQUIRED' if response.status in (401, 403) else 'GOOGLE_REQUEST_FAILED'
            raise Denied(code)
        payload = response.read(2 * 1024 * 1024 + 1)
        if len(payload) > 2 * 1024 * 1024:
            raise Denied('GOOGLE_RESPONSE_TOO_LARGE')
        return json.loads(payload)
    finally:
        conn.close()
        raw.close()
