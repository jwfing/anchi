import base64
import json
from pathlib import Path
import socket
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'services'))
import auth
import gmail
from common import Denied, google_json, recv_json


class GmailPolicyTests(unittest.TestCase):
    def setUp(self):
        self.policy = patch('gmail.policy_client.require')
        self.policy.start()
        self.addCleanup(self.policy.stop)

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
        with (
            patch('gmail.rpc', return_value={'access_token': 'CANARY_TOKEN', 'account_generation': 'test'}),
            patch(
                'gmail.google_json', return_value={'messages': [{'id': 'ab', 'threadId': 'cd', 'secret': 'ignored'}]}
            ) as http,
        ):
            result = gmail.handle({'op': 'list', 'query': 'in:inbox', 'limit': 1})
            self.assertEqual(result, {'messages': [{'id': 'ab', 'threadId': 'cd'}]})
            args, kwargs = http.call_args
            self.assertEqual(args[:2], ('gmail.googleapis.com', 'GET'))
            self.assertTrue(args[2].startswith('/gmail/v1/users/me/messages?'))
            self.assertEqual(kwargs['token'], 'CANARY_TOKEN')
            self.assertNotIn('CANARY_TOKEN', json.dumps(result))

    def test_policy_failure_never_reaches_google(self):
        with (
            patch('gmail.rpc', return_value={'access_token': 'TOKEN', 'account_generation': 'test'}),
            patch('gmail.policy_client.require', side_effect=Denied('POLICY_UNAVAILABLE')),
            patch('gmail.google_json') as http,
        ):
            with self.assertRaisesRegex(Denied, 'POLICY_UNAVAILABLE'):
                gmail.handle({'op': 'list', 'limit': 1})
            http.assert_not_called()

    def test_nested_multipart_prefers_plain_text_and_bounds_depth(self):
        encode = lambda text: base64.urlsafe_b64encode(text.encode()).decode()
        payload = {
            'mimeType': 'multipart/mixed',
            'parts': [
                {
                    'mimeType': 'multipart/alternative',
                    'parts': [
                        {'mimeType': 'text/plain', 'body': {'data': encode('plain body')}},
                        {'mimeType': 'text/html', 'body': {'data': encode('<b>html</b>')}},
                    ],
                },
                {'mimeType': 'application/pdf', 'body': {'attachmentId': 'x'}},
            ],
        }
        self.assertEqual(gmail.body_text(payload).strip(), 'plain body')
        deep = {'mimeType': 'text/plain', 'body': {'data': encode('too deep')}}
        for _ in range(12):
            deep = {'mimeType': 'multipart/mixed', 'parts': [deep]}
        self.assertEqual(gmail.body_text(deep).strip(), '')

    def test_normalized_message_and_best_effort_scrub(self):
        body = base64.urlsafe_b64encode(b'Your code: 123456 https://example.test/login').decode()
        response = {
            'id': 'ab',
            'payload': {
                'mimeType': 'text/plain',
                'body': {'data': body},
                'headers': [{'name': 'Subject', 'value': 'test'}, {'name': 'X-Secret', 'value': 'private'}],
            },
        }
        with (
            patch('gmail.rpc', return_value={'access_token': 'TOKEN', 'account_generation': 'test'}),
            patch('gmail.google_json', return_value=response),
        ):
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
        key = Path(self.directory.name) / "master.key"
        key.write_bytes(b"x" * 32)
        self.key_override = patch("vault.KEY", key)
        self.key_override.start()
        auth.import_client({'installed': {'client_id': 'test.apps.googleusercontent.com', 'client_secret': 'TEST'}})

    def tearDown(self):
        self.key_override.stop()
        self.override.stop()
        self.directory.cleanup()

    def test_pkce_and_readonly_scope(self):
        from urllib.parse import parse_qs, urlsplit

        flow = auth.begin('gmail', 'http://127.0.0.1:12345/callback')
        q = parse_qs(urlsplit(flow['url']).query)
        self.assertEqual(q['code_challenge_method'], ['S256'])
        self.assertEqual(q['scope'], [auth.SCOPE])
        self.assertNotIn('verifier', flow)

    def test_state_mismatch_never_exchanges(self):
        auth.begin('gmail', 'http://127.0.0.1:12345/callback')
        with patch('auth.google_json') as http:
            with self.assertRaises(Denied):
                auth.complete('gmail', {'state': 'wrong', 'code': 'test'})
            http.assert_not_called()

    def test_expired_state(self):
        flow = auth.begin('gmail', 'http://127.0.0.1:12345/callback')
        value = auth.read('pending.json')
        value['expires'] = 0
        auth.write('pending.json', value)
        with self.assertRaises(Denied):
            auth.complete('gmail', {'state': flow['state'], 'code': 'test'})

    def test_scope_escalation_rejected(self):
        flow = auth.begin('gmail', 'http://127.0.0.1:12345/callback')
        with patch('auth.google_json', return_value={'scope': 'https://mail.google.com/', 'refresh_token': 'secret'}):
            with self.assertRaises(Denied):
                auth.complete('gmail', {'state': flow['state'], 'code': 'test'})
        self.assertFalse(auth.status()['connected'])

    def test_refresh_and_private_storage(self):
        auth.write('tokens.json', {'refresh_token': 'REFRESH', 'access_token': 'OLD', 'expires_at': 0})
        with patch('auth.google_json', return_value={'access_token': 'NEW', 'expires_in': 3600}):
            self.assertEqual(auth.access_token('gmail'), 'NEW')
        self.assertEqual((auth.STORE / 'tokens.json.enc').stat().st_mode & 0o777, 0o600)
        self.assertEqual(auth.read('tokens.json')['refresh_token'], 'REFRESH')
        with patch("auth.google_json", return_value={}):
            auth.disconnect('gmail')
        self.assertFalse(auth.status()['connected'])

    def test_dead_refresh_token_requires_reconnect_without_hammering_google(self):
        auth.write('tokens.json', {'refresh_token': 'DEAD', 'access_token': 'OLD', 'expires_at': 0})
        with patch('auth.google_json', side_effect=Denied('GOOGLE_AUTH_REQUIRED')) as http:
            with self.assertRaisesRegex(Denied, 'GMAIL_REAUTH_REQUIRED'):
                auth.access_token('gmail')
            self.assertEqual(http.call_count, 1)
        self.assertTrue(auth.status()['reauth_required'])
        self.assertTrue(auth.status()['connected'])
        with patch('auth.google_json') as http:
            with self.assertRaisesRegex(Denied, 'GMAIL_REAUTH_REQUIRED'):
                auth.access_token('gmail')
            http.assert_not_called()
        # Transient provider failures do not flip the flag.
        auth.write('tokens.json', {'refresh_token': 'OK', 'access_token': 'OLD', 'expires_at': 0})
        with patch('auth.google_json', side_effect=Denied('GOOGLE_REQUEST_FAILED')):
            with self.assertRaisesRegex(Denied, 'GOOGLE_REQUEST_FAILED'):
                auth.access_token('gmail')
        self.assertFalse(auth.status()['reauth_required'])
        # A fresh authorization clears the state.
        flow = auth.begin('gmail', 'http://127.0.0.1:12345/callback')
        auth.write(
            'tokens.json', {'refresh_token': 'DEAD', 'access_token': 'OLD', 'expires_at': 0, 'reauth_required': True}
        )
        with patch(
            'auth.google_json',
            return_value={'scope': auth.SCOPE, 'refresh_token': 'NEW', 'access_token': 'A', 'expires_in': 3600},
        ):
            auth.complete('gmail', {'state': flow['state'], 'code': 'test'})
        self.assertFalse(auth.status()['reauth_required'])

    def test_drive_and_gmail_tokens_are_separate_with_exact_scopes(self):
        from urllib.parse import parse_qs, urlsplit

        gmail_flow = auth.begin('gmail', 'http://127.0.0.1:1/callback')
        drive_flow = auth.begin('drive', 'http://127.0.0.1:2/callback')
        self.assertEqual(
            parse_qs(urlsplit(drive_flow['url']).query)['scope'][0].split(), sorted(auth.GOOGLE['drive']['scopes'])
        )
        drive_scopes = ' '.join(sorted(auth.GOOGLE['drive']['scopes']))
        with patch(
            'auth.google_json',
            return_value={'scope': drive_scopes, 'refresh_token': 'D', 'access_token': 'DA', 'expires_in': 3600},
        ):
            auth.complete('drive', {'state': drive_flow['state'], 'code': 'c'})
        with patch(
            'auth.google_json',
            return_value={'scope': auth.SCOPE, 'refresh_token': 'G', 'access_token': 'GA', 'expires_in': 3600},
        ):
            auth.complete('gmail', {'state': gmail_flow['state'], 'code': 'c'})
        self.assertEqual(auth.access_token('drive'), 'DA')
        self.assertEqual(auth.access_token('gmail'), 'GA')
        self.assertNotEqual(auth.read('tokens.json')['generation'], auth.read('drive-tokens.json')['generation'])
        flow = auth.begin('drive', 'http://127.0.0.1:3/callback')
        with patch(
            'auth.google_json',
            return_value={
                'scope': 'https://www.googleapis.com/auth/drive.readonly',
                'refresh_token': 'x',
                'access_token': 'y',
                'expires_in': 1,
            },
        ):
            with self.assertRaises(Denied):
                auth.complete('drive', {'state': flow['state'], 'code': 'c'})
        status = auth.status()
        self.assertTrue(status['drive']['connected'] and status['gmail']['connected'])
        self.assertEqual(status['drive']['scope_text'], drive_scopes)
        self.assertEqual(auth.handle({'op': 'access_token'}, 'drive')['access_token'], 'DA')
        with self.assertRaises(Denied):
            auth.handle({'op': 'access_token'}, 'notion')

    def test_static_tokens_validate_format_and_never_leave_in_status(self):
        auth.import_token('notion', {'token': 'ntn_' + 'a' * 40})
        auth.import_token('slack', {'token': 'xoxb-' + '1' * 40})
        for connector, bad in (
            ('notion', 'xoxb-' + 'a' * 40),
            ('slack', 'ntn_' + 'a' * 40),
            ('notion', 'ntn_short'),
            ('gmail', 'ntn_' + 'a' * 40),
        ):
            with self.assertRaises(Denied):
                auth.import_token(connector, {'token': bad})
        status = auth.status()
        self.assertTrue(status['notion']['connected'] and status['slack']['connected'])
        self.assertNotIn('ntn_', json.dumps(status))
        self.assertEqual(auth.handle({'op': 'token'}, 'notion')['token'], 'ntn_' + 'a' * 40)
        with self.assertRaises(Denied):
            auth.handle({'op': 'token'}, 'gmail')
        auth.set_account('slack', 'Acme Workspace')
        self.assertEqual(auth.status()['slack']['account'], 'Acme Workspace')
        auth.remove_token('slack')
        self.assertFalse(auth.status()['slack']['connected'])

    def test_disallow_client_replacement_while_connected(self):
        auth.write('tokens.json', {'access_token': 'x'})
        with self.assertRaises(Denied):
            auth.import_client({'installed': {'client_id': 'other.apps.googleusercontent.com', 'client_secret': 'x'}})


