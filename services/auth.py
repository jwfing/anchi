"""Credential service: per-connector Google OAuth tokens and imported static tokens, all in the vault."""

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
DRIVE_SCOPES = frozenset(
    {'https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive.file'}
)
# Google connectors: one PKCE flow and one token file each; scopes must come back exactly as requested.
GOOGLE = {
    'gmail': {
        'scopes': frozenset({SCOPE}),
        'tokens': 'tokens.json',
        'pending': 'pending.json',
        'revocation': 'revocation.json',
    },
    'drive': {
        'scopes': DRIVE_SCOPES,
        'tokens': 'drive-tokens.json',
        'pending': 'drive-pending.json',
        'revocation': 'drive-revocation.json',
    },
}
# Static tokens the user pastes into the trusted desktop window; validated by shape only here.
TOKENS = {
    'notion': {'file': 'notion.json', 'pattern': r'(ntn_|secret_)[A-Za-z0-9_-]{30,190}'},
    'slack': {'file': 'slack.json', 'pattern': r'xoxb-[A-Za-z0-9-]{30,190}'},
}


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


def google(connector):
    if connector not in GOOGLE:
        raise Denied('UNKNOWN_CONNECTOR')
    return GOOGLE[connector]


def connector_status(connector):
    if connector in GOOGLE:
        spec = GOOGLE[connector]
        connected = vault.exists(STORE, spec['tokens'])
        reauth, account = False, None
        if connected and vault.KEY.exists():
            try:
                tokens = read(spec['tokens'])
                reauth, account = bool(tokens.get('reauth_required')), tokens.get('account')
            except Denied:
                pass
        return {
            'connected': connected,
            'reauth_required': reauth,
            'account': account,
            'scope_text': ' '.join(sorted(spec['scopes'])),
            'revocation_pending': vault.exists(STORE, spec['revocation']),
            'auth': 'google',
        }
    if connector not in TOKENS:
        raise Denied('UNKNOWN_CONNECTOR')
    spec = TOKENS[connector]
    connected = vault.exists(STORE, spec['file'])
    account = None
    if connected and vault.KEY.exists():
        try:
            account = read(spec['file']).get('account')
        except Denied:
            pass
    return {
        'connected': connected,
        'reauth_required': False,
        'account': account,
        'scope_text': '',
        'revocation_pending': False,
        'auth': 'token',
    }


def status(connector=None):
    if connector:
        return connector_status(connector)
    value = {name: connector_status(name) for name in (*GOOGLE, *TOKENS)}
    value['client_configured'] = vault.exists(STORE, 'client.json')
    value['vault_unlocked'] = vault.KEY.exists()
    # Top-level Gmail fields stay for one release so older desktop builds keep working.
    value.update({k: value['gmail'][k] for k in ('connected', 'reauth_required', 'revocation_pending')})
    value['scope'] = SCOPE
    return value


def import_client(value):
    if any(vault.exists(STORE, spec['tokens']) for spec in GOOGLE.values()):
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
    for spec in GOOGLE.values():
        vault.remove(STORE, spec['pending'])
    return status()


def begin(connector, redirect_uri):
    spec = google(connector)
    if not isinstance(redirect_uri, str) or not re.fullmatch(r'http://127\.0\.0\.1:[0-9]{1,5}/callback', redirect_uri):
        raise Denied('BAD_REDIRECT_URI')
    client = read('client.json')
    verifier = secrets.token_urlsafe(48)
    state = secrets.token_urlsafe(32)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
    write(
        spec['pending'],
        {'verifier': verifier, 'state': state, 'redirect_uri': redirect_uri, 'expires': time.time() + 600},
    )
    params = {
        'client_id': client['client_id'],
        'redirect_uri': redirect_uri,
        'response_type': 'code',
        'scope': ' '.join(sorted(spec['scopes'])),
        'state': state,
        'code_challenge': challenge,
        'code_challenge_method': 'S256',
        'access_type': 'offline',
        'prompt': 'consent',
    }
    return {'url': 'https://accounts.google.com/o/oauth2/v2/auth?' + urlencode(params), 'state': state}


