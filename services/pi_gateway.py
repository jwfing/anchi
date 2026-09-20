"""Codex backend for the real pi agent; exact approvals and persistent deduplication."""
import hashlib
import json
from pathlib import Path
import re
import time

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
            return {'configured':True, **configuration()}
        except Denied:
            return {'configured':False, 'provider':'openai-codex', 'model':None}
    fields(request, ('op','request_id','instructions','input','tools'), ('op','request_id','instructions','input','tools'))
    if request['op'] != 'pi_generate' or not isinstance(request['request_id'],str) or not re.fullmatch('[a-f0-9]{32}',request['request_id']):
        raise Denied('BAD_REQUEST')
    config = configuration()
    codex_schema.validate_parts(request['instructions'],request['input'],request['tools'])
    credential = rpc('/run/secure-auth/token.sock', {'op':'codex_token'})
    payload = {'model':config['model'], 'store':False, 'stream':True, 'instructions':request['instructions'],
               'input':request['input'], 'tools':request['tools'], 'tool_choice':'auto','parallel_tool_calls':False,
               'include':['reasoning.encrypted_content'], 'reasoning':{'effort':'low','summary':'auto'}}
    codex_schema.validate_payload(payload)
    action = {'operation':'inference.codex','account':credential['generation'],'params':payload}
    digest = hashlib.sha256(json.dumps(action,sort_keys=True).encode()).hexdigest()
    # Share the existing durable execution ledger and single service process.
    from inference import database
    with database() as conn:
        conn.execute('BEGIN IMMEDIATE')
        row = conn.execute('SELECT * FROM runs WHERE id=?',(request['request_id'],)).fetchone()
        if row:
            if row['digest'] != digest:
                raise Denied('REQUEST_ID_CONFLICT')
            if row['state'] == 'SUCCEEDED':
                return json.loads(row['result'])
            if row['state'] != 'WAITING_APPROVAL':
                raise Denied('REQUEST_ALREADY_'+row['state'])
        elif conn.execute("SELECT count(*) FROM runs WHERE provider='openai-codex' AND created>?",(time.time()-86400,)).fetchone()[0] >= 50:
            raise Denied('DAILY_REQUEST_LIMIT')
        if not row:
            conn.execute('INSERT INTO runs(id,digest,provider,model,created,state) VALUES(?,?,?,?,?,?)',
                         (request['request_id'],digest,'openai-codex',config['model'],time.time(),'WAITING_APPROVAL'))
    try:
        policy_client.require(action)
    except Denied as exc:
        if not str(exc).startswith('APPROVAL_REQUIRED:'):
            with database() as conn:
                conn.execute("UPDATE runs SET state='FAILED',error=?,finished=? WHERE id=?",(str(exc),time.time(),request['request_id']))
        raise
    with database() as conn:
        conn.execute("UPDATE runs SET state='RUNNING' WHERE id=?",(request['request_id'],))
    try:
        result = codex_transport.responses(payload,credential)
        with database() as conn:
            conn.execute("UPDATE runs SET state='SUCCEEDED',result=?,finished=? WHERE id=?",(json.dumps(result),time.time(),request['request_id']))
        return result
    except Exception as exc:
        code = str(exc) if isinstance(exc,Denied) else 'CODEX_EXECUTION_UNKNOWN'
        with database() as conn:
            conn.execute('UPDATE runs SET state=?,error=?,finished=? WHERE id=?',
                         ('FAILED' if isinstance(exc,Denied) else 'UNKNOWN',code,time.time(),request['request_id']))
        raise Denied(code) from None
