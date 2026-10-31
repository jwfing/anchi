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
    'api.x.com': ['104.244.42.1'],
    'www.reddit.com': ['151.101.1.140'],
    'oauth.reddit.com': ['151.101.65.140'],
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
        self.resolv = root / 'resolv.conf'
        self.resolv.write_text('nameserver 1.1.1.1\n')
        self.lookups, self.commands = [], []
        self.answers = dict(ADDRESSES)
        for p in (
            patch('auth.STORE', root / 'store'),
            patch('vault.KEY', key),
            patch('auth.BUILTIN_CLIENT', root / 'google_client.json'),
            patch('network_rules.TARGETS', self.targets),
            patch('network_rules.RESOLV_CONF', self.resolv),
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
        lines = [line for line in self.commands[-1].splitlines() if 'resolvers' not in line]
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

    def test_x_oauth_and_connector_roles_open_only_when_needed(self):
        import x_auth

        x_auth.import_client({'client_id': 'test-client'})
        network_rules.refresh()
        self.assertEqual(self.lookups, [])
        x_auth.begin(x_auth.REDIRECT_URI)
        network_rules.refresh()
        self.assertEqual(self.sets()[0], {'xauth4'})
        self.assertFalse(network_rules.configured('x'))
        auth.write(x_auth.TOKENS, {'access_token': 'TEST_ACCESS', 'generation': 'test'})
        self.lookups.clear()
        network_rules.refresh()
        self.assertEqual(self.sets()[0], {'xauth4', 'x4'})
        self.assertEqual(self.lookups, ['api.x.com'])
        auth.vault.remove(auth.STORE, x_auth.TOKENS)
        auth.vault.remove(auth.STORE, x_auth.PENDING)
        auth.write(x_auth.REVOCATION, {'token': 'TEST_REFRESH'})
        network_rules.refresh()
        self.assertEqual(self.sets()[0], {'xauth4'})
        auth.vault.remove(auth.STORE, x_auth.REVOCATION)
        network_rules.refresh()
        self.assertEqual(self.sets()[0], set())

    def test_reddit_oauth_and_connector_roles_open_only_when_needed(self):
        import reddit_auth

        reddit_auth.import_client({'client_id': 'test-client', 'developer_username': 'developer'})
        network_rules.refresh()
        self.assertEqual(self.lookups, [])
        reddit_auth.begin(reddit_auth.REDIRECT_URI)
        network_rules.refresh()
        self.assertEqual(self.sets()[0], {'redditauth4', 'redditidentity4'})
        self.assertFalse(network_rules.configured('reddit'))
        auth.write(reddit_auth.TOKENS, {'access_token': 'TEST_ACCESS', 'generation': 'test'})
        self.lookups.clear()
        network_rules.refresh()
        self.assertEqual(self.sets()[0], {'redditauth4', 'redditidentity4', 'reddit4'})
        self.assertEqual(self.lookups, ['www.reddit.com', 'oauth.reddit.com'])
        auth.vault.remove(auth.STORE, reddit_auth.TOKENS)
        auth.vault.remove(auth.STORE, reddit_auth.PENDING)
        auth.write(reddit_auth.REVOCATION, {'token': 'TEST_REFRESH'})
        network_rules.refresh()
        self.assertEqual(self.sets()[0], {'redditauth4', 'redditidentity4'})
        auth.vault.remove(auth.STORE, reddit_auth.REVOCATION)
        network_rules.refresh()
        self.assertEqual(self.sets()[0], set())

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

    def test_resolvers_follow_resolv_conf_in_the_same_transaction(self):
        auth.import_token('notion', {'token': 'ntn_' + 'a' * 40})
        network_rules.refresh()
        self.assertIn('add element inet secure_vm resolvers4 { 1.1.1.1 }', self.commands[-1])
        # Tailscale rewrites resolv.conf after boot; a provider lookup failing at the same moment
        # must not hold the resolver sets back.
        self.resolv.write_text('# generated by tailscale\nnameserver 100.100.100.100\n')
        del self.answers['api.notion.com']
        self.assertEqual(network_rules.refresh(), ['api.notion.com'])
        lines = self.commands[-1].splitlines()
        self.assertIn('flush set inet secure_vm resolvers4', lines)
        self.assertIn('flush set inet secure_vm resolvers6', lines)
        self.assertIn('add element inet secure_vm resolvers4 { 100.100.100.100 }', lines)
        self.assertNotIn('1.1.1.1', self.commands[-1])


if __name__ == '__main__':
    unittest.main()


class EgressProxyRuleTests(unittest.TestCase):
    def rules(self):
        with patch('network_rules.pwd.getpwnam', return_value=type('pw', (), {'pw_uid': 990})):
            return network_rules.egress_proxy_rules()

    def resolvers(self, resolv):
        with tempfile.NamedTemporaryFile('w', suffix='.conf') as conf:
            conf.write(resolv)
            conf.flush()
            with patch('network_rules.RESOLV_CONF', Path(conf.name)):
                return network_rules.resolver_commands()

    def dns_rules(self, rules):
        return [r for r in rules if 'dport 53' in r]

    def test_systemd_resolved_stub_is_the_only_resolver_on_ubuntu(self):
        self.assertEqual(
            self.resolvers('nameserver 127.0.0.53\noptions edns0 trust-ad\nsearch .\n'),
            [
                'flush set inet secure_vm resolvers4',
                'add element inet secure_vm resolvers4 { 127.0.0.53 }',
                'flush set inet secure_vm resolvers6',
            ],
        )

    def test_only_named_addresses_enter_the_resolver_sets(self):
        commands = self.resolvers(
            '# cloud image\nnameserver 1.1.1.1\nnameserver 2606:4700::1111\nnameserver fe80::1%eth0\n'
            'nameserver dns.example.com\nsearch 10.0.0.1\nnameserver 1.1.1.1\n'
        )
        self.assertEqual(
            commands,
            [
                'flush set inet secure_vm resolvers4',
                'add element inet secure_vm resolvers4 { 1.1.1.1 }',
                'flush set inet secure_vm resolvers6',
                'add element inet secure_vm resolvers6 { 2606:4700::1111 }',
            ],
        )

    def test_resolvers_are_reachable_on_port_53_only(self):
        rules = self.rules()
        self.assertEqual(
            self.dns_rules(rules),
            [
                '  meta skuid 990 ip daddr @resolvers4 meta l4proto { tcp, udp } th dport 53 accept',
                '  meta skuid 990 ip6 daddr @resolvers6 meta l4proto { tcp, udp } th dport 53 accept',
            ],
        )
        # The DNS accepts come before the backstop, and the backstop still refuses non-TCP traffic
        # and every private destination.
        last_dns = max(i for i, r in enumerate(rules) if 'dport 53' in r)
        self.assertTrue(rules[last_dns + 1].endswith('counter reject') and 'ip daddr {' in rules[last_dns + 1])
        self.assertIn('  meta skuid 990 meta l4proto != tcp counter reject', rules[last_dns + 1 :])
        self.assertEqual(rules[-1], '  meta skuid 990 accept')

    def test_no_resolver_named_means_glibc_loopback_default(self):
        self.assertIn('add element inet secure_vm resolvers4 { 127.0.0.1 }', self.resolvers('options rotate\n'))
        with patch('network_rules.RESOLV_CONF', Path('/nonexistent/resolv.conf')):
            self.assertIn('add element inet secure_vm resolvers4 { 127.0.0.1 }', network_rules.resolver_commands())
