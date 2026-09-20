"""Root-only onboarding probe. Only public readiness metadata leaves the VM."""
import json
import os
from pathlib import Path
import time
import auth
import vault


def status():
    root = Path('/var/lib/secure-vm/rootfs')
    result = {'installed': (root / 'opt/secure-pi/host-files.mjs').is_file() and Path('/usr/local/sbin/secure-cell-run').is_file(),
              'unlocked': vault.KEY.exists(), 'configured': False, 'model': None, 'expires_at': None}
    config = Path('/etc/secure-vm/pi.json')
    if config.exists():
        result['model'] = json.loads(config.read_text()).get('model')
    if result['unlocked']:
        with auth.locked():
            if vault.exists(auth.STORE, 'codex.json'):
                credential = auth.read('codex.json')
                result['expires_at'] = credential.get('expires_at', 0)
                result['configured'] = bool(result['model'] and result['expires_at'] > time.time() + 120)
    return result

if __name__ == '__main__':
    try:
        if os.getuid() != 0:
            raise ValueError()
        print(json.dumps(status()))
    except Exception:
        print(json.dumps({'error': 'SETUP_STATUS_FAILED'}))
        raise SystemExit(1)
