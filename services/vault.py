"""AEAD credential files; master key lives only in guest tmpfs while unlocked."""

import base64
import json
import os
from pathlib import Path
import tempfile

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from common import Denied

KEY = Path('/run/secure-vault/master.key')
NAMES = {'client.json', 'tokens.json', 'pending.json', 'model.json', 'revocation.json', 'codex.json'}


def key():
    try:
        data = KEY.read_bytes()
    except FileNotFoundError:
        raise Denied('VAULT_LOCKED') from None
    if len(data) != 32:
        raise Denied('VAULT_KEY_INVALID')
    return data


def path(store, name):
    if name not in NAMES:
        raise Denied('VAULT_NAME_DENIED')
    return store / (name + '.enc')


def decrypt(name, envelope, master):
    try:
        if envelope['version'] != 1:
            raise ValueError()
        plaintext = AESGCM(master).decrypt(
            base64.b64decode(envelope['nonce'], validate=True),
            base64.b64decode(envelope['ciphertext'], validate=True),
            ('secure-vm:v1:' + name).encode(),
        )
        return json.loads(plaintext)
    except Exception:
        raise Denied('VAULT_INTEGRITY_ERROR') from None


def read(store, name):
    master = key()
    try:
        envelope = json.loads(path(store, name).read_text())
    except FileNotFoundError:
        raise Denied('NOT_CONNECTED') from None
    except ValueError:
        raise Denied('VAULT_INTEGRITY_ERROR') from None
    return decrypt(name, envelope, master)


def write(store, name, value):
    master, nonce = key(), os.urandom(12)
    encrypted = AESGCM(master).encrypt(nonce, json.dumps(value).encode(), ('secure-vm:v1:' + name).encode())
    envelope = {
        'version': 1,
        'nonce': base64.b64encode(nonce).decode(),
        'ciphertext': base64.b64encode(encrypted).decode(),
    }
    target = path(store, name)
    fd, temporary = tempfile.mkstemp(dir=store, prefix='.encrypted-')
    try:
        os.fchmod(fd, 0o600)
        if os.getuid() == 0:
            owner = store.stat()
            os.fchown(fd, owner.st_uid, owner.st_gid)
        with os.fdopen(fd, 'w') as file:
            json.dump(envelope, file)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, target)
        directory = os.open(store, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        Path(temporary).unlink(missing_ok=True)


def exists(store, name):
    return path(store, name).exists()


def remove(store, name):
    path(store, name).unlink(missing_ok=True)
