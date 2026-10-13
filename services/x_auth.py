"""X OAuth for a native public client; only secure-auth exchanges or refreshes tokens."""

import base64
import hashlib
import json
import re
import secrets
import time
import uuid
from urllib.parse import urlencode

import auth
import common
from common import Denied, fields
import vault

CLIENT = 'x-client.json'
TOKENS = 'x-tokens.json'
PENDING = 'x-pending.json'
REVOCATION = 'x-revocation.json'
REDIRECT_URI = 'http://127.0.0.1:48173/callback'
SCOPES = frozenset({'tweet.read', 'tweet.write', 'users.read', 'offline.access'})


def request(path, form=None, token=None):
    """Fixed destinations, no redirects or provider error bodies, including OAuth failures."""
    if path not in ('/2/oauth2/token', '/2/oauth2/revoke', '/2/users/me'):
        raise Denied('DESTINATION_DENIED')
    headers = {'Accept': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    if form is not None:
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
    try:
        code, payload, *_ = common.TRANSPORT(
            'api.x.com',
            'POST' if form is not None else 'GET',
            path,
            headers,
            urlencode(form).encode() if form is not None else None,
        )
    except (OSError, ValueError):
        raise Denied('X_REQUEST_FAILED') from None
    if code in (400, 401, 403):
        raise Denied('X_REAUTH_REQUIRED')
    if code != 200:
        raise Denied('X_RATE_LIMITED' if code == 429 else 'X_REQUEST_FAILED')
    if len(payload) > 16384:
        raise Denied('X_RESPONSE_INVALID')
    try:
        value = json.loads(payload)
        if not isinstance(value, dict):
            raise ValueError()
        return value
    except ValueError:
        raise Denied('X_RESPONSE_INVALID') from None


def status():
    connected = vault.exists(auth.STORE, TOKENS)
    value = {}
    if connected and vault.KEY.exists():
        try:
            value = auth.read(TOKENS)
        except Denied:
            pass
    return {
        'connected': connected,
        'account': value.get('account'),
        'reauth_required': bool(value.get('reauth_required')),
        'revocation_pending': vault.exists(auth.STORE, REVOCATION),
        'client_configured': vault.exists(auth.STORE, CLIENT),
        'auth': 'oauth',
    }


def import_client(value):
    fields(value, ('client_id',), ('client_id',))
    if not isinstance(value['client_id'], str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,256}', value['client_id']):
        raise Denied('BAD_X_CLIENT_ID')
    if vault.exists(auth.STORE, TOKENS) or vault.exists(auth.STORE, REVOCATION):
        raise Denied('DISCONNECT_BEFORE_REPLACING_CLIENT')
    auth.write(CLIENT, value)
    vault.remove(auth.STORE, PENDING)
    return status()


def client():
    if not vault.exists(auth.STORE, CLIENT):
        raise Denied('X_CLIENT_REQUIRED')
    return auth.read(CLIENT)


def begin(redirect_uri):
    if redirect_uri != REDIRECT_URI:
        raise Denied('BAD_REDIRECT_URI')
    if vault.exists(auth.STORE, REVOCATION):
        raise Denied('X_REVOCATION_PENDING')
    oauth_client = client()
    verifier, state = secrets.token_urlsafe(48), secrets.token_urlsafe(32)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
    auth.write(PENDING, {'verifier': verifier, 'state': state, 'expires': time.time() + 600})
    return {
        'url': 'https://x.com/i/oauth2/authorize?'
        + urlencode(
            {
                **oauth_client,
                'redirect_uri': REDIRECT_URI,
                'response_type': 'code',
                'scope': ' '.join(sorted(SCOPES)),
                'state': state,
                'code_challenge': challenge,
                'code_challenge_method': 'S256',
            }
        ),
        'state': state,
    }


def token_result(value, *, refresh=False):
    scope = value.get('scope')
    if (not refresh or scope is not None) and (not isinstance(scope, str) or set(scope.split()) != SCOPES):
        raise Denied('X_UNEXPECTED_SCOPES')
    if str(value.get('token_type', '')).lower() != 'bearer':
        raise Denied('X_RESPONSE_INVALID')
    result = {}
    for key in ('access_token', 'refresh_token'):
        token = value.get(key)
        if key == 'refresh_token' and refresh and token is None:
            continue
        if not isinstance(token, str) or not re.fullmatch(r'[\x21-\x7e]{1,4096}', token):
            raise Denied('X_RESPONSE_INVALID')
        result[key] = token
    expiry = value.get('expires_in')
    if type(expiry) is not int or not 60 <= expiry <= 86400:
        raise Denied('X_RESPONSE_INVALID')
    return {**result, 'expires_at': time.time() + expiry}


def complete(value):
    fields(value, ('code', 'state'), ('code', 'state'))
    pending = auth.read(PENDING)
    if (
        not isinstance(value['state'], str)
        or not value['state'].isascii()
        or not secrets.compare_digest(value['state'], pending['state'])
        or pending.get('consumed')
        or pending['expires'] < time.time()
    ):
        raise Denied('INVALID_OAUTH_STATE')
    if not isinstance(value['code'], str) or not re.fullmatch(r'[\x21-\x7e]{1,4096}', value['code']):
        raise Denied('BAD_REQUEST')
    # Keep the configured network role during exchange, but never accept this state twice.
    auth.write(PENDING, {**pending, 'consumed': True})
    try:
        tokens = token_result(
            request(
                '/2/oauth2/token',
                {
                    **client(),
                    'grant_type': 'authorization_code',
                    'code': value['code'],
                    'redirect_uri': REDIRECT_URI,
                    'code_verifier': pending['verifier'],
                },
            )
        )
        user = request('/2/users/me', token=tokens['access_token']).get('data', {})
        if (
            not isinstance(user, dict)
            or not isinstance(user.get('id'), str)
            or not re.fullmatch(r'[0-9]{1,20}', user['id'])
            or not isinstance(user.get('username'), str)
            or not re.fullmatch(r'[A-Za-z0-9_]{1,15}', user['username'])
        ):
            raise Denied('X_RESPONSE_INVALID')
        auth.write(
            TOKENS, {**tokens, 'generation': uuid.uuid4().hex, 'user_id': user['id'], 'account': '@' + user['username']}
        )
        return status()
    finally:
        vault.remove(auth.STORE, PENDING)


def credential():
    if not vault.exists(auth.STORE, TOKENS):
        raise Denied('X_NOT_CONNECTED')
    tokens = auth.read(TOKENS)
    if tokens.get('reauth_required'):
        raise Denied('X_REAUTH_REQUIRED')
    if tokens['expires_at'] <= time.time() + 60:
        try:
            result = token_result(
                request(
                    '/2/oauth2/token',
                    {
                        **client(),
                        'grant_type': 'refresh_token',
                        'refresh_token': tokens['refresh_token'],
                    },
                ),
                refresh=True,
            )
        except Denied as exc:
            if str(exc) in ('X_REAUTH_REQUIRED', 'X_UNEXPECTED_SCOPES', 'X_RESPONSE_INVALID'):
                tokens['reauth_required'] = True
                auth.write(TOKENS, tokens)
            raise
        tokens.update(result)
        auth.write(TOKENS, tokens)
    return {
        'access_token': tokens['access_token'],
        'account_generation': tokens['generation'],
        'user_id': tokens['user_id'],
        'account': tokens['account'],
    }


def disconnect():
    if vault.exists(auth.STORE, TOKENS):
        value = auth.read(TOKENS)
        auth.write(REVOCATION, {'token': value['refresh_token']})
        vault.remove(auth.STORE, TOKENS)
    vault.remove(auth.STORE, PENDING)
    if vault.exists(auth.STORE, REVOCATION):
        try:
            request('/2/oauth2/revoke', {**client(), **auth.read(REVOCATION), 'token_type_hint': 'refresh_token'})
            vault.remove(auth.STORE, REVOCATION)
        except Denied:
            return {'connected': False, 'remote_revoked': False, 'revocation_pending': True}
    return {'connected': False, 'remote_revoked': True, 'revocation_pending': False}
