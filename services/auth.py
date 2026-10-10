"""Credential service: per-connector Google OAuth tokens and imported static tokens, all in the vault."""

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
import uuid
from urllib.parse import urlencode

from common import Denied, fields, google_json
import vault

STORE = Path('/var/lib/secure-auth')
SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'
DRIVE_SCOPES = frozenset(
    {'https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive.file'}
)
# Google connectors: one PKCE flow and one token file per account; scopes must come back exactly as requested.
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
    # Agent-team connectors: only the egress proxy reads these, to inject them into cell traffic.
    'github': {'file': 'github.json', 'pattern': r'(ghp_|gho_|ghu_|github_pat_)[A-Za-z0-9_]{20,255}'},
    'linear': {'file': 'linear.json', 'pattern': r'lin_api_[A-Za-z0-9]{20,100}'},
}
AWS_FILE = 'aws.json'
# Named Google accounts within one connector. `default` keeps the file names above, so tokens from
# before accounts existed stay where they are; other accounts get `<file>.<account>.json`.
ACCOUNT = re.compile(r'[a-z0-9][a-z0-9_-]{0,31}')
DEFAULT_ACCOUNT = 'default'
MAX_ACCOUNTS = 8
# Anchi's own Desktop OAuth client, shipped with the services when there is one. A client the
# user imported into the vault takes precedence.
BUILTIN_CLIENT = Path(__file__).resolve().with_name('google_client.json')
# Connectors whose credentials the egress proxy may read; never exposed to any other caller.
EGRESS_CONNECTORS = {'github': 'github.json', 'linear': 'linear.json', 'aws': AWS_FILE}


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


def account_name(account):
    if not isinstance(account, str) or not ACCOUNT.fullmatch(account):
        raise Denied('BAD_ACCOUNT')
    return account


def google_file(connector, kind, account=DEFAULT_ACCOUNT):
    name = google(connector)[kind]
    return name if account_name(account) == DEFAULT_ACCOUNT else f'{name[:-5]}.{account}.json'


def account_files(connector, kind):
    """(account, logical name) of every stored file of one kind, by name only (no decryption)."""
    name = google(connector)[kind]
    found = [(DEFAULT_ACCOUNT, name)] if vault.exists(STORE, name) else []
    stem = name[:-5] + '.'
    for path in STORE.glob(stem + '*.json.enc'):
        account = path.name[len(stem) : -len('.json.enc')]
        if ACCOUNT.fullmatch(account) and account != DEFAULT_ACCOUNT:
            found.append((account, path.name[:-4]))
    return sorted(found)


def accounts(connector):
    """Accounts with tokens or a pending revocation; a sign-in in progress is not an account yet."""
    return sorted({a for kind in ('tokens', 'revocation') for a, _ in account_files(connector, kind)})


def google_present(kinds=('tokens',)):
    return any(account_files(connector, kind) for connector in GOOGLE for kind in kinds)


def account_status(connector, account):
    name = google_file(connector, 'tokens', account)
    connected = vault.exists(STORE, name)
    reauth, label = False, None
    if connected and vault.KEY.exists():
        try:
            tokens = read(name)
            reauth, label = bool(tokens.get('reauth_required')), tokens.get('account')
        except Denied:
            pass
    return {
        'name': account,
        'connected': connected,
        'reauth_required': reauth,
        'account': label,
        'revocation_pending': vault.exists(STORE, google_file(connector, 'revocation', account)),
    }


