"""Live service boundary checks; never reads mailbox contents."""

import json
from pathlib import Path
from common import Denied, rpc

checks = []


def check(name, condition):
    checks.append({'check': name, 'passed': bool(condition)})


status = rpc('/run/secure-gmail/api.sock', {'op': 'status'})
check(
    'gateway_and_authd_reachable',
    set(status) == {'connected', 'reauth_required', 'account', 'scope_text', 'revocation_pending', 'auth'},
)
check('policy_socket_not_visible', not Path('/run/secure-policy/api.sock').exists())
check('vault_key_not_visible', not Path('/run/secure-vault/master.key').exists())
check('auth_socket_not_visible', not Path('/run/secure-auth/token.sock').exists())
check('credential_storage_not_visible', not Path('/var/lib/secure-auth').exists())
for name, request in [
    ('no_sending', {'op': 'send'}),
    ('no_deletion', {'op': 'delete'}),
    ('no_token_export', {'op': 'access_token'}),
    ('no_forged_approval', {'op': 'list', 'approved': True}),
    ('no_forged_identity', {'op': 'list', 'role': 'secure-auth'}),
    ('no_arbitrary_destination', {'op': 'list', 'url': 'https://evil.test'}),
    ('no_path_injection', {'op': 'read', 'id': '../profile'}),
]:
    denied = False
    try:
        rpc('/run/secure-gmail/api.sock', request)
    except Denied as exc:
        denied = str(exc) in ('OPERATION_DENIED', 'BAD_REQUEST', 'BAD_MESSAGE_ID')
    check(name, denied)
print(json.dumps({'checks': checks, 'passed': all(c['passed'] for c in checks)}, indent=2))
raise SystemExit(0 if all(c['passed'] for c in checks) else 1)
