"""Reddit OAuth for an installed public client; only secure-auth exchanges or refreshes tokens."""

import base64
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

CLIENT = 'reddit-client.json'
TOKENS = 'reddit-tokens.json'
PENDING = 'reddit-pending.json'
REVOCATION = 'reddit-revocation.json'
REDIRECT_URI = 'http://127.0.0.1:48174/callback'
SCOPES = frozenset({'identity', 'read', 'submit'})


def user_agent():
    value = client()
    return f"linux:anchi-{value['client_id']}:v1 (by /u/{value['developer_username']})"


def request(path, form=None, token=None):
    """OAuth uses www; bearer tokens go only to oauth.reddit.com. Neither follows redirects."""
    if path not in ('/api/v1/access_token', '/api/v1/revoke_token', '/api/v1/me'):
        raise Denied('DESTINATION_DENIED')
    identity = path == '/api/v1/me'
    if identity != (token is not None) or identity == (form is not None):
        raise Denied('DESTINATION_DENIED')
    headers = {'Accept': 'application/json', 'User-Agent': user_agent()}
    if identity:
        headers['Authorization'] = 'Bearer ' + token
    else:
        # Installed clients use an empty Basic-auth password, never the Reddit password.
        headers['Authorization'] = 'Basic ' + base64.b64encode((client()['client_id'] + ':').encode()).decode()
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
    try:
        code, payload, *_ = common.TRANSPORT(
            'oauth.reddit.com' if identity else 'www.reddit.com',
            'GET' if identity else 'POST',
            path,
            headers,
            urlencode(form).encode() if form is not None else None,
        )
    except (OSError, ValueError):
        raise Denied('REDDIT_REQUEST_FAILED') from None
    if code in (400, 401, 403):
        raise Denied('REDDIT_REAUTH_REQUIRED')
    if code != 200:
        raise Denied('REDDIT_RATE_LIMITED' if code == 429 else 'REDDIT_REQUEST_FAILED')
    if len(payload) > 16384:
        raise Denied('REDDIT_RESPONSE_INVALID')
    if path == '/api/v1/revoke_token' and not payload:
        return {}
    try:
        value = json.loads(payload)
        if not isinstance(value, dict):
            raise ValueError()
    except ValueError:
        raise Denied('REDDIT_RESPONSE_INVALID') from None
    if 'error' in value:
        raise Denied('REDDIT_REAUTH_REQUIRED')
    return value


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
    fields(value, ('client_id', 'developer_username'), ('client_id', 'developer_username'))
    if not isinstance(value['client_id'], str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,256}', value['client_id']):
        raise Denied('BAD_REDDIT_CLIENT_ID')
    if not isinstance(value['developer_username'], str) or not re.fullmatch(
        r'[A-Za-z0-9_-]{3,20}', value['developer_username']
    ):
        raise Denied('BAD_REDDIT_DEVELOPER_USERNAME')
    if vault.exists(auth.STORE, TOKENS) or vault.exists(auth.STORE, REVOCATION):
        raise Denied('DISCONNECT_BEFORE_REPLACING_CLIENT')
    auth.write(CLIENT, value)
    vault.remove(auth.STORE, PENDING)
    return status()


def client():
    if not vault.exists(auth.STORE, CLIENT):
        raise Denied('REDDIT_CLIENT_REQUIRED')
    return auth.read(CLIENT)


def begin(redirect_uri):
    if redirect_uri != REDIRECT_URI:
        raise Denied('BAD_REDIRECT_URI')
    if vault.exists(auth.STORE, REVOCATION):
        raise Denied('REDDIT_REVOCATION_PENDING')
    oauth_client = client()
    state = secrets.token_urlsafe(32)
    auth.write(PENDING, {'state': state, 'expires': time.time() + 600})
    return {
        'url': 'https://www.reddit.com/api/v1/authorize?'
        + urlencode(
            {
                'client_id': oauth_client['client_id'],
                'redirect_uri': REDIRECT_URI,
                'response_type': 'code',
                'scope': ' '.join(sorted(SCOPES)),
                'state': state,
                'duration': 'permanent',
            }
        ),
        'state': state,
    }


def token_result(value, *, refresh=False):
    scope = value.get('scope')
    if (not refresh or scope is not None) and (not isinstance(scope, str) or set(scope.split()) != SCOPES):
        raise Denied('REDDIT_UNEXPECTED_SCOPES')
    if str(value.get('token_type', '')).lower() != 'bearer':
        raise Denied('REDDIT_RESPONSE_INVALID')
    result = {}
    for key in ('access_token', 'refresh_token'):
        token = value.get(key)
        if key == 'refresh_token' and refresh and token is None:
            continue
        if not isinstance(token, str) or not re.fullmatch(r'[\x21-\x7e]{1,4096}', token):
            raise Denied('REDDIT_RESPONSE_INVALID')
        result[key] = token
    expiry = value.get('expires_in')
    if type(expiry) is not int or not 60 <= expiry <= 86400:
        raise Denied('REDDIT_RESPONSE_INVALID')
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
                '/api/v1/access_token',
                {
                    'grant_type': 'authorization_code',
                    'code': value['code'],
                    'redirect_uri': REDIRECT_URI,
                },
            )
        )
        user = request('/api/v1/me', token=tokens['access_token'])
        if (
            not isinstance(user, dict)
            or not isinstance(user.get('id'), str)
            or not re.fullmatch(r'[a-z0-9]{1,20}', user['id'])
            or not isinstance(user.get('name'), str)
            or not re.fullmatch(r'[A-Za-z0-9_-]{3,20}', user['name'])
        ):
            raise Denied('REDDIT_RESPONSE_INVALID')
        auth.write(
            TOKENS, {**tokens, 'generation': uuid.uuid4().hex, 'user_id': user['id'], 'account': 'u/' + user['name']}
        )
        return status()
    finally:
        vault.remove(auth.STORE, PENDING)


def credential():
    if not vault.exists(auth.STORE, TOKENS):
        raise Denied('REDDIT_NOT_CONNECTED')
    tokens = auth.read(TOKENS)
    if tokens.get('reauth_required'):
        raise Denied('REDDIT_REAUTH_REQUIRED')
    if tokens['expires_at'] <= time.time() + 60:
        try:
            result = token_result(
                request(
                    '/api/v1/access_token',
                    {
                        'grant_type': 'refresh_token',
                        'refresh_token': tokens['refresh_token'],
                    },
                ),
                refresh=True,
            )
        except Denied as exc:
            if str(exc) in ('REDDIT_REAUTH_REQUIRED', 'REDDIT_UNEXPECTED_SCOPES', 'REDDIT_RESPONSE_INVALID'):
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
        'user_agent': user_agent(),
    }


def disconnect():
    if vault.exists(auth.STORE, TOKENS):
        value = auth.read(TOKENS)
        auth.write(REVOCATION, {'token': value['refresh_token']})
        vault.remove(auth.STORE, TOKENS)
    vault.remove(auth.STORE, PENDING)
    if vault.exists(auth.STORE, REVOCATION):
        try:
            request('/api/v1/revoke_token', {**auth.read(REVOCATION), 'token_type_hint': 'refresh_token'})
            vault.remove(auth.STORE, REVOCATION)
        except Denied:
            return {'connected': False, 'remote_revoked': False, 'revocation_pending': True}
    return {'connected': False, 'remote_revoked': True, 'revocation_pending': False}
