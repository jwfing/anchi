"""Slack connector (bot token): list joined channels, read history, post messages."""

import json
import re
from urllib.parse import urlencode

import connector_base
import connectors
from common import Denied, fields, provider_request, rpc

SELF = connectors.CONNECTORS['slack']
CHANNEL = re.compile(r'[A-Z0-9]{1,32}')
TS = re.compile(r'[0-9]{1,16}\.[0-9]{1,8}')
ERRORS = {
    'not_in_channel': 'NOT_IN_CHANNEL',
    'channel_not_found': 'NOT_IN_CHANNEL',
    'invalid_auth': 'REAUTH_REQUIRED',
    'token_revoked': 'REAUTH_REQUIRED',
    'account_inactive': 'REAUTH_REQUIRED',
    'ratelimited': 'PROVIDER_RATE_LIMITED',
}


def validate(op, params):
    if op == 'slack.status':
        fields(params, ())
    elif op == 'slack.channels':
        fields(params, ('limit',), ('limit',))
        if type(params['limit']) is not int or not 1 <= params['limit'] <= 200:
            raise Denied('BAD_LIMIT')
    elif op == 'slack.history':
        fields(params, ('channel', 'limit', 'oldest', 'cursor'), ('channel', 'limit'))
        if not isinstance(params['channel'], str) or not CHANNEL.fullmatch(params['channel']):
            raise Denied('BAD_CHANNEL')
        if type(params['limit']) is not int or not 1 <= params['limit'] <= 50:
            raise Denied('BAD_LIMIT')
        if 'oldest' in params and (type(params['oldest']) is not int or params['oldest'] < 0):
            raise Denied('BAD_OLDEST')
        if 'cursor' in params and (
            not isinstance(params['cursor'], str) or not re.fullmatch(r'[A-Za-z0-9_=:-]{1,512}', params['cursor'])
        ):
            raise Denied('BAD_CURSOR')
    elif op == 'slack.post':
        fields(params, ('channel', 'text', 'thread_ts'), ('channel', 'text'))
        if not isinstance(params['channel'], str) or not CHANNEL.fullmatch(params['channel']):
            raise Denied('BAD_CHANNEL')
        if not isinstance(params['text'], str) or not 1 <= len(params['text']) <= 4000:
            raise Denied('BAD_TEXT')
        if 'thread_ts' in params and (
            not isinstance(params['thread_ts'], str) or not TS.fullmatch(params['thread_ts'])
        ):
            raise Denied('BAD_THREAD')
    else:
        raise Denied('OPERATION_DENIED')


def call(token, method, path, body=None, *, write=False):
    encoded = json.dumps(body).encode('utf-8') if body is not None else None
    result = provider_request(SELF, method, path, token=token, body=encoded, write=write)
    if result.get('ok') is not True:
        # Slack signals failures with ok:false; map to fixed codes, never echo provider text.
        raise Denied(ERRORS.get(str(result.get('error')), 'PROVIDER_REJECTED'))
    return result


def channels(token, limit):
    query = urlencode({'types': 'public_channel,private_channel', 'exclude_archived': 'true', 'limit': limit})
    result = call(token, 'GET', '/api/conversations.list?' + query)
    joined = [{'id': c['id'], 'name': c.get('name', '')} for c in result.get('channels', []) if c.get('is_member')]
    return {'channels': joined[:limit], 'untrusted_content': True}


def history(token, params):
    query = {'channel': params['channel'], 'limit': params['limit']}
    if 'oldest' in params:
        query['oldest'] = params['oldest']
    if 'cursor' in params:
        query['cursor'] = params['cursor']
    result = call(token, 'GET', '/api/conversations.history?' + urlencode(query))
    messages = []
    clipped = False
    for m in result.get('messages', [])[: params['limit']]:
        item = {'ts': m.get('ts'), 'user': m.get('user', ''), 'text': str(m.get('text', ''))[:4000]}
        if m.get('thread_ts'):
            item['thread_ts'] = m['thread_ts']
        messages.append(item)
        if len(json.dumps(messages, ensure_ascii=False).encode('utf-8')) > 46000:
            messages.pop()
            clipped = True
            break
        if len(str(m.get('text', ''))) > 4000:
            clipped = True
    return {
        'messages': messages,
        'untrusted_content': True,
        'truncated': clipped or bool(result.get('has_more')),
        'next_cursor': result.get('response_metadata', {}).get('next_cursor') if not clipped else None,
    }


def post(token, params):
    body = {'channel': params['channel'], 'text': params['text']}
    if 'thread_ts' in params:
        body['thread_ts'] = params['thread_ts']
    result = call(token, 'POST', '/api/chat.postMessage', body, write=True)
    return {'ts': result.get('ts'), 'channel': result.get('channel')}


def probe(token):
    result = call(token, 'GET', '/api/auth.test')
    team = result.get('team', '')
    if not isinstance(team, str) or not 1 <= len(team) <= 200:
        raise Denied('PROBE_FAILED')
    return team


def revoke(token):
    return bool(call(token, 'GET', '/api/auth.revoke').get('revoked'))


def handle(request):
    op = request.get('op')
    if op == 'status':
        fields(request, ('op',), ('op',))
        return rpc(connector_base.AUTH_SOCKET, {'op': 'status'})['slack']
    if op not in ('channels', 'history', 'post'):
        raise Denied('OPERATION_DENIED')
    request_id = request.get('request_id')
    params = {k: v for k, v in request.items() if k not in ('op', 'request_id')}
    operation = 'slack.' + op
    validate(operation, params)
    cred = connector_base.credential(SELF)
    token, account = cred['token'], cred['generation']
    if op == 'channels':
        return connector_base.read(SELF, operation, params, account, lambda: channels(token, params['limit']))
    if op == 'history':
        return connector_base.read(SELF, operation, params, account, lambda: history(token, params))
    return connector_base.write(SELF, operation, params, account, request_id, lambda p: p, lambda p: post(token, p))
