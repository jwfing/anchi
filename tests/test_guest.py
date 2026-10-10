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


class AuditRowsTests(unittest.TestCase):
    def test_reads_one_task_across_rotated_files_newest_last(self):
        import json
        import tempfile

        tmp = Path(tempfile.mkdtemp())
        old, cur = tmp / 'audit.jsonl.1', tmp / 'audit.jsonl'
        row = lambda task, n: json.dumps({'task': task, 'n': n, 'host': 'h'}, sort_keys=True)  # noqa: E731
        old.write_text('\n'.join([row('t-a', 1), row('t-b', 2), 'not json', row('t-a', 3)]) + '\n')
        cur.write_text('\n'.join([row('t-a', 4), row('t-ab', 5)]) + '\n')
        found = anchi_cell.audit_rows('t-a', [old, cur, tmp / 'missing'])
        self.assertEqual([r['n'] for r in found['rows']], [1, 3, 4])
        self.assertEqual((found['total'], found['truncated']), (3, False))
        limited = anchi_cell.audit_rows('t-a', [old, cur], limit=2)
        self.assertEqual(([r['n'] for r in limited['rows']], limited['truncated']), ([3, 4], True))


class AccountArgumentTests(unittest.TestCase):
    def test_accounts_name_google_services_of_the_agent_only(self):
        self.assertEqual(anchi_cell.parse_accounts('-', ['gmail']), {})
        self.assertEqual(
            anchi_cell.parse_accounts('gmail=work,drive=personal', ['gmail', 'drive']),
            {'gmail': 'work', 'drive': 'personal'},
        )
        for arg, connectors in (
            ('gmail=work', ['drive']),
            ('notion=work', ['notion']),
            ('gmail=Work', ['gmail']),
            ('gmail=', ['gmail']),
            ('gmail=a,gmail=b', ['gmail']),
            ('gmail', ['gmail']),
        ):
            with self.assertRaises(anchi_cell.Failure):
                anchi_cell.parse_accounts(arg, connectors)
