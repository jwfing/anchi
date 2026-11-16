import importlib.util
import json
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


class StartCommandTests(unittest.TestCase):
    def test_start_takes_the_high_risk_argument_and_checks_it(self):
        from unittest.mock import patch

        seen = []
        args = ['anchi-cell', 'start', 't-1', 'dev', 'codex', 'base', 'github', 'cell', 'codex', '-', '-', '-']
        with (
            patch.object(anchi_cell.os, 'getuid', lambda: 0),
            patch.object(anchi_cell, 'cell_start', lambda *a: seen.append(a)),
        ):
            anchi_cell.main(args)
            anchi_cell.main([*args, 'github-merge'])
            anchi_cell.main([*args, '-', 'x'])
            with self.assertRaises(anchi_cell.Failure):
                anchi_cell.main([*args, 'github-merge', 'x', 'extra'])
        self.assertEqual([len(a) for a in seen], [10, 11, 12])
        self.assertEqual(seen[1][-1], 'github-merge')
        self.assertEqual(seen[2][-1], 'x')
        with self.assertRaises(anchi_cell.Failure) as refused:
            anchi_cell.cell_start('t-1', 'dev', 'codex', 'base', 'github', 'cell', 'codex', '-', '-', '-', 'a b')
        self.assertEqual(str(refused.exception), 'BAD_HIGH_RISK')

    def test_auto_names_only_x_or_reddit_of_the_agent_that_do_not_ask(self):
        for connectors, ask, auto in (
            ('notion', '-', 'notion'),
            ('github,x', '-', 'github'),
            ('reddit', '-', 'x'),
            ('x', 'x', 'x'),
            ('x,reddit', '-', 'x,x'),
            ('x', '-', 'X'),
        ):
            with self.subTest(auto=auto), self.assertRaises(anchi_cell.Failure) as refused:
                anchi_cell.cell_start(
                    't-1', 'dev', 'codex', 'base', connectors, 'cell', 'codex', ask, '-', '-', '-', auto
                )
            self.assertEqual(str(refused.exception), 'BAD_APPROVALS')

    def test_policy_rules_follow_the_agent_approvals(self):
        from types import SimpleNamespace
        from unittest.mock import patch

        rules = {'x': 'ask', 'reddit': 'ask', 'notion': 'auto', 'x:dev': 'ask', 'notion:dev': 'ask'}
        calls = []

        def run(*argv, **_):
            calls.append(argv[2:])
            return SimpleNamespace(stdout=json.dumps({'rules': rules}))

        with patch.object(anchi_cell, 'run', run):
            anchi_cell.sync_policy_modes('dev', ['x', 'reddit', 'notion'], [], ['x', 'reddit'])
        self.assertEqual(
            calls, [('rules',), ('mode', 'x:dev', 'auto'), ('mode', 'reddit:dev', 'auto'), ('clear', 'notion:dev')]
        )
        calls.clear()
        rules.update({'x:dev': 'auto'})
        with patch.object(anchi_cell, 'run', run):
            anchi_cell.sync_policy_modes('dev', ['x'], [], ['x'])
            anchi_cell.sync_policy_modes('dev', ['x'], ['x'])
            anchi_cell.sync_policy_modes('dev', ['x'], [])
        self.assertEqual(calls, [('rules',), ('rules',), ('mode', 'x:dev', 'ask'), ('rules',), ('clear', 'x:dev')])


