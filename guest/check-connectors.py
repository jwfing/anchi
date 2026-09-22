"""Live connector boundary checks from inside the cell; no accounts, no writes, no model calls."""

import json
from pathlib import Path
import sys

sys.path.insert(0, '/opt/secure-vm')
from common import Denied, rpc

checks = []


def check(name, ok):
    checks.append({'check': name, 'passed': bool(ok)})


STATUS_KEYS = {'connected', 'reauth_required', 'account', 'scope_text', 'revocation_pending', 'auth'}
for connector in ('drive', 'notion', 'slack'):
    sock = f'/run/secure-{connector}/api.sock'
    check(f'{connector}_socket_visible', Path(sock).exists())
    status = rpc(sock, {'op': 'status'})
    check(f'{connector}_status_has_no_secret', set(status) == STATUS_KEYS)
    probes = [
        ('forged_delete', {'op': 'delete', 'request_id': 'a' * 32}),
        ('token_export', {'op': 'token'}),
        ('credential_export', {'op': 'access_token'}),
    ]
    if connector == 'slack':
        probes.append(('forged_approval', {'op': 'channels', 'limit': 1, 'approved': True}))
    else:
        probes.append(('forged_approval', {'op': 'search', 'query': 'x', 'limit': 1, 'approved': True}))
    for name, request in probes:
        denied = False
        try:
            rpc(sock, request)
        except Denied as exc:
            denied = str(exc) in ('OPERATION_DENIED', 'BAD_REQUEST', 'BAD_LIMIT', 'BAD_QUERY', 'NOT_CONNECTED')
        check(f'{connector}_{name}_denied', denied)
check('auth_socket_not_visible', not Path('/run/secure-auth/token.sock').exists())
check('policy_socket_not_visible', not Path('/run/secure-policy/api.sock').exists())
print(json.dumps({'checks': checks, 'passed': all(c['passed'] for c in checks)}, indent=2))
raise SystemExit(0 if all(c['passed'] for c in checks) else 1)
