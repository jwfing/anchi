"""Fixed subscription endpoint, pinned public IP, bounded SSE, no retries."""

import http.client
import json
import socket
import ssl
import time
from common import PI_VERSION, Denied, target_ips


def read_response(response):
    if response.status != 200:
        code = {401: 'CODEX_AUTH_REQUIRED', 403: 'CODEX_ACCESS_DENIED', 429: 'CODEX_USAGE_LIMIT'}.get(
            response.status, 'CODEX_HTTP_' + str(response.status)
        )
        body = response.read(16384).lower()
        for term, label in [
            (b'model', 'MODEL'),
            (b'unsupported parameter', 'UNSUPPORTED_PARAMETER'),
            (b'instructions', 'INSTRUCTIONS'),
            (b'stream', 'STREAM'),
            (b'tool', 'TOOL'),
            (b'reasoning', 'REASONING'),
            (b'input', 'INPUT'),
            (b'cookie', 'COOKIE'),
        ]:
            if term in body:
                code += '_' + label
        raise Denied(code)
    content_type = response.getheader('Content-Type', '').lower()
    if content_type.startswith('application/json'):
        raw = response.read(262145)
        if len(raw) > 262144:
            raise Denied('CODEX_RESPONSE_TOO_LARGE')
        return normalize_response(json.loads(raw))
    # Some subscription backends omit the SSE content type; require valid events instead.
    if content_type.startswith('text/html'):
        raise Denied('CODEX_UNEXPECTED_HTML')
    size, deadline = 0, time.monotonic() + 120
    items = []
    while time.monotonic() < deadline:
        line = response.readline(262145)
        if not line:
            break
        size += len(line)
        if len(line) > 262144 or size > 2 * 1024 * 1024:
            raise Denied('CODEX_RESPONSE_TOO_LARGE')
        if not line.startswith(b'data: '):
            continue
        data = line[6:].strip()
        if data == b'[DONE]':
            break
        event = json.loads(data)
        if event.get('type') == 'response.output_item.done':
            items.append(event['item'])
        if event.get('type') in ('response.completed', 'response.done'):
            result = event['response']
            result.setdefault('status', 'completed')
            if not result.get('output'):
                result['output'] = items
            return normalize_response(result)
        if event.get('type') in ('error', 'response.failed', 'response.incomplete'):
            raise Denied('CODEX_INCOMPLETE')
    raise RuntimeError('CODEX_STREAM_INTERRUPTED')


def normalize_response(result):
    if (
        not isinstance(result, dict)
        or result.get('status') != 'completed'
        or not isinstance(result.get('output'), list)
    ):
        raise Denied('CODEX_INCOMPLETE')
    result = {k: result[k] for k in ('id', 'model', 'status', 'output', 'usage') if k in result}
    if len(json.dumps(result, ensure_ascii=False).encode()) > 48000:
        raise Denied('CODEX_RESPONSE_TOO_LARGE')
    return result


def responses(payload, credential):
    host = 'chatgpt.com'
    addresses = target_ips(host)
    connection = http.client.HTTPSConnection(host, timeout=120)
    raw = socket.create_connection((addresses[0], 443), timeout=10)
    try:
        raw.settimeout(120)
        connection.sock = ssl.create_default_context().wrap_socket(raw, server_hostname=host)
        connection.request(
            'POST',
            '/backend-api/codex/responses',
            body=json.dumps(payload).encode(),
            headers={
                'Authorization': 'Bearer ' + credential['access_token'],
                'chatgpt-account-id': credential['account_id'],
                'originator': 'pi',
                'User-Agent': 'pi/' + PI_VERSION + ' secure-vm',
                'OpenAI-Beta': 'responses=experimental',
                'Content-Type': 'application/json',
                'Accept': 'text/event-stream',
            },
        )
        return read_response(connection.getresponse())
    finally:
        connection.close()
        raw.close()