class GitIdentityTests(unittest.TestCase):
    GITHUB = {'github_login': 'octo', 'github_id': 42, 'github_name': 'Octo Cat'}

    def env(self, connectors, identifiers):
        return anchi_cell.cell_environment('t1', 'dev', connectors, {'claude_kind': 'oauth', **identifiers})

    def test_commits_are_authored_by_the_linked_github_account_and_committed_by_the_agent(self):
        env = self.env(['github'], self.GITHUB)
        self.assertEqual(env['GIT_AUTHOR_NAME'], 'Octo Cat')
        self.assertEqual(env['GIT_AUTHOR_EMAIL'], '42+octo@users.noreply.github.com')
        self.assertEqual(env['GIT_COMMITTER_NAME'], 'dev (Anchi agent)')
        self.assertEqual(env['GIT_COMMITTER_EMAIL'], 'dev@agents.anchi.invalid')

    def test_without_the_github_grant_the_agent_authors_its_commits(self):
        env = self.env([], self.GITHUB)
        self.assertEqual(env['GIT_AUTHOR_NAME'], 'dev (Anchi agent)')
        self.assertEqual(env['GIT_AUTHOR_EMAIL'], 'dev@agents.anchi.invalid')

    def test_an_identity_that_could_change_the_command_line_is_not_used(self):
        """The values become --setenv arguments of systemd-run; the proxy checks them, and so do we."""
        for bad in (
            {'github_login': '$(id)'},
            {'github_login': 'oc to'},
            {'github_login': 'a' * 40},
            {'github_id': '42'},
            {'github_id': True},
            {'github_id': 0},
            {'github_name': 'A\nB'},
            {'github_name': 'x ${HOME}'},
            {'github_name': 'x %h'},
            {'github_name': '<x>'},
            {'github_name': 'a\u202eb'},
            {'github_name': ''},
            {'github_name': 'n' * 101},
            {'github_name': None},
        ):
            env = self.env(['github'], {**self.GITHUB, **bad})
            self.assertEqual(env['GIT_AUTHOR_EMAIL'], 'dev@agents.anchi.invalid', bad)
            self.assertEqual(env['GIT_AUTHOR_NAME'], 'dev (Anchi agent)', bad)


