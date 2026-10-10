import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'services'))
import auth
import network_rules

ADDRESSES = {
    'oauth2.googleapis.com': ['142.250.1.1', '2a00:1450::1'],
    'gmail.googleapis.com': ['142.250.1.2'],
    'www.googleapis.com': ['142.250.1.3'],
    'api.notion.com': ['104.18.1.1'],
    'slack.com': ['3.1.1.1'],
}


class RefreshTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        (root / 'store').mkdir()
        key = root / 'master.key'
        key.write_bytes(os.urandom(32))
        self.targets = root / 'targets.json'
        self.lookups, self.commands = [], []
        self.answers = dict(ADDRESSES)
        for p in (
            patch('auth.STORE', root / 'store'),
            patch('vault.KEY', key),
            patch('auth.BUILTIN_CLIENT', root / 'google_client.json'),
            patch('network_rules.TARGETS', self.targets),
            patch('network_rules.nft', side_effect=self.commands.append),
            patch('network_rules.socket.getaddrinfo', side_effect=self.lookup),
        ):
            p.start()
            self.addCleanup(p.stop)

    def lookup(self, host, port, type=None):
        self.lookups.append(host)
        if host not in self.answers:
            raise socket.gaierror('no answer')
        return [(None, None, None, '', (a, port)) for a in self.answers[host]]

    def sets(self):
        """Role sets the last transaction left populated, and the ones it flushed."""
        lines = self.commands[-1].splitlines()
        return (
            {line.split()[4] for line in lines if line.startswith('add element')},
            {line.split()[4] for line in lines if line.startswith('flush set')},
        )

    def test_fresh_vm_resolves_nothing_and_leaves_every_set_empty(self):
        self.assertEqual(network_rules.refresh(), [])
        self.assertEqual(self.lookups, [])
        populated, flushed = self.sets()
        self.assertEqual(populated, set())
        self.assertEqual(flushed, {f'{role}{v}' for role in network_rules.ROLES for v in (4, 6)})
        self.assertEqual(json.loads(self.targets.read_text()), {})

    def test_auth_needs_a_client_and_a_sign_in_or_token(self):
        # A client alone is not enough: nothing would use oauth2 yet.
        auth.import_client({'installed': {'client_id': 'x.apps.googleusercontent.com', 'client_secret': 's'}})
        network_rules.refresh()
        self.assertEqual(self.lookups, [])
        # A sign-in in progress makes oauth2 reachable before the user returns from the browser.
        auth.begin('gmail', 'http://127.0.0.1:1/callback', 'work')
        network_rules.refresh()
        self.assertEqual(self.lookups, ['oauth2.googleapis.com'])
        self.assertEqual(self.sets()[0], {'auth4', 'auth6'})
        # Tokens of a named account configure the connector role too.
        auth.write('tokens.work.json', {'access_token': 'a', 'generation': 'g'})
        self.lookups.clear()
        network_rules.refresh()
        self.assertEqual(self.lookups, ['oauth2.googleapis.com', 'gmail.googleapis.com'])

    def test_builtin_client_counts_and_static_tokens_configure_their_role(self):
        auth.write('drive-pending.json', {'state': 's'})
        network_rules.refresh()
        self.assertEqual(self.lookups, [])
        auth.BUILTIN_CLIENT.write_text(
            json.dumps({'installed': {'client_id': 'b.apps.googleusercontent.com', 'client_secret': 's'}})
        )
        auth.import_token('notion', {'token': 'ntn_' + 'a' * 40})
        network_rules.refresh()
        self.assertEqual(self.lookups, ['oauth2.googleapis.com', 'api.notion.com'])

    def test_one_failed_lookup_keeps_old_targets_and_refreshes_the_others(self):
        auth.import_token('notion', {'token': 'ntn_' + 'a' * 40})
        auth.import_token('slack', {'token': 'xoxb-' + '1' * 40})
        network_rules.refresh()
        before = json.loads(self.targets.read_text())
        del self.answers['api.notion.com']
        self.answers['slack.com'] = ['3.1.1.2']
        self.assertEqual(network_rules.refresh(), ['api.notion.com'])
        after = json.loads(self.targets.read_text())
        self.assertEqual(after['api.notion.com'], before['api.notion.com'])
        self.assertEqual(after['slack.com']['addresses'], ['3.1.1.2'])
        # The failed role's kernel set is neither flushed nor extended; it expires on its own.
        populated, flushed = self.sets()
        self.assertNotIn('notion4', flushed | populated)
        self.assertIn('slack4', populated)

    def test_private_answers_are_refused_per_host(self):
        auth.import_token('notion', {'token': 'ntn_' + 'a' * 40})
        auth.import_token('slack', {'token': 'xoxb-' + '1' * 40})
        self.answers['slack.com'] = ['10.0.0.1']
        self.assertEqual(network_rules.refresh(), ['slack.com'])
        targets = json.loads(self.targets.read_text())
        self.assertNotIn('slack.com', targets)
        self.assertEqual(targets['api.notion.com']['addresses'], ['104.18.1.1'])
        self.assertNotIn('10.0.0.1', self.commands[-1])


if __name__ == '__main__':
    unittest.main()
