import base64
import re
from urllib.parse import urlencode

from common import Denied, fields, google_json, rpc
import policy_client

AUTH_SOCKET = '/run/secure-auth/token.sock'


def scrub(text):
    # Best effort only; not a complete DLP or prompt-injection detector.
    text = re.sub(r'https?://\S+', '[link omitted]', text, flags=re.I)
    return re.sub(r'(?<!\d)\d{4,8}(?!\d)', '[number omitted]', text)


def body_text(part, depth=0):
    if depth > 10:
        return ''
    if part.get('mimeType') == 'text/plain':
        data = part.get('body', {}).get('data', '')
        if not isinstance(data, str):
            return ''
        return base64.urlsafe_b64decode(data + '=' * (-len(data) % 4)).decode('utf-8', 'replace')[:12000]
    return '\n'.join(body_text(p, depth + 1) for p in part.get('parts', [])[:30])[:12000]


def validate(op, params):
    """Parameter schema the policy service enforces before any grant is issued."""
    if op == 'gmail.status':
        fields(params, ())
    elif op == 'gmail.list':
        fields(params, ('query', 'limit'), ('query', 'limit'))
        if (
            type(params['limit']) is not int
            or not 1 <= params['limit'] <= 10
            or not isinstance(params['query'], str)
            or len(params['query']) > 512
            or any(ord(c) < 32 for c in params['query'])
        ):
            raise Denied('BAD_ACTION')
    elif op == 'gmail.read':
        fields(params, ('id',), ('id',))
        if not isinstance(params['id'], str) or not re.fullmatch('[0-9a-fA-F]{1,128}', params['id']):
            raise Denied('BAD_ACTION')
    else:
        raise Denied('OPERATION_DENIED')


def handle(request):
    op = request.get('op')
    if op == 'status':
        fields(request, ('op',), ('op',))
        return rpc(AUTH_SOCKET, {'op': 'status'})
    if op == 'list':
        fields(request, ('op', 'query', 'limit'), ('op',))
        query, limit = request.get('query', 'in:inbox'), request.get('limit', 5)
        if not isinstance(query, str) or len(query) > 512 or any(ord(c) < 32 for c in query):
            raise Denied('BAD_QUERY')
        if type(limit) is not int or not 1 <= limit <= 10:
            raise Denied('BAD_LIMIT')
        path = '/gmail/v1/users/me/messages?' + urlencode({'q': query, 'maxResults': limit})
        params = {'query': query, 'limit': limit}
    elif op == 'read':
        fields(request, ('op', 'id'), ('op', 'id'))
        if not isinstance(request['id'], str) or not re.fullmatch('[0-9a-fA-F]{1,128}', request['id']):
            raise Denied('BAD_MESSAGE_ID')
        path = '/gmail/v1/users/me/messages/' + request['id'] + '?format=full'
        params = {'id': request['id']}
    else:
        raise Denied('OPERATION_DENIED')
    credentials = rpc(AUTH_SOCKET, {'op': 'access_token'})
    token = credentials['access_token']
    policy_client.require({'operation': 'gmail.' + op, 'account': credentials['account_generation'], 'params': params})
    result = google_json('gmail.googleapis.com', 'GET', path, token=token)
    if op == 'list':
        return {
            'messages': [{k: m[k] for k in ('id', 'threadId') if k in m} for m in result.get('messages', [])[:limit]]
        }
    payload = result.get('payload', {})
    headers = {
        h['name'].lower(): scrub(h['value'])[:2000]
        for h in payload.get('headers', [])
        if h.get('name', '').lower() in ('from', 'to', 'subject', 'date')
    }
    return {
        'id': result.get('id'),
        'headers': headers,
        'text': scrub(body_text(payload)),
        'snippet': scrub(result.get('snippet', ''))[:1000],
        'untrusted_content': True,
        'attachments_omitted': True,
        'notice': 'Best-effort redaction; HTML-only bodies and attachments are not retrieved.',
    }
