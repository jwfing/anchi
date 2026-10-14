"""Bounded Reddit reads and approved self posts/comments through an account-bound bridge."""

import json
import re
from urllib.parse import urlencode

import connector_base
import connectors
from common import Denied, ExecutionUnknown, fields, provider_request, rpc

SELF = connectors.CONNECTORS['reddit']
NAME = r'[A-Za-z0-9_]{2,21}'
THING = r't[13]_[a-z0-9]{1,20}'
POST = r't3_[a-z0-9]{1,20}'
WRITES = ('submit', 'comment')


def matches(pattern, value):
    return isinstance(value, str) and bool(re.fullmatch(pattern, value))


def clean_text(value, maximum):
    return (
        isinstance(value, str)
        and 1 <= len(value) <= maximum
        and bool(value.strip())
        and not re.search(r'[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]', value)
    )


PARAMS = {
    'status': ((), ()),
    'list': (('subreddit', 'limit', 'sort', 'cursor'), ('subreddit', 'limit')),
    'search': (('query', 'limit', 'subreddit', 'cursor'), ('query', 'limit')),
    'read': (('id',), ('id',)),
    'comments': (('post_id', 'limit'), ('post_id', 'limit')),
    'submit': (('subreddit', 'title', 'text'), ('subreddit', 'title', 'text')),
    'comment': (('parent', 'text'), ('parent', 'text')),
}


def validate(operation, params):
    op = operation.removeprefix('reddit.')
    if operation != 'reddit.' + op or op not in PARAMS:
        raise Denied('OPERATION_DENIED')
    allowed, required = PARAMS[op]
    fields(params, (*allowed, 'account_id', 'account_label') if op in WRITES else allowed, required)
    for key, pattern in (('subreddit', NAME), ('id', THING), ('parent', THING), ('post_id', POST), ('cursor', POST)):
        if key in params and not matches(pattern, params[key]):
            raise Denied('BAD_' + key.upper())
    if 'limit' in params and (type(params['limit']) is not int or not 1 <= params['limit'] <= 25):
        raise Denied('BAD_LIMIT')
    if 'sort' in params and params['sort'] not in ('hot', 'new', 'top'):
        raise Denied('BAD_SORT')
    for key, maximum in (('query', 512), ('title', 300), ('text', 10000)):
        if key in params and not clean_text(params[key], maximum):
            raise Denied('BAD_' + key.upper())
    if 'title' in params and re.search(r'[\r\n\t]', params['title']):
        raise Denied('BAD_TITLE')
    if 'account_id' in params and not matches(r'[a-z0-9]{1,20}', params['account_id']):
        raise Denied('BAD_ACCOUNT')
    if 'account_label' in params and not matches(r'u/[A-Za-z0-9_-]{3,20}', params['account_label']):
        raise Denied('BAD_ACCOUNT')


def api(cred, method, path, form=None):
    return provider_request(
        SELF,
        method,
        path,
        token=cred['token'],
        headers={'User-Agent': cred['user_agent']},
        body=urlencode(form).encode() if form is not None else None,
        content_type='application/x-www-form-urlencoded',
        write=form is not None,
        raw=True,
    )


def listing(value):
    if not isinstance(value, dict) or value.get('kind') != 'Listing' or not isinstance(value.get('data'), dict):
        raise Denied('PROVIDER_RESPONSE_INVALID')
    data = value['data']
    if not isinstance(data.get('children'), list):
        raise Denied('PROVIDER_RESPONSE_INVALID')
    return data


