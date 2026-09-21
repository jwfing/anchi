"""Durable execution ledger: one row per request_id, no automatic replay of ambiguous results."""

from contextlib import contextmanager
import json
import sqlite3
import time

from common import Denied


class Ledger:
    def __init__(self, path, scope, limit_code='DAILY_REQUEST_LIMIT'):
        self.path, self.scope, self.limit_code = path, scope, limit_code

    @contextmanager
    def database(self):
        conn = sqlite3.connect(self.path, timeout=5)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute('''CREATE TABLE IF NOT EXISTS runs (
                id TEXT PRIMARY KEY, digest TEXT NOT NULL, provider TEXT NOT NULL,
                model TEXT NOT NULL, created REAL NOT NULL, finished REAL,
                state TEXT NOT NULL, result TEXT, error TEXT)''')
            with conn:
                yield conn
        finally:
            conn.close()

    def begin(self, request_id, digest, *, model='', daily_limit=None, window=86400):
        """Reserve request_id as RUNNING. Returns the cached result when it already succeeded."""
        now = time.time()
        with self.database() as conn:
            conn.execute('BEGIN IMMEDIATE')
            row = conn.execute('SELECT * FROM runs WHERE id=?', (request_id,)).fetchone()
            if row:
                if row['digest'] != digest:
                    raise Denied('REQUEST_ID_CONFLICT')
                if row['state'] == 'SUCCEEDED':
                    return json.loads(row['result'])
                if row['state'] != 'WAITING_APPROVAL':
                    raise Denied('REQUEST_ALREADY_' + row['state'])
            elif daily_limit is not None:
                count = conn.execute(
                    'SELECT count(*) FROM runs WHERE created>? AND provider=?', (now - window, self.scope)
                ).fetchone()[0]
                if count >= daily_limit:
                    raise Denied(self.limit_code)
            if row:
                conn.execute("UPDATE runs SET state='RUNNING',error=NULL,finished=NULL WHERE id=?", (request_id,))
            else:
                conn.execute(
                    'INSERT INTO runs (id,digest,provider,model,created,state) VALUES (?,?,?,?,?,?)',
                    (request_id, digest, self.scope, model, now, 'RUNNING'),
                )
        return None

    def waiting(self, request_id):
        self.mark(request_id, 'WAITING_APPROVAL')

    def mark(self, request_id, state, *, result=None, error=None):
        with self.database() as conn:
            conn.execute(
                'UPDATE runs SET state=?,result=?,error=?,finished=? WHERE id=?',
                (state, json.dumps(result) if result is not None else None, error, time.time(), request_id),
            )

    def recover(self):
        with self.database() as conn:
            conn.execute(
                "UPDATE runs SET state='UNKNOWN', error='SERVICE_RESTARTED', finished=? WHERE state='RUNNING'",
                (time.time(),),
            )

    def history(self, limit=20):
        with self.database() as conn:
            return [
                dict(r)
                for r in conn.execute(
                    'SELECT id,provider,model,created,finished,state,error FROM runs ORDER BY created DESC LIMIT ?',
                    (limit,),
                )
            ]

    def get(self, request_id):
        with self.database() as conn:
            row = conn.execute('SELECT * FROM runs WHERE id=?', (request_id,)).fetchone()
        if row is None:
            return None
        value = dict(row)
        value['result'] = json.loads(value['result']) if value['result'] else None
        return value
