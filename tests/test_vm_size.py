"""scripts/vm-size.sh: the size of a new VM, half of the host's unless the user picks another."""

import os
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]


def vm_size(host_cpus, host_gib, **env):
    full = {k: v for k, v in os.environ.items() if not k.startswith('ANCHI_VM_')}
    full.update(env)
    return subprocess.run(
        [
            'bash',
            '-c',
            'source scripts/vm-size.sh && anchi_vm_size "$1" "$2"',
            'vm-size',
            str(host_cpus),
            str(host_gib),
        ],
        cwd=ROOT,
        env=full,
        capture_output=True,
        text=True,
    )


class VmSizeTests(unittest.TestCase):
    def test_default_is_half_of_the_host(self):
        self.assertEqual(vm_size(10, 24).stdout.split(), ['5', '12'])
        self.assertEqual(vm_size(1, 3).stdout.split(), ['1', '2'])

    def test_the_user_picks_another_size(self):
        r = vm_size(10, 24, ANCHI_VM_CPUS='8', ANCHI_VM_MEMORY_GIB='20')
        self.assertEqual(r.stdout.split(), ['8', '20'])

    def test_refuses_values_that_are_not_whole_numbers_or_exceed_the_host(self):
        for env in (
            {'ANCHI_VM_CPUS': '11'},
            {'ANCHI_VM_CPUS': '0'},
            {'ANCHI_VM_CPUS': '2.5'},
            {'ANCHI_VM_MEMORY_GIB': '25'},
            {'ANCHI_VM_MEMORY_GIB': '1'},
            # Arithmetic on this string would run the command substitution.
            {'ANCHI_VM_CPUS': 'a[$(touch /tmp/anchi-vm-size-probe)]'},
        ):
            r = vm_size(10, 24, **env)
            self.assertNotEqual(r.returncode, 0, env)
            self.assertEqual(r.stdout, '', env)
            self.assertIn('Invalid', r.stderr, env)
        self.assertFalse(Path('/tmp/anchi-vm-size-probe').exists())

    def test_up_creates_the_vm_with_that_size_only(self):
        text = (ROOT / 'scripts/up.sh').read_text()
        create = next(line for line in text.splitlines() if '--name="$vm_name"' in line)
        self.assertIn('--cpus="$vm_cpus" --memory="$vm_gib"', create)
        # Starting an existing VM keeps its size.
        self.assertIn('limactl start --tty=false "$vm_name"\n', text)


if __name__ == '__main__':
    unittest.main()
