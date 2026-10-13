"""Bounded X reads and approved text posts; no arbitrary endpoints or cell-held credentials."""

import json
import re
import sqlite3
import time
from urllib.parse import urlencode

import connector_base
import connectors
from common import Denied, ExecutionUnknown, fields, provider_request, rpc

SELF = connectors.CONNECTORS['x']
ID = re.compile(r'[0-9]{1,20}')
CURSOR = re.compile(r'[A-Za-z0-9_=-]{1,2048}')
DAILY_READS = 1000


def identifier(value):
    return isinstance(value, str) and bool(ID.fullmatch(value))


def clean_text(value, maximum):
    return (
        isinstance(value, str)
        and 1 <= len(value) <= maximum
        and bool(value.strip())
        and not re.search(r'[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]', value)
    )


def validate(op, params):
    if op == 'x.status':
        fields(params, ())
    elif op == 'x.read':
        fields(params, ('id',), ('id',))
        if not identifier(params['id']):
            raise Denied('BAD_POST_ID')
    elif op in ('x.search', 'x.mentions'):
        allowed = ('limit', 'cursor', 'query') if op == 'x.search' else ('limit', 'cursor')
        required = ('limit', 'query') if op == 'x.search' else ('limit',)
        fields(params, allowed, required)
        if type(params['limit']) is not int or not 10 <= params['limit'] <= 25:
            raise Denied('BAD_LIMIT')
        if op == 'x.search' and not clean_text(params['query'], 512):
            raise Denied('BAD_QUERY')
        if 'cursor' in params and (not isinstance(params['cursor'], str) or not CURSOR.fullmatch(params['cursor'])):
            raise Denied('BAD_CURSOR')
    elif op == 'x.post':
        fields(params, ('text', 'reply_to', 'account_id', 'account_label'), ('text',))
        if not clean_text(params['text'], 280):
            raise Denied('BAD_TEXT')
        if 'reply_to' in params and not identifier(params['reply_to']):
            raise Denied('BAD_POST_ID')
        if 'account_id' in params and not identifier(params['account_id']):
            raise Denied('BAD_ACCOUNT')
        if 'account_label' in params and (
            not isinstance(params['account_label'], str)
            or not re.fullmatch(r'@[A-Za-z0-9_]{1,15}', params['account_label'])
        ):
            raise Denied('BAD_ACCOUNT')
    else:
        raise Denied('OPERATION_DENIED')


def reserve_reads(count):
    """Reserve the requested resource count before calling X, including unsuccessful reads."""
    path = connector_base.LEDGER_ROOT / 'secure-x' / 'reads.sqlite3'
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=5)
    try:
        with conn:
            conn.execute('CREATE TABLE IF NOT EXISTS usage (day INTEGER PRIMARY KEY, count INTEGER NOT NULL)')
            conn.execute('BEGIN IMMEDIATE')
            day = int(time.time() // 86400)
            conn.execute('DELETE FROM usage WHERE day < ?', (day,))
            conn.execute('INSERT OR IGNORE INTO usage VALUES (?, 0)', (day,))
            if conn.execute('SELECT count FROM usage WHERE day=?', (day,)).fetchone()[0] + count > DAILY_READS:
                raise Denied('X_DAILY_READ_LIMIT')
            conn.execute('UPDATE usage SET count=count+? WHERE day=?', (count, day))
    finally:
        conn.close()


def posts(token, op, params, user_id):
    limit = params.get('limit', 1)
    query = {'tweet.fields': 'author_id,created_at'}
    if op == 'read':
        path = '/2/tweets/' + params['id']
    else:
        query['max_results'] = limit
        if op == 'search':
            path = '/2/tweets/search/recent'
            query['query'] = params['query']
            cursor_key = 'next_token'
        else:
            path = f'/2/users/{user_id}/mentions'
            cursor_key = 'pagination_token'
        if 'cursor' in params:
            query[cursor_key] = params['cursor']
    reserve_reads(limit)
    value = provider_request(SELF, 'GET', path + '?' + urlencode(query), token=token)
    data = value.get('data', [] if op != 'read' else None)
    if op == 'read':
        data = [data] if isinstance(data, dict) else []
    if not isinstance(data, list):
        raise Denied('PROVIDER_RESPONSE_INVALID')
    result, clipped = [], False
    for item in data[:limit]:
        if not isinstance(item, dict) or not identifier(item.get('id')) or not isinstance(item.get('text'), str):
            raise Denied('PROVIDER_RESPONSE_INVALID')
        text, cut = connector_base.text_limit(item['text'], 8000)
        post = {'id': item['id'], 'text': text, 'url': 'https://x.com/i/status/' + item['id']}
        if identifier(item.get('author_id')):
            post['author_id'] = item['author_id']
        if isinstance(item.get('created_at'), str):
            post['created_at'] = item['created_at'][:40]
        result.append(post)
        if len(json.dumps(result, ensure_ascii=False).encode()) > 46000:
            result.pop()
            clipped = True
            break
        clipped |= cut
    meta = value.get('meta', {})
    cursor = meta.get('next_token') if isinstance(meta, dict) else None
    if not isinstance(cursor, str) or not CURSOR.fullmatch(cursor):
        cursor = None
    return {
        'posts': result,
        'next_cursor': None if clipped else cursor,
        'truncated': clipped or bool(cursor) or len(data) > limit,
        'untrusted_content': True,
    }


def post(token, params):
    body = {'text': params['text']}
    if 'reply_to' in params:
        body['reply'] = {'in_reply_to_tweet_id': params['reply_to']}
    value = provider_request(
        SELF, 'POST', '/2/tweets', token=token, body=json.dumps(body).encode(), write=True, success_statuses=(201,)
    )
    data = value.get('data')
    if not isinstance(data, dict) or not identifier(data.get('id')):
        raise ExecutionUnknown('WRITE_EXECUTION_UNKNOWN')
    return {'id': data['id'], 'url': 'https://x.com/i/status/' + data['id']}


def handle(request):
    op = request.get('op')
    if op == 'status':
        fields(request, ('op',), ('op',))
        return rpc(connector_base.AUTH_SOCKET, {'op': 'status'})['x']
    if op not in ('read', 'search', 'mentions', 'post'):
        raise Denied('OPERATION_DENIED')
    # The cell cannot choose the posting account or inject trusted approval labels.
    allowed = {
        'read': ('id',),
        'search': ('query', 'limit', 'cursor'),
        'mentions': ('limit', 'cursor'),
        'post': ('text', 'reply_to', 'request_id'),
    }[op]
    fields(request, ('op', *allowed), ('op',))
    params = {k: v for k, v in request.items() if k not in ('op', 'request_id')}
    operation = 'x.' + op
    validate(operation, params)
    cred = connector_base.credential(SELF)
    token, account = cred['token'], cred['generation']
    if op != 'post':
        return connector_base.read(SELF, operation, params, account, lambda: posts(token, op, params, cred['user_id']))
    params.update(account_id=cred['user_id'], account_label=cred['account'])
    return connector_base.write(
        SELF, operation, params, account, request.get('request_id'), lambda p: p, lambda p: post(token, p)
    )
