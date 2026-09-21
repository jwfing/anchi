"""Root-only model configuration, explicit cloud consent, stdin-only secrets."""

import json
import uuid
import os
from pathlib import Path
import pwd
import re
import sys
import tempfile
import resource

from common import Denied
import auth
import vault

CONFIG = Path('/etc/secure-vm/model.json')


def validate(value):
    if not isinstance(value, dict) or set(value) != {'provider', 'model', 'api_key', 'allow_cloud_mail'}:
        raise Denied('BAD_MODEL_CONFIG')
    if value['provider'] != 'openai' or value['allow_cloud_mail'] is not True:
        raise Denied('EXPLICIT_CLOUD_MAIL_CONSENT_REQUIRED')
    if not isinstance(value['model'], str) or not re.fullmatch('[a-zA-Z0-9._:-]{1,100}', value['model']):
        raise Denied('BAD_MODEL_NAME')
    if not isinstance(value['api_key'], str) or not re.fullmatch('[!-~]{20,512}', value['api_key']):
        raise Denied('BAD_API_KEY')
    return value


def main():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    if os.getuid() != 0:
        raise Denied('GUEST_ADMIN_REQUIRED')
    if sys.argv[1] == 'disable':
        CONFIG.unlink(missing_ok=True)
        with auth.locked():
            vault.remove(auth.STORE, 'model.json')
        print('{"enabled": false}')
        return
    if sys.argv[1] != 'configure':
        raise Denied('UNKNOWN_ADMIN_ACTION')
    raw = sys.stdin.buffer.read(4097)
    if len(raw) > 4096:
        raise Denied('INPUT_TOO_LARGE')
    value = validate(json.loads(raw))
    with auth.locked():
        auth.write('model.json', {'api_key': value.pop('api_key'), 'generation': uuid.uuid4().hex})
    CONFIG.parent.mkdir(mode=0o750, exist_ok=True)
    gid = pwd.getpwnam('secure-inference').pw_gid
    os.chown(CONFIG.parent, 0, gid)
    fd, path = tempfile.mkstemp(dir=CONFIG.parent, prefix='.model-')
    try:
        os.fchmod(fd, 0o640)
        os.fchown(fd, 0, gid)
        with os.fdopen(fd, 'w') as file:
            json.dump(value, file)
            file.flush()
            os.fsync(file.fileno())
        os.replace(path, CONFIG)
    finally:
        Path(path).unlink(missing_ok=True)
    print(json.dumps({'enabled': True, 'provider': value['provider'], 'model': value['model']}))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'error': str(exc) if isinstance(exc, Denied) else 'MODEL_CONFIG_FAILED'}))
        sys.exit(1)
