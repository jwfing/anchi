"""Trusted import of a Claude Code credential for agent cells, via stdin only.

A `claude setup-token` subscription token (`sk-ant-oat01-…`, long-lived, no refresh) or an
Anthropic API key (`sk-ant-api03-…`). Cells hold a placeholder; the egress proxy substitutes
this value on api.anthropic.com.
"""

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

FILE = 'claude.json'
KINDS = {'oauth': 'sk-ant-oat01-', 'api_key': 'sk-ant-api03-'}


def validate(value):
    fields(value, ('token',), ('token',))
    token = value['token']
    if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_-]{40,500}', token):
        raise Denied('CLAUDE_TOKEN_REQUIRED')
    for kind, prefix in KINDS.items():
        if token.startswith(prefix):
            if 'anchi-placeholder' in token:
                raise Denied('CLAUDE_TOKEN_REQUIRED')
            return {'token': token, 'kind': kind}
    raise Denied('CLAUDE_TOKEN_REQUIRED')


def status():
    with auth.locked():
        value = auth.read(FILE) if vault.exists(auth.STORE, FILE) else None
    return {
        'configured': value is not None,
        'kind': value and value['kind'],
        'imported_at': value and value['imported_at'],
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
            vault.remove(auth.STORE, FILE)
        print(json.dumps(status()))
        return
    if action != 'import-token':
        raise Denied('UNKNOWN_ADMIN_ACTION')
    raw = sys.stdin.buffer.read(4001)
    if len(raw) > 4000:
        raise Denied('INPUT_TOO_LARGE')
    credential = validate(json.loads(raw))
    credential.update(generation=uuid.uuid4().hex, imported_at=time.time())
    with auth.locked():
        auth.write(FILE, credential)
    print(json.dumps(status()))


if __name__ == '__main__':
    try:
        main()
    except (Denied, ValueError) as exc:
        print(json.dumps({'error': str(exc) if isinstance(exc, Denied) else 'BAD_INPUT'}))
        sys.exit(1)
