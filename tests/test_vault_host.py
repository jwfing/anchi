"""Host vault commands use temporary keys and a fake VM, never the user's vault."""

import base64
import importlib.util
import io
import os
from pathlib import Path
import stat
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('host_vault', ROOT / 'scripts/vault.py')
host_vault = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host_vault)


class HostVaultTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.key = self.root / 'config/vault.key'

    def run_command(self, action, remote):
        output = io.StringIO()
        with (
            patch.dict(os.environ, {'ANCHI_VM_MIGRATING': '1'}),
            patch('sys.argv', ['vault.py', action, '--key-file', str(self.key)]),
            patch.object(host_vault, 'remote', remote),
            redirect_stdout(output),
        ):
            host_vault.main()
        return output.getvalue()

    def test_unlock_missing_key_gives_recovery_steps_without_creating_or_sending_a_key(self):
        with patch.object(host_vault, 'remote') as remote:
            with self.assertRaisesRegex(SystemExit, 'VAULT_KEY_MISSING.*setup vault init.*Restore'):
                self.run_command('unlock', remote)
            remote.assert_not_called()
        self.assertFalse(self.key.exists())

    def test_init_refuses_a_replacement_key_over_encrypted_credentials(self):
        with patch.object(host_vault, 'remote', return_value={'encrypted_files': 1}) as remote:
            with self.assertRaisesRegex(SystemExit, 'Restore the original master key'):
                self.run_command('init', remote)
            remote.assert_called_once_with('status')
        self.assertFalse(self.key.exists())

    def test_unlock_refuses_symlinks_permissions_directories_and_pipes(self):
        self.key.parent.mkdir()
        target = self.root / 'original'
        target.write_bytes(b'f' * 32)
        self.key.symlink_to(target)
        self.assert_bad_key()
        self.key.unlink()
        self.key.write_bytes(b'f' * 32)
        self.key.chmod(0o644)
        self.assert_bad_key()
        self.key.unlink()
        self.key.mkdir()
        self.assert_bad_key()
        self.key.rmdir()
        os.mkfifo(self.key, 0o600)
        self.assert_bad_key()
        self.assertEqual(target.read_bytes(), b'f' * 32)

    def assert_bad_key(self):
        with patch.object(host_vault, 'remote') as remote:
            with self.assertRaisesRegex(SystemExit, 'Key file'):
                self.run_command('unlock', remote)
            remote.assert_not_called()

    def test_init_creates_a_private_key_only_for_an_empty_vault_and_keeps_it_on_retry(self):
        with patch.object(host_vault, 'remote') as remote:
            remote.side_effect = [{'encrypted_files': 0}, {'unlocked': True}]
            output = self.run_command('init', remote)
            self.assertEqual(remote.call_args_list[0].args, ('status',))
            master = self.key.read_bytes()
            self.assertEqual(len(master), 32)
            self.assertEqual(stat.S_IMODE(self.key.stat().st_mode), 0o600)
            encoded = base64.b64encode(master).decode()
            remote.assert_called_with('unlock', {'key': encoded})
            self.assertNotIn(encoded, output)
            remote.reset_mock(side_effect=True)
            remote.return_value = {'unlocked': True}
            self.run_command('init', remote)
            remote.assert_called_once_with('unlock', {'key': encoded})
            self.assertEqual(self.key.read_bytes(), master)
