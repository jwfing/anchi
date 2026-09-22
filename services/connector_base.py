"""Shared read/write execution for connector handlers: policy first, one upstream call, durable ledger."""

import hashlib
import json
from pathlib import Path

from common import Denied, ExecutionUnknown, rpc
from ledger import Ledger
import policy_client

AUTH_SOCKET = '/run/secure-auth/token.sock'
LEDGER_ROOT = Path('/var/lib')
DAILY_WRITES = 200


def ledger(connector):
    return Ledger(
        LEDGER_ROOT / f'secure-{connector.id}' / 'writes.sqlite3', connector.id, limit_code='DAILY_WRITE_LIMIT'
    )


def credential(connector):
    """Token and account generation for this service identity; the kernel UID selects the credential."""
    op = 'access_token' if connector.credential.startswith('google:') else 'token'
    value = rpc(AUTH_SOCKET, {'op': op})
    return {'token': value.get('access_token') or value.get('token'), 'generation': value['account_generation']}


def text_limit(text, limit=40000):
    data = text.encode('utf-8')
    if len(data) <= limit:
        return text, False
    return data[:limit].decode('utf-8', 'ignore'), True


def read(connector, op, params, account, execute):
    policy_client.require({'operation': op, 'account': account, 'params': params})
    return execute()


def write(connector, op, params, account, request_id, prepare, execute):
    """Freeze the exact content, get a one-time grant, execute once; ambiguous outcomes stay UNKNOWN."""
    if not isinstance(request_id, str) or len(request_id) != 32 or any(c not in '0123456789abcdef' for c in request_id):
        raise Denied('BAD_REQUEST_ID')
    book = ledger(connector)
    source_digest = hashlib.sha256(
        json.dumps(
            {'operation': op, 'account': account, 'params': params}, sort_keys=True, separators=(',', ':')
        ).encode()
    ).hexdigest()
    frozen = book.freeze(request_id, source_digest, lambda: prepare(dict(params)))
    action = {'operation': op, 'account': account, 'params': frozen}
    digest = hashlib.sha256(
        json.dumps(action, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()
    ).hexdigest()
    cached = book.begin(request_id, digest, model=op, daily_limit=DAILY_WRITES)
    if cached is not None:
        return cached
    try:
        policy_client.require(action)
    except Denied as exc:
        if str(exc).startswith('APPROVAL_REQUIRED:'):
            book.waiting(request_id)
        else:
            book.mark(request_id, 'FAILED', error=str(exc))
        raise
    try:
        result = execute(frozen)
    except ExecutionUnknown:
        book.mark(request_id, 'UNKNOWN', error='WRITE_EXECUTION_UNKNOWN')
        raise Denied('WRITE_EXECUTION_UNKNOWN') from None
    except Denied as exc:
        book.mark(request_id, 'FAILED', error=str(exc))
        raise
    except Exception:
        book.mark(request_id, 'UNKNOWN', error='WRITE_EXECUTION_UNKNOWN')
        raise Denied('WRITE_EXECUTION_UNKNOWN') from None
    book.mark(request_id, 'SUCCEEDED', result=result)
    return result
