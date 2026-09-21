"""Offline checks inside the real cell; no model calls or mailbox reads."""

import json
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, '/opt/secure-vm')
from common import CELL, rpc, Denied

checks = []


def check(name, passed):
    checks.append({'check': name, 'passed': bool(passed)})


expected_pi = CELL['SECURE_PI_VERSION']
check(
    'pi_version',
    subprocess.check_output(
        [
            '/opt/node/bin/node',
            '/opt/secure-pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
            '--version',
        ],
        text=True,
    ).strip()
    == expected_pi,
)
check(
    'pi_manifest_matches_cell_env',
    json.loads(Path('/opt/secure-pi/package.json').read_text())['dependencies']['@earendil-works/pi-coding-agent']
    == expected_pi,
)
check(
    'node_version',
    subprocess.check_output(['/opt/node/bin/node', '--version'], text=True).strip()
    == 'v' + CELL['SECURE_NODE_VERSION'],
)
check('no_codex_auth_cache', not Path('/workspace/.codex/auth.json').exists())
check(
    'no_pi_auth_cache',
    not Path('/workspace/.pi/agent/auth.json').exists() and not Path('/workspace/.pi-secure/auth.json').exists(),
)
check('codex_vault_not_visible', not Path('/var/lib/secure-auth/codex.json.enc').exists())
check('codex_config_not_visible', not Path('/etc/secure-vm/pi.json').exists())
check('credential_socket_not_visible', not Path('/run/secure-auth/token.sock').exists())
try:
    with Path('/opt/secure-pi/probe').open('w') as f:
        f.write('test')
    check('pi_install_readonly', False)
except OSError:
    check('pi_install_readonly', True)
check(
    'pi_gateway_metadata_only',
    set(rpc('/run/secure-inference/api.sock', {'op': 'pi_status'})) == {'configured', 'provider', 'model'},
)
try:
    rpc('/run/secure-inference/api.sock', {'op': 'codex_token'})
    check('cell_cannot_export_codex_token', False)
except Denied as e:
    check('cell_cannot_export_codex_token', str(e) == 'OPERATION_DENIED')
print(json.dumps({'checks': checks, 'passed': all(c['passed'] for c in checks)}, indent=2))
raise SystemExit(0 if all(c['passed'] for c in checks) else 1)
