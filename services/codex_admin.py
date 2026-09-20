"""Trusted import of a short-lived Codex subscription access token, via stdin only."""
import base64
import json
import os
from pathlib import Path
import pwd
import re
import resource
import sys
import tempfile
import time
import uuid

import auth
import vault
from common import Denied, fields

CONFIG = Path('/etc/secure-vm/pi.json')

def validate(value):
    fields(value, ('access_token', 'account_id', 'model'), ('access_token', 'account_id', 'model'))
    token = value['access_token']
    if not isinstance(token, str) or not 100 <= len(token) <= 16000:
        raise Denied('CODEX_SUBSCRIPTION_TOKEN_REQUIRED')
    try:
        claims = json.loads(base64.urlsafe_b64decode(token.split('.')[1] + '==='))
        account = claims['https://api.openai.com/auth']['chatgpt_account_id']
        expires = float(claims['exp'])
    except Exception:
        raise Denied('CODEX_SUBSCRIPTION_TOKEN_REQUIRED') from None
    if not isinstance(account, str) or not re.fullmatch('[a-zA-Z0-9_-]{1,128}', account) or account != value['account_id']:
        raise Denied('CODEX_ACCOUNT_MISMATCH')
    if expires <= time.time() + 120:
        raise Denied('CODEX_TOKEN_EXPIRED_RELOGIN_ON_HOST')
    if not isinstance(value['model'], str) or not re.fullmatch('gpt-[a-zA-Z0-9._-]{1,80}', value['model']):
        raise Denied('BAD_MODEL_NAME')
    # JWT claims here are only local metadata; the upstream service validates the token.
    return {'access_token': token, 'account_id': account, 'expires_at': expires}

def main():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    if os.getuid() != 0:
        raise Denied('GUEST_ADMIN_REQUIRED')
    if sys.argv[1] == 'disable':
        CONFIG.unlink(missing_ok=True)
        with auth.locked():
            vault.remove(auth.STORE, 'codex.json')
        print('{"configured":false}')
        return
    if sys.argv[1] != 'import':
        raise Denied('UNKNOWN_ADMIN_ACTION')
    raw = sys.stdin.buffer.read(20001)
    if len(raw) > 20000:
        raise Denied('INPUT_TOO_LARGE')
    value = json.loads(raw)
    credential = validate(value)
    with auth.locked():
        old = auth.read('codex.json') if vault.exists(auth.STORE, 'codex.json') else {}
        credential['generation'] = old.get('generation') if old.get('account_id') == credential['account_id'] else uuid.uuid4().hex
        auth.write('codex.json', credential)
    CONFIG.parent.mkdir(mode=0o750, exist_ok=True)
    gid = pwd.getpwnam('secure-inference').pw_gid
    os.chown(CONFIG.parent, 0, gid)
    fd, temporary = tempfile.mkstemp(dir=CONFIG.parent, prefix='.pi-')
    try:
        os.fchown(fd, 0, gid)
        os.fchmod(fd, 0o640)
        with os.fdopen(fd, 'w') as file:
            json.dump({'provider':'openai-codex', 'model':value['model']}, file)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, CONFIG)
    finally:
        Path(temporary).unlink(missing_ok=True)
    print(json.dumps({'configured': True, 'provider':'openai-codex', 'model':value['model'],
                      'expires_at':credential['expires_at'], 'refresh_token_imported':False}))

if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'error':str(exc) if isinstance(exc, Denied) else 'CODEX_IMPORT_FAILED'}))
        sys.exit(1)
