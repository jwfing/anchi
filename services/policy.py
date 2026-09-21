"""Independent, fail-closed authorization with one-use, exact-request grants."""

from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import re
import secrets
import sqlite3
import time
import uuid

import importlib

from common import Denied, fields
import connectors

DATABASE = Path('/var/lib/secure-policy/policy.sqlite3')
BOOT_ID = Path('/proc/sys/kernel/random/boot_id')


@contextmanager
def database():
    conn = sqlite3.connect(DATABASE, timeout=5)
    conn.row_factory = sqlite3.Row
    try:
        conn.executescript('''
          CREATE TABLE IF NOT EXISTS config (id INTEGER PRIMARY KEY CHECK(id=1), epoch INTEGER NOT NULL, gmail_read INTEGER NOT NULL);
          INSERT OR IGNORE INTO config VALUES(1,1,0);
          CREATE TABLE IF NOT EXISTS grants (
            id TEXT PRIMARY KEY, digest TEXT NOT NULL, action TEXT NOT NULL, principal TEXT NOT NULL,
            epoch INTEGER NOT NULL, boot TEXT NOT NULL, state TEXT NOT NULL, created REAL NOT NULL,
            expires REAL NOT NULL, ticket_hash TEXT, decided REAL, consumed REAL);
          CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, at REAL NOT NULL, event TEXT NOT NULL, grant_id TEXT, digest TEXT);
          CREATE TABLE IF NOT EXISTS read_rules (connector TEXT PRIMARY KEY, allowed INTEGER NOT NULL);
        ''')
        with conn:
            yield conn
    finally:
        conn.close()


