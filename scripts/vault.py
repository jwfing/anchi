"""Keep the master key outside the VM; only send it via SSH stdin to tmpfs."""

import argparse
import base64
import json
import os
import re
from pathlib import Path
import stat
import resource
import subprocess


VM = os.environ.get('ANCHI_INSTALL_VM', 'anchi-vm')
if not re.fullmatch(r'anchi-vm(-[a-z0-9-]+)?', VM):
    raise SystemExit('ANCHI_INSTALL_VM must look like anchi-vm or anchi-vm-<suffix>')
KEY_FILE = Path.home() / '.config/anchi/vault.key'


def remote(action, value=None):
    result = subprocess.run(
        [
            'limactl',
            'shell',
            VM,
            '--',
            'sudo',
            '/usr/bin/python3',
            '/opt/secure-vm/services/vault_admin.py',
            action,
        ],
        input=json.dumps(value) if value is not None else '',
        text=True,
        capture_output=True,
    )
    try:
        response = json.loads(result.stdout)
    except ValueError:
        raise SystemExit('Cannot contact vault admin; no secret output displayed.') from None
    if result.returncode:
        raise SystemExit(response.get('error', 'VAULT_OPERATION_FAILED'))
    return response


def main():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('init', 'unlock', 'lock', 'status'))
    parser.add_argument('--key-file', type=Path, default=KEY_FILE)
    args = parser.parse_args()
    if VM == 'anchi-vm' and os.environ.get('ANCHI_VM_MIGRATING') != '1':
        # Renames a VM created as secure-vm and moves its key here first (scripts/vm-name.sh).
        # A failed migration stops us: the key and the VM may still carry their old names.
        migration = subprocess.run(
            ['bash', str(Path(__file__).with_name('vm-name.sh')), 'migrate'],
            env={**os.environ, 'ANCHI_VM_MIGRATING': '1'},
        )
        if migration.returncode:
            raise SystemExit('The move from secure-vm to anchi-vm failed; see the messages above.')
    if args.action in ('status', 'lock'):
        print(json.dumps(remote(args.action), indent=2))
        return
    if args.action == 'init' and not args.key_file.exists():
        if remote('status')['encrypted_files']:
            raise SystemExit(
                'Encrypted credentials exist. Restore the original master key; do not generate a replacement.'
            )
        args.key_file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd = os.open(args.key_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as file:
            file.write(os.urandom(32))
            file.flush()
            os.fsync(file.fileno())
    fd = os.open(args.key_file, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as file:
        info = os.fstat(file.fileno())
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077 or not stat.S_ISREG(info.st_mode):
            raise SystemExit('Key file must be owned by you, regular, and inaccessible to group/others (0600).')
        master = file.read(33)
    if len(master) != 32:
        raise SystemExit('Invalid master key file.')
    print(json.dumps(remote('unlock', {'key': base64.b64encode(master).decode()}), indent=2))


if __name__ == '__main__':
    main()
