import socket
import sys
import threading
from pathlib import Path
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'services'))
import connector_base
import server
from common import recv_json, send_json

GMAIL_UID, EGRESS_UID, CELL_UID, STRANGER_UID = 1001, 1002, 2001, 3001
SERVICE_UIDS = {GMAIL_UID: 'gmail', EGRESS_UID: 'egress'}


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class ServerTests(unittest.TestCase):
    def service(self, mode, handler=None):
        clock = Clock()
        service = server.Service(mode, SERVICE_UIDS, cell_uid=CELL_UID, clock=clock)
        if handler:
            service.handler = handler
        service.clock_object = clock
        return service

    def exchange(self, service, uid, write):
        # Socketpair buffers are small; serve concurrently so large frames never deadlock the test.
        a, b = socket.socketpair()
        with a, b:
            service.peer = lambda conn: uid
            worker = threading.Thread(target=service.process, args=(b,))
            worker.start()
            try:
                write(a)
                return recv_json(a)
            finally:
                worker.join(10)

    def call(self, service, uid, raw):
        return self.exchange(service, uid, lambda a: a.sendall(raw))

    def request(self, service, uid, value):
        return self.exchange(service, uid, lambda a: send_json(a, value))

    def test_readonly_connector_has_no_ledger_and_failed_recovery_blocks_only_writes(self):
        import sqlite3

        with patch('connector_base.ledger') as ledger:
            self.assertTrue(server.recover_connector('gmail'))
            ledger.assert_not_called()
            ledger.return_value.recover.side_effect = sqlite3.OperationalError('readonly')
            with patch('sys.stderr'):
                ready = server.recover_connector('drive')
        self.assertFalse(ready)
        service = self.service('drive', lambda request: {'available': True})
        service.writes_ready = ready
        self.assertTrue(self.request(service, CELL_UID, {'op': 'status'})['ok'])
        self.assertEqual(self.request(service, CELL_UID, {'op': 'create'})['error'], 'LEDGER_UNAVAILABLE')

    def test_kernel_uid_gates_every_mode(self):
        gmail = self.service('gmail', lambda request: {'echo': request})
        self.assertEqual(self.request(gmail, CELL_UID, {'op': 'x'}), {'ok': True, 'result': {'echo': {'op': 'x'}}})
        for uid in (GMAIL_UID, STRANGER_UID, 0):
            self.assertEqual(self.request(gmail, uid, {'op': 'x'})['error'], 'CALLER_DENIED')
        # The egress bridge may call connector services, always naming the agent it serves.
        self.assertEqual(self.request(gmail, EGRESS_UID, {'op': 'x'})['error'], 'BAD_AGENT')
        # Google services also get the cell's account from the bridge, never from the request body.
        self.assertEqual(self.request(gmail, EGRESS_UID, {'op': 'x', 'agent': 'dev'})['error'], 'BAD_ACCOUNT')
        self.assertEqual(
            self.request(gmail, EGRESS_UID, {'op': 'x', 'agent': 'dev', 'account': '../x'})['error'], 'BAD_ACCOUNT'
        )
        seen = []
        gmail.handler = lambda request: seen.append(connector_base.ACCOUNT) or {'echo': request}
        self.assertEqual(
            self.request(gmail, EGRESS_UID, {'op': 'x', 'agent': 'dev', 'account': 'work'}),
            {'ok': True, 'result': {'echo': {'op': 'x'}}},
        )
        self.request(gmail, CELL_UID, {'op': 'x'})
        self.assertEqual(seen, ['work', 'default'])
        self.assertEqual(connector_base.ACCOUNT, 'default')
        # A cell cannot claim an agent or an account: the fields reach the handler untouched and are
        # rejected there.
        echo = self.request(gmail, CELL_UID, {'op': 'x', 'agent': 'dev', 'account': 'work'})['result']['echo']
        self.assertEqual((echo['agent'], echo['account']), ('dev', 'work'))
        notion = self.service('notion', lambda request: {'echo': request})
        self.assertEqual(
            self.request(notion, EGRESS_UID, {'op': 'x', 'agent': 'dev'}), {'ok': True, 'result': {'echo': {'op': 'x'}}}
        )
        policy = self.service('policy', lambda request, caller: {'caller': caller})
        self.assertEqual(self.request(policy, EGRESS_UID, {'op': 'x'})['result'], {'caller': 'egress'})
        self.assertEqual(self.request(policy, CELL_UID, {'op': 'x'})['error'], 'CALLER_DENIED')

    def test_credential_scope_enforced_before_handler(self):
        called = []
        auth = self.service('auth', lambda request, caller: called.append((request, caller)) or {'ok': 1})
        self.assertEqual(self.request(auth, GMAIL_UID, {'op': 'codex_token'})['error'], 'CREDENTIAL_SCOPE_DENIED')
        self.assertEqual(self.request(auth, EGRESS_UID, {'op': 'access_token'})['error'], 'CREDENTIAL_SCOPE_DENIED')
        self.assertEqual(called, [])
        self.assertTrue(self.request(auth, GMAIL_UID, {'op': 'access_token'})['ok'])
        self.assertTrue(self.request(auth, EGRESS_UID, {'op': 'codex_token'})['ok'])

    def test_rate_limit_window(self):
        service = self.service('gmail', lambda request: {})
        for _ in range(server.RATE_LIMIT):
            self.assertTrue(self.request(service, CELL_UID, {'op': 'x'})['ok'])
        self.assertEqual(self.request(service, CELL_UID, {'op': 'x'})['error'], 'RATE_LIMITED')
        service.clock_object.now += server.RATE_WINDOW + 1
        self.assertTrue(self.request(service, CELL_UID, {'op': 'x'})['ok'])

    def test_malformed_and_internal_errors_never_leak(self):
        def explode(request):
            raise RuntimeError('SECRET_PROVIDER_DETAIL')

        service = self.service('gmail', explode)
        for raw in (b'[]\n', b'{bad\n', b'{}\n{}\n'):
            self.assertEqual(self.call(service, CELL_UID, raw)['error'], 'BAD_REQUEST')
        reply = self.request(service, CELL_UID, {'op': 'x'})
        self.assertEqual(reply, {'ok': False, 'error': 'SERVICE_UNAVAILABLE'})

    def test_modes_and_credential_scopes_come_from_registry(self):
        for connector in ('gmail', 'drive', 'notion', 'slack'):
            self.assertIn(connector, server.MODES)
        self.assertEqual(server.credential_ops('gmail'), ('status', 'access_token'))
        self.assertEqual(server.credential_ops('drive'), ('status', 'access_token'))
        self.assertEqual(server.credential_ops('notion'), ('status', 'token'))
        self.assertEqual(server.credential_ops('slack'), ('status', 'token'))
        self.assertEqual(server.credential_ops('inference'), ())
        uids = {1001: 'gmail', 1002: 'egress', 1003: 'drive', 1004: 'notion', 1005: 'slack'}
        seen = []
        auth = server.Service('auth', uids, cell_uid=CELL_UID, clock=Clock())
        auth.handler = lambda request, caller: seen.append((request['op'], caller)) or {}
        self.assertEqual(self.request(auth, 1004, {'op': 'access_token'})['error'], 'CREDENTIAL_SCOPE_DENIED')
        self.assertTrue(self.request(auth, 1004, {'op': 'token'})['ok'])
        self.assertTrue(self.request(auth, 1003, {'op': 'access_token'})['ok'])
        self.assertEqual(seen, [('token', 'notion'), ('access_token', 'drive')])
        drive = server.Service('drive', uids, cell_uid=CELL_UID, clock=Clock())
        self.assertEqual(drive.allowed_uids, {CELL_UID, 1002})

    def test_utf8_wire_is_bounded_by_bytes_not_escapes(self):
        service = self.service('gmail', lambda request: {'text': request['text']})
        text = '你' * 20000  # 60000 UTF-8 bytes; ASCII escaping would need 120000
        self.assertEqual(self.request(service, CELL_UID, {'text': text})['result']['text'], text)
        service = self.service('gmail', lambda request: {'text': '你' * 22000})
        self.assertEqual(self.request(service, CELL_UID, {'op': 'x'})['error'], 'RESPONSE_TOO_LARGE')


if __name__ == '__main__':
    unittest.main()
