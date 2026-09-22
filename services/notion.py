"""Notion connector: search, read pages as text, create pages, append paragraphs."""

import json
import re

import connector_base
import connectors
from common import Denied, fields, provider_request, rpc

SELF = connectors.CONNECTORS['notion']
VERSION = '2022-06-28'
ID = re.compile(r'[A-Za-z0-9-]{1,128}')
TEXT_BLOCKS = (
    'paragraph',
    'heading_1',
    'heading_2',
    'heading_3',
    'bulleted_list_item',
    'numbered_list_item',
    'quote',
    'code',
    'to_do',
    'callout',
)
LIST_BLOCKS = ('bulleted_list_item', 'numbered_list_item', 'to_do')
HEADERS = {'Notion-Version': VERSION}


def check_paragraphs(value):
    if not isinstance(value, list) or not 1 <= len(value) <= 100:
        raise Denied('BAD_PARAGRAPHS')
    total = 0
    for item in value:
        if not isinstance(item, str) or len(item) > 2000:
            raise Denied('BAD_PARAGRAPHS')
        total += len(item.encode('utf-8'))
    if total > 48000:
        raise Denied('BAD_TEXT')


def validate(op, params):
    if op == 'notion.status':
        fields(params, ())
    elif op == 'notion.search':
        fields(params, ('query', 'limit'), ('query', 'limit'))
        if (
            not isinstance(params['query'], str)
            or len(params['query']) > 512
            or any(ord(c) < 32 for c in params['query'])
        ):
            raise Denied('BAD_QUERY')
        if type(params['limit']) is not int or not 1 <= params['limit'] <= 10:
            raise Denied('BAD_LIMIT')
    elif op == 'notion.read':
        fields(params, ('page_id',), ('page_id',))
        if not isinstance(params['page_id'], str) or not ID.fullmatch(params['page_id']):
            raise Denied('BAD_PAGE_ID')
    elif op == 'notion.create_page':
        fields(params, ('parent_page_id', 'title', 'paragraphs'), ('parent_page_id', 'title', 'paragraphs'))
        if (
            not ID.fullmatch(str(params['parent_page_id']))
            or not isinstance(params['title'], str)
            or not 1 <= len(params['title']) <= 200
        ):
            raise Denied('BAD_TARGET')
        check_paragraphs(params['paragraphs'])
    elif op == 'notion.append':
        fields(
            params,
            ('page_id', 'paragraphs', 'expected_last_edited', 'title'),
            ('page_id', 'paragraphs', 'expected_last_edited', 'title'),
        )
        if not ID.fullmatch(str(params['page_id'])) or not isinstance(params['expected_last_edited'], str):
            raise Denied('BAD_TARGET')
        check_paragraphs(params['paragraphs'])
    else:
        raise Denied('OPERATION_DENIED')


def plain(rich):
    return ''.join(item.get('plain_text', '') for item in rich if isinstance(item, dict))


def title_of(item):
    if item.get('object') == 'database':
        return plain(item.get('title', []))
    for prop in item.get('properties', {}).values():
        if isinstance(prop, dict) and prop.get('type') == 'title':
            return plain(prop.get('title', []))
    return ''


def post(token, path, body):
    return provider_request(SELF, 'POST', path, token=token, headers=HEADERS, body=json.dumps(body).encode('utf-8'))


def get(token, path):
    return provider_request(SELF, 'GET', path, token=token, headers=HEADERS)


def search(token, query, limit):
    result = post(token, '/v1/search', {'query': query, 'page_size': limit})
    results = [
        {
            'id': r.get('id'),
            'object': r.get('object'),
            'title': title_of(r),
            'last_edited_time': r.get('last_edited_time'),
        }
        for r in result.get('results', [])[:limit]
    ]
    return {'results': results, 'untrusted_content': True}


