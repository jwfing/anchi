"""Trusted import of the Hermes runtime's model endpoint, via stdin only.

Hermes talks to an OpenAI-compatible endpoint the user chooses: its base URL, an API key and a
default model. The key stays in the vault; cells hold a placeholder, and the egress proxy
substitutes the key under the base URL only: that host, that path prefix. The base URL and model
are not secret: cells get them to configure Hermes.
"""

import json
import os
import re
import resource
import sys
import time
import uuid
from urllib.parse import urlsplit

import auth
import egress_rules
import vault
from common import Denied, fields

FILE = 'hermes.json'
MODEL = re.compile(r'[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,99}')
PATH = re.compile(r'(/[A-Za-z0-9._~-]+){0,8}/?')


def endpoint(base_url):
    """(host, normalized base URL) of an https endpoint on a public-looking name."""
    if not isinstance(base_url, str) or len(base_url) > 300:
        raise Denied('HERMES_BASE_URL_INVALID')
    parts = urlsplit(base_url.strip())
    host = (parts.hostname or '').lower()
    if (
        parts.scheme != 'https'
        or parts.username
        or parts.password
        or parts.port not in (None, 443)
        or parts.query
        or parts.fragment
        or not egress_rules.EGRESS_PATTERN.fullmatch(host)
        or host.startswith('*.')
        or not PATH.fullmatch(parts.path or '/')
    ):
        raise Denied('HERMES_BASE_URL_INVALID')
    # A host that already has a rule (the Anthropic API, GitHub, AWS…) would get two credentials.
    if egress_rules.find_rule(host) is not None:
        raise Denied('HERMES_BASE_URL_RESERVED')
    return host, f'https://{host}{parts.path.rstrip("/")}'


def validate(value):
    fields(value, ('base_url', 'api_key', 'model'), ('base_url', 'api_key', 'model'))
    host, base_url = endpoint(value['base_url'])
    key = value['api_key']
    if not isinstance(key, str) or not re.fullmatch(r'[\x21-\x7e]{8,500}', key) or egress_rules.PLACEHOLDER_MARK in key:
        raise Denied('HERMES_API_KEY_REQUIRED')
    model = value['model']
    if not isinstance(model, str) or not MODEL.fullmatch(model):
        raise Denied('HERMES_MODEL_INVALID')
    return {'base_url': base_url, 'host': host, 'api_key': key, 'model': model}


def status():
    with auth.locked():
        value = auth.read(FILE) if vault.exists(auth.STORE, FILE) else None
    return {
        'configured': value is not None,
        'base_url': value and value['base_url'],
        'model': value and value['model'],
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
    if action != 'import':
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
