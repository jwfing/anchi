import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'services'))
import auth
import policy
import vault
from common import Denied, target_ips


class SecurityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.key = self.root / 'master'
        self.key.write_bytes(os.urandom(32))
        boot = self.root / 'boot'
        boot.write_text('test-boot')
        self.patches = [
            patch('vault.KEY', self.key),
            patch('auth.STORE', self.root),
            patch('policy.DATABASE', self.root / 'policy.sqlite3'),
            patch('policy.BOOT_ID', boot),
            patch('common.TARGETS_FILE', self.root / 'targets.json'),
        ]
        for p in self.patches:
            p.start()
        self.action = {'operation': 'gmail.list', 'account': 'generation1', 'params': {'query': 'in:inbox', 'limit': 1}}

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.temp.cleanup()

    def test_legacy_upgrade_keeps_auto_default_and_current_explicit_modes(self):
        import sqlite3

        conn = sqlite3.connect(policy.DATABASE)
        conn.executescript(
            'CREATE TABLE config(id INTEGER PRIMARY KEY, epoch INTEGER, gmail_read INTEGER); INSERT INTO config VALUES(1,7,0);'
        )
        conn.close()
        self.assertTrue(all(mode == 'auto' for mode in policy.inspect_rules()['rules'].values()))
        policy.set_mode('gmail', 'ask')
        self.assertEqual(policy.inspect_rules()['rules']['gmail'], 'ask')
        self.assertEqual(policy.inspect_rules()['rules']['inference'], 'auto')

    def test_policy_reads_do_not_require_a_write_lock(self):
        import sqlite3

        policy.inspect_rules()
        conn = sqlite3.connect(policy.DATABASE)
        try:
            conn.execute('BEGIN IMMEDIATE')
            self.assertEqual(policy.inspect_rules()['rules']['gmail'], 'auto')
            policy.inspect()
            policy.inspect_audit()
        finally:
            conn.close()

    def issued(self):
        policy.set_mode('gmail', 'ask')
        request = policy.authorize(self.action, 'gmail')
        policy.decide(request['approval_id'], 'APPROVED', request['digest'])
        return policy.authorize(self.action, 'gmail')

    def consume(self, grant, action=None):
        return policy.consume(action or self.action, 'gmail', grant['grant_id'], grant['ticket'])

    def test_ciphertext_and_random_nonce(self):
        auth.write('tokens.json', {'access_token': 'CANARY_PLAINTEXT'})
        first = (self.root / 'tokens.json.enc').read_text()
        self.assertNotIn('CANARY_PLAINTEXT', first)
        self.assertFalse((self.root / 'tokens.json').exists())
        auth.write('tokens.json', {'access_token': 'CANARY_PLAINTEXT'})
        self.assertNotEqual(first, (self.root / 'tokens.json.enc').read_text())
        self.assertEqual(auth.read('tokens.json')['access_token'], 'CANARY_PLAINTEXT')

    def test_wrong_key_and_tampering(self):
        auth.write('tokens.json', {'access_token': 'x'})
        master = self.key.read_bytes()
        self.key.write_bytes(os.urandom(32))
        with self.assertRaisesRegex(Denied, 'VAULT_INTEGRITY_ERROR'):
            auth.read('tokens.json')
        self.key.write_bytes(master)
        envelope = json.loads((self.root / 'tokens.json.enc').read_text())
        envelope['ciphertext'] = 'AAAA'
        (self.root / 'tokens.json.enc').write_text(json.dumps(envelope))
        with self.assertRaisesRegex(Denied, 'VAULT_INTEGRITY_ERROR'):
            auth.read('tokens.json')

    def test_aad_prevents_credential_substitution(self):
        auth.write('tokens.json', {'access_token': 'x'})
        (self.root / 'client.json.enc').write_bytes((self.root / 'tokens.json.enc').read_bytes())
        with self.assertRaisesRegex(Denied, 'VAULT_INTEGRITY_ERROR'):
            auth.read('client.json')

    def test_lock_has_no_plaintext_fallback(self):
        auth.write('tokens.json', {'access_token': 'x'})
        (self.root / 'tokens.json').write_text('{"access_token":"legacy"}')
        self.key.unlink()
        with self.assertRaisesRegex(Denied, 'VAULT_LOCKED'):
            auth.read('tokens.json')

    def test_revoke_locally_first_and_retry(self):
        auth.write('tokens.json', {'access_token': 'ACCESS', 'refresh_token': 'REFRESH'})

        def fail(*args):
            self.assertFalse(vault.exists(self.root, 'tokens.json'))
            raise TimeoutError()

        with patch('auth.google_json', side_effect=fail):
            self.assertTrue(auth.disconnect('gmail')['revocation_pending'])
        with patch('auth.google_json', return_value={}) as revoke:
            self.assertTrue(auth.disconnect('gmail')['remote_revoked'])
            self.assertEqual(revoke.call_args.args[2], '/revoke')
        self.assertFalse(vault.exists(self.root, 'revocation.json'))

    def test_approval_requires_exact_digest(self):
        policy.set_mode('gmail', 'ask')
        pending = policy.authorize(self.action, 'gmail')
        self.assertEqual(pending['decision'], 'ask')
        with self.assertRaisesRegex(Denied, 'DIGEST_OR_STATE'):
            policy.decide(pending['approval_id'], 'APPROVED', 'forged')
        with self.assertRaisesRegex(Denied, 'OPERATION_DENIED'):
            policy.handle({'op': 'approve'}, 'gmail')

    def test_modified_request_and_replay(self):
        grant = self.issued()
        altered = copy.deepcopy(self.action)
        altered['params']['query'] = 'secret'
        with self.assertRaises(Denied):
            self.consume(grant, altered)
        self.assertTrue(self.consume(grant)['allowed'])
        with self.assertRaises(Denied):
            self.consume(grant)
        self.assertEqual(policy.authorize(self.action, 'gmail')['decision'], 'ask')

    def test_account_and_principal_binding(self):
        grant = self.issued()
        altered = {**self.action, 'account': 'different-account'}
        with self.assertRaises(Denied):
            self.consume(grant, altered)
        with self.assertRaises(Denied):
            policy.consume(self.action, 'inference', grant['grant_id'], grant['ticket'])

    def test_expired_revoked_and_boot_invalid(self):
        for mode in ('expiry', 'revoke', 'boot', 'epoch'):
            with self.subTest(mode=mode):
                self.action['params']['query'] = mode
                grant = self.issued()
                if mode == 'expiry':
                    with policy.database() as conn:
                        conn.execute('UPDATE grants SET expires=0 WHERE id=?', (grant['grant_id'],))
                elif mode == 'revoke':
                    policy.decide(grant['grant_id'], 'REVOKED')
                elif mode == 'boot':
                    policy.BOOT_ID.write_text('another-boot')
                else:
                    policy.set_read('gmail', False)
                with self.assertRaises(Denied):
                    self.consume(grant)

    def test_concurrent_consumption_only_one_wins(self):
        grant = self.issued()

        def attempt(_):
            try:
                return self.consume(grant)['allowed']
            except Denied:
                return False

        with ThreadPoolExecutor(max_workers=4) as pool:
            self.assertEqual(sum(pool.map(attempt, range(4))), 1)

    def test_auto_read_does_not_allow_write_or_model(self):
        policy.set_read('gmail', True)
        self.assertEqual(policy.authorize(self.action, 'gmail')['decision'], 'allow')
        with self.assertRaises(Denied):
            policy.authorize({**self.action, 'operation': 'gmail.send'}, 'gmail')
        with self.assertRaises(Denied):
            policy.authorize(self.action, 'inference')

    def test_audit_readout_is_bounded_metadata(self):
        grant = self.issued()
        self.consume(grant)
        rows = policy.inspect_audit(10)['audit']
        self.assertEqual(
            [r['event'] for r in reversed(rows)],
            ['RULE_GMAIL_ASK', 'REQUESTED', 'APPROVED', 'ISSUED_APPROVED', 'CONSUMED'],
        )
        self.assertEqual(set(rows[0]), {'id', 'at', 'event', 'grant_id', 'digest'})
        self.assertNotIn('in:inbox', json.dumps(rows))
        self.assertEqual(len(policy.inspect_audit(2)['audit']), 2)
        for limit in (0, 501, '10', True):
            with self.assertRaisesRegex(Denied, 'BAD_LIMIT'):
                policy.inspect_audit(limit)

    def test_standing_authorization_is_default_and_ask_mode_falls_back_to_approval(self):
        search = {'operation': 'drive.search', 'account': 'g', 'params': {'query': 'plan', 'limit': 3}}
        create = {
            'operation': 'drive.create',
            'account': 'g',
            'params': {'parent_id': 'root', 'name': 'a.txt', 'mime_type': 'text/plain', 'text': 'hi'},
        }
        model = {
            'operation': 'inference.openai',
            'account': 'gen',
            'params': {
                'model': 'm',
                'instructions': 'i',
                'input': [],
                'max_output_tokens': 1,
                'store': False,
                'tools': [],
                'stream': False,
            },
        }
        # Connected means authorized: reads, writes and model calls issue grants without a human.
        self.assertEqual(policy.authorize(search, 'drive')['decision'], 'allow')
        self.assertEqual(policy.authorize(create, 'drive')['decision'], 'allow')
        self.assertEqual(policy.authorize(model, 'inference')['decision'], 'allow')
        self.assertEqual(policy.inspect_rules()['rules'], {p: 'auto' for p in policy.PRINCIPALS})
        # Switching a principal to ask mode revokes outstanding grants and requires approval again.
        issued = policy.authorize(create, 'drive')
        policy.set_mode('drive', 'ask')
        with self.assertRaises(Denied):
            policy.consume(create, 'drive', issued['grant_id'], issued['ticket'])
        self.assertEqual(policy.authorize(create, 'drive')['decision'], 'ask')
        self.assertEqual(policy.authorize(search, 'drive')['decision'], 'ask')
        self.assertEqual(policy.authorize(model, 'inference')['decision'], 'allow')
        policy.set_mode('inference', 'ask')
        self.assertEqual(policy.authorize(model, 'inference')['decision'], 'ask')
        self.assertEqual(policy.inspect_rules()['rules']['inference'], 'ask')
        with self.assertRaises(Denied):
            policy.authorize(search, 'notion')
        with self.assertRaises(Denied):
            policy.authorize({**search, 'operation': 'drive.delete'}, 'drive')
        for bad in (('bogus', 'auto'), ('drive', 'maybe')):
            with self.assertRaises(Denied):
                policy.set_mode(*bad)
        # Legacy alias keeps working.
        policy.set_read('drive', True)
        self.assertEqual(policy.authorize(search, 'drive')['decision'], 'allow')

    def test_absent_rule_means_standing_authorization_regardless_of_legacy_column(self):
        with policy.database() as conn:
            conn.execute('UPDATE config SET gmail_read=0 WHERE id=1')
            conn.execute('DELETE FROM rules')
        self.assertEqual(policy.inspect_rules()['rules']['gmail'], 'auto')
        self.assertEqual(policy.authorize(self.action, 'gmail')['decision'], 'allow')

    def test_target_file_expiry_and_private_addresses(self):
        target = self.root / 'targets.json'
        for address, expires in [('127.0.0.1', time.time() + 60), ('::1', time.time() + 60), ('1.1.1.1', 0)]:
            target.write_text(json.dumps({'test': {'addresses': [address], 'expires_at': expires}}))
            with self.assertRaisesRegex(Denied, 'EGRESS_TARGETS_UNAVAILABLE'):
                target_ips('test')
        target.write_text(json.dumps({'test': {'addresses': ['1.1.1.1'], 'expires_at': time.time() + 60}}))
        self.assertEqual(target_ips('test'), ['1.1.1.1'])
