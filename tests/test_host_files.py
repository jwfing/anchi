import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('host_files', Path(__file__).resolve().parents[1] / 'scripts/host-files.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class HostFilesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        st = self.root.stat()
        self.grant = {'path': str(self.root), 'mode': 'rw', 'identity': [str(st.st_dev), str(st.st_ino)]}
    def run_op(self, op, path='', **extra):
        return module.operate({'grant': self.grant, 'request': {'op': op, 'path': path, **extra}})
    def test_lifecycle(self):
        self.run_op('mkdir', 'output')
        self.run_op('write', 'output/report.txt', text='你好')
        self.assertEqual(self.run_op('read', 'output/report.txt'), {'text': '你好'})
        self.assertEqual(self.run_op('list')['entries'][0]['name'], 'output')
        self.run_op('write', 'output/report.txt', text='replacement')
        self.run_op('delete', 'output/report.txt')
        self.assertFalse((self.root / 'output/report.txt').exists())
    def test_read_only_blocks_mutations(self):
        self.grant['mode'] = 'ro'
        for op in ('write','mkdir','delete'):
            with self.assertRaisesRegex(ValueError, 'READ_ONLY'):
                self.run_op(op, 'x', text='x')
    def test_escape_links_hidden_and_special_files(self):
        (self.root / 'link').symlink_to('/etc')
        (self.root / 'file').write_text('x')
        os.link(self.root / 'file', self.root / 'hard')
        os.mkfifo(self.root / 'pipe')
        for target in ('../escape', '/etc/passwd', 'link/passwd', '.env', 'hard', 'pipe'):
            with self.assertRaises((ValueError, OSError)):
                self.run_op('read', target)
    def test_identity_and_limits(self):
        with self.assertRaisesRegex(ValueError, 'FILE_TOO_LARGE'):
            self.run_op('write', 'big', text='x' * 24001)
        self.grant['identity'][1] = '0'
        with self.assertRaisesRegex(ValueError, 'DIRECTORY_CHANGED'):
            self.run_op('list')