class BoundaryTests(unittest.TestCase):
    def test_token_endpoint_400_is_an_authorization_failure(self):
        from unittest.mock import MagicMock

        class Response:
            status = 400

            def read(self, size=-1):
                return b'{"error":"invalid_grant","secret":"NEVER_REFLECTED"}'

        class Connection:
            def __init__(self, *args, **kwargs):
                self.sock = None

            def request(self, *args, **kwargs):
                pass

            def getresponse(self):
                return Response()

            def close(self):
                pass

        with (
            patch('common.target_ips', return_value=['1.1.1.1']),
            patch('common.socket.create_connection', return_value=MagicMock()),
            patch('common.ssl.create_default_context', return_value=MagicMock()),
            patch('common.http.client.HTTPSConnection', Connection),
        ):
            with self.assertRaisesRegex(Denied, '^GOOGLE_AUTH_REQUIRED$'):
                google_json('oauth2.googleapis.com', 'POST', '/token', 'grant_type=refresh_token')
            with self.assertRaisesRegex(Denied, '^GOOGLE_REQUEST_FAILED$'):
                google_json('gmail.googleapis.com', 'GET', '/gmail/v1/users/me/messages')

    def test_non_google_destination_denied(self):
        for host, method in [('evil.test', 'GET'), ('gmail.googleapis.com', 'POST')]:
            with self.assertRaises(Denied):
                google_json(host, method, '/')

    def test_malformed_rpc(self):
        for payload in [b'[]\n', b'null\n', b'{invalid}\n', b'{}\n{}\n']:
            a, b = socket.socketpair()
            with a, b:
                a.sendall(payload)
                with self.assertRaises(Denied):
                    recv_json(b)


if __name__ == '__main__':
    unittest.main()
