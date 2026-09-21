"""Google Drive connector: search and read text, create files, update files this app created."""

import re

from common import Denied, fields

DOC = 'application/vnd.google-apps.document'
TEXT_TYPES = ('text/plain', 'text/markdown', 'application/json')
CREATE_TYPES = ('text/plain', 'text/markdown', DOC)
ID = re.compile(r'[A-Za-z0-9_-]{1,128}')


def check_text(text):
    if not isinstance(text, str) or len(text.encode('utf-8')) > 48000:
        raise Denied('BAD_TEXT')


def check_query(query):
    if not isinstance(query, str) or not 1 <= len(query) <= 512 or any(ord(c) < 32 for c in query):
        raise Denied('BAD_QUERY')


def validate(op, params):
    if op == 'drive.status':
        fields(params, ())
    elif op == 'drive.search':
        fields(params, ('query', 'limit'), ('query', 'limit'))
        check_query(params['query'])
        if type(params['limit']) is not int or not 1 <= params['limit'] <= 10:
            raise Denied('BAD_LIMIT')
    elif op == 'drive.read':
        fields(params, ('file_id',), ('file_id',))
        if not isinstance(params['file_id'], str) or not ID.fullmatch(params['file_id']):
            raise Denied('BAD_FILE_ID')
    elif op == 'drive.create':
        fields(params, ('parent_id', 'name', 'mime_type', 'text'), ('parent_id', 'name', 'mime_type', 'text'))
        if (
            not ID.fullmatch(str(params['parent_id']))
            or not isinstance(params['name'], str)
            or not 1 <= len(params['name']) <= 255
            or '/' in params['name']
        ):
            raise Denied('BAD_TARGET')
        if params['mime_type'] not in CREATE_TYPES:
            raise Denied('UNSUPPORTED_MIME_TYPE')
        check_text(params['text'])
    elif op == 'drive.update':
        # expected_revision/name/mime_type are filled by prepare(); the cell never supplies them.
        fields(
            params,
            ('file_id', 'text', 'expected_revision', 'name', 'mime_type'),
            ('file_id', 'text', 'expected_revision', 'name', 'mime_type'),
        )
        if not ID.fullmatch(str(params['file_id'])) or not isinstance(params['expected_revision'], str):
            raise Denied('BAD_TARGET')
        check_text(params['text'])
    else:
        raise Denied('OPERATION_DENIED')


def handle(request):
    raise Denied('OPERATION_DENIED')
