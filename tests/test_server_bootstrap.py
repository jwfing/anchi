"""The desktop bootstrap must refuse unsafe inputs and existing guest installations."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/bootstrap-server.sh"


class BootstrapRefusalTest(unittest.TestCase):
    def run_script(self, *args, env=None):
        return subprocess.run(
            ["/bin/bash", str(SCRIPT), *args],
            env=env,
            capture_output=True,
            text=True,
            timeout=10,
        )

    def test_rejects_shell_text_and_unmanaged_data_paths_before_setup(self):
        for version, directory in [
            ("1.2.3; exit 0", "/data/anchi"),
            ("latest", "/data/anchi"),
            ("1.2.3", "/etc"),
            ("1.2.3", "/data/../etc"),
        ]:
            with self.subTest(version=version, directory=directory):
                result = self.run_script(version, directory)
                self.assertEqual(result.returncode, 64, result.stderr)

    def test_refuses_existing_guest_and_missing_sudo_without_installing(self):
        with tempfile.TemporaryDirectory(prefix="anchi-bootstrap-refusal-") as tmp:
            root = Path(tmp)
            commands = {
                "uname": 'case "$1" in -s) echo Linux;; -m) echo x86_64;; esac',
                "python3": "exit 0",
                "systemctl": "exit 99",
                "loginctl": "exit 99",
                "flock": "exit 99",
                "anchi-cell": "exit 99",
                "curl": "exit 99",
                "tar": "exit 99",
            }
            for name, body in commands.items():
                path = root / name
                path.write_text("#!/bin/sh\n" + body + "\n")
                path.chmod(0o755)
            env = {
                **os.environ,
                "PATH": f"{root}:/usr/bin:/bin",
                "HOME": str(root / "home"),
                "XDG_CONFIG_HOME": str(root / "home/.config"),
            }
            sudo = root / "sudo"
            for allowed in (True, False):
                sudo.write_text(
                    '#!/bin/sh\n[ "$*" = "-n true" ] || exit 99\n' + ("exit 0\n" if allowed else "exit 1\n")
                )
                sudo.chmod(0o755)
                result = self.run_script("0.4.2", "/data/anchi", env=env)
                self.assertNotEqual(result.returncode, 0)
                expected = "Guest services already exist" if allowed else "passwordless sudo"
                self.assertIn(expected, result.stderr)
