"""Slack connector (bot token): list joined channels, read history, post messages."""

import re

from common import Denied, fields

CHANNEL = re.compile(r'[A-Z0-9]{1,32}')
TS = re.compile(r'[0-9]{1,16}\.[0-9]{1,8}')


def validate(op, params):
    if op == 'slack.status':
        fields(params, ())
    elif op == 'slack.channels':
        fields(params, ('limit',), ('limit',))
        if type(params['limit']) is not int or not 1 <= params['limit'] <= 200:
            raise Denied('BAD_LIMIT')
    elif op == 'slack.history':
        fields(params, ('channel', 'limit', 'oldest'), ('channel', 'limit'))
        if not isinstance(params['channel'], str) or not CHANNEL.fullmatch(params['channel']):
            raise Denied('BAD_CHANNEL')
        if type(params['limit']) is not int or not 1 <= params['limit'] <= 50:
            raise Denied('BAD_LIMIT')
        if 'oldest' in params and (type(params['oldest']) is not int or params['oldest'] < 0):
            raise Denied('BAD_OLDEST')
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


def handle(request):
    raise Denied('OPERATION_DENIED')