def read(token, page_id):
    page = get(token, f'/v1/pages/{page_id}')
    lines, reasons = [], set()
    pages_left, bytes_left = 5, 40000

    def visit(block_id, depth=0):
        nonlocal pages_left, bytes_left
        if depth > 8:
            reasons.add('depth_limit')
            return
        cursor = None
        while True:
            if pages_left <= 0:
                reasons.add('page_limit')
                return
            pages_left -= 1
            path = f'/v1/blocks/{block_id}/children?page_size=100' + (f'&start_cursor={cursor}' if cursor else '')
            chunk = get(token, path)
            for block in chunk.get('results', []):
                kind = block.get('type')
                if kind in TEXT_BLOCKS:
                    text = ('- ' if kind in LIST_BLOCKS else '') + plain(block.get(kind, {}).get('rich_text', []))
                    text, clipped = connector_base.text_limit(text, max(0, bytes_left - 1))
                    lines.append(text)
                    bytes_left -= len(text.encode('utf-8')) + 1
                    if clipped or bytes_left <= 0:
                        reasons.add('text_limit')
                        return
                else:
                    reasons.add('unsupported_block')
                if block.get('has_children'):
                    child_id = block.get('id')
                    if not isinstance(child_id, str) or not ID.fullmatch(child_id):
                        reasons.add('missing_children')
                    else:
                        visit(child_id, depth + 1)
            if not chunk.get('has_more'):
                return
            cursor = chunk.get('next_cursor')
            if not cursor:
                reasons.add('missing_cursor')
                return

    visit(page_id)
    text = '\n'.join(lines)
    truncated = bool(reasons)
    return {
        'id': page.get('id'),
        'title': title_of(page),
        'last_edited_time': page.get('last_edited_time'),
        'text': text,
        'truncated': truncated,
        'omissions': sorted(reasons),
        'untrusted_content': True,
    }


def paragraph_blocks(paragraphs):
    return [
        {'object': 'block', 'type': 'paragraph', 'paragraph': {'rich_text': [{'type': 'text', 'text': {'content': p}}]}}
        for p in paragraphs
    ]


def create_page(token, params):
    body = {
        'parent': {'page_id': params['parent_page_id']},
        'properties': {'title': {'title': [{'type': 'text', 'text': {'content': params['title']}}]}},
        'children': paragraph_blocks(params['paragraphs']),
    }
    result = post(token, '/v1/pages', body)
    return {'id': result.get('id')}


def prepare_append(token, params):
    """Bind the approval to the page's current edit time so a concurrent edit fails the append."""
    page = get(token, f'/v1/pages/{params["page_id"]}')
    return {**params, 'expected_last_edited': str(page.get('last_edited_time', '')), 'title': title_of(page)}


def append(token, params):
    page = get(token, f'/v1/pages/{params["page_id"]}')
    if str(page.get('last_edited_time', '')) != params['expected_last_edited']:
        raise Denied('TARGET_CHANGED')
    provider_request(
        SELF,
        'PATCH',
        f'/v1/blocks/{params["page_id"]}/children',
        token=token,
        headers=HEADERS,
        body=json.dumps({'children': paragraph_blocks(params['paragraphs'])}).encode('utf-8'),
    )
    return {'id': params['page_id'], 'appended': len(params['paragraphs'])}


def probe(token):
    me = get(token, '/v1/users/me')
    label = me.get('bot', {}).get('workspace_name') or me.get('name') or ''
    if not isinstance(label, str) or not 1 <= len(label) <= 200:
        raise Denied('PROBE_FAILED')
    return label


def handle(request):
    op = request.get('op')
    if op == 'status':
        fields(request, ('op',), ('op',))
        return rpc(connector_base.AUTH_SOCKET, {'op': 'status'})['notion']
    if op not in ('search', 'read', 'create_page', 'append'):
        raise Denied('OPERATION_DENIED')
    request_id = request.get('request_id')
    params = {k: v for k, v in request.items() if k not in ('op', 'request_id')}
    operation = 'notion.' + op
    if op in ('search', 'read', 'create_page'):
        validate(operation, params)
    cred = connector_base.credential(SELF)
    token, account = cred['token'], cred['generation']
    if op == 'search':
        return connector_base.read(
            SELF, operation, params, account, lambda: search(token, params['query'], params['limit'])
        )
    if op == 'read':
        return connector_base.read(SELF, operation, params, account, lambda: read(token, params['page_id']))
    if op == 'create_page':
        return connector_base.write(
            SELF, operation, params, account, request_id, lambda p: p, lambda p: create_page(token, p)
        )

    def prepare(p):
        fields(p, ('page_id', 'paragraphs'), ('page_id', 'paragraphs'))
        validate('notion.read', {'page_id': p['page_id']})
        check_paragraphs(p['paragraphs'])
        frozen = prepare_append(token, p)
        validate(operation, frozen)
        return frozen

    return connector_base.write(SELF, operation, params, account, request_id, prepare, lambda p: append(token, p))