def connector_status(connector, account=None):
    if connector in GOOGLE:
        spec = GOOGLE[connector]
        common = {'scope_text': ' '.join(sorted(spec['scopes'])), 'auth': 'google'}
        if account is not None:
            # One account's view, for the connector service serving a cell pinned to it.
            entry = account_status(connector, account)
            return {**{k: v for k, v in entry.items() if k != 'name'}, **common}
        entries = [account_status(connector, a) for a in accounts(connector)]
        connected = [e for e in entries if e['connected']]
        # The single-account fields describe the default account, else the first connected one.
        primary = next((e for e in connected if e['name'] == DEFAULT_ACCOUNT), connected[0] if connected else {})
        return {
            'connected': bool(connected),
            'reauth_required': primary.get('reauth_required', False),
            'account': primary.get('account'),
            'revocation_pending': any(e['revocation_pending'] for e in entries),
            'accounts': entries,
            **common,
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


def aws_status():
    connected = vault.exists(STORE, AWS_FILE)
    account = None
    if connected and vault.KEY.exists():
        try:
            value = read(AWS_FILE)
            account = value.get('account') or value['access_key_id'][:4] + '…' + value['access_key_id'][-4:]
        except Denied:
            pass
    return {
        'connected': connected,
        'reauth_required': False,
        'account': account,
        'scope_text': '',
        'revocation_pending': False,
        'auth': 'aws',
    }


def status(connector=None):
    if connector == 'aws':
        return aws_status()
    if connector:
        return connector_status(connector)
    value = {name: connector_status(name) for name in (*GOOGLE, *TOKENS)}
    value['aws'] = aws_status()
    value['client_source'] = client_source()
    value['client_configured'] = value['client_source'] is not None
    value['vault_unlocked'] = vault.KEY.exists()
    # Top-level Gmail fields stay for one release so older desktop builds keep working.
    value.update({k: value['gmail'][k] for k in ('connected', 'reauth_required', 'revocation_pending')})
    value['scope'] = SCOPE
    return value


def desktop_client(value):
    client = value.get('installed') if isinstance(value, dict) else None
    if (
        not isinstance(client, dict)
        or not isinstance(client.get('client_id'), str)
        or not client['client_id'].endswith('.apps.googleusercontent.com')
    ):
        raise Denied('DESKTOP_OAUTH_CLIENT_REQUIRED')
    if not isinstance(client.get('client_secret'), str) or not client['client_secret']:
        raise Denied('CLIENT_SECRET_REQUIRED')
    return {k: client[k] for k in ('client_id', 'client_secret')}


def builtin_client():
    """The shipped client in Google's download format, or None when absent or malformed."""
    try:
        return desktop_client(json.loads(BUILTIN_CLIENT.read_text()))
    except (OSError, ValueError, Denied):
        return None


def client_source():
    if vault.exists(STORE, 'client.json'):
        return 'user'
    return 'builtin' if builtin_client() else None


def client():
    if vault.exists(STORE, 'client.json'):
        return read('client.json')
    value = builtin_client()
    if value is None:
        raise Denied('GOOGLE_CLIENT_REQUIRED')
    return value


def remove_pending():
    for connector in GOOGLE:
        for _, name in account_files(connector, 'pending'):
            vault.remove(STORE, name)


def import_client(value):
    # Tokens are bound to the client that obtained them; refreshing with another one fails.
    if google_present():
        raise Denied('DISCONNECT_BEFORE_REPLACING_CLIENT')
    write('client.json', desktop_client(value))
    remove_pending()
    return status()


def remove_client():
    """Drops the user's client, so the built-in one (when shipped) applies again."""
    if google_present():
        raise Denied('DISCONNECT_BEFORE_REPLACING_CLIENT')
    vault.remove(STORE, 'client.json')
    remove_pending()
    return status()


def begin(connector, redirect_uri, account=DEFAULT_ACCOUNT):
    pending = google_file(connector, 'pending', account)
    spec = google(connector)
    if account not in accounts(connector) and len(accounts(connector)) >= MAX_ACCOUNTS:
        raise Denied('TOO_MANY_ACCOUNTS')
    if not isinstance(redirect_uri, str) or not re.fullmatch(r'http://127\.0\.0\.1:[0-9]{1,5}/callback', redirect_uri):
        raise Denied('BAD_REDIRECT_URI')
    oauth_client = client()
    verifier = secrets.token_urlsafe(48)
    state = secrets.token_urlsafe(32)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
    write(
        pending,
        {'verifier': verifier, 'state': state, 'redirect_uri': redirect_uri, 'expires': time.time() + 600},
    )
    params = {
        'client_id': oauth_client['client_id'],
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


def complete(connector, value, account=DEFAULT_ACCOUNT):
    spec = google(connector)
    pending_name = google_file(connector, 'pending', account)
    fields(value, ('code', 'state'), ('code', 'state'))
    pending = read(pending_name)
    if (
        not isinstance(value['state'], str)
        or not secrets.compare_digest(value['state'], pending['state'])
        or pending['expires'] < time.time()
    ):
        raise Denied('INVALID_OAUTH_STATE')
    if not isinstance(value['code'], str) or not 1 <= len(value['code']) <= 4096:
        raise Denied('BAD_REQUEST')
    # Consume before exchange: ambiguous failures require a new login.
    vault.remove(STORE, pending_name)
    result = google_json(
        'oauth2.googleapis.com',
        'POST',
        '/token',
        urlencode(
            {
                **client(),
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
    write(google_file(connector, 'tokens', account), result)
    return status()


def access_token(connector, account=DEFAULT_ACCOUNT):
    spec = google(connector)
    name = google_file(connector, 'tokens', account)
    tokens = read(name)
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
                urlencode({**client(), 'grant_type': 'refresh_token', 'refresh_token': tokens['refresh_token']}),
            )
        except Denied as exc:
            if str(exc) == 'GOOGLE_AUTH_REQUIRED':
                tokens['reauth_required'] = True
                write(name, tokens)
                raise Denied(reauth_code) from None
            raise
        if result.get('scope') and set(result['scope'].split()) != set(spec['scopes']):
            raise Denied('UNEXPECTED_SCOPE')
        tokens.update(result)
        tokens['expires_at'] = time.time() + int(result['expires_in'])
        write(name, tokens)
    return tokens['access_token']


def disconnect(connector, account=DEFAULT_ACCOUNT):
    tokens_name, revocation = google_file(connector, 'tokens', account), google_file(connector, 'revocation', account)
    if vault.exists(STORE, tokens_name):
        tokens = read(tokens_name)
        write(revocation, {'token': tokens.get('refresh_token', tokens['access_token'])})
        vault.remove(STORE, tokens_name)
    vault.remove(STORE, google_file(connector, 'pending', account))
    if vault.exists(STORE, revocation):
        try:
            google_json('oauth2.googleapis.com', 'POST', '/revoke', urlencode(read(revocation)))
            vault.remove(STORE, revocation)
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


AWS_KEY_ID = re.compile(r'(AKIA|ASIA)[A-Z0-9]{12,124}')
AWS_REGION = re.compile(r'[a-z]{2}(-gov)?-[a-z]+-[0-9]')


def import_aws(value):
    """A dedicated least-privilege principal's keys; the proxy re-signs cell requests with them."""
    fields(
        value,
        ('access_key_id', 'secret_access_key', 'session_token', 'region'),
        ('access_key_id', 'secret_access_key', 'region'),
    )
    key_id, secret = value['access_key_id'], value['secret_access_key']
    session = value.get('session_token')
    if not isinstance(key_id, str) or not AWS_KEY_ID.fullmatch(key_id):
        raise Denied('BAD_AWS_ACCESS_KEY_ID')
    if not isinstance(secret, str) or not re.fullmatch(r'[A-Za-z0-9/+=]{20,128}', secret):
        raise Denied('BAD_AWS_SECRET')
    if session is not None and (not isinstance(session, str) or not re.fullmatch(r'[A-Za-z0-9/+=]{16,4096}', session)):
        raise Denied('BAD_AWS_SESSION_TOKEN')
    if key_id.startswith('ASIA') != (session is not None):
        raise Denied('AWS_SESSION_TOKEN_MISMATCH')
    if not isinstance(value['region'], str) or not AWS_REGION.fullmatch(value['region']):
        raise Denied('BAD_AWS_REGION')
    stored = {
        'access_key_id': key_id,
        'secret_access_key': secret,
        'region': value['region'],
        'generation': uuid.uuid4().hex,
        'imported_at': time.time(),
    }
    if session is not None:
        stored['session_token'] = session
    write(AWS_FILE, stored)
    return aws_status()


def remove_aws():
    vault.remove(STORE, AWS_FILE)
    return aws_status()


def set_account(connector, label, account=DEFAULT_ACCOUNT):
    if connector == 'aws':
        name = AWS_FILE
    else:
        name = google_file(connector, 'tokens', account) if connector in GOOGLE else TOKENS[connector]['file']
    if not isinstance(label, str) or not 1 <= len(label) <= 200:
        raise Denied('BAD_ACCOUNT_LABEL')
    value = read(name)
    value['account'] = label
    write(name, value)
    return status(connector)


def remove_token(connector):
    if connector not in TOKENS:
        raise Denied('UNKNOWN_CONNECTOR')
    vault.remove(STORE, TOKENS[connector]['file'])
    return connector_status(connector)


def egress_credential(connector):
    """Credential the egress proxy injects for one connector; secrets only, no labels."""
    if connector not in EGRESS_CONNECTORS:
        raise Denied('UNKNOWN_CONNECTOR')
    value = read(EGRESS_CONNECTORS[connector])
    keys = ('access_key_id', 'secret_access_key', 'session_token', 'region') if connector == 'aws' else ('token',)
    return {**{k: value[k] for k in keys if k in value}, 'generation': value['generation']}


def handle(request, caller):
    fields(request, ('op', 'connector', 'account'), ('op',))
    # A Google connector service names the account of the cell it serves; nobody else names one.
    if 'account' in request and caller not in GOOGLE:
        raise Denied('BAD_REQUEST')
    account = account_name(request.get('account', DEFAULT_ACCOUNT))
    with locked():
        op = request['op']
        if op == 'egress_credential' and caller == 'egress':
            return egress_credential(request.get('connector'))
        if op == 'status':
            # A Google service sees its own account only, not the labels of the others.
            return {caller: connector_status(caller, account)} if caller in GOOGLE else status()
        if op == 'access_token' and caller in GOOGLE:
            token = access_token(caller, account)
            generation = read(google_file(caller, 'tokens', account))['generation']
            return {'access_token': token, 'account_generation': generation}
        if op == 'token' and caller in TOKENS:
            value = read(TOKENS[caller]['file'])
            return {'token': value['token'], 'account_generation': value['generation']}
        if op == 'codex_account' and caller == 'egress':
            # An identifier, not an authenticator: cells need it even when the token has expired.
            return {'account_id': read('codex.json')['account_id']}
        if op == 'codex_token' and caller == 'egress':
            credential = read('codex.json')
            if credential['expires_at'] <= time.time() + 30:
                raise Denied('CODEX_TOKEN_EXPIRED_REIMPORT_ON_HOST')
            return credential
        if op == 'claude_token' and caller == 'egress':
            # A `claude setup-token` token or an API key; no refresh on either side.
            value = read('claude.json')
            return {'token': value['token'], 'kind': value['kind'], 'generation': value['generation']}
        raise Denied('OPERATION_DENIED')
