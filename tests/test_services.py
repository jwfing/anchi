import base64
import json
from pathlib import Path
import socket
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'services'))
import auth
import gmail
from common import Denied, google_json, recv_json

class GmailPolicyTests(unittest.TestCase):
    def test_rejects_writes_and_arbitrary_network_before_credentials(self):
        with patch('gmail.rpc') as credentials:
            for op in ['send', 'delete', 'modify', 'http', 'access_token']:
                with self.assertRaises(Denied):
                    gmail.handle({'op': op})
            credentials.assert_not_called()

    def test_rejects_forged_identity_and_account(self):
        for key in ['role', 'approved', 'account', 'url', 'token']:
            with self.assertRaises(Denied):
                gmail.handle({'op': 'list', key: 'forged'})

    def test_limit_validation(self):
        for limit in [0, 11, True, '5', -1]:
            with self.assertRaises(Denied):
                gmail.handle({'op': 'list', 'limit': limit})

    def test_path_injection(self):
        for message_id in ['../profile', 'abc?format=raw', 'https://evil.test', 'a/b', '']:
            with self.assertRaises(Denied):
                gmail.handle({'op': 'read', 'id': message_id})

    def test_query_validation(self):
        for query in ['x' * 513, 'a\r\nb', None]:
            with self.assertRaises(Denied):
                gmail.handle({'op': 'list', 'query': query})

    def test_fixed_request_and_no_token_in_result(self):
        with patch('gmail.rpc', return_value={'access_token': 'CANARY_TOKEN'}), \
             patch('gmail.google_json', return_value={'messages': [{'id': 'ab', 'threadId': 'cd', 'secret': 'ignored'}]}) as http:
            result = gmail.handle({'op': 'list', 'query': 'in:inbox', 'limit': 1})
            self.assertEqual(result, {'messages': [{'id': 'ab', 'threadId': 'cd'}]})
            args, kwargs = http.call_args
            self.assertEqual(args[:2], ('gmail.googleapis.com', 'GET'))
            self.assertTrue(args[2].startswith('/gmail/v1/users/me/messages?'))
            self.assertEqual(kwargs['token'], 'CANARY_TOKEN')
            self.assertNotIn('CANARY_TOKEN', json.dumps(result))

    def test_normalized_message_and_best_effort_scrub(self):
        body = base64.urlsafe_b64encode(b'Your code: 123456 https://example.test/login').decode()
        response = {'id': 'ab', 'payload': {'mimeType': 'text/plain', 'body': {'data': body},
                    'headers': [{'name': 'Subject', 'value': 'test'}, {'name': 'X-Secret', 'value': 'private'}]}}
        with patch('gmail.rpc', return_value={'access_token': 'TOKEN'}), patch('gmail.google_json', return_value=response):
            result = gmail.handle({'op': 'read', 'id': 'ab'})
        self.assertTrue(result['untrusted_content'])
        self.assertNotIn('123456', result['text'])
        self.assertNotIn('https://', result['text'])
        self.assertNotIn('x-secret', result['headers'])

class OAuthTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.override = patch('auth.STORE', Path(self.directory.name))
        self.override.start()
        auth.import_client({'installed': {'client_id': 'test.apps.googleusercontent.com', 'client_secret': 'TEST'}})

    def tearDown(self):
        self.override.stop()
        self.directory.cleanup()

    def test_pkce_and_readonly_scope(self):
        from urllib.parse import parse_qs, urlsplit
        flow = auth.begin('http://127.0.0.1:12345/callback')
        q = parse_qs(urlsplit(flow['url']).query)
        self.assertEqual(q['code_challenge_method'], ['S256'])
        self.assertEqual(q['scope'], [auth.SCOPE])
        self.assertNotIn('verifier', flow)

    def test_state_mismatch_never_exchanges(self):
        auth.begin('http://127.0.0.1:12345/callback')
        with patch('auth.google_json') as http:
            with self.assertRaises(Denied):
                auth.complete({'state': 'wrong', 'code': 'test'})
            http.assert_not_called()

    def test_expired_state(self):
        flow = auth.begin('http://127.0.0.1:12345/callback')
        value = auth.read('pending.json')
        value['expires'] = 0
        auth.write('pending.json', value)
        with self.assertRaises(Denied):
            auth.complete({'state': flow['state'], 'code': 'test'})

    def test_scope_escalation_rejected(self):
        flow = auth.begin('http://127.0.0.1:12345/callback')
        with patch('auth.google_json', return_value={'scope': 'https://mail.google.com/', 'refresh_token': 'secret'}):
            with self.assertRaises(Denied):
                auth.complete({'state': flow['state'], 'code': 'test'})
        self.assertFalse(auth.status()['connected'])

    def test_refresh_and_private_storage(self):
        auth.write('tokens.json', {'refresh_token': 'REFRESH', 'access_token': 'OLD', 'expires_at': 0})
        with patch('auth.google_json', return_value={'access_token': 'NEW', 'expires_in': 3600}):
            self.assertEqual(auth.access_token(), 'NEW')
        self.assertEqual((auth.STORE / 'tokens.json').stat().st_mode & 0o777, 0o600)
        self.assertEqual(auth.read('tokens.json')['refresh_token'], 'REFRESH')
        auth.disconnect()
        self.assertFalse(auth.status()['connected'])

    def test_disallow_client_replacement_while_connected(self):
        auth.write('tokens.json', {'access_token': 'x'})
        with self.assertRaises(Denied):
            auth.import_client({'installed': {'client_id': 'other.apps.googleusercontent.com', 'client_secret': 'x'}})

class BoundaryTests(unittest.TestCase):
    def test_non_google_destination_denied(self):
        for host, method in [('evil.test', 'GET'), ('gmail.googleapis.com', 'POST')]:
            with self.assertRaises(Denied):
                google_json(host, method, '/')

    def test_private_dns_denied(self):
        with patch('socket.getaddrinfo', return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('127.0.0.1', 443))]):
            with self.assertRaises(Denied):
                google_json('gmail.googleapis.com', 'GET', '/')

    def test_malformed_rpc(self):
        for payload in [b'[]\n', b'null\n', b'{invalid}\n', b'{}\n{}\n']:
            a, b = socket.socketpair()
            with a, b:
                a.sendall(payload)
                with self.assertRaises(Denied):
                    recv_json(b)

if __name__ == '__main__':
    unittest.main()
