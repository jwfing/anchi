"""One fixed OpenAI route; no caller-selected URL, headers, tools, or callbacks."""
import http.client
import ipaddress
import json
import socket
import ssl
import time

from common import Denied, rpc, target_ips
import policy_client

def responses(payload):
    host = 'api.openai.com'
    addresses = target_ips(host)
    credential = rpc('/run/secure-auth/token.sock', {'op': 'model_key'})
    policy_client.require({'operation': 'inference.openai', 'account': credential['generation'], 'params': payload})
    api_key = credential['api_key']
    conn = http.client.HTTPSConnection(host, timeout=90)
    raw = socket.create_connection((addresses[0], 443), timeout=10)
    try:
        raw.settimeout(90)
        conn.sock = ssl.create_default_context().wrap_socket(raw, server_hostname=host)
        conn.request('POST', '/v1/responses', body=json.dumps(payload).encode(), headers={
            'Content-Type': 'application/json', 'Authorization': 'Bearer ' + api_key,
            'Accept': 'application/json'})
        response = conn.getresponse()
        if response.status != 200:
            raise Denied('MODEL_REQUEST_FAILED')
        # No redirects, retries, streaming, or provider error body reflection.
        deadline, chunks, size = time.monotonic() + 90, [], 0
        while True:
            if time.monotonic() > deadline:
                raise Denied('MODEL_TIMEOUT')
            chunk = response.read(16384)
            if not chunk:
                break
            size += len(chunk)
            if size > 1024 * 1024:
                raise Denied('MODEL_RESPONSE_TOO_LARGE')
            chunks.append(chunk)
        return json.loads(b''.join(chunks))
    finally:
        conn.close()
        raw.close()
