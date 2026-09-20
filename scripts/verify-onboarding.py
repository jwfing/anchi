"""Explicit live onboarding smoke test on a disposable VM; no real credentials/model calls."""
import base64
import json
import os
import selectors
import subprocess
import time
import sys
from pathlib import Path

INSTANCE = 'secure-vm-onboarding-test'
BASE = ['limactl', 'shell', INSTANCE, '--', 'sudo']

def run(arguments, value=None):
    result = subprocess.run(BASE + arguments, input=json.dumps(value) if value is not None else '',
                            text=True, capture_output=True, timeout=90)
    if result.returncode:
        raise RuntimeError('LIVE_GUEST_OPERATION_FAILED')
    return json.loads(result.stdout)

def main():
    status_script = ['/usr/bin/python3', '/opt/secure-vm/services/setup_status.py']
    before = run(status_script)
    assert before['installed'] and not before['configured']
    run(['/usr/bin/python3', '/opt/secure-vm/services/vault_admin.py', 'unlock'],
        {'key': base64.b64encode(os.urandom(32)).decode()})
    # Intentionally unsigned, synthetic metadata only: upstream would reject this.
    # This validates local import and Pi startup without using a user's subscription.
    claims = {'exp': time.time() + 3600, 'https://api.openai.com/auth': {'chatgpt_account_id': 'synthetic-test'}}
    token = 'fixture.' + base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=') + '.invalid'
    run(['/usr/bin/python3', '/opt/secure-vm/services/codex_admin.py', 'import'],
        {'access_token': token, 'account_id': 'synthetic-test', 'model': 'gpt-6-astra'})
    after = run(status_script)
    assert after['installed'] and after['unlocked'] and after['configured']
    checks = run(['/usr/local/sbin/secure-cell-run', '/usr/bin/python3', '/opt/secure-vm/check-pi.py'])
    assert checks['passed']
    proc = subprocess.Popen(BASE + ['/usr/local/sbin/secure-cell-run', '/opt/node/bin/node', '/opt/secure-pi/agent.mjs', '--rpc', '--host-files'],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    selector = selectors.DefaultSelector()
    selector.register(proc.stdout, selectors.EVENT_READ)
    try:
        if not selector.select(40):
            raise RuntimeError('PI_START_TIMEOUT')
        ready = json.loads(proc.stdout.readline())
        assert ready['type'] == 'ready'
        proc.stdin.write(json.dumps({'id': 'close-test', 'op': 'close'}) + '\n')
        proc.stdin.flush()
        proc.communicate(timeout=20)
        assert proc.returncode == 0
    finally:
        selector.close()
        if proc.poll() is None:
            proc.kill()
            proc.wait()
    print('PASS: fresh install, vault unlock, synthetic credential import, isolation checks, real Pi RPC handshake.')

if __name__ == '__main__':
    try:
        if sys.argv[1:] == ['--retry']:
            run(['/usr/local/sbin/secure-cell-run', '/usr/bin/python3', '-c', "from pathlib import Path; import json; Path('/workspace/onboarding-retained.txt').write_text('synthetic'); print(json.dumps({'ok':True}))"])
            result = subprocess.run(['bash', 'scripts/install-pi.sh'], cwd=Path(__file__).resolve().parents[1], env={**os.environ, 'QISUO_INSTALL_VM': INSTANCE}, capture_output=True, timeout=900)
            assert result.returncode == 0
            assert run(['/usr/bin/python3', '/opt/secure-vm/services/setup_status.py'])['configured']
            assert run(['/usr/local/sbin/secure-cell-run', '/usr/bin/python3', '-c', "from pathlib import Path; import json; print(json.dumps({'retained':Path('/workspace/onboarding-retained.txt').read_text() == 'synthetic'}))"])['retained']
            print('PASS: installer retry preserves encrypted credentials, model configuration and workspace.')
        elif not sys.argv[1:]:
            main()
        else:
            raise ValueError()
    except Exception:
        raise SystemExit('ONBOARDING_LIVE_CHECK_FAILED (credential-bearing diagnostics suppressed)') from None
