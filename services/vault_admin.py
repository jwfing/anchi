"""Root-only unlock, migration and lock; no key or plaintext on stdout."""
import base64
import fcntl
import json
import os
from pathlib import Path
import pwd
import sys
import uuid
import resource

import auth
import vault
from common import Denied

def main():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    if os.getuid() != 0:
        raise Denied('GUEST_ADMIN_REQUIRED')
    action = sys.argv[1]
    if action == 'status':
        print(json.dumps({'unlocked': vault.KEY.exists(),
            'encrypted_files': len(list(auth.STORE.glob('*.enc'))),
            'legacy_files': sum((auth.STORE / name).exists() for name in vault.NAMES)}))
        return
    # Serialize against OAuth exchanges, refresh and revocation.
    with auth.locked():
        if action == 'lock':
            vault.KEY.unlink(missing_ok=True)
            print('{"unlocked": false}')
            return
        if action != 'unlock':
            raise Denied('UNKNOWN_VAULT_ACTION')
        if len(Path('/proc/swaps').read_text().splitlines()) > 1:
            raise Denied('SWAP_MUST_BE_DISABLED')
        raw = sys.stdin.buffer.read(1025)
        if len(raw) > 1024:
            raise Denied('INPUT_TOO_LARGE')
        master = base64.b64decode(json.loads(raw)['key'], validate=True)
        if len(master) != 32:
            raise Denied('VAULT_KEY_INVALID')
        # A wrong key must never replace an already working in-memory key.
        for encrypted in auth.STORE.glob('*.json.enc'):
            vault.decrypt(encrypted.name[:-4], json.loads(encrypted.read_text()), master)
        gid = pwd.getpwnam('secure-auth').pw_gid
        vault.KEY.parent.mkdir(mode=0o750, exist_ok=True)
        os.chown(vault.KEY.parent, 0, gid)
        temporary = vault.KEY.with_name('master.new')
        fd = os.open(temporary, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o640)
        os.fchown(fd, 0, gid)
        os.fchmod(fd, 0o640)
        with os.fdopen(fd, 'wb') as file:
            file.write(master)
        os.replace(temporary, vault.KEY)
        migrated = []
        for name in ('client.json', 'tokens.json', 'pending.json', 'revocation.json'):
            legacy = auth.STORE / name
            if not legacy.exists():
                continue
            value = json.loads(legacy.read_text())
            if vault.exists(auth.STORE, name):
                if vault.read(auth.STORE, name) != value:
                    raise Denied('MIGRATION_CONFLICT')
            else:
                vault.write(auth.STORE, name, value)
            if vault.read(auth.STORE, name) != value:
                raise Denied('MIGRATION_VERIFICATION_FAILED')
            legacy.unlink()
            migrated.append(name)
        if vault.exists(auth.STORE, 'tokens.json'):
            tokens = auth.read('tokens.json')
            if 'generation' not in tokens:
                tokens['generation'] = uuid.uuid4().hex
                auth.write('tokens.json', tokens)
        model_file = Path('/etc/secure-vm/model.json')
        if model_file.exists():
            config = json.loads(model_file.read_text())
            if 'api_key' in config:
                vault.write(auth.STORE, 'model.json', {'api_key': config.pop('api_key'), 'generation': uuid.uuid4().hex})
                fd = os.open(model_file, os.O_WRONLY | os.O_TRUNC)
                with os.fdopen(fd, 'w') as file:
                    json.dump(config, file)
                    file.flush()
                    os.fsync(file.fileno())
                migrated.append('model-key')
        print(json.dumps({'unlocked': True, 'migrated': migrated}))

if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'error': str(exc) if isinstance(exc, Denied) else 'VAULT_ADMIN_FAILED'}))
        sys.exit(1)
