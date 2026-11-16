"""Host placement: the trusted services and their admin scripts under ANCHI_HOST_STATE, run as
the real scripts in subprocesses, as the daemon runs them on a machine without a VM."""

import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'services'))
from common import Denied, rpc

SERVICES = Path(__file__).resolve().parents[1] / 'services'
KEY = base64.b64encode(b'k' * 32).decode()


def run(script, args, env, stdin=''):
    result = subprocess.run(
        [sys.executable, str(SERVICES / script), *args],
        input=stdin,
        capture_output=True,
        text=True,
        env={**env, 'PATH': os.environ.get('PATH', '')},
        timeout=60,
    )
    try:
        value = json.loads(result.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        value = {'error': 'NO_OUTPUT', 'stderr': result.stderr[-500:]}
    return result.returncode, value


class HostPlacementTests(unittest.TestCase):
    def setUp(self):
        # Socket paths must stay short: macOS caps them at 104 bytes.
        self.state = Path(tempfile.mkdtemp(prefix='ah', dir='/tmp'))
        self.addCleanup(shutil.rmtree, self.state, True)
        self.env = {'ANCHI_HOST_STATE': str(self.state)}

    def test_admin_scripts_still_require_root_without_a_host_state(self):
        if os.getuid() == 0:
            self.skipTest('runs as root')
        for script, args in (
            ('vault_admin.py', ['status']),
            ('admin.py', ['status']),
            ('connector_admin.py', ['notion', 'probe']),
        ):
            code, value = run(script, args, {})
            self.assertEqual((code, value.get('error')), (1, 'GUEST_ADMIN_REQUIRED'), script)

    def test_vault_and_token_live_under_the_state_directory_and_the_egress_listener_reads_them(self):
        code, value = run('vault_admin.py', ['status'], self.env)
        self.assertEqual((code, value), (0, {'unlocked': False, 'encrypted_files': 0, 'legacy_files': 0}))
        code, value = run('vault_admin.py', ['unlock'], self.env, json.dumps({'key': KEY}))
        self.assertEqual((code, value), (0, {'unlocked': True, 'migrated': []}))
        key = self.state / 'run' / 'master.key'
        self.assertEqual(oct(key.stat().st_mode & 0o777), '0o600')
        self.assertEqual(key.read_bytes(), b'k' * 32)
        code, value = run('admin.py', ['import-token', 'github'], self.env, json.dumps({'token': 'ghp_' + 'a' * 36}))
        self.assertEqual(code, 0, value)
        self.assertTrue((self.state / 'auth' / 'github.json.enc').exists())
        self.assertFalse(list(self.state.glob('auth/github.json')))
        code, value = run('vault_admin.py', ['status'], self.env)
        self.assertEqual(value['encrypted_files'], 1)
        # The auth service on its host listeners: the egress role reads the token, gmail cannot.
        (self.state / 'run').mkdir(exist_ok=True)
        sockets = {role: str(self.state / 'run' / f'auth-{role}.sock') for role in ('egress', 'gmail')}
        child = subprocess.Popen(
            [sys.executable, str(SERVICES / 'server.py'), 'auth']
            + [arg for role, path in sockets.items() for arg in ('--listen', f'{role}={path}')],
            env={**self.env, 'PATH': os.environ.get('PATH', '')},
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        self.addCleanup(child.stderr.close)
        self.addCleanup(child.wait, 10)
        self.addCleanup(child.terminate)
        for _ in range(200):
            if all(Path(p).exists() for p in sockets.values()):
                break
            time.sleep(0.05)
        self.assertIsNone(child.poll(), child.stderr.read().decode()[-500:] if child.poll() is not None else '')
        credential = rpc(sockets['egress'], {'op': 'egress_credential', 'connector': 'github'})
        self.assertEqual(credential['token'], 'ghp_' + 'a' * 36)
        with self.assertRaises(Denied) as refused:
            rpc(sockets['gmail'], {'op': 'egress_credential', 'connector': 'github'})
        self.assertEqual(str(refused.exception), 'CREDENTIAL_SCOPE_DENIED')
        with self.assertRaises(Denied) as refused:
            rpc(sockets['egress'], {'op': 'egress_credential', 'connector': 'notion'})
        self.assertEqual(str(refused.exception), 'UNKNOWN_CONNECTOR')
        # Lock: the key is gone, the encrypted file stays.
        code, value = run('vault_admin.py', ['lock'], self.env)
        self.assertEqual((code, value), (0, {'unlocked': False}))
        self.assertFalse(key.exists())
        self.assertTrue((self.state / 'auth' / 'github.json.enc').exists())

    def test_host_control_registers_the_host_principal_and_relays_decisions(self):
        import socket as sockets_module

        requests = []
        answers = [
            {'ok': False, 'error': 'CELL_EXISTS'},
            {'ok': True, 'result': {'removed': True}},
            {'ok': True, 'result': {'listen_port': 3128}},
        ]
        (self.state / 'run' / 'egress').mkdir(parents=True)
        control = self.state / 'run' / 'egress' / 'control.sock'
        server = sockets_module.socket(sockets_module.AF_UNIX, sockets_module.SOCK_STREAM)
        server.bind(str(control))
        server.listen(8)
        self.addCleanup(server.close)

        def serve():
            while True:
                try:
                    conn, _ = server.accept()
                except OSError:
                    return
                with conn:
                    line = conn.makefile('rb').readline()
                    requests.append(json.loads(line))
                    answer = answers.pop(0) if answers else {'ok': True, 'result': {}}
                    conn.sendall(json.dumps(answer).encode() + b'\n')

        threading.Thread(target=serve, daemon=True).start()
        spec = {
            'connectors': ['github', 'aws'],
            'ask': ['github'],
            'high_risk_disabled': ['github-merge'],
            'listen_port': 3128,
        }
        code, value = run('host_control.py', ['register'], self.env, json.dumps(spec))
        self.assertEqual((code, value), (0, {'listen_port': 3128}))
        # Registered again after a settings change: the first attempt finds the principal there.
        self.assertEqual([r['op'] for r in requests], ['register', 'unregister', 'register'])
        self.assertEqual(
            {k: requests[0][k] for k in ('task', 'agent', 'connectors', 'ask', 'high_risk_disabled', 'listen_port')},
            {
                'task': 'host',
                'agent': 'host',
                'connectors': ['github', 'aws'],
                'ask': ['github'],
                'high_risk_disabled': ['github-merge'],
                'listen_port': 3128,
            },
        )
        code, value = run('host_control.py', ['register'], self.env, json.dumps({'connectors': ['gmail']}))
        self.assertEqual((code, value['error']), (1, 'BAD_CONNECTORS'))
        code, value = run('host_control.py', ['approvals', 'decide', '0123456789abcdef', 'allow'], self.env)
        self.assertEqual(code, 0)
        self.assertEqual(requests[-1], {'op': 'approvals.decide', 'id': '0123456789abcdef', 'allow': True})
        code, value = run('host_control.py', ['approvals', 'decide', 'nope', 'allow'], self.env)
        self.assertEqual((code, value['error']), (1, 'USAGE'))
        code, value = run('host_control.py', ['list'], self.env)
        self.assertEqual((code, value), (0, {'cells': []}))
        code, value = run('host_control.py', ['version'], self.env)
        self.assertRegex(value['runtime_version'], r'^\d+\.\d+\.\d+')
        # Without a state directory nothing is reachable, by design.
        code, value = run('host_control.py', ['quota'], {})
        self.assertEqual((code, value['error']), (1, 'HOST_STATE_REQUIRED'))


if __name__ == '__main__':
    unittest.main()
