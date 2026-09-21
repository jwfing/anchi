import json
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'services'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import slack
from common import Denied
from connector_harness import ConnectorHarness


class SlackTests(ConnectorHarness):
    def test_channels_only_member_and_history_trimmed(self):
        listing = {
            'ok': True,
            'channels': [
                {'id': 'C1', 'name': 'general', 'is_member': True, 'topic': {'value': 'x'}},
                {'id': 'C2', 'name': 'random', 'is_member': False},
            ],
        }
        self.responses = [(200, json.dumps(listing).encode())]
        result = slack.handle({'op': 'channels', 'limit': 50})
        self.assertEqual(result['channels'], [{'id': 'C1', 'name': 'general'}])
        self.assertIn('types=public_channel%2Cprivate_channel', self.calls[0][1])
        history = {
            'ok': True,
            'messages': [{'ts': '1', 'user': 'U1', 'text': 'x' * 5000, 'blocks': [], 'thread_ts': '1'}],
        }
        self.responses = [(200, json.dumps(history).encode())]
        result = slack.handle({'op': 'history', 'channel': 'C1', 'limit': 20, 'oldest': 1700000000})
        self.assertEqual(len(result['messages'][0]['text']), 4000)
        self.assertEqual(set(result['messages'][0]), {'ts', 'user', 'text', 'thread_ts'})
        self.assertIn('oldest=1700000000', self.calls[1][1])

    def test_ok_false_maps_to_fixed_codes(self):
        for error, code in (
            ('not_in_channel', 'NOT_IN_CHANNEL'),
            ('invalid_auth', 'REAUTH_REQUIRED'),
            ('token_revoked', 'REAUTH_REQUIRED'),
            ('ratelimited', 'PROVIDER_RATE_LIMITED'),
            ('weird_thing', 'PROVIDER_REJECTED'),
        ):
            self.responses = [(200, json.dumps({'ok': False, 'error': error, 'detail': 'SECRET'}).encode())]
            with self.assertRaises(Denied) as caught:
                slack.handle({'op': 'channels', 'limit': 5})
            self.assertEqual(str(caught.exception), code)

    def test_post_is_json_and_frozen(self):
        self.responses = [(200, json.dumps({'ok': True, 'ts': '99.1', 'channel': 'C1'}).encode())]
        result = slack.handle(
            {'op': 'post', 'request_id': 'a' * 32, 'channel': 'C1', 'text': 'hello', 'thread_ts': '1.2'}
        )
        self.assertEqual(result, {'ts': '99.1', 'channel': 'C1'})
        method, path, headers, body = self.calls[0]
        self.assertEqual((method, path), ('POST', '/api/chat.postMessage'))
        self.assertEqual(json.loads(body), {'channel': 'C1', 'text': 'hello', 'thread_ts': '1.2'})
        action = self.approved_action(slack)
        self.assertEqual(action['params'], {'channel': 'C1', 'text': 'hello', 'thread_ts': '1.2'})

    def test_validation(self):
        for params in (
            {'channel': 'C1', 'text': 'x' * 4001},
            {'channel': 'bad channel', 'text': 'x'},
            {'channel': 'C1', 'text': 'x', 'thread_ts': 'abc'},
        ):
            with self.assertRaises(Denied):
                slack.validate('slack.post', params)
        with self.assertRaises(Denied):
            slack.validate('slack.history', {'channel': 'C1', 'limit': 51})

    def test_probe_and_revoke(self):
        self.responses = [
            (200, json.dumps({'ok': True, 'team': 'Acme', 'user': 'bot', 'url': 'https://acme.slack.com/'}).encode())
        ]
        self.assertEqual(slack.probe('xoxb-x'), 'Acme')
        self.responses = [(200, json.dumps({'ok': True, 'revoked': True}).encode())]
        self.assertTrue(slack.revoke('xoxb-x'))


if __name__ == '__main__':
    unittest.main()
