import json
import fcntl
import sys
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'services'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import auth
import policy
import x_connector
import x_auth
from common import Denied
from connector_harness import ConnectorHarness


class XBoundaryTests(ConnectorHarness):
    def setUp(self):
        super().setUp()
        x_connector.connector_base.credential.return_value = {
            'token': 'TEST_ACCESS',
            'generation': 'g1',
            'user_id': '123',
            'account': '@example',
        }

    def test_refuses_arbitrary_operations_and_forged_identity_before_credentials(self):
        for request in (
            {'op': 'http', 'url': 'https://evil.test'},
            {'op': 'delete', 'id': '123'},
            {'op': 'post', 'text': 'hi', 'account_id': '456'},
            {'op': 'mentions', 'limit': 10, 'account': 'other'},
            {'op': 'read', 'id': '../oauth2/token'},
            {'op': 'search', 'query': 'hi', 'limit': 100},
            {'op': 'post', 'text': 'hi\x1b[2J'},
        ):
            with self.subTest(request=request), self.assertRaises(Denied):
                x_connector.handle(request)
        x_connector.connector_base.credential.assert_not_called()
        self.assertEqual(self.calls, [])

    def test_unapproved_post_never_reaches_provider(self):
        x_connector.connector_base.policy_client.require.side_effect = Denied('APPROVAL_REQUIRED:test')
        with self.assertRaisesRegex(Denied, 'APPROVAL_REQUIRED'):
            x_connector.handle({'op': 'post', 'text': 'hello', 'request_id': 'a' * 32})
        self.assertEqual(self.calls, [])
        params = self.approved_action(x_connector)['params']
        self.assertEqual(params['account_id'], '123')
        self.assertEqual(params['account_label'], '@example')

    def test_invalid_limits_are_refused_before_credentials_or_network(self):
        for op in ('search', 'mentions'):
            for limit in (0, 1, 9, 26, 100, True, 10.5, '10', None):
                request = {'op': op, 'limit': limit}
                if op == 'search':
                    request['query'] = 'news'
                with self.subTest(op=op, limit=limit), self.assertRaisesRegex(Denied, '^BAD_LIMIT$'):
                    x_connector.handle(request)
        x_connector.connector_base.credential.assert_not_called()
        self.assertEqual(self.calls, [])

    def test_payment_refusal_is_explicit_without_provider_body_or_automatic_retry(self):
        requests = (
            {'op': 'search', 'query': '新闻 -is:retweet', 'limit': 10},
            {'op': 'post', 'text': 'hello', 'request_id': 'e' * 32},
        )
        for request in requests:
            self.responses = [(402, b'{"detail":"TEST_ACCESS private billing details"}')]
            with self.subTest(op=request['op']), self.assertRaisesRegex(Denied, '^PROVIDER_PAYMENT_REQUIRED$'):
                x_connector.handle(request)
        self.assertEqual(len(self.calls), 2)

    def test_policy_requires_approval_even_with_legacy_auto_rule(self):
        boot = Path(self.temp.name) / 'boot'
        boot.write_text('test-boot')
        with patch('policy.DATABASE', Path(self.temp.name) / 'policy.db'), patch('policy.BOOT_ID', boot):
            with policy.database() as conn:
                conn.execute("INSERT INTO rules VALUES('x:dev','auto')")
            action = {
                'operation': 'x.post',
                'account': 'g1',
                'params': {
                    'text': 'hello',
                    'account_id': '123',
                    'account_label': '@example',
                },
            }
            self.assertEqual(policy.authorize(action, 'x:dev')['decision'], 'ask')
            with self.assertRaisesRegex(Denied, 'X_WRITES_REQUIRE_APPROVAL'):
                policy.set_mode('x', 'auto')

    def test_real_policy_approval_is_bound_to_content_and_execution_happens_once(self):
        boot = Path(self.temp.name) / 'boot'
        boot.write_text('test-boot')

        def require(action):
            decision = policy.authorize(action, 'x:dev')
            if decision['decision'] == 'ask':
                raise Denied('APPROVAL_REQUIRED:' + decision['approval_id'])
            policy.consume(action, 'x:dev', decision['grant_id'], decision['ticket'])

        x_connector.connector_base.policy_client.require.side_effect = require
        request = {'op': 'post', 'text': 'hello', 'reply_to': '987', 'request_id': 'b' * 32}
        with patch('policy.DATABASE', Path(self.temp.name) / 'policy.db'), patch('policy.BOOT_ID', boot):
            with self.assertRaisesRegex(Denied, 'APPROVAL_REQUIRED'):
                x_connector.handle(request)
            grant = policy.inspect()['pending'][0]
            shown = policy.inspect(grant['id'])['action']['params']
            self.assertEqual(
                shown, {'text': 'hello', 'reply_to': '987', 'account_id': '123', 'account_label': '@example'}
            )
            policy.decide(grant['id'], 'APPROVED', grant['digest'])
            with self.assertRaisesRegex(Denied, 'REQUEST_ID_CONFLICT'):
                x_connector.handle({**request, 'text': 'changed'})
            self.responses = [(201, b'{"data":{"id":"456","text":"hello"}}')]
            expected = {'id': '456', 'url': 'https://x.com/i/status/456'}
            self.assertEqual(x_connector.handle(request), expected)
            self.assertEqual(x_connector.handle(request), expected)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0][:2], ('POST', '/2/tweets'))
        self.assertEqual(json.loads(self.calls[0][3]), {'text': 'hello', 'reply': {'in_reply_to_tweet_id': '987'}})

    def test_reconnect_invalidates_a_waiting_request(self):
        gate = x_connector.connector_base.policy_client.require
        gate.side_effect = Denied('APPROVAL_REQUIRED:test')
        request = {'op': 'post', 'text': 'hello', 'request_id': 'c' * 32}
        with self.assertRaises(Denied):
            x_connector.handle(request)
        gate.side_effect = None
        x_connector.connector_base.credential.return_value['generation'] = 'g2'
        with self.assertRaisesRegex(Denied, 'REQUEST_ID_CONFLICT'):
            x_connector.handle(request)
        self.assertEqual(self.calls, [])

    def test_ambiguous_post_is_never_retried(self):
        request = {'op': 'post', 'text': 'hello', 'request_id': 'd' * 32}
        self.responses = [(503, b'private provider response')]
        with self.assertRaisesRegex(Denied, 'WRITE_EXECUTION_UNKNOWN'):
            x_connector.handle(request)
        with self.assertRaisesRegex(Denied, 'REQUEST_ALREADY_UNKNOWN'):
            x_connector.handle(request)
        self.assertEqual(len(self.calls), 1)

    def test_reads_use_fixed_paths_and_the_authenticated_mentions_account(self):
        self.responses = [
            (200, b'{"data":[{"id":"42","text":"hi","author_id":"7","secret":"ignore"}],"meta":{"next_token":"next"}}')
        ]
        result = x_connector.handle({'op': 'mentions', 'limit': 10})
        self.assertTrue(self.calls[0][1].startswith('/2/users/123/mentions?'))
        self.assertEqual(
            result['posts'][0], {'id': '42', 'text': 'hi', 'author_id': '7', 'url': 'https://x.com/i/status/42'}
        )
        self.assertEqual(result['next_cursor'], 'next')
        self.responses = [(200, b'{"data":[]}')]
        x_connector.handle({'op': 'search', 'query': 'from:example #anchi', 'limit': 10, 'cursor': 'next'})
        query = parse_qs(urlsplit(self.calls[1][1]).query)
        self.assertEqual(query['query'], ['from:example #anchi'])
        self.assertEqual(query['next_token'], ['next'])

    def test_read_budget_survives_connections_and_stops_before_network(self):
        with patch('x_connector.DAILY_READS', 10):
            self.responses = [(200, b'{"data":[]}')]
            x_connector.handle({'op': 'search', 'query': 'anchi', 'limit': 10})
            with self.assertRaisesRegex(Denied, 'X_DAILY_READ_LIMIT'):
                x_connector.handle({'op': 'read', 'id': '42'})
        self.assertEqual(len(self.calls), 1)

    def test_output_has_a_byte_budget_and_provider_errors_are_not_reflected(self):
        self.responses = [(200, json.dumps({'data': [{'id': '42', 'text': '中' * 4000}] * 25}).encode())]
        result = x_connector.handle({'op': 'search', 'query': 'anchi', 'limit': 25})
        self.assertTrue(result['truncated'])
        self.assertLess(len(json.dumps(result, ensure_ascii=False).encode()), 48000)
        self.responses = [(403, b'TEST_ACCESS must never be echoed')]
        with self.assertRaisesRegex(Denied, '^PROVIDER_AUTH_REQUIRED$'):
            x_connector.handle({'op': 'read', 'id': '42'})


class XOAuthBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        key = root / 'master.key'
        key.write_bytes(b'x' * 32)
        for p in (patch('auth.STORE', root), patch('vault.KEY', key)):
            p.start()
            self.addCleanup(p.stop)
        x_auth.import_client({'client_id': 'test-client'})

    def test_state_mismatch_and_redirect_refused_without_network(self):
        with patch('x_auth.request') as request:
            with self.assertRaisesRegex(Denied, 'BAD_REDIRECT_URI'):
                x_auth.begin('https://evil.test/callback')
            x_auth.begin(x_auth.REDIRECT_URI)
            with self.assertRaisesRegex(Denied, 'INVALID_OAUTH_STATE'):
                x_auth.complete({'code': 'test-code', 'state': 'wrong'})
            request.assert_not_called()

    def test_scope_escalation_never_stores_tokens(self):
        flow = x_auth.begin(x_auth.REDIRECT_URI)
        with patch(
            'x_auth.request',
            return_value={
                'access_token': 'TEST_ACCESS',
                'refresh_token': 'TEST_REFRESH',
                'expires_in': 7200,
                'token_type': 'bearer',
                'scope': 'dm.write',
            },
        ):
            with self.assertRaisesRegex(Denied, 'X_UNEXPECTED_SCOPES'):
                x_auth.complete({'code': 'test-code', 'state': flow['state']})
        self.assertFalse(x_auth.status()['connected'])
        self.assertNotIn('TEST_ACCESS', json.dumps(auth.status()))

    def connect(self):
        flow = x_auth.begin(x_auth.REDIRECT_URI)
        response = {
            'access_token': 'TEST_ACCESS',
            'refresh_token': 'TEST_REFRESH',
            'expires_in': 7200,
            'token_type': 'bearer',
            'scope': ' '.join(x_auth.SCOPES),
        }
        with patch('x_auth.request', side_effect=[response, {'data': {'id': '123', 'username': 'example'}}]) as request:
            result = x_auth.complete({'code': 'test-code', 'state': flow['state']})
        return result, request

    def test_pkce_exchange_keeps_tokens_in_vault_and_only_x_can_read_access_token(self):
        flow = x_auth.begin(x_auth.REDIRECT_URI)
        query = parse_qs(urlsplit(flow['url']).query)
        self.assertEqual(query['code_challenge_method'], ['S256'])
        self.assertEqual(set(query['scope'][0].split()), x_auth.SCOPES)
        self.assertNotIn('verifier', flow)
        result, request = self.connect()
        self.assertEqual(result['account'], '@example')
        self.assertNotIn('TEST_ACCESS', json.dumps(result))
        self.assertIn('code_verifier', request.call_args_list[0].args[1])
        credential = auth.handle({'op': 'access_token'}, 'x')
        self.assertEqual(credential['access_token'], 'TEST_ACCESS')
        self.assertNotIn('refresh_token', credential)
        with self.assertRaises(Denied):
            auth.handle({'op': 'egress_credential', 'connector': 'x'}, 'egress')
        with self.assertRaisesRegex(Denied, 'DISCONNECT_BEFORE_REPLACING_CLIENT'):
            x_auth.import_client({'client_id': 'different-client'})

    def test_expired_flow_and_replay_never_exchange(self):
        flow = x_auth.begin(x_auth.REDIRECT_URI)
        pending = auth.read(x_auth.PENDING)
        auth.write(x_auth.PENDING, {**pending, 'expires': 0})
        with patch('x_auth.request') as request:
            with self.assertRaisesRegex(Denied, 'INVALID_OAUTH_STATE'):
                x_auth.complete({'code': 'test-code', 'state': flow['state']})
            request.assert_not_called()

    def test_exchange_consumes_state_but_keeps_egress_open_until_it_finishes(self):
        import network_rules

        flow = x_auth.begin(x_auth.REDIRECT_URI)

        def exchange(*_args):
            self.assertTrue(auth.read(x_auth.PENDING)['consumed'])
            self.assertTrue(network_rules.configured('xauth'))
            with self.assertRaisesRegex(Denied, 'INVALID_OAUTH_STATE'):
                x_auth.complete({'code': 'test-code', 'state': flow['state']})
            raise Denied('X_REQUEST_FAILED')

        with patch('x_auth.request', side_effect=exchange):
            with self.assertRaisesRegex(Denied, 'X_REQUEST_FAILED'):
                x_auth.complete({'code': 'test-code', 'state': flow['state']})
        self.assertFalse(network_rules.configured('xauth'))
        self.connect()
        with patch('x_auth.request') as request:
            with self.assertRaises(Denied):
                x_auth.complete({'code': 'test-code', 'state': flow['state']})
            request.assert_not_called()

    def test_refresh_rotation_preserves_identity_and_generation(self):
        self.connect()
        old = auth.read(x_auth.TOKENS)
        auth.write(x_auth.TOKENS, {**old, 'expires_at': 0})
        with patch(
            'x_auth.request',
            return_value={
                'access_token': 'NEXT_ACCESS',
                'refresh_token': 'NEXT_REFRESH',
                'expires_in': 7200,
                'token_type': 'bearer',
            },
        ) as request:
            value = x_auth.credential()
        self.assertEqual(request.call_args.args[1]['refresh_token'], 'TEST_REFRESH')
        self.assertEqual(value['access_token'], 'NEXT_ACCESS')
        self.assertEqual(value['account_generation'], old['generation'])
        self.assertEqual(value['user_id'], '123')
        self.assertEqual(auth.read(x_auth.TOKENS)['refresh_token'], 'NEXT_REFRESH')

    def test_failed_refresh_requires_sign_in_and_disconnect_retains_revocation_for_retry(self):
        self.connect()
        old = auth.read(x_auth.TOKENS)
        auth.write(x_auth.TOKENS, {**old, 'expires_at': 0})
        with patch('x_auth.request', side_effect=Denied('X_REAUTH_REQUIRED')) as request:
            for _ in range(2):
                with self.assertRaisesRegex(Denied, 'X_REAUTH_REQUIRED'):
                    x_auth.credential()
            self.assertEqual(request.call_count, 1)
        self.assertTrue(x_auth.status()['reauth_required'])
        with patch('x_auth.request', side_effect=Denied('X_REQUEST_FAILED')):
            self.assertTrue(x_auth.disconnect()['revocation_pending'])
        self.assertFalse(x_auth.status()['connected'])
        with self.assertRaisesRegex(Denied, 'X_NOT_CONNECTED'):
            x_auth.credential()
        with patch('x_auth.request', return_value={}):
            self.assertTrue(x_auth.disconnect()['remote_revoked'])
        self.assertFalse(x_auth.status()['revocation_pending'])

    def test_oauth_transport_refuses_redirects_and_redacts_errors(self):
        for code in (302, 400, 401, 429, 500):
            with patch('common.TRANSPORT', return_value=(code, b'TEST_ACCESS', None)) as transport:
                with self.assertRaises(Denied) as caught:
                    x_auth.request('/2/oauth2/token', {'grant_type': 'refresh_token'})
                self.assertNotIn('TEST_ACCESS', str(caught.exception))
                self.assertEqual(transport.call_args.args[0], 'api.x.com')
        with patch('common.TRANSPORT') as transport:
            with self.assertRaisesRegex(Denied, 'DESTINATION_DENIED'):
                x_auth.request('/2/dm_events')
            transport.assert_not_called()

    def test_payment_failure_during_refresh_preserves_login_without_exposing_body(self):
        self.connect()
        expired = {**auth.read(x_auth.TOKENS), 'expires_at': 0}
        auth.write(x_auth.TOKENS, expired)
        with patch('common.TRANSPORT', return_value=(402, b'TEST_REFRESH private billing details', None)) as transport:
            with self.assertRaisesRegex(Denied, '^PROVIDER_PAYMENT_REQUIRED$'):
                x_auth.credential()
        self.assertEqual(transport.call_count, 1)
        self.assertEqual(auth.read(x_auth.TOKENS), expired)

    def test_admin_disconnect_holds_the_refresh_lock(self):
        import connector_admin

        self.connect()

        def revoke(*_args):
            with (auth.STORE / 'lock').open('a') as lock:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return {}

        with (
            patch('connector_admin.run_as', side_effect=lambda _user, fn: fn()),
            patch('x_auth.request', side_effect=revoke),
        ):
            self.assertTrue(connector_admin.disconnect('x')['remote_revoked'])
