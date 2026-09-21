"""Guest-root integration checks, synthetic approvals and tokenless network probes."""

import json
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, '/opt/secure-vm/services')

checks = []


def check(name, passed):
    checks.append({'check': name, 'passed': bool(passed)})


def as_user(user, code, data=None):
    run = subprocess.run(
        [
            'runuser',
            '-u',
            user,
            '--',
            'python3',
            '-c',
            "import sys; sys.path.insert(0, '/opt/secure-vm/services'); " + code,
        ],
        input=json.dumps(data) if data is not None else '',
        text=True,
        capture_output=True,
    )
    if run.returncode:
        raise RuntimeError('Probe failed: ' + user)
    return json.loads(run.stdout)


def rpc_as(user, path, request):
    return as_user(
        user,
        "from common import rpc, Denied; import json\ntry:\n print(json.dumps(rpc("
        + repr(path)
        + ", json.load(sys.stdin))))\nexcept Denied as e:\n print(json.dumps({'error':str(e)}))",
        request,
    )


check('no_swap', len(Path('/proc/swaps').read_text().splitlines()) == 1)
check(
    'no_plaintext_credentials',
    not any(
        (Path('/var/lib/secure-auth') / n).exists()
        for n in ('client.json', 'tokens.json', 'pending.json', 'model.json')
    ),
)
check(
    'vault_key_tmpfs',
    subprocess.check_output(['findmnt', '-n', '-o', 'FSTYPE', '-T', '/run/secure-vault'], text=True).strip() == 'tmpfs',
)
import connectors

for user in ('secure-auth', 'secure-inference', 'secure-policy', *connectors.SERVICE_USERS):
    probe = '''import socket, json
results=[]
for host, port, family, kind in [('1.1.1.1',443,socket.AF_INET,socket.SOCK_STREAM), ('192.168.5.2',443,socket.AF_INET,socket.SOCK_STREAM), ('1.1.1.1',53,socket.AF_INET,socket.SOCK_DGRAM), ('2606:4700:4700::1111',443,socket.AF_INET6,socket.SOCK_STREAM)]:
 s=socket.socket(family,kind); s.settimeout(2)
 try:
  if kind == socket.SOCK_DGRAM: s.sendto(b'nonsecret-probe',(host,port))
  else: s.connect((host,port))
  results.append(False)
 except OSError: results.append(True)
 finally: s.close()
print(json.dumps(results))'''
    for label, passed in zip(('public_tcp', 'private_tcp', 'dns_udp', 'ipv6'), as_user(user, probe)):
        check(user + '_blocks_' + label, passed)
# A TLS handshake proves the allow rule works without transmitting any credential.
for user, host in [
    ('secure-auth', 'oauth2.googleapis.com'),
    ('secure-inference', 'api.openai.com'),
    ('secure-inference', 'chatgpt.com'),
    *((c.user, c.hosts[0]) for c in connectors.CONNECTORS.values()),
]:
    probe = (
        "from common import target_ips; import socket, ssl, json; host="
        + repr(host)
        + "; raw=socket.create_connection((target_ips(host)[0],443),timeout=5); tls=ssl.create_default_context().wrap_socket(raw,server_hostname=host); print(json.dumps(bool(tls.version()))); tls.close()"
    )
    check(user + '_' + host + '_tls_allowed', as_user(user, probe))
# Each connector identity can only fetch its own credential kind.
check(
    'drive_cannot_get_static_token',
    rpc_as('secure-drive', '/run/secure-auth/token.sock', {'op': 'token'}).get('error') == 'CREDENTIAL_SCOPE_DENIED',
)
check(
    'notion_cannot_get_google_token',
    rpc_as('secure-notion', '/run/secure-auth/token.sock', {'op': 'access_token'}).get('error')
    == 'CREDENTIAL_SCOPE_DENIED',
)
check(
    'gmail_cannot_get_codex_token',
    rpc_as('secure-gmail', '/run/secure-auth/token.sock', {'op': 'codex_token'}).get('error')
    == 'CREDENTIAL_SCOPE_DENIED',
)
check(
    'gmail_cannot_get_model_key',
    rpc_as('secure-gmail', '/run/secure-auth/token.sock', {'op': 'model_key'}).get('error')
    == 'CREDENTIAL_SCOPE_DENIED',
)
check(
    'inference_cannot_get_google_token',
    rpc_as('secure-inference', '/run/secure-auth/token.sock', {'op': 'access_token'}).get('error')
    == 'CREDENTIAL_SCOPE_DENIED',
)
check(
    'service_cannot_approve',
    rpc_as('secure-inference', '/run/secure-policy/api.sock', {'op': 'approve'}).get('error') == 'OPERATION_DENIED',
)
# Synthetic action only: no inference execution and no cloud request.
action = {
    'operation': 'inference.openai',
    'account': 'synthetic-security-test',
    'params': {
        'model': 'test-model',
        'instructions': 'synthetic approval test',
        'input': [],
        'max_output_tokens': 1,
        'store': False,
        'tools': [],
        'stream': False,
    },
}
sock = '/run/secure-policy/api.sock'
pending = rpc_as('secure-inference', sock, {'op': 'authorize', 'action': action})
check('independent_approval_required', pending.get('decision') == 'ask')
# Use the actual external admin CLI, preserving database ownership.
subprocess.run(
    [
        'python3',
        '/opt/secure-vm/services/policy_admin.py',
        'approve',
        pending['approval_id'],
        '--digest',
        pending['digest'],
    ],
    check=True,
    capture_output=True,
)
grant = rpc_as('secure-inference', sock, {'op': 'authorize', 'action': action})
consume = {'op': 'consume', 'action': action, 'grant_id': grant['grant_id'], 'ticket': grant['ticket']}
check('approved_grant_consumed', rpc_as('secure-inference', sock, consume).get('allowed') is True)
check('grant_replay_denied', rpc_as('secure-inference', sock, consume).get('error') == 'INVALID_OR_CONSUMED_GRANT')
print(json.dumps({'checks': checks, 'passed': all(c['passed'] for c in checks)}, indent=2))
raise SystemExit(0 if all(c['passed'] for c in checks) else 1)
