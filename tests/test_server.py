import socket
import sys
import threading
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'services'))
import server
from common import recv_json, send_json

GMAIL_UID, INFERENCE_UID, CELL_UID, STRANGER_UID = 1001, 1002, 2001, 3001
SERVICE_UIDS = {GMAIL_UID: 'gmail', INFERENCE_UID: 'inference'}


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

    def test_kernel_uid_gates_every_mode(self):
        gmail = self.service('gmail', lambda request: {'echo': request})
        self.assertEqual(self.request(gmail, CELL_UID, {'op': 'x'}), {'ok': True, 'result': {'echo': {'op': 'x'}}})
        for uid in (GMAIL_UID, INFERENCE_UID, STRANGER_UID, 0):
            self.assertEqual(self.request(gmail, uid, {'op': 'x'})['error'], 'CALLER_DENIED')
        policy = self.service('policy', lambda request, caller: {'caller': caller})
        self.assertEqual(self.request(policy, INFERENCE_UID, {'op': 'x'})['result'], {'caller': 'inference'})
        self.assertEqual(self.request(policy, CELL_UID, {'op': 'x'})['error'], 'CALLER_DENIED')

    def test_credential_scope_enforced_before_handler(self):
        called = []
        auth = self.service('auth', lambda request, caller: called.append((request, caller)) or {'ok': 1})
        self.assertEqual(self.request(auth, GMAIL_UID, {'op': 'codex_token'})['error'], 'CREDENTIAL_SCOPE_DENIED')
        self.assertEqual(self.request(auth, INFERENCE_UID, {'op': 'access_token'})['error'], 'CREDENTIAL_SCOPE_DENIED')
        self.assertEqual(called, [])
        self.assertTrue(self.request(auth, GMAIL_UID, {'op': 'access_token'})['ok'])
        self.assertTrue(self.request(auth, INFERENCE_UID, {'op': 'codex_token'})['ok'])

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
        self.assertEqual(server.credential_ops('inference'), ('model_key', 'codex_token'))
        uids = {1001: 'gmail', 1002: 'inference', 1003: 'drive', 1004: 'notion', 1005: 'slack'}
        seen = []
        auth = server.Service('auth', uids, cell_uid=CELL_UID, clock=Clock())
        auth.handler = lambda request, caller: seen.append((request['op'], caller)) or {}
        self.assertEqual(self.request(auth, 1004, {'op': 'access_token'})['error'], 'CREDENTIAL_SCOPE_DENIED')
        self.assertTrue(self.request(auth, 1004, {'op': 'token'})['ok'])
        self.assertTrue(self.request(auth, 1003, {'op': 'access_token'})['ok'])
        self.assertEqual(seen, [('token', 'notion'), ('access_token', 'drive')])
        drive = server.Service('drive', uids, cell_uid=CELL_UID, clock=Clock())
        self.assertEqual(drive.allowed_uids, {CELL_UID})

    def test_utf8_wire_is_bounded_by_bytes_not_escapes(self):
        service = self.service('gmail', lambda request: {'text': request['text']})
        text = '你' * 20000  # 60000 UTF-8 bytes; ASCII escaping would need 120000
        self.assertEqual(self.request(service, CELL_UID, {'text': text})['result']['text'], text)
        service = self.service('gmail', lambda request: {'text': '你' * 22000})
        self.assertEqual(self.request(service, CELL_UID, {'op': 'x'})['error'], 'RESPONSE_TOO_LARGE')


if __name__ == '__main__':
    unittest.main()
