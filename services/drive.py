"""Google Drive connector: search and read text, create files, update files this app created."""

import json
import re
from urllib.parse import quote, urlencode

import connector_base
import connectors
from common import Denied, fields, provider_request, rpc

SELF = connectors.CONNECTORS['drive']
DOC = 'application/vnd.google-apps.document'
TEXT_TYPES = ('text/plain', 'text/markdown', 'application/json')
CREATE_TYPES = ('text/plain', 'text/markdown', DOC)
ID = re.compile(r'[A-Za-z0-9_-]{1,128}')
FIELDS = 'id,name,mimeType,modifiedTime,size,headRevisionId'
BOUNDARY = 'anchi-7a1c3e-multipart'


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
            ('file_id', 'text', 'expected_revision', 'expected_etag', 'name', 'mime_type'),
            ('file_id', 'text', 'expected_revision', 'expected_etag', 'name', 'mime_type'),
        )
        if not ID.fullmatch(str(params['file_id'])) or not isinstance(params['expected_revision'], str):
            raise Denied('BAD_TARGET')
        if (
            (params['expected_etag'] is not None and not valid_etag(params['expected_etag']))
            or not params['expected_revision']
            or params['mime_type'] not in TEXT_TYPES
        ):
            raise Denied('SAFE_UPDATE_UNAVAILABLE')
        check_text(params['text'])
    else:
        raise Denied('OPERATION_DENIED')


def valid_etag(value):
    return isinstance(value, str) and re.fullmatch(r'"[\x21\x23-\x7e]{1,256}"', value) is not None


def metadata(token, file_id):
    value, etag = provider_request(
        SELF, 'GET', f'/drive/v3/files/{file_id}?fields={FIELDS}', token=token, with_etag=True
    )
    return {**value, '_etag': etag}


def search(token, query, limit):
    structured = any(k in query for k in ('contains', '=', 'mimeType', 'name'))
    expression = query if structured else "fullText contains '" + query.replace("'", "\\'") + "'"
    params = {'q': expression, 'pageSize': limit, 'fields': 'files(id,name,mimeType,modifiedTime,size)'}
    result = provider_request(SELF, 'GET', '/drive/v3/files?' + urlencode(params), token=token)
    keep = ('id', 'name', 'mimeType', 'modifiedTime', 'size')
    files = [{k: f[k] for k in keep if k in f} for f in result.get('files', [])[:limit]]
    return {'files': files, 'untrusted_content': True}


def read(token, file_id):
    meta = metadata(token, file_id)
    if meta.get('mimeType') == DOC:
        path = f'/drive/v3/files/{file_id}/export?mimeType={quote("text/plain", safe="")}'
        raw = provider_request(SELF, 'GET', path, token=token, raw=True)
    elif meta.get('mimeType') in TEXT_TYPES:
        raw = provider_request(SELF, 'GET', f'/drive/v3/files/{file_id}?alt=media', token=token, raw=True)
    else:
        raise Denied('UNSUPPORTED_MIME_TYPE')
    text, truncated = connector_base.text_limit(raw.decode('utf-8', 'replace'))
    return {
        'id': meta.get('id'),
        'name': meta.get('name'),
        'mimeType': meta.get('mimeType'),
        'revision': meta.get('headRevisionId'),
        'text': text,
        'truncated': truncated,
        'untrusted_content': True,
    }


def multipart(meta, text, mime_type):
    body = (
        f'--{BOUNDARY}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{json.dumps(meta)}\r\n'
        f'--{BOUNDARY}\r\nContent-Type: {mime_type}; charset=UTF-8\r\n\r\n{text}\r\n--{BOUNDARY}--'
    ).encode('utf-8')
    return body, f'multipart/related; boundary={BOUNDARY}'


def create(token, params):
    meta = {'name': params['name'], 'parents': [params['parent_id']], 'mimeType': params['mime_type']}
    upload_type = 'text/plain' if params['mime_type'] == DOC else params['mime_type']
    body, content_type = multipart(meta, params['text'], upload_type)
    result = provider_request(
        SELF,
        'POST',
        '/upload/drive/v3/files?uploadType=multipart',
        token=token,
        body=body,
        content_type=content_type,
        write=True,
    )
    return {'id': result.get('id'), 'name': result.get('name')}


def prepare_update(token, params):
    """Bind the approval to the file's current revision so a concurrent edit fails the write."""
    meta = metadata(token, params['file_id'])
    if meta.get('mimeType') == DOC:
        raise Denied('SAFE_UPDATE_UNAVAILABLE')
    if meta.get('mimeType') not in TEXT_TYPES:
        raise Denied('UNSUPPORTED_MIME_TYPE')
    if not meta.get('headRevisionId'):
        raise Denied('SAFE_UPDATE_UNAVAILABLE')
    return {
        **params,
        'expected_etag': meta.get('_etag') if valid_etag(meta.get('_etag')) else None,
        'expected_revision': str(meta.get('headRevisionId', '')),
        'name': meta.get('name', ''),
        'mime_type': meta['mimeType'],
    }


def update(token, params):
    current = metadata(token, params['file_id'])
    if str(current.get('headRevisionId', '')) != params['expected_revision'] or (
        params['expected_etag'] is not None and current.get('_etag') != params['expected_etag']
    ):
        raise Denied('TARGET_CHANGED')
    content_type = params['mime_type']
    try:
        result = provider_request(
            SELF,
            'PATCH',
            f'/upload/drive/v3/files/{params["file_id"]}?uploadType=media',
            token=token,
            headers={'If-Match': params['expected_etag']} if params['expected_etag'] else {},
            write=True,
            body=params['text'].encode('utf-8'),
            content_type=content_type,
        )
    except Denied as exc:
        # drive.file scope: Google refuses files this app did not create.
        if str(exc) == 'PROVIDER_AUTH_REQUIRED':
            raise Denied('TARGET_NOT_WRITABLE') from None
        raise
    return {'id': result.get('id'), 'revision': result.get('headRevisionId')}


def probe(token):
    about = provider_request(SELF, 'GET', '/drive/v3/about?fields=user(emailAddress)', token=token)
    email = about.get('user', {}).get('emailAddress', '')
    if not isinstance(email, str) or not 3 <= len(email) <= 200:
        raise Denied('PROBE_FAILED')
    return email


def handle(request):
    op = request.get('op')
    if op == 'status':
        fields(request, ('op',), ('op',))
        return rpc(connector_base.AUTH_SOCKET, {'op': 'status'})['drive']
    if op not in ('search', 'read', 'create', 'update'):
        raise Denied('OPERATION_DENIED')
    request_id = request.get('request_id')
    params = {k: v for k, v in request.items() if k not in ('op', 'request_id')}
    operation = 'drive.' + op
    if op in ('search', 'read', 'create'):
        validate(operation, params)
    cred = connector_base.credential(SELF)
    token, account = cred['token'], cred['generation']
    if op == 'search':
        return connector_base.read(
            SELF, operation, params, account, lambda: search(token, params['query'], params['limit'])
        )
    if op == 'read':
        return connector_base.read(SELF, operation, params, account, lambda: read(token, params['file_id']))
    if op == 'create':
        return connector_base.write(
            SELF, operation, params, account, request_id, lambda p: p, lambda p: create(token, p)
        )

    def prepare(p):
        fields(p, ('file_id', 'text'), ('file_id', 'text'))
        validate('drive.read', {'file_id': p['file_id']})
        check_text(p['text'])
        frozen = prepare_update(token, p)
        validate(operation, frozen)
        return frozen

    return connector_base.write(SELF, operation, params, account, request_id, prepare, lambda p: update(token, p))
