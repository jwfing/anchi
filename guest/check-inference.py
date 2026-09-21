"""Live inference boundary checks using only a fixed synthetic fixture."""

import json
from pathlib import Path
import uuid

from common import Denied, rpc

SOCKET = '/run/secure-inference/api.sock'
checks = []


def check(name, condition):
    checks.append({'check': name, 'passed': bool(condition)})


status = rpc(SOCKET, {'op': 'status'})
check('status_has_no_credentials', set(status) == {'enabled', 'provider', 'model', 'cloud_mail_enabled'})
check('model_config_not_visible', not Path('/etc/secure-vm/model.json').exists())
check('ledger_not_visible', not Path('/var/lib/secure-inference').exists())
for name, request in [
    ('no_key_export', {'op': 'access_token'}),
    ('no_cell_configuration', {'op': 'configure', 'provider': 'openai'}),
    ('no_arbitrary_url', {'op': 'status', 'url': 'https://evil.test'}),
    ('no_caller_model_selection', {'op': 'status', 'model': 'other'}),
    ('no_forged_roles', {'op': 'status', 'role': 'admin'}),
]:
    denied = False
    try:
        rpc(SOCKET, request)
    except Denied as exc:
        denied = str(exc) in ('OPERATION_DENIED', 'BAD_REQUEST')
    check(name, denied)
request = {'op': 'demo', 'request_id': uuid.uuid4().hex}
first = rpc(SOCKET, request)
check('offline_demo', first['demo'] is True and first['provider'] == 'fixture')
check('idempotent_result', rpc(SOCKET, request) == first)
history = rpc(SOCKET, {'op': 'history'})
check(
    'persistent_history', any(r['id'] == request['request_id'] and r['state'] == 'SUCCEEDED' for r in history['runs'])
)
print(json.dumps({'checks': checks, 'passed': all(c['passed'] for c in checks)}, indent=2))
raise SystemExit(0 if all(c['passed'] for c in checks) else 1)
