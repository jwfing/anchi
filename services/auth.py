import base64
from contextlib import contextmanager
import fcntl
import hashlib
import os
from pathlib import Path
import re
import secrets
import time
import uuid
from urllib.parse import urlencode

from common import Denied, fields, google_json
import vault

STORE = Path('/var/lib/secure-auth')
SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'


@contextmanager
def locked():
    with (STORE / 'lock').open('a') as lock:
        if os.getuid() == 0:
            owner = STORE.stat()
            os.fchown(lock.fileno(), owner.st_uid, owner.st_gid)
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def read(name):
    return vault.read(STORE, name)


def write(name, value):
    vault.write(STORE, name, value)


def status():
    connected = vault.exists(STORE, 'tokens.json')
    reauth_required = False
    if connected and vault.KEY.exists():
        try:
            reauth_required = bool(read('tokens.json').get('reauth_required'))
        except Denied:
            reauth_required = False
    return {
        'client_configured': vault.exists(STORE, 'client.json'),
        'connected': connected,
        'scope': SCOPE,
        'reauth_required': reauth_required,
        'vault_unlocked': vault.KEY.exists(),
        'revocation_pending': vault.exists(STORE, 'revocation.json'),
    }


def import_client(value):
    if vault.exists(STORE, 'tokens.json'):
        raise Denied('DISCONNECT_BEFORE_REPLACING_CLIENT')
    client = value.get('installed')
    if (
        not isinstance(client, dict)
        or not isinstance(client.get('client_id'), str)
        or not client['client_id'].endswith('.apps.googleusercontent.com')
    ):
        raise Denied('DESKTOP_OAUTH_CLIENT_REQUIRED')
    if not isinstance(client.get('client_secret'), str) or not client['client_secret']:
        raise Denied('CLIENT_SECRET_REQUIRED')
    write('client.json', {k: client[k] for k in ('client_id', 'client_secret')})
    vault.remove(STORE, 'pending.json')
    return status()


def begin(redirect_uri):
    if not isinstance(redirect_uri, str) or not re.fullmatch(r'http://127\.0\.0\.1:[0-9]{1,5}/callback', redirect_uri):
        raise Denied('BAD_REDIRECT_URI')
    client = read('client.json')
    verifier = secrets.token_urlsafe(48)
    state = secrets.token_urlsafe(32)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
    write(
        'pending.json',
        {'verifier': verifier, 'state': state, 'redirect_uri': redirect_uri, 'expires': time.time() + 600},
    )
    params = {
        'client_id': client['client_id'],
        'redirect_uri': redirect_uri,
        'response_type': 'code',
        'scope': SCOPE,
        'state': state,
        'code_challenge': challenge,
        'code_challenge_method': 'S256',
        'access_type': 'offline',
        'prompt': 'consent',
    }
    return {'url': 'https://accounts.google.com/o/oauth2/v2/auth?' + urlencode(params), 'state': state}


def complete(value):
    fields(value, ('code', 'state'), ('code', 'state'))
    pending = read('pending.json')
    if (
        not isinstance(value['state'], str)
        or not secrets.compare_digest(value['state'], pending['state'])
        or pending['expires'] < time.time()
    ):
        raise Denied('INVALID_OAUTH_STATE')
    if not isinstance(value['code'], str) or not 1 <= len(value['code']) <= 4096:
        raise Denied('BAD_REQUEST')
    # Consume before exchange: ambiguous failures require a new login.
    vault.remove(STORE, 'pending.json')
    client = read('client.json')
    result = google_json(
        'oauth2.googleapis.com',
        'POST',
        '/token',
        urlencode(
            {
                **client,
                'grant_type': 'authorization_code',
                'code': value['code'],
                'redirect_uri': pending['redirect_uri'],
                'code_verifier': pending['verifier'],
            }
        ),
    )
    if set(result.get('scope', '').split()) != {SCOPE} or not result.get('refresh_token'):
        raise Denied('EXPECTED_READONLY_SCOPE_AND_REFRESH_TOKEN')
    result['expires_at'] = time.time() + int(result['expires_in'])
    result['generation'] = uuid.uuid4().hex
    write('tokens.json', result)
    return status()


def access_token():
    tokens = read('tokens.json')
    if tokens.get('reauth_required'):
        # The refresh token is dead; do not hammer Google, the user must reconnect.
        raise Denied('GMAIL_REAUTH_REQUIRED')
    if tokens['expires_at'] <= time.time() + 60:
        try:
            result = google_json(
                'oauth2.googleapis.com',
                'POST',
                '/token',
                urlencode(
                    {**read('client.json'), 'grant_type': 'refresh_token', 'refresh_token': tokens['refresh_token']}
                ),
            )
        except Denied as exc:
            if str(exc) == 'GOOGLE_AUTH_REQUIRED':
                tokens['reauth_required'] = True
                write('tokens.json', tokens)
                raise Denied('GMAIL_REAUTH_REQUIRED') from None
            raise
        if result.get('scope') and set(result['scope'].split()) != {SCOPE}:
            raise Denied('UNEXPECTED_SCOPE')
        tokens.update(result)
        tokens['expires_at'] = time.time() + int(result['expires_in'])
        write('tokens.json', tokens)
    return tokens['access_token']


def disconnect():
    if vault.exists(STORE, 'tokens.json'):
        tokens = read('tokens.json')
        write('revocation.json', {'token': tokens.get('refresh_token', tokens['access_token'])})
        vault.remove(STORE, 'tokens.json')
    vault.remove(STORE, 'pending.json')
    if vault.exists(STORE, 'revocation.json'):
        try:
            google_json('oauth2.googleapis.com', 'POST', '/revoke', urlencode(read('revocation.json')))
            vault.remove(STORE, 'revocation.json')
        except Exception:
            return {'connected': False, 'remote_revoked': False, 'revocation_pending': True}
    return {'connected': False, 'remote_revoked': True, 'revocation_pending': False}


def handle(request):
    fields(request, ('op',), ('op',))
    with locked():
        if request['op'] == 'status':
            return status()
        if request['op'] == 'access_token':
            token = access_token()
            return {'access_token': token, 'account_generation': read('tokens.json')['generation']}
        if request['op'] == 'codex_token':
            credential = read('codex.json')
            if credential['expires_at'] <= time.time() + 30:
                raise Denied('CODEX_TOKEN_EXPIRED_REIMPORT_ON_HOST')
            return credential
        if request['op'] == 'model_key':
            return read('model.json')
        raise Denied('OPERATION_DENIED')
