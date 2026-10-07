"""Trusted import of a short-lived Codex subscription access token for agent cells, via stdin only."""

import base64
import json
import os
import re
import resource
import sys
import time
import uuid

import auth
import vault
from common import Denied, fields


def validate(value):
    fields(value, ('access_token', 'account_id'), ('access_token', 'account_id'))
    token = value['access_token']
    if not isinstance(token, str) or not 100 <= len(token) <= 16000:
        raise Denied('CODEX_SUBSCRIPTION_TOKEN_REQUIRED')
    try:
        claims = json.loads(base64.urlsafe_b64decode(token.split('.')[1] + '==='))
        account = claims['https://api.openai.com/auth']['chatgpt_account_id']
        expires = float(claims['exp'])
    except Exception:
        raise Denied('CODEX_SUBSCRIPTION_TOKEN_REQUIRED') from None
    if (
        not isinstance(account, str)
        or not re.fullmatch('[a-zA-Z0-9_-]{1,128}', account)
        or account != value['account_id']
    ):
        raise Denied('CODEX_ACCOUNT_MISMATCH')
    if expires <= time.time() + 120:
        raise Denied('CODEX_TOKEN_EXPIRED_RELOGIN_ON_HOST')
    # JWT claims here are only local metadata; the upstream service validates the token.
    return {'access_token': token, 'account_id': account, 'expires_at': expires}


def status():
    with auth.locked():
        credential = auth.read('codex.json') if vault.exists(auth.STORE, 'codex.json') else None
    return {
        'configured': credential is not None,
        'account_id': credential and credential['account_id'],
        'expires_at': credential and credential['expires_at'],
    }


def main():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    if os.getuid() != 0:
        raise Denied('GUEST_ADMIN_REQUIRED')
    action = sys.argv[1] if len(sys.argv) > 1 else ''
    if action == 'status':
        print(json.dumps(status()))
        return
    if action == 'disable':
        with auth.locked():
            vault.remove(auth.STORE, 'codex.json')
        print(json.dumps(status()))
        return
    if action != 'import-token':
        raise Denied('UNKNOWN_ADMIN_ACTION')
    raw = sys.stdin.buffer.read(20001)
    if len(raw) > 20000:
        raise Denied('INPUT_TOO_LARGE')
    credential = validate(json.loads(raw))
    with auth.locked():
        old = auth.read('codex.json') if vault.exists(auth.STORE, 'codex.json') else {}
        credential['generation'] = (
            old.get('generation') if old.get('account_id') == credential['account_id'] else uuid.uuid4().hex
        )
        auth.write('codex.json', credential)
    print(json.dumps(status()))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'error': str(exc) if isinstance(exc, Denied) else 'CODEX_IMPORT_FAILED'}))
        sys.exit(1)
