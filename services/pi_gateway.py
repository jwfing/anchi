"""Codex backend for the real pi agent; exact approvals and persistent deduplication."""

import hashlib
import json
from pathlib import Path
import re

from common import Denied, fields, rpc
import codex_schema
import codex_transport
import policy_client

CONFIG = Path('/etc/secure-vm/pi.json')


def configuration():
    try:
        return json.loads(CONFIG.read_text())
    except FileNotFoundError:
        raise Denied('CODEX_NOT_CONFIGURED') from None


def handle(request):
    if request.get('op') == 'pi_status':
        fields(request, ('op',), ('op',))
        try:
            return {'configured': True, **configuration()}
        except Denied:
            return {'configured': False, 'provider': 'openai-codex', 'model': None}
    fields(
        request,
        ('op', 'request_id', 'instructions', 'input', 'tools'),
        ('op', 'request_id', 'instructions', 'input', 'tools'),
    )
    if (
        request['op'] != 'pi_generate'
        or not isinstance(request['request_id'], str)
        or not re.fullmatch('[a-f0-9]{32}', request['request_id'])
    ):
        raise Denied('BAD_REQUEST')
    config = configuration()
    codex_schema.validate_parts(request['instructions'], request['input'], request['tools'])
    credential = rpc('/run/secure-auth/token.sock', {'op': 'codex_token'})
    payload = {
        'model': config['model'],
        'store': False,
        'stream': True,
        'instructions': request['instructions'],
        'input': request['input'],
        'tools': request['tools'],
        'tool_choice': 'auto',
        'parallel_tool_calls': False,
        'include': ['reasoning.encrypted_content'],
        'reasoning': {'effort': 'low', 'summary': 'auto'},
    }
    codex_schema.validate_payload(payload)
    action = {'operation': 'inference.codex', 'account': credential['generation'], 'params': payload}
    digest = hashlib.sha256(json.dumps(action, sort_keys=True).encode()).hexdigest()
    # Share the durable execution ledger (and database file) with the legacy summarize path.
    from inference import DATABASE
    from ledger import Ledger

    book = Ledger(DATABASE, 'openai-codex')
    cached = book.begin(request['request_id'], digest, model=config['model'], daily_limit=50)
    if cached is not None:
        return cached
    try:
        policy_client.require(action)
    except Denied as exc:
        if str(exc).startswith('APPROVAL_REQUIRED:'):
            book.waiting(request['request_id'])
        else:
            book.mark(request['request_id'], 'FAILED', error=str(exc))
        raise
    try:
        result = codex_transport.responses(payload, credential)
        book.mark(request['request_id'], 'SUCCEEDED', result=result)
        return result
    except Exception as exc:
        code = str(exc) if isinstance(exc, Denied) else 'CODEX_EXECUTION_UNKNOWN'
        book.mark(request['request_id'], 'FAILED' if isinstance(exc, Denied) else 'UNKNOWN', error=code)
        raise Denied(code) from None
