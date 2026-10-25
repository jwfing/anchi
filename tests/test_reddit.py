import json
import fcntl
import tempfile
import unittest
from unittest.mock import patch
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'services'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import reddit_connector
import reddit_auth
import auth
import policy
from common import Denied
from connector_harness import ConnectorHarness


class RedditBoundaryTests(ConnectorHarness):
    def setUp(self):
        super().setUp()
        reddit_connector.connector_base.credential.return_value = {
            'token': 'TEST_ACCESS',
            'generation': 'g1',
            'user_id': 'abc',
            'account': 'u/example',
            'user_agent': 'linux:anchi-test:v1 (by /u/developer)',
        }

    def test_refuses_operations_paths_and_forged_identity_before_credentials(self):
        for request in (
            {'op': 'http', 'url': 'https://evil.test'},
            {'op': 'vote', 'id': 't3_abc'},
            {'op': 'submit', 'subreddit': 'test', 'title': 'Hi', 'text': 'hi', 'account_id': 'other'},
            {'op': 'read', 'id': '../api/v1/me'},
            {'op': 'list', 'subreddit': 'test/../../api', 'limit': 10},
            {'op': 'search', 'query': 'hi', 'limit': 100},
            {'op': 'comment', 'parent': 't4_private', 'text': 'hi'},
            {'op': 'comment', 'parent': 't3_abc', 'text': 'hi\x1b[2J'},
        ):
            with self.subTest(request=request), self.assertRaises(Denied):
                reddit_connector.handle(request)
        reddit_connector.connector_base.credential.assert_not_called()
        self.assertEqual(self.calls, [])

    def test_unapproved_comment_never_reaches_reddit(self):
        reddit_connector.connector_base.policy_client.require.side_effect = Denied('APPROVAL_REQUIRED:test')
        with self.assertRaisesRegex(Denied, 'APPROVAL_REQUIRED'):
            reddit_connector.handle({'op': 'comment', 'parent': 't3_abc', 'text': 'Hello', 'request_id': 'a' * 32})
        self.assertEqual(self.calls, [])
        self.assertEqual(
            self.approved_action(reddit_connector)['params'],
            {
                'parent': 't3_abc',
                'text': 'Hello',
                'account_id': 'abc',
                'account_label': 'u/example',
            },
        )

    def test_reddit_http_200_error_is_not_success_and_never_reflects_message(self):
        self.responses = [(200, b'{"json":{"errors":[["RATELIMIT","TEST_ACCESS", "ratelimit"]]}}')]
        with self.assertRaisesRegex(Denied, '^PROVIDER_RATE_LIMITED$'):
            reddit_connector.handle(
                {'op': 'submit', 'subreddit': 'test', 'title': 'Hi', 'text': 'hello', 'request_id': 'b' * 32}
            )
        self.assertEqual(parse_qs(self.calls[0][3].decode())['kind'], ['self'])

    def test_ambiguous_result_is_never_retried(self):
        self.responses = [(200, b'{"json":{"errors":[],"data":{}}}')]
        request = {'op': 'comment', 'parent': 't3_abc', 'text': 'Hello', 'request_id': 'c' * 32}
        with self.assertRaisesRegex(Denied, 'WRITE_EXECUTION_UNKNOWN'):
            reddit_connector.handle(request)
        with self.assertRaisesRegex(Denied, 'REQUEST_ALREADY_UNKNOWN'):
            reddit_connector.handle(request)
        self.assertEqual(len(self.calls), 1)

    def test_read_whitelists_fields_and_bounds_content(self):
        item = {
            'kind': 't3',
            'data': {
                'name': 't3_abc',
                'title': 'hello',
                'selftext': '中' * 10000,
                'subreddit': 'test',
                'secret': 'omit',
            },
        }
        self.responses = [
            (200, json.dumps({'kind': 'Listing', 'data': {'children': [item] * 25, 'after': 't3_next'}}).encode())
        ]
        result = reddit_connector.handle({'op': 'list', 'subreddit': 'test', 'limit': 25})
        self.assertTrue(result['untrusted_content'])
        self.assertTrue(result['truncated'])
        self.assertIsNone(result['next_cursor'])
        self.assertLess(len(json.dumps(result, ensure_ascii=False).encode()), 48000)
        self.assertNotIn('secret', result['items'][0])

    def test_real_approval_binds_account_content_and_target_and_executes_once(self):
        boot = Path(self.temp.name) / 'boot'
        boot.write_text('test-boot')

        def require(action):
            decision = policy.authorize(action, 'reddit:dev')
            if decision['decision'] == 'ask':
                raise Denied('APPROVAL_REQUIRED:' + decision['approval_id'])
            policy.consume(action, 'reddit:dev', decision['grant_id'], decision['ticket'])

        reddit_connector.connector_base.policy_client.require.side_effect = require
        request = {'op': 'submit', 'subreddit': 'test', 'title': 'Hello', 'text': 'Full draft', 'request_id': 'd' * 32}
        with patch('policy.DATABASE', Path(self.temp.name) / 'policy.db'), patch('policy.BOOT_ID', boot):
            # No rule: the connector's default holds every post for the exact content.
            self.assertEqual(policy.inspect_rules()['rules']['reddit'], 'ask')
            with self.assertRaisesRegex(Denied, 'APPROVAL_REQUIRED'):
                reddit_connector.handle(request)
            grant = policy.inspect()['pending'][0]
            shown = policy.inspect(grant['id'])['action']['params']
            self.assertEqual(
                shown,
                {
                    'subreddit': 'test',
                    'title': 'Hello',
                    'text': 'Full draft',
                    'account_id': 'abc',
                    'account_label': 'u/example',
                },
            )
            policy.decide(grant['id'], 'APPROVED', grant['digest'])
            for change in ({'text': 'changed'}, {'subreddit': 'other'}, {'title': 'changed'}):
                with self.assertRaisesRegex(Denied, 'REQUEST_ID_CONFLICT'):
                    reddit_connector.handle({**request, **change})
            self.responses = [(200, b'{"json":{"errors":[],"data":{"name":"t3_newpost"}}}')]
            expected = {'id': 't3_newpost', 'url': 'https://www.reddit.com/comments/newpost/'}
            self.assertEqual(reddit_connector.handle(request), expected)
            self.assertEqual(reddit_connector.handle(request), expected)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0][:2], ('POST', '/api/submit'))
        form = parse_qs(self.calls[0][3].decode())
        self.assertEqual(form['sr'], ['test'])
        self.assertEqual(form['text'], ['Full draft'])
        self.assertNotIn('account_id', form)
        self.assertEqual(self.calls[0][2]['User-Agent'], 'linux:anchi-test:v1 (by /u/developer)')

    def test_an_auto_rule_publishes_without_approval_for_that_agent_only(self):
        boot = Path(self.temp.name) / 'boot'
        boot.write_text('test-boot')
        agent = {'name': 'dev'}

        def require(action):
            decision = policy.authorize(action, f'reddit:{agent["name"]}')
            if decision['decision'] == 'ask':
                raise Denied('APPROVAL_REQUIRED:' + decision['approval_id'])
            policy.consume(action, f'reddit:{agent["name"]}', decision['grant_id'], decision['ticket'])

        reddit_connector.connector_base.policy_client.require.side_effect = require
        request = {'op': 'comment', 'parent': 't3_post', 'text': 'Reply', 'request_id': 'a' * 32}
        with patch('policy.DATABASE', Path(self.temp.name) / 'policy.db'), patch('policy.BOOT_ID', boot):
            policy.set_mode('reddit:dev', 'auto')
            self.responses = [(200, b'{"json":{"errors":[],"data":{"things":[{"kind":"t1","data":{"name":"t1_r"}}]}}}')]
            self.assertEqual(reddit_connector.handle(request), {'id': 't1_r'})
            agent['name'] = 'ops'
            with self.assertRaisesRegex(Denied, 'APPROVAL_REQUIRED'):
                reddit_connector.handle({**request, 'request_id': 'b' * 32})
            for bad in ('sometimes', 'AUTO'):
                with self.subTest(mode=bad), self.assertRaisesRegex(Denied, '^BAD_MODE$'):
                    policy.set_mode('reddit', bad)
        self.assertEqual(len(self.calls), 1)

    def test_reconnect_invalidates_waiting_comment(self):
        gate = reddit_connector.connector_base.policy_client.require
        gate.side_effect = Denied('APPROVAL_REQUIRED:test')
        request = {'op': 'comment', 'parent': 't1_parent', 'text': 'Reply', 'request_id': 'e' * 32}
        with self.assertRaises(Denied):
            reddit_connector.handle(request)
        gate.side_effect = None
        reddit_connector.connector_base.credential.return_value['generation'] = 'g2'
        with self.assertRaisesRegex(Denied, 'REQUEST_ID_CONFLICT'):
            reddit_connector.handle(request)
        self.assertEqual(self.calls, [])

    def test_comment_success_and_http_failure_redaction(self):
        self.responses = [(200, b'{"json":{"errors":[],"data":{"things":[{"kind":"t1","data":{"name":"t1_reply"}}]}}}')]
        request = {'op': 'comment', 'parent': 't3_post', 'text': 'Reply', 'request_id': 'f' * 32}
        self.assertEqual(reddit_connector.handle(request), {'id': 't1_reply'})
        self.assertEqual(parse_qs(self.calls[0][3].decode())['thing_id'], ['t3_post'])
        self.responses = [(403, b'TEST_ACCESS must not be reflected')]
        with self.assertRaisesRegex(Denied, '^PROVIDER_AUTH_REQUIRED$'):
            reddit_connector.handle({'op': 'read', 'id': 't3_post'})

    def test_search_encodes_query_and_comments_flatten_only_bounded_content(self):
        self.responses = [(200, b'{"kind":"Listing","data":{"children":[],"after":"t3_next"}}')]
        result = reddit_connector.handle(
            {'op': 'search', 'query': 'hi & test', 'subreddit': 'test', 'limit': 2, 'cursor': 't3_prev'}
        )
        self.assertEqual(result['next_cursor'], 't3_next')
        path = urlsplit(self.calls[0][1])
        self.assertEqual(path.path, '/r/test/search')
        self.assertEqual(parse_qs(path.query)['q'], ['hi & test'])
        comment = {
            'kind': 't1',
            'data': {
                'name': 't1_top',
                'body': 'Top',
                'parent_id': 't3_post',
                'link_id': 't3_post',
                'replies': {
                    'kind': 'Listing',
                    'data': {'children': [{'kind': 't1', 'data': {'name': 't1_child', 'body': 'Child'}}]},
                },
            },
        }
        self.responses = [
            (200, json.dumps([{}, {'kind': 'Listing', 'data': {'children': [comment, {'kind': 'more'}]}}]).encode())
        ]
        result = reddit_connector.handle({'op': 'comments', 'post_id': 't3_post', 'limit': 3})
        self.assertEqual([v['id'] for v in result['items']], ['t1_top', 't1_child'])
        self.assertTrue(result['truncated'])
        self.assertTrue(self.calls[1][1].startswith('/comments/post?'))


class RedditOAuthBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        key = root / 'master.key'
        key.write_bytes(b'r' * 32)
        for p in (patch('auth.STORE', root), patch('vault.KEY', key)):
            p.start()
            self.addCleanup(p.stop)
        reddit_auth.import_client({'client_id': 'test-client', 'developer_username': 'developer'})

    def test_oauth_uses_empty_basic_password_but_identity_uses_bearer_on_separate_host(self):
        import base64

        with patch('common.TRANSPORT', return_value=(200, b'{}')) as transport:
            reddit_auth.request('/api/v1/access_token', {'code': 'TEST_CODE'})
            host, method, path, headers, body = transport.call_args.args
            self.assertEqual((host, method, path), ('www.reddit.com', 'POST', '/api/v1/access_token'))
            self.assertEqual(base64.b64decode(headers['Authorization'].split()[1]), b'test-client:')
            self.assertEqual(headers['User-Agent'], 'linux:anchi-test-client:v1 (by /u/developer)')
            self.assertEqual(parse_qs(body.decode()), {'code': ['TEST_CODE']})
            reddit_auth.request('/api/v1/me', token='TEST_ACCESS')
            self.assertEqual(transport.call_args.args[0], 'oauth.reddit.com')
            self.assertEqual(transport.call_args.args[3]['Authorization'], 'Bearer TEST_ACCESS')
            for path, form, token in (
                ('/api/v1/access_token', {}, 'TEST_ACCESS'),
                ('/api/v1/me', {}, None),
                ('/api/v1/me', {}, 'TEST_ACCESS'),
            ):
                transport.reset_mock()
                with self.assertRaisesRegex(Denied, 'DESTINATION_DENIED'):
                    reddit_auth.request(path, form, token)
                transport.assert_not_called()
        with patch('common.TRANSPORT', return_value=(200, b'')):
            self.assertEqual(reddit_auth.request('/api/v1/revoke_token', {'token': 'TEST_REFRESH'}), {})

    def test_public_client_refuses_secrets_and_user_agent_injection(self):
        for value in (
            {'client_id': 'id', 'developer_username': 'developer', 'client_secret': 'forged'},
            {'client_id': 'id', 'developer_username': 'developer\r\nAuthorization: forged'},
            {'client_id': 'id', 'developer_username': 'u/developer'},
        ):
            with self.assertRaises(Denied):
                reddit_auth.import_client(value)

    def test_state_mismatch_and_redirect_refused_without_network(self):
        with patch('reddit_auth.request') as request:
            with self.assertRaisesRegex(Denied, 'BAD_REDIRECT_URI'):
                reddit_auth.begin('https://evil.test/callback')
            reddit_auth.begin(reddit_auth.REDIRECT_URI)
            with self.assertRaisesRegex(Denied, 'INVALID_OAUTH_STATE'):
                reddit_auth.complete({'code': 'test-code', 'state': 'wrong'})
            request.assert_not_called()

    def test_scope_escalation_never_stores_tokens(self):
        flow = reddit_auth.begin(reddit_auth.REDIRECT_URI)
        with patch(
            'reddit_auth.request',
            return_value={
                'access_token': 'TEST_ACCESS',
                'refresh_token': 'TEST_REFRESH',
                'expires_in': 7200,
                'token_type': 'bearer',
                'scope': 'vote',
            },
        ):
            with self.assertRaisesRegex(Denied, 'REDDIT_UNEXPECTED_SCOPES'):
                reddit_auth.complete({'code': 'test-code', 'state': flow['state']})
        self.assertFalse(reddit_auth.status()['connected'])
        self.assertNotIn('TEST_ACCESS', json.dumps(auth.status()))

    def connect(self):
        flow = reddit_auth.begin(reddit_auth.REDIRECT_URI)
        response = {
            'access_token': 'TEST_ACCESS',
            'refresh_token': 'TEST_REFRESH',
            'expires_in': 7200,
            'token_type': 'bearer',
            'scope': ' '.join(reddit_auth.SCOPES),
        }
        with patch('reddit_auth.request', side_effect=[response, {'id': 'abc', 'name': 'example'}]) as request:
            result = reddit_auth.complete({'code': 'test-code', 'state': flow['state']})
        return result, request

    def test_installed_app_exchange_keeps_tokens_in_vault_and_only_reddit_can_read_access_token(self):
        flow = reddit_auth.begin(reddit_auth.REDIRECT_URI)
        query = parse_qs(urlsplit(flow['url']).query)
        self.assertEqual(query['duration'], ['permanent'])
        self.assertEqual(query['response_type'], ['code'])
        self.assertEqual(query['redirect_uri'], [reddit_auth.REDIRECT_URI])
        self.assertEqual(set(query['scope'][0].split()), reddit_auth.SCOPES)
        self.assertNotIn('verifier', flow)
        result, request = self.connect()
        self.assertEqual(result['account'], 'u/example')
        self.assertNotIn('TEST_ACCESS', json.dumps(result))
        self.assertEqual(request.call_args_list[0].args[1]['redirect_uri'], reddit_auth.REDIRECT_URI)
        credential = auth.handle({'op': 'access_token'}, 'reddit')
        self.assertEqual(credential['access_token'], 'TEST_ACCESS')
        self.assertNotIn('refresh_token', credential)
        with self.assertRaises(Denied):
            auth.handle({'op': 'egress_credential', 'connector': 'reddit'}, 'egress')
        with self.assertRaisesRegex(Denied, 'DISCONNECT_BEFORE_REPLACING_CLIENT'):
            reddit_auth.import_client({'client_id': 'different-client', 'developer_username': 'developer'})

    def test_expired_flow_and_replay_never_exchange(self):
        flow = reddit_auth.begin(reddit_auth.REDIRECT_URI)
        pending = auth.read(reddit_auth.PENDING)
        auth.write(reddit_auth.PENDING, {**pending, 'expires': 0})
        with patch('reddit_auth.request') as request:
            with self.assertRaisesRegex(Denied, 'INVALID_OAUTH_STATE'):
                reddit_auth.complete({'code': 'test-code', 'state': flow['state']})
            request.assert_not_called()

    def test_exchange_consumes_state_but_keeps_egress_open_until_it_finishes(self):
        import network_rules

        flow = reddit_auth.begin(reddit_auth.REDIRECT_URI)

        def exchange(*_args):
            self.assertTrue(auth.read(reddit_auth.PENDING)['consumed'])
            self.assertTrue(network_rules.configured('redditauth'))
            with self.assertRaisesRegex(Denied, 'INVALID_OAUTH_STATE'):
                reddit_auth.complete({'code': 'test-code', 'state': flow['state']})
            raise Denied('REDDIT_REQUEST_FAILED')

        with patch('reddit_auth.request', side_effect=exchange):
            with self.assertRaisesRegex(Denied, 'REDDIT_REQUEST_FAILED'):
                reddit_auth.complete({'code': 'test-code', 'state': flow['state']})
        self.assertFalse(network_rules.configured('redditauth'))
        self.connect()
        with patch('reddit_auth.request') as request:
            with self.assertRaises(Denied):
                reddit_auth.complete({'code': 'test-code', 'state': flow['state']})
            request.assert_not_called()

    def test_refresh_rotation_preserves_identity_and_generation(self):
        self.connect()
        old = auth.read(reddit_auth.TOKENS)
        auth.write(reddit_auth.TOKENS, {**old, 'expires_at': 0})
        with patch(
            'reddit_auth.request',
            return_value={
                'access_token': 'NEXT_ACCESS',
                'refresh_token': 'NEXT_REFRESH',
                'expires_in': 7200,
                'token_type': 'bearer',
            },
        ) as request:
            value = reddit_auth.credential()
        self.assertEqual(request.call_args.args[1]['refresh_token'], 'TEST_REFRESH')
        self.assertEqual(value['access_token'], 'NEXT_ACCESS')
        self.assertEqual(value['account_generation'], old['generation'])
        self.assertEqual(value['user_id'], 'abc')
        self.assertEqual(auth.read(reddit_auth.TOKENS)['refresh_token'], 'NEXT_REFRESH')

    def test_failed_refresh_requires_sign_in_and_disconnect_retains_revocation_for_retry(self):
        self.connect()
        old = auth.read(reddit_auth.TOKENS)
        auth.write(reddit_auth.TOKENS, {**old, 'expires_at': 0})
        with patch('reddit_auth.request', side_effect=Denied('REDDIT_REAUTH_REQUIRED')) as request:
            for _ in range(2):
                with self.assertRaisesRegex(Denied, 'REDDIT_REAUTH_REQUIRED'):
                    reddit_auth.credential()
            self.assertEqual(request.call_count, 1)
        self.assertTrue(reddit_auth.status()['reauth_required'])
        with patch('reddit_auth.request', side_effect=Denied('REDDIT_REQUEST_FAILED')):
            self.assertTrue(reddit_auth.disconnect()['revocation_pending'])
        self.assertFalse(reddit_auth.status()['connected'])
        with self.assertRaisesRegex(Denied, 'REDDIT_NOT_CONNECTED'):
            reddit_auth.credential()
        with patch('reddit_auth.request', return_value={}):
            self.assertTrue(reddit_auth.disconnect()['remote_revoked'])
        self.assertFalse(reddit_auth.status()['revocation_pending'])

    def test_oauth_transport_refuses_redirects_and_redacts_errors(self):
        for code in (302, 400, 401, 429, 500):
            with patch('common.TRANSPORT', return_value=(code, b'TEST_ACCESS', None)) as transport:
                with self.assertRaises(Denied) as caught:
                    reddit_auth.request('/api/v1/access_token', {'grant_type': 'refresh_token'})
                self.assertNotIn('TEST_ACCESS', str(caught.exception))
                self.assertEqual(transport.call_args.args[0], 'www.reddit.com')
        with patch('common.TRANSPORT') as transport:
            with self.assertRaisesRegex(Denied, 'DESTINATION_DENIED'):
                reddit_auth.request('/api/vote')
            transport.assert_not_called()

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
            patch('reddit_auth.request', side_effect=revoke),
        ):
            self.assertTrue(connector_admin.disconnect('reddit')['remote_revoked'])
