"""scripts/vm-name.sh: the VM name check and the move from secure-vm, against a fake limactl."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts/vm-name.sh'

# Records each call; `list` prints the instances in $FAKE_VMS ("name status" per line), and
# stop/rename/start update them. `shell … anchi-cell list` reports no cells.
FAKE_LIMACTL = r"""#!/bin/bash
echo "$*" >>"$FAKE_LOG"
case $1 in
  list) cat "$FAKE_VMS" ;;
  stop) sed -i.bak "s/^$2 .*/$2 Stopped/" "$FAKE_VMS" ;;
  rename) sed -i.bak "s/^$2 /$3 /" "$FAKE_VMS" ;;
  start) sed -i.bak "s/^$3 .*/$3 Running/" "$FAKE_VMS" ;;
  shell) echo '{"cells": []}' ;;
esac
"""


class VmNameTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.home = self.tmp / 'home'
        self.home.mkdir()
        bin_dir = self.tmp / 'bin'
        bin_dir.mkdir()
        (bin_dir / 'limactl').write_text(FAKE_LIMACTL)
        (bin_dir / 'limactl').chmod(0o755)
        # vault.py stands in for the real one: it must not reach a VM either.
        python = subprocess.run(['sh', '-c', 'command -v python3'], capture_output=True, text=True).stdout.strip()
        (bin_dir / 'python3').write_text(
            f'#!/bin/sh\ncase $1 in *vault.py) echo "vault $*" >>"$FAKE_LOG"; exit 0 ;; esac\nexec {python} "$@"\n'
        )
        (bin_dir / 'python3').chmod(0o755)
        self.vms = self.tmp / 'vms'
        self.log = self.tmp / 'log'
        self.log.write_text('')
        self.env = {
            'HOME': str(self.home),
            'PATH': f'{bin_dir}:/usr/bin:/bin',
            'FAKE_VMS': str(self.vms),
            'FAKE_LOG': str(self.log),
        }

    def run_script(self, *args, **env):
        return subprocess.run(['bash', str(SCRIPT), *args], env={**self.env, **env}, capture_output=True, text=True)

    def calls(self):
        return [c for c in self.log.read_text().splitlines() if c]

    def test_names(self):
        self.assertEqual(self.run_script('name').stdout.strip(), 'anchi-vm')
        self.assertEqual(self.run_script('name', ANCHI_INSTALL_VM='anchi-vm-ci').stdout.strip(), 'anchi-vm-ci')
        refused = self.run_script('name', ANCHI_INSTALL_VM='secure-vm')
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn('anchi-vm', refused.stderr)

    def test_renames_a_running_secure_vm_restarts_it_and_unlocks_the_vault(self):
        self.vms.write_text('secure-vm Running\nother Running\n')
        old_key = self.home / '.config/secure-vm/vault.key'
        old_key.parent.mkdir(parents=True)
        old_key.write_bytes(b'k' * 32)
        old_key.chmod(0o600)
        result = self.run_script('migrate')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.vms.read_text(), 'anchi-vm Running\nother Running\n')
        calls = self.calls()
        self.assertEqual(
            [c for c in calls if c.split()[0] in ('stop', 'rename', 'start', 'vault')],
            [
                'stop secure-vm',
                'rename secure-vm anchi-vm',
                'start --tty=false anchi-vm',
                f'vault {ROOT}/scripts/vault.py unlock',
            ],
        )
        new_key = self.home / '.config/anchi/vault.key'
        self.assertEqual(new_key.read_bytes(), b'k' * 32)
        self.assertEqual(new_key.stat().st_mode & 0o777, 0o600)
        self.assertFalse(old_key.parent.exists())
        # A second run has nothing to do.
        self.log.write_text('')
        self.assertEqual(self.run_script('migrate').returncode, 0)
        self.assertEqual(self.calls(), ['list --format {{.Name}} {{.Status}}'])

    def test_a_stopped_vm_is_renamed_without_starting_it(self):
        self.vms.write_text('secure-vm Stopped\n')
        self.assertEqual(self.run_script('migrate').returncode, 0)
        self.assertEqual(self.vms.read_text(), 'anchi-vm Stopped\n')
        self.assertFalse([c for c in self.calls() if c.startswith(('start', 'stop', 'vault'))])

    def test_never_replaces_an_existing_vm_or_key(self):
        self.vms.write_text('secure-vm Stopped\nanchi-vm Running\n')
        for name in ('secure-vm', 'anchi'):
            key = self.home / '.config' / name / 'vault.key'
            key.parent.mkdir(parents=True)
            key.write_text(name)
        result = self.run_script('migrate')
        self.assertEqual(result.returncode, 0)
        self.assertIn('Both Lima VMs', result.stderr)
        self.assertEqual(self.vms.read_text(), 'secure-vm Stopped\nanchi-vm Running\n')
        self.assertEqual((self.home / '.config/anchi/vault.key').read_text(), 'anchi')
        self.assertEqual((self.home / '.config/secure-vm/vault.key').read_text(), 'secure-vm')

    def test_refuses_while_task_cells_run(self):
        self.vms.write_text('secure-vm Running\n')
        fake = self.tmp / 'bin/limactl'
        fake.write_text(
            fake.read_text().replace(
                """shell) echo '{"cells": []}' ;;""",
                """shell) echo '{"cells": [{"task": "t-1", "active": true}]}' ;;""",
            )
        )
        result = self.run_script('migrate', PATH=f'{self.tmp / "bin"}:{os.environ["PATH"]}')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('t-1', result.stderr)
        self.assertEqual(self.vms.read_text(), 'secure-vm Running\n')


if __name__ == '__main__':
    unittest.main()