class BaseImageTests(unittest.TestCase):
    def test_downloads_count_as_busy_before_a_build_cell_exists(self):
        import fcntl
        import tempfile
        from unittest.mock import patch

        with tempfile.TemporaryDirectory() as tmp, patch.object(anchi_cell, 'LAYERS', Path(tmp)):
            self.assertFalse(anchi_cell.image_busy())
            with (Path(tmp) / '.build.lock').open('a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                self.assertTrue(anchi_cell.image_busy())
                with patch.object(anchi_cell, 'cell_metas', return_value=[]), patch.object(anchi_cell, 'emit') as emit:
                    anchi_cell.cell_list()
                    self.assertEqual(emit.call_args.args[0]['cells'][0]['active'], True)
            self.assertFalse(anchi_cell.image_busy())

    def test_cached_base_does_not_accept_a_forged_runtime_hash(self):
        with self.assertRaisesRegex(anchi_cell.Failure, 'BAD_HASH'):
            anchi_cell.image_build('codex', 'runtime')

    def test_a_changed_build_script_or_runtime_pin_is_a_new_base(self):
        import tempfile
        from unittest.mock import patch

        root = Path(__file__).parents[1] / 'guest'
        with tempfile.TemporaryDirectory() as tmp:
            lib = Path(tmp)
            (lib / 'build-base.sh').write_bytes((root / 'anchi-build-base.sh').read_bytes())
            with patch.object(anchi_cell, 'LIB', lib), patch.object(anchi_cell, 'CELL_ENV', root / 'cell.env'):
                first = anchi_cell.base_version()
                self.assertRegex(first, r'^base-[0-9a-f]{12}$')
                (lib / 'build-base.sh').write_text('#!/bin/sh\necho changed\n')
                self.assertNotEqual(anchi_cell.base_version(), first)

    def test_the_build_script_reads_only_pins_from_cell_env(self):
        script = (Path(__file__).parents[1] / 'guest' / 'anchi-build-base.sh').read_text()
        env = (Path(__file__).parents[1] / 'guest' / 'cell.env').read_text()
        used = set(__import__('re').findall(r'\$\{?(ANCHI_[A-Z0-9_]+)', script))
        self.assertTrue({'ANCHI_GO_VERSION', 'ANCHI_RUST_VERSION', 'ANCHI_PNPM_VERSION'} <= used)
        for name in used:
            self.assertRegex(env, rf'(?m)^{name}=\S+$', name)


class RuntimeLayerTests(unittest.TestCase):
    """Each runtime is a layer of its own over the base, stacked above an agent's recipe."""

    def setUp(self):
        import json
        import tempfile
        from unittest.mock import patch

        self.json = json
        root = Path(__file__).parents[1] / 'guest'
        self.tmp = Path(tempfile.mkdtemp())
        self.lib = self.tmp / 'lib'
        self.lib.mkdir()
        (self.lib / 'build-base.sh').write_bytes((root / 'anchi-build-base.sh').read_bytes())
        for runtime in ('codex', 'claude-code', 'hermes'):
            name = f'build-runtime-{runtime}.sh'
            (self.lib / name).write_bytes((root / f'anchi-{name}').read_bytes())
        self.env = self.tmp / 'cell.env'
        self.env.write_text((root / 'cell.env').read_text())
        for patcher in (
            patch.object(anchi_cell, 'LIB', self.lib),
            patch.object(anchi_cell, 'CELL_ENV', self.env),
            patch.object(anchi_cell, 'LAYERS', self.tmp / 'layers'),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def built(self, image, digest):
        layer = anchi_cell.layer_dir(image, digest)
        (layer / 'upper').mkdir(parents=True)
        (layer / 'meta.json').write_text(self.json.dumps({'ok': True, 'base': anchi_cell.base_version()}))
        return layer / 'upper'

    def test_layers_stack_runtime_over_recipe_over_base(self):
        base = self.built('codex', 'base')
        with self.assertRaises(anchi_cell.Failure) as missing:
            anchi_cell.lowerdirs('codex', 'base', 'hermes')
        self.assertEqual(str(missing.exception), 'RUNTIME_IMAGE_NOT_BUILT')
        hermes = self.built('runtime-hermes', 'runtime')
        recipe = self.built('node', 'a' * 16)
        self.assertEqual(
            anchi_cell.lowerdirs('node', 'a' * 16, 'hermes').split(':'),
            [str(hermes), str(recipe), str(base), str(anchi_cell.BASE)],
        )
        self.assertEqual(anchi_cell.lowerdirs('codex', 'base').split(':'), [str(base), str(anchi_cell.BASE)])

    def test_a_pin_names_a_new_layer_of_the_runtime_that_reads_it(self):
        hermes = anchi_cell.layer_dir('runtime-hermes', 'runtime')
        codex = anchi_cell.layer_dir('runtime-codex', 'runtime')
        base = anchi_cell.base_version()
        self.env.write_text(self.env.read_text().replace('ANCHI_HERMES_VERSION=', 'ANCHI_HERMES_VERSION=9'))
        self.assertNotEqual(anchi_cell.layer_dir('runtime-hermes', 'runtime'), hermes)
        self.assertEqual(anchi_cell.layer_dir('runtime-codex', 'runtime'), codex)
        self.assertEqual(anchi_cell.base_version(), base)
        # A new base is a new layer for every runtime built on it.
        (self.lib / 'build-base.sh').write_text('#!/bin/sh\necho changed\n')
        self.assertNotEqual(anchi_cell.layer_dir('runtime-codex', 'runtime'), codex)

    def test_runtime_layers_are_built_from_their_script_and_cannot_be_removed(self):
        for image, digest in (('runtime-hermes', 'base'), ('codex', 'runtime'), ('node', 'runtime')):
            with self.assertRaises(anchi_cell.Failure, msg=(image, digest)):
                anchi_cell.image_build(image, digest)
        with self.assertRaises(anchi_cell.Failure) as removed:
            anchi_cell.image_remove('runtime-codex')
        self.assertEqual(str(removed.exception), 'BASE_IMAGE_PROTECTED')

    def test_runtime_build_scripts_never_use_apt(self):
        for runtime in ('codex', 'claude-code', 'hermes'):
            script = (self.lib / f'build-runtime-{runtime}.sh').read_text()
            self.assertNotIn('apt-get', script, runtime)
            self.assertIn('sha256sum -c', script, runtime)


class LiveCheckOverlayTests(unittest.TestCase):
    """The live start-up measurement runs on the overlay a Codex cell gets. Layer names follow
    the build scripts and their pins, so the check asks the manager for them."""

    def setUp(self):
        guest = Path(__file__).parents[1] / 'guest'
        self.guest = guest
        spec = importlib.util.spec_from_file_location('check_anchi', guest / 'check-anchi.py')
        self.check = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.check)

    def test_the_overlay_comes_from_the_manager_not_a_layer_path(self):
        script = (self.guest / 'check-anchi.py').read_text()
        self.assertIn("lowerdirs(cell.BASE_IMAGE, 'base', runtime='codex')", script)
        self.assertNotIn(str(anchi_cell.LAYERS), script)

    def test_the_manager_is_where_the_installer_puts_it(self):
        install = (self.guest / 'install-anchi.sh').read_text()
        self.assertIn(f'"$src/anchi_cell.py" {self.check.MANAGER}', install)


class InstalledVersionTests(unittest.TestCase):
    """`anchi-cell version` tells the daemon which Anchi installed the guest, so it can ask for
    `anchi setup install` after an update instead of failing tasks against an older guest."""

    def test_reports_the_installing_version_or_unknown(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'installed.json'
            self.assertEqual(anchi_cell.installed_version(path), {'runtime_version': 'unknown', 'installed_at': None})
            path.write_text('{"runtime_version": "0.3.1", "installed_at": "2026-10-11T19:07:53Z"}')
            self.assertEqual(
                anchi_cell.installed_version(path),
                {'runtime_version': '0.3.1', 'installed_at': '2026-10-11T19:07:53Z'},
            )
            for broken in ('not json', '[1]', '{"runtime_version": ""}', '{"runtime_version": 3}'):
                path.write_text(broken)
                self.assertEqual(anchi_cell.installed_version(path)['runtime_version'], 'unknown', broken)
            # Bounded: the daemon shows it in the TUI.
            path.write_text(json.dumps({'runtime_version': 'v' * 100}))
            self.assertEqual(len(anchi_cell.installed_version(path)['runtime_version']), 40)
        self.assertIn(
            "command == 'version' and not rest", (Path(__file__).parents[1] / 'guest/anchi_cell.py').read_text()
        )


class AgentHomeWriteTests(unittest.TestCase):
    """Root writes the Codex placeholder into a home the agent owns. A link the agent left
    where the directory or the file should be must not make root create, truncate or hand
    over anything the link names."""

    def setUp(self):
        import tempfile
        from unittest.mock import patch

        self.tmp = Path(tempfile.mkdtemp(prefix='anchi-home-'))
        self.addCleanup(__import__('shutil').rmtree, self.tmp, True)
        self.home = self.tmp / 'home'
        self.home.mkdir()
        self.elsewhere = self.tmp / 'elsewhere'
        self.elsewhere.mkdir()
        patcher = patch('os.fchown')  # ownership needs root; the links are what is tested here
        self.fchown = patcher.start()
        self.addCleanup(patcher.stop)

    def write(self):
        anchi_cell.write_owned(self.home, '.codex/auth.json', '{}', 1000)

    def test_writes_the_file_into_a_directory_it_creates(self):
        import os
        import stat

        self.write()
        path = self.home / '.codex/auth.json'
        self.assertEqual(path.read_text(), '{}')
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((self.home / '.codex').stat().st_mode), 0o700 & ~os.umask(0o022))
        # Both the directory and the file are handed to the agent.
        self.assertEqual([c.args[1:] for c in self.fchown.call_args_list], [(1000, 1000), (1000, 1000)])

    def test_a_linked_directory_refuses_the_cell_without_entering_the_target(self):
        (self.home / '.codex').symlink_to(self.elsewhere)
        with self.assertRaisesRegex(anchi_cell.Failure, r'^AGENT_HOME_LINK:\.codex/auth\.json$'):
            self.write()
        self.assertEqual(list(self.elsewhere.iterdir()), [])
        self.assertFalse(self.fchown.called)

    def test_a_file_in_place_of_the_directory_refuses_the_cell(self):
        (self.home / '.codex').write_text('kept')
        with self.assertRaisesRegex(anchi_cell.Failure, 'AGENT_HOME_LINK'):
            self.write()
        self.assertEqual((self.home / '.codex').read_text(), 'kept')

    def test_a_linked_file_is_replaced_and_its_target_left_alone(self):
        (self.home / '.codex').mkdir()
        target = self.elsewhere / 'auth.json'
        target.write_text('theirs')
        (self.home / '.codex/auth.json').symlink_to(target)
        self.write()
        self.assertFalse((self.home / '.codex/auth.json').is_symlink())
        self.assertEqual((self.home / '.codex/auth.json').read_text(), '{}')
        self.assertEqual(target.read_text(), 'theirs')

    def test_a_directory_in_place_of_the_file_refuses_the_cell(self):
        (self.home / '.codex/auth.json').mkdir(parents=True)
        with self.assertRaisesRegex(anchi_cell.Failure, 'AGENT_HOME_LINK'):
            self.write()
        self.assertTrue((self.home / '.codex/auth.json').is_dir())


class CellCleanupTests(unittest.TestCase):
    """A cell's work directory holds its mounts; removing it while one is still mounted would
    remove files through it."""

    def setUp(self):
        import tempfile

        self.tmp = Path(tempfile.mkdtemp(prefix='anchi-cells-'))
        self.addCleanup(__import__('shutil').rmtree, self.tmp, True)

    def test_mount_points_below_a_cell_come_deepest_first(self):
        table = self.tmp / 'mounts'
        cells = '/run/anchi/cells'
        table.write_text(
            '\n'.join(
                [
                    f'overlay {cells}/t1/root overlay rw 0 0',
                    f'virtiofs {cells}/t1/ws/rw virtiofs rw 0 0',
                    f'virtiofs {cells}/t1/ws/rw/.git/hooks virtiofs ro 0 0',
                    f'virtiofs {cells}/t1/ws/my\\040space virtiofs ro 0 0',
                    f'overlay {cells}/t10/root overlay rw 0 0',
                    f'overlay {cells}/t1-b/root overlay rw 0 0',
                    'tmpfs /run tmpfs rw 0 0',
                ]
            )
        )
        points = anchi_cell.mount_points(f'{cells}/t1', table=table)
        self.assertEqual(points[0], f'{cells}/t1/ws/rw/.git/hooks')
        self.assertEqual(
            sorted(points),
            [f'{cells}/t1/root', f'{cells}/t1/ws/my space', f'{cells}/t1/ws/rw', f'{cells}/t1/ws/rw/.git/hooks'],
        )

    def test_the_work_directory_stays_while_something_is_mounted_below_it(self):
        from types import SimpleNamespace
        from unittest.mock import patch

        work = self.tmp / 't1'
        (work / 'ws/rw').mkdir(parents=True)
        (work / 'ws/rw/file').write_text('the Mac side')

        def egress(request, timeout=15):
            raise anchi_cell.Failure('EGRESS_UNAVAILABLE')

        with patch.multiple(
            anchi_cell,
            CELLS=self.tmp,
            run=lambda *a, **k: SimpleNamespace(returncode=1, stdout=''),
            egress=egress,
            unmount_below=lambda path: False,
        ):
            anchi_cell.cleanup('t1')
        self.assertEqual((work / 'ws/rw/file').read_text(), 'the Mac side')
        with patch.multiple(
            anchi_cell,
            CELLS=self.tmp,
            run=lambda *a, **k: SimpleNamespace(returncode=1, stdout=''),
            egress=egress,
            unmount_below=lambda path: True,
        ):
            anchi_cell.cleanup('t1')
        self.assertFalse(work.exists())


class CellProcessTests(unittest.TestCase):
    def test_cell_pids_follow_descent_into_nested_pid_namespaces(self):
        import tempfile

        proc = Path(tempfile.mkdtemp(prefix='anchi-proc-'))
        self.addCleanup(__import__('shutil').rmtree, proc, True)

        def process(pid, ppid):
            (proc / str(pid)).mkdir()
            (proc / str(pid) / 'status').write_text(f'Name:\tx\nPPid:\t{ppid}\nNSpid:\t{pid}\n')

        process(1, 0)
        process(100, 1)  # the cell's init
        process(101, 100)  # the runner
        process(102, 101)  # bwrap, which unshares pid
        process(103, 102)  # what runs inside the sandbox: another pid namespace
        process(200, 1)  # another cell
        process(201, 200)
        (proc / 'self').mkdir()  # not a process entry
        (proc / '300').mkdir()  # gone before its status could be read
        self.assertEqual(anchi_cell.cell_pids(100, proc=proc), [100, 101, 102, 103])
        self.assertEqual(anchi_cell.cell_pids(200, proc=proc), [200, 201])


class ScanTests(unittest.TestCase):
    def setUp(self):
        import tempfile

        self.tmp = Path(tempfile.mkdtemp(prefix='anchi-scan-'))
        self.addCleanup(__import__('shutil').rmtree, self.tmp, True)
        self.root = self.tmp / 'root'
        for relative, text in (
            ('etc/app.conf', 'token=abc'),
            ('home/agent/work/notes.txt', 'hello'),
            ('opt/claude/bin/claude', 'toolchain'),
            ('usr/local/go/bin/go', 'toolchain'),
            ('proc/1/environ', 'kernel'),
        ):
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        (self.root / 'etc/link').symlink_to(self.root / 'etc/app.conf')

    def scan(self, **kw):
        seen = []
        result = anchi_cell.scan_files(self.root, lambda blob, where: seen.append((where, blob)), **kw)
        return sorted(w for w, _ in seen), result

    def test_reads_the_writable_tree_but_not_toolchains_or_links(self):
        where, result = self.scan()
        self.assertEqual(where, ['/etc/app.conf', '/home/agent/work/notes.txt'])
        self.assertEqual(result, {'files': 2, 'bytes': 14, 'unchanged': 0, 'partial': False})

    def test_reads_only_files_changed_since_the_cell_started(self):
        import time

        where, result = self.scan(since=time.time() + 60)
        self.assertEqual((where, result['files'], result['unchanged']), ([], 0, 2))
        where, _ = self.scan(since=time.time() - 60)
        self.assertEqual(len(where), 2)

    def test_stops_at_its_limits_and_says_which(self):
        from unittest.mock import patch

        with patch.object(anchi_cell, 'SCAN_MAX_FILES', 1):
            where, result = self.scan()
        self.assertEqual((len(where), result['partial'], result['stopped_at']), (1, True, 'files'))
        with patch.object(anchi_cell, 'SCAN_MAX_BYTES', 3):
            where, result = self.scan()
        self.assertEqual((where, result['stopped_at']), ([], 'bytes'))
        ticks = iter(range(0, 10_000, 100))
        where, result = self.scan(clock=lambda: next(ticks))
        self.assertEqual((where, result['stopped_at']), ([], 'time'))

    def test_scan_since_is_the_cell_start_with_a_margin(self):
        from unittest.mock import patch

        (self.tmp / 't1').mkdir()
        (self.tmp / 't1/meta.json').write_text(json.dumps({'task': 't1', 'started_at': 1000.0}))
        with patch.object(anchi_cell, 'CELLS', self.tmp):
            self.assertEqual(anchi_cell.scan_since('t1'), 995.0)
            self.assertIsNone(anchi_cell.scan_since('t2'))


class ReapTests(unittest.TestCase):
    def test_reap_keeps_a_running_image_build_and_its_mounts(self):
        import tempfile
        from unittest.mock import patch

        cells = Path(tempfile.mkdtemp(prefix='anchi-cells-'))
        self.addCleanup(__import__('shutil').rmtree, cells, True)
        for d in ('t-old', 'build-abc', 'build-done'):
            (cells / d).mkdir()
        cleaned, unregistered, umounts, out = [], [], [], []

        def egress(request, timeout=15):
            if request['op'] == 'list':
                return ['t-old', 'build-abc', 't-registered-only']
            unregistered.append(request['task'])

        with patch.multiple(
            anchi_cell,
            CELLS=cells,
            cleanup=cleaned.append,
            active=lambda u: u == 'anchi-cell-build-abc.service',
            egress=egress,
            mount_points=lambda below: [f'{cells}/build-abc/root', f'{cells}/t-gone/root', str(cells)],
            run=lambda *a, **k: umounts.append(a),
            emit=out.append,
        ):
            anchi_cell.cell_reap([])
        self.assertEqual(sorted(cleaned), ['build-done', 't-old'])
        self.assertEqual(unregistered, ['t-registered-only'])
        self.assertEqual(umounts, [('umount', '-l', f'{cells}/t-gone/root')])
        self.assertEqual(
            out, [{'reaped': ['build-done', 't-old', 't-registered-only'], 'unmounted': [f'{cells}/t-gone/root']}]
        )
