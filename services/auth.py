import base64
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import time
from urllib.parse import urlencode

from common import Denied, fields, google_json

STORE = Path('/var/lib/secure-auth')
SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'

@contextmanager
def locked():
    with (STORE / 'lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield

def read(name):
    try:
        return json.loads((STORE / name).read_text())
    except FileNotFoundError:
        raise Denied('NOT_CONNECTED') from None

def write(name, value):
    target = STORE / name
    temporary = STORE / (name + '.new')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as file:
        json.dump(value, file)
        file.flush()
        os.fsync(file.fileno())
    temporary.replace(target)

def status():
    return {'client_configured': (STORE / 'client.json').exists(),
            'connected': (STORE / 'tokens.json').exists(), 'scope': SCOPE}

def import_client(value):
    if (STORE / 'tokens.json').exists():
        raise Denied('DISCONNECT_BEFORE_REPLACING_CLIENT')
    client = value.get('installed')
    if not isinstance(client, dict) or not isinstance(client.get('client_id'), str) or not client['client_id'].endswith('.apps.googleusercontent.com'):
        raise Denied('DESKTOP_OAUTH_CLIENT_REQUIRED')
    if not isinstance(client.get('client_secret'), str) or not client['client_secret']:
        raise Denied('CLIENT_SECRET_REQUIRED')
    write('client.json', {k: client[k] for k in ('client_id', 'client_secret')})
    (STORE / 'pending.json').unlink(missing_ok=True)
    return status()

def begin(redirect_uri):
    if not isinstance(redirect_uri, str) or not re.fullmatch(r'http://127\.0\.0\.1:[0-9]{1,5}/callback', redirect_uri):
        raise Denied('BAD_REDIRECT_URI')
    client = read('client.json')
    verifier = secrets.token_urlsafe(48)
    state = secrets.token_urlsafe(32)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
    write('pending.json', {'verifier': verifier, 'state': state, 'redirect_uri': redirect_uri, 'expires': time.time() + 600})
    params = {'client_id': client['client_id'], 'redirect_uri': redirect_uri,
              'response_type': 'code', 'scope': SCOPE, 'state': state,
              'code_challenge': challenge, 'code_challenge_method': 'S256',
              'access_type': 'offline', 'prompt': 'consent'}
    return {'url': 'https://accounts.google.com/o/oauth2/v2/auth?' + urlencode(params), 'state': state}

def complete(value):
    fields(value, ('code', 'state'), ('code', 'state'))
    pending = read('pending.json')
    if not isinstance(value['state'], str) or not secrets.compare_digest(value['state'], pending['state']) or pending['expires'] < time.time():
        raise Denied('INVALID_OAUTH_STATE')
    if not isinstance(value['code'], str) or not 1 <= len(value['code']) <= 4096:
        raise Denied('BAD_REQUEST')
    # Consume before exchange: ambiguous failures require a new login.
    (STORE / 'pending.json').unlink()
    client = read('client.json')
    result = google_json('oauth2.googleapis.com', 'POST', '/token', urlencode({
        **client, 'grant_type': 'authorization_code', 'code': value['code'],
        'redirect_uri': pending['redirect_uri'], 'code_verifier': pending['verifier']}))
    if set(result.get('scope', '').split()) != {SCOPE} or not result.get('refresh_token'):
        raise Denied('EXPECTED_READONLY_SCOPE_AND_REFRESH_TOKEN')
    result['expires_at'] = time.time() + int(result['expires_in'])
    write('tokens.json', result)
    return status()

def access_token():
    tokens = read('tokens.json')
    if tokens['expires_at'] <= time.time() + 60:
        result = google_json('oauth2.googleapis.com', 'POST', '/token', urlencode({
            **read('client.json'), 'grant_type': 'refresh_token', 'refresh_token': tokens['refresh_token']}))
        if result.get('scope') and set(result['scope'].split()) != {SCOPE}:
            raise Denied('UNEXPECTED_SCOPE')
        tokens.update(result)
        tokens['expires_at'] = time.time() + int(result['expires_in'])
        write('tokens.json', tokens)
    return tokens['access_token']

def disconnect():
    # Stop local use first. Remote revocation is also available in the Google account UI.
    for name in ('tokens.json', 'pending.json'):
        (STORE / name).unlink(missing_ok=True)
    return {'connected': False, 'remote_revocation_required': True}

def handle(request):
    fields(request, ('op',), ('op',))
    with locked():
        if request['op'] == 'status':
            return status()
        if request['op'] == 'access_token':
            return {'access_token': access_token()}
        raise Denied('OPERATION_DENIED')
