"""Notion connector: search, read pages as text, create pages, append paragraphs."""

import re

from common import Denied, fields

ID = re.compile(r'[A-Za-z0-9-]{1,128}')


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


def handle(request):
    raise Denied('OPERATION_DENIED')
