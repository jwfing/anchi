"""Root-only onboarding probe. Only public readiness metadata leaves the VM."""

import json
import os
from pathlib import Path
import time
import auth
import vault

ROOTFS = Path('/var/lib/secure-vm/rootfs')
CELL_RUN = Path('/usr/local/sbin/secure-cell-run')
CONFIG = Path('/etc/secure-vm/pi.json')
INSTALLED = Path('/opt/secure-vm/installed.json')


def status():
    result = {
        'installed': (ROOTFS / 'opt/secure-pi/host-files.mjs').is_file() and CELL_RUN.is_file(),
        'unlocked': vault.KEY.exists(),
        'configured': False,
        'model': None,
        'expires_at': None,
        'runtime_version': None,
    }
    try:
        version = json.loads(INSTALLED.read_text()).get('runtime_version')
        if isinstance(version, str) and len(version) <= 64:
            result['runtime_version'] = version
    except (OSError, ValueError, AttributeError):
        pass
    if CONFIG.exists():
        result['model'] = json.loads(CONFIG.read_text()).get('model')
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
