import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('anchi_cell', Path(__file__).parents[1] / 'guest' / 'anchi_cell.py')
anchi_cell = importlib.util.module_from_spec(spec)
spec.loader.exec_module(anchi_cell)

MOUNTINFO = '\n'.join(
    [
        '22 1 254:1 / / rw,relatime - ext4 /dev/vda1 rw',
        '40 22 0:35 / /var/lib/anchi/agents/dev/home/workspaces/w rw - virtiofs mount0 rw',
        r'41 22 0:36 / /var/lib/anchi/agents/my\040agent rw - tmpfs tmpfs rw',
        '42 22 0:37 / /var/lib/anchi/agents/developer rw - tmpfs tmpfs rw',
        'short line',
    ]
)


class PurgeGuardTests(unittest.TestCase):
    def test_finds_mounts_at_or_below_a_path_only(self):
        self.assertEqual(
            anchi_cell.mounts_under(Path('/var/lib/anchi/agents/dev'), MOUNTINFO),
            ['/var/lib/anchi/agents/dev/home/workspaces/w'],
        )
        # A sibling sharing the prefix is not below the path; escapes are decoded.
        self.assertEqual(anchi_cell.mounts_under(Path('/var/lib/anchi/agents/dev/'), MOUNTINFO)[0][-1], 'w')
        self.assertEqual(
            anchi_cell.mounts_under(Path('/var/lib/anchi/agents/my agent'), MOUNTINFO),
            ['/var/lib/anchi/agents/my agent'],
        )
        self.assertEqual(anchi_cell.mounts_under(Path('/var/lib/anchi/agents/ops'), MOUNTINFO), [])


if __name__ == '__main__':
    unittest.main()