def read(cred, op, params):
    limit = params.get('limit', 1)
    query = {'raw_json': 1, 'limit': limit}
    if op == 'read':
        path = '/api/info'
        query['id'] = params['id']
    elif op == 'comments':
        path = '/comments/' + params['post_id'][3:]
        query.update(depth=3, sort='top')
    else:
        prefix = '/r/' + params['subreddit'] if 'subreddit' in params else ''
        path = prefix + ('/search' if op == 'search' else '/' + params.get('sort', 'hot'))
        if op == 'search':
            query.update(q=params['query'], type='link', sort='relevance', restrict_sr=int(bool(prefix)))
        if 'cursor' in params:
            query['after'] = params['cursor']
    try:
        value = json.loads(api(cred, 'GET', path + '?' + urlencode(query)))
    except ValueError:
        raise Denied('PROVIDER_RESPONSE_INVALID') from None
    if op == 'comments':
        if not isinstance(value, list) or len(value) != 2:
            raise Denied('PROVIDER_RESPONSE_INVALID')
        value = value[1]
    data = listing(value)
    pending = list(data['children'][: limit + 1])
    result, clipped = [], len(data['children']) > limit
    while pending and len(result) < limit:
        thing = pending.pop(0)
        if not isinstance(thing, dict):
            raise Denied('PROVIDER_RESPONSE_INVALID')
        if thing.get('kind') == 'more':
            clipped = True
            continue
        item = thing.get('data')
        if not isinstance(item, dict) or thing.get('kind') not in ('t1', 't3') or not matches(THING, item.get('name')):
            raise Denied('PROVIDER_RESPONSE_INVALID')
        out = {'id': item['name'], 'kind': 'post' if thing['kind'] == 't3' else 'comment'}
        for key, maximum in (
            ('title', 1200),
            ('selftext', 12000),
            ('body', 12000),
            ('author', 100),
            ('subreddit', 100),
        ):
            if isinstance(item.get(key), str):
                out[key], cut = connector_base.text_limit(item[key], maximum)
                clipped |= cut
        if thing['kind'] == 't3':
            out['url'] = 'https://www.reddit.com/comments/' + item['name'][3:] + '/'
        for key in ('parent_id', 'link_id'):
            if matches(THING, item.get(key)):
                out[key] = item[key]
        result.append(out)
        if len(json.dumps(result, ensure_ascii=False).encode()) > 46000:
            result.pop()
            clipped = True
            break
        if op == 'comments' and item.get('replies'):
            children = listing(item['replies'])['children']
            capacity = limit - len(result) - len(pending)
            pending.extend(children[: max(0, capacity)])
            clipped |= len(children) > max(0, capacity)
    clipped |= bool(pending)
    cursor = data.get('after') if matches(POST, data.get('after')) and op in ('list', 'search') else None
    return {
        'items': result,
        'next_cursor': None if clipped else cursor,
        'truncated': clipped or bool(cursor),
        'untrusted_content': True,
    }


def publish(cred, op, params):
    form = {'api_type': 'json', 'raw_json': 1, 'text': params['text']}
    if op == 'submit':
        form.update(kind='self', sr=params['subreddit'], title=params['title'], sendreplies='false', resubmit='false')
    else:
        form['thing_id'] = params['parent']
    try:
        value = json.loads(api(cred, 'POST', '/api/' + op, form))
        envelope = value.get('json') if isinstance(value, dict) else None
        if not isinstance(envelope, dict) or not isinstance(envelope.get('errors'), list):
            raise ValueError()
        if envelope['errors']:
            # Reddit reports many rejections with HTTP 200. Never echo its messages.
            rate = any(isinstance(e, list) and e and e[0] == 'RATELIMIT' for e in envelope['errors'])
            raise Denied('PROVIDER_RATE_LIMITED' if rate else 'REDDIT_WRITE_REJECTED')
        data = envelope['data']
        name = data['name'] if op == 'submit' else data['things'][0]['data']['name']
        if not matches(POST if op == 'submit' else r't1_[a-z0-9]{1,20}', name):
            raise ValueError()
    except (ValueError, KeyError, TypeError, IndexError):
        raise ExecutionUnknown('WRITE_EXECUTION_UNKNOWN') from None
    result = {'id': name}
    if op == 'submit':
        result['url'] = 'https://www.reddit.com/comments/' + name[3:] + '/'
    return result


def handle(request):
    op = request.get('op')
    if op not in PARAMS:
        raise Denied('OPERATION_DENIED')
    allowed, _ = PARAMS[op]
    fields(request, ('op', *allowed, 'request_id') if op in WRITES else ('op', *allowed), ('op',))
    params = {k: v for k, v in request.items() if k not in ('op', 'request_id')}
    operation = 'reddit.' + op
    validate(operation, params)
    if op == 'status':
        return rpc(connector_base.AUTH_SOCKET, {'op': 'status'})['reddit']
    cred = connector_base.credential(SELF)
    if op not in WRITES:
        return connector_base.read(SELF, operation, params, cred['generation'], lambda: read(cred, op, params))
    params.update(account_id=cred['user_id'], account_label=cred['account'])
    return connector_base.write(
        SELF,
        operation,
        params,
        cred['generation'],
        request.get('request_id'),
        lambda p: p,
        lambda p: publish(cred, op, p),
    )