def normalize(action, principal):
    if not isinstance(action, dict):
        raise Denied('BAD_ACTION')
    fields(action, ('operation', 'account', 'params'), ('operation', 'account', 'params'))
    params, op = action['params'], action['operation']
    if (
        not isinstance(params, dict)
        or not isinstance(action['account'], str)
        or not re.fullmatch('[a-zA-Z0-9._:-]{1,128}', action['account'])
    ):
        raise Denied('BAD_ACTION')
    if principal != 'inference':
        connector = connectors.CONNECTORS.get(principal)
        if connector is None or op not in connector.ops:
            raise Denied('OPERATION_DENIED')
        importlib.import_module(connector.module).validate(op, params)
    elif principal == 'inference' and op == 'inference.codex':
        from codex_schema import validate_payload

        validate_payload(params)
    elif principal == 'inference' and op == 'inference.openai':
        fields(
            params,
            ('model', 'instructions', 'input', 'max_output_tokens', 'store', 'tools', 'stream'),
            ('model', 'instructions', 'input', 'max_output_tokens', 'store', 'tools', 'stream'),
        )
        if (
            params['store'] is not False
            or params['stream'] is not False
            or params['tools'] != []
            or type(params['max_output_tokens']) is not int
            or not 1 <= params['max_output_tokens'] <= 2048
        ):
            raise Denied('BAD_ACTION')
        if not isinstance(params['model'], str) or not re.fullmatch('[a-zA-Z0-9._:-]{1,100}', params['model']):
            raise Denied('BAD_ACTION')
        if not isinstance(params['instructions'], str) or not isinstance(params['input'], list):
            raise Denied('BAD_ACTION')
    else:
        raise Denied('OPERATION_DENIED')
    # Digest canonical form stays ASCII for stability; the size bound counts UTF-8 bytes.
    encoded = json.dumps(action, sort_keys=True, separators=(',', ':'), ensure_ascii=True)
    if len(json.dumps(action, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()) > 56000:
        raise Denied('ACTION_TOO_LARGE')
    return encoded, hashlib.sha256(encoded.encode()).hexdigest()


def read_allowed(conn, connector):
    row = conn.execute('SELECT allowed FROM read_rules WHERE connector=?', (connector,)).fetchone()
    if row is None and connector == 'gmail':
        # One-time migration of the pre-registry column; the column stays for old backups.
        legacy = conn.execute('SELECT gmail_read FROM config WHERE id=1').fetchone()[0]
        conn.execute('INSERT OR IGNORE INTO read_rules VALUES(?,?)', ('gmail', int(legacy)))
        return bool(legacy)
    return bool(row and row['allowed'])


def audit(conn, event, grant_id=None, digest=None):
    conn.execute('INSERT INTO audit(at,event,grant_id,digest) VALUES(?,?,?,?)', (time.time(), event, grant_id, digest))


def authorize(action, principal):
    encoded, digest = normalize(action, principal)
    now, boot = time.time(), BOOT_ID.read_text().strip()
    with database() as conn:
        conn.execute('BEGIN IMMEDIATE')
        settings = conn.execute('SELECT * FROM config WHERE id=1').fetchone()
        conn.execute(
            "UPDATE grants SET state='EXPIRED' WHERE state IN ('PENDING','APPROVED','ISSUED') AND (expires<? OR boot!=? OR epoch!=?)",
            (now, boot, settings['epoch']),
        )
        # Bounded retention: pending payloads may contain email excerpts.
        conn.execute('DELETE FROM grants WHERE created<?', (now - 7 * 86400,))
        conn.execute('DELETE FROM audit WHERE at<?', (now - 30 * 86400,))
        grant = conn.execute(
            "SELECT * FROM grants WHERE digest=? AND principal=? AND epoch=? AND boot=? AND expires>? AND state IN ('PENDING','APPROVED','DENIED','REVOKED') ORDER BY created DESC LIMIT 1",
            (digest, principal, settings['epoch'], boot, now),
        ).fetchone()
        if grant and grant['state'] in ('DENIED', 'REVOKED'):
            raise Denied('POLICY_DENIED')
        auto = (
            principal != 'inference'
            and connectors.kind(action['operation']) == connectors.READ
            and read_allowed(conn, principal)
        )
        if grant and grant['state'] == 'APPROVED':
            grant_id = grant['id']
        elif auto:
            grant_id = uuid.uuid4().hex
            conn.execute(
                'INSERT INTO grants(id,digest,action,principal,epoch,boot,state,created,expires) VALUES(?,?,?,?,?,?,?,?,?)',
                (grant_id, digest, encoded, principal, settings['epoch'], boot, 'APPROVED', now, now + 60),
            )
        else:
            if grant is None:
                pending_count = conn.execute("SELECT count(*) FROM grants WHERE state='PENDING'").fetchone()[0]
                if pending_count >= 32:
                    raise Denied('TOO_MANY_PENDING_APPROVALS')
                grant_id = uuid.uuid4().hex
                conn.execute(
                    'INSERT INTO grants(id,digest,action,principal,epoch,boot,state,created,expires) VALUES(?,?,?,?,?,?,?,?,?)',
                    (grant_id, digest, encoded, principal, settings['epoch'], boot, 'PENDING', now, now + 600),
                )
                audit(conn, 'REQUESTED', grant_id, digest)
            else:
                grant_id = grant['id']
            return {'decision': 'ask', 'approval_id': grant_id, 'digest': digest}
        ticket = secrets.token_urlsafe(32)
        conn.execute(
            "UPDATE grants SET state='ISSUED',ticket_hash=?,expires=? WHERE id=?",
            (hashlib.sha256(ticket.encode()).hexdigest(), now + 60, grant_id),
        )
        audit(conn, 'ISSUED_AUTO' if auto else 'ISSUED_APPROVED', grant_id, digest)
        return {'decision': 'allow', 'grant_id': grant_id, 'ticket': ticket}


def consume(action, principal, grant_id, ticket):
    _, digest = normalize(action, principal)
    if not isinstance(grant_id, str) or not isinstance(ticket, str) or len(ticket) > 128:
        raise Denied('INVALID_GRANT')
    now, boot = time.time(), BOOT_ID.read_text().strip()
    with database() as conn:
        conn.execute('BEGIN IMMEDIATE')
        epoch = conn.execute('SELECT epoch FROM config WHERE id=1').fetchone()[0]
        result = conn.execute(
            "UPDATE grants SET state='CONSUMED',consumed=? WHERE id=? AND principal=? AND digest=? AND ticket_hash=? AND state='ISSUED' AND epoch=? AND boot=? AND expires>?",
            (now, grant_id, principal, digest, hashlib.sha256(ticket.encode()).hexdigest(), epoch, boot, now),
        )
        if result.rowcount != 1:
            raise Denied('INVALID_OR_CONSUMED_GRANT')
        audit(conn, 'CONSUMED', grant_id, digest)
    return {'allowed': True}


def handle(request, principal):
    if request.get('op') == 'authorize':
        fields(request, ('op', 'action'), ('op', 'action'))
        return authorize(request['action'], principal)
    if request.get('op') == 'consume':
        fields(request, ('op', 'action', 'grant_id', 'ticket'), ('op', 'action', 'grant_id', 'ticket'))
        return consume(request['action'], principal, request['grant_id'], request['ticket'])
    raise Denied('OPERATION_DENIED')


def inspect(grant_id=None):
    with database() as conn:
        if grant_id:
            row = conn.execute(
                'SELECT id,digest,action,state,created,expires,principal FROM grants WHERE id=?', (grant_id,)
            ).fetchone()
            if row is None:
                raise Denied('APPROVAL_NOT_FOUND')
            result = dict(row)
            result['action'] = json.loads(result['action'])
            return result
        return {
            'pending': [
                dict(r)
                for r in conn.execute(
                    "SELECT id,digest,principal,created,expires FROM grants WHERE state='PENDING' AND expires>? AND boot=? ORDER BY created DESC",
                    (time.time(), BOOT_ID.read_text().strip()),
                )
            ]
        }


def inspect_audit(limit=100):
    if type(limit) is not int or not 1 <= limit <= 500:
        raise Denied('BAD_LIMIT')
    with database() as conn:
        return {
            'audit': [
                dict(r)
                for r in conn.execute(
                    'SELECT id,at,event,grant_id,digest FROM audit ORDER BY at DESC, id DESC LIMIT ?', (limit,)
                )
            ]
        }


def decide(grant_id, decision, digest=None):
    if decision not in ('APPROVED', 'DENIED', 'REVOKED'):
        raise Denied('BAD_DECISION')
    with database() as conn:
        conn.execute('BEGIN IMMEDIATE')
        row = conn.execute('SELECT * FROM grants WHERE id=?', (grant_id,)).fetchone()
        epoch = conn.execute('SELECT epoch FROM config WHERE id=1').fetchone()[0]
        if (
            row is None
            or row['expires'] <= time.time()
            or row['boot'] != BOOT_ID.read_text().strip()
            or row['epoch'] != epoch
        ):
            raise Denied('APPROVAL_EXPIRED_OR_MISSING')
        if decision == 'APPROVED' and (digest != row['digest'] or row['state'] != 'PENDING'):
            raise Denied('APPROVAL_DIGEST_OR_STATE_MISMATCH')
        if row['state'] not in ('PENDING', 'APPROVED', 'ISSUED'):
            raise Denied('APPROVAL_ALREADY_FINAL')
        conn.execute('UPDATE grants SET state=?,decided=? WHERE id=?', (decision, time.time(), grant_id))
        audit(conn, decision, grant_id, row['digest'])
    return {'approval_id': grant_id, 'state': decision}


def set_read(connector, allow):
    if connector not in connectors.CONNECTORS:
        raise Denied('UNKNOWN_CONNECTOR')
    with database() as conn:
        conn.execute('BEGIN IMMEDIATE')
        conn.execute(
            'INSERT INTO read_rules VALUES(?,?) ON CONFLICT(connector) DO UPDATE SET allowed=excluded.allowed',
            (connector, int(allow)),
        )
        if connector == 'gmail':
            conn.execute('UPDATE config SET gmail_read=? WHERE id=1', (int(allow),))
        # Any rule change invalidates every outstanding grant, exactly like before.
        conn.execute('UPDATE config SET epoch=epoch+1 WHERE id=1')
        conn.execute("UPDATE grants SET state='REVOKED' WHERE state IN ('PENDING','APPROVED','ISSUED')")
        audit(
            conn, f'{connector.upper()}_READ_ENABLED' if allow else f'{connector.upper()}_READ_DISABLED_GRANTS_REVOKED'
        )
    return {'connector': connector, 'read': allow, 'outstanding_grants_revoked': True}