def complete(connector, value):
    spec = google(connector)
    fields(value, ('code', 'state'), ('code', 'state'))
    pending = read(spec['pending'])
    if (
        not isinstance(value['state'], str)
        or not secrets.compare_digest(value['state'], pending['state'])
        or pending['expires'] < time.time()
    ):
        raise Denied('INVALID_OAUTH_STATE')
    if not isinstance(value['code'], str) or not 1 <= len(value['code']) <= 4096:
        raise Denied('BAD_REQUEST')
    # Consume before exchange: ambiguous failures require a new login.
    vault.remove(STORE, spec['pending'])
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
    if set(result.get('scope', '').split()) != set(spec['scopes']) or not result.get('refresh_token'):
        raise Denied('EXPECTED_EXACT_SCOPES_AND_REFRESH_TOKEN')
    result['expires_at'] = time.time() + int(result['expires_in'])
    result['generation'] = uuid.uuid4().hex
    write(spec['tokens'], result)
    return status()


def access_token(connector):
    spec = google(connector)
    tokens = read(spec['tokens'])
    reauth_code = f'{connector.upper()}_REAUTH_REQUIRED'
    if tokens.get('reauth_required'):
        # The refresh token is dead; do not hammer Google, the user must reconnect.
        raise Denied(reauth_code)
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
                write(spec['tokens'], tokens)
                raise Denied(reauth_code) from None
            raise
        if result.get('scope') and set(result['scope'].split()) != set(spec['scopes']):
            raise Denied('UNEXPECTED_SCOPE')
        tokens.update(result)
        tokens['expires_at'] = time.time() + int(result['expires_in'])
        write(spec['tokens'], tokens)
    return tokens['access_token']


def disconnect(connector):
    spec = google(connector)
    if vault.exists(STORE, spec['tokens']):
        tokens = read(spec['tokens'])
        write(spec['revocation'], {'token': tokens.get('refresh_token', tokens['access_token'])})
        vault.remove(STORE, spec['tokens'])
    vault.remove(STORE, spec['pending'])
    if vault.exists(STORE, spec['revocation']):
        try:
            google_json('oauth2.googleapis.com', 'POST', '/revoke', urlencode(read(spec['revocation'])))
            vault.remove(STORE, spec['revocation'])
        except Exception:
            return {'connected': False, 'remote_revoked': False, 'revocation_pending': True}
    return {'connected': False, 'remote_revoked': True, 'revocation_pending': False}


def import_token(connector, value):
    spec = TOKENS.get(connector)
    if spec is None:
        raise Denied('UNKNOWN_CONNECTOR')
    fields(value, ('token',), ('token',))
    token = value['token']
    if not isinstance(token, str) or not re.fullmatch(spec['pattern'], token):
        raise Denied('BAD_TOKEN_FORMAT')
    write(spec['file'], {'token': token, 'generation': uuid.uuid4().hex, 'imported_at': time.time()})
    return connector_status(connector)


def set_account(connector, label):
    name = GOOGLE[connector]['tokens'] if connector in GOOGLE else TOKENS[connector]['file']
    if not isinstance(label, str) or not 1 <= len(label) <= 200:
        raise Denied('BAD_ACCOUNT_LABEL')
    value = read(name)
    value['account'] = label
    write(name, value)
    return connector_status(connector)


def remove_token(connector):
    if connector not in TOKENS:
        raise Denied('UNKNOWN_CONNECTOR')
    vault.remove(STORE, TOKENS[connector]['file'])
    return connector_status(connector)


def handle(request, caller):
    fields(request, ('op',), ('op',))
    with locked():
        op = request['op']
        if op == 'status':
            return status()
        if op == 'access_token' and caller in GOOGLE:
            token = access_token(caller)
            return {'access_token': token, 'account_generation': read(GOOGLE[caller]['tokens'])['generation']}
        if op == 'token' and caller in TOKENS:
            value = read(TOKENS[caller]['file'])
            return {'token': value['token'], 'account_generation': value['generation']}
        if op == 'codex_token' and caller == 'inference':
            credential = read('codex.json')
            if credential['expires_at'] <= time.time() + 30:
                raise Denied('CODEX_TOKEN_EXPIRED_REIMPORT_ON_HOST')
            return credential
        if op == 'model_key' and caller == 'inference':
            return read('model.json')
        raise Denied('OPERATION_DENIED')
