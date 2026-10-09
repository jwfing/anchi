"""Exercise the public installer and packaged daemon without a checkout or a real VM.

Usage: python3 scripts/check-release.py artifacts/releases/anchi-<target>.tar.gz
"""

import hashlib
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import termios
import time

REPO = Path(__file__).resolve().parents[1]
ARCHIVE = Path(sys.argv[1]).resolve()


def run(args, env, cwd, *, ok=True):
    result = subprocess.run(args, env=env, cwd=cwd, capture_output=True, text=True, timeout=40)
    if ok and result.returncode:
        raise AssertionError(f"{args}: {result.stdout}\n{result.stderr}")
    return result


with tempfile.TemporaryDirectory(prefix="anchi release '", dir="/tmp") as temporary:
    root = Path(temporary)
    home = root / "home"
    home.mkdir()
    fixtures = root / "downloads"
    fixtures.mkdir()
    shutil.copyfile(ARCHIVE, fixtures / ARCHIVE.name)
    digest = hashlib.sha256(ARCHIVE.read_bytes()).hexdigest()
    checksum = fixtures / f"{ARCHIVE.name}.sha256"
    checksum.write_text(f"{digest}  {ARCHIVE.name}\n")
    fakebin = root / "tools"
    fakebin.mkdir()
    # Intercept downloads only; use the actual archive, Node, bundles and installer.
    curl = fakebin / "curl"
    curl.write_text(
        f"#!{sys.executable}\n"
        "import os, pathlib, shutil, sys\n"
        "args = sys.argv[1:]\n"
        "url = next(a for a in args if a.startswith('https://'))\n"
        "shutil.copyfile(pathlib.Path(os.environ['FIXTURES']) / url.rsplit('/', 1)[1], "
        "args[args.index('-o') + 1])\n"
    )
    curl.chmod(0o755)
    lima = fakebin / "limactl"
    lima.write_text("#!/bin/sh\nexit 1\n")
    lima.chmod(0o755)
    bindir = home / ".local/bin"
    bindir.mkdir(parents=True)
    env = {
        **os.environ,
        "HOME": str(home),
        "ANCHI_HOME": str(home / ".anchi"),
        "ANCHI_INSTALL_ROOT": str(home / ".local/share/anchi"),
        "ANCHI_BIN_DIR": str(bindir),
        "ANCHI_VERSION": "latest",
        "FIXTURES": str(fixtures),
        "PATH": f"{fakebin}:{bindir}:/usr/bin:/bin:/usr/sbin:/sbin",
        "SHELL": "/bin/sh",
        "TERM": "xterm-256color",
        "CI": "false",
    }
    installer = (REPO / "landing/dist/install.sh").read_text()

    def install(ok=True, custom_env=None):
        result = subprocess.run(
            ["sh"],
            input=installer,
            text=True,
            capture_output=True,
            env=custom_env or env,
            cwd=root,
            timeout=90,
        )
        if ok and result.returncode:
            raise AssertionError(result.stdout + result.stderr)
        return result

    install()
    cli = str(bindir / "anchi")
    current = home / ".local/share/anchi/current"
    first = current.resolve()
    version = json.loads((current / "manifest.json").read_text())["version"]
    assert run([cli, "--version"], env, root).stdout.strip() == version
    assert "setup" in run([cli, "--help"], env, root).stdout
    # Reject corruption before switching a working installation.
    checksum.write_text(f"{'0' * 64}  {ARCHIVE.name}\n")
    assert install(ok=False).returncode != 0
    assert current.resolve() == first
    assert run([cli, "--version"], env, root).stdout.strip() == version
    checksum.write_text(f"{digest}  {ARCHIVE.name}\n")
    install()
    assert current.resolve() != first and first.exists()
    # A failed/missing release must not replace the active version either.
    second = current.resolve()
    checksum.unlink()
    assert install(ok=False).returncode != 0
    assert current.resolve() == second
    checksum.write_text(f"{digest}  {ARCHIVE.name}\n")
    # Do not clobber an unrelated command.
    other = root / "other-bin"
    other.mkdir()
    (other / "anchi").write_text("unrelated command")
    assert install(ok=False, custom_env={**env, "ANCHI_BIN_DIR": str(other)}).returncode != 0
    assert (other / "anchi").read_text() == "unrelated command"
    # PATH setup must be idempotent for shells without ~/.local/bin on PATH.
    no_path = {**env, "PATH": f"{fakebin}:/usr/bin:/bin:/usr/sbin:/sbin"}
    install(custom_env=no_path)
    install(custom_env=no_path)
    assert (home / ".profile").read_text().count("# Anchi") == 1
    # Verify packaged setup resources and prebuilt cell runners without touching a VM.
    lima.write_text(
        f"#!{sys.executable}\n"
        "import json, pathlib, sys\n"
        "args = sys.argv[1:]\n"
        "if args[0] == 'copy':\n"
        "    for source in args[1:-1]:\n"
        "        if source != '-r' and not pathlib.Path(source).exists():\n"
        "            raise SystemExit('Missing setup resource: ' + source)\n"
        "if any('vault_admin.py' in arg for arg in args):\n"
        "    print(json.dumps({'encrypted_files': 0, 'unlocked': True}))\n"
    )
    # The release path must never invoke pnpm, even with ANCHI_REBUNDLE=1.
    run(["bash", str(current / "scripts/install-anchi.sh")], {**env, "ANCHI_REBUNDLE": "1"}, root)
    assert not (current / "anchi/node_modules").exists()
    runner = current / "anchi/packages/cell-runner/dist/mcp.mjs"
    runner.rename(runner.with_suffix(".saved"))
    try:
        assert run(["bash", str(current / "scripts/install-anchi.sh")], env, root, ok=False).returncode
    finally:
        runner.with_suffix(".saved").rename(runner)
    try:
        run([cli, "daemon", "start"], env, root)
    except AssertionError:
        log = home / ".anchi/data/daemon.log"
        if log.exists():
            print(log.read_text(), file=sys.stderr)
        raise
    try:
        status = json.loads(run([cli, "daemon", "status"], env, root).stdout)
        assert status
        run([cli, "setup", "vault", "init"], env, root)
        assert len((home / ".config/secure-vm/vault.key").read_bytes()) == 32
        # Render the real full-screen UI using a PTY, from outside the repository.
        master, slave = pty.openpty()
        termios.tcsetwinsize(slave, (40, 120))
        child = subprocess.Popen([cli], env=env, cwd=root, stdin=slave, stdout=slave, stderr=slave)
        os.close(slave)
        output = b""
        try:
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                if select.select([master], [], [], 0.2)[0]:
                    try:
                        output += os.read(master, 65536)
                    except OSError:
                        break
                if b"Runtimes" in output and b"Agent builder" in output:
                    break
                if child.poll() is not None:
                    break
            assert b"Runtimes" in output, output.decode(errors="replace")
            assert b"Agent builder" in output, output.decode(errors="replace")
        finally:
            child.send_signal(signal.SIGTERM)
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)
            os.close(master)
    finally:
        run([cli, "daemon", "stop"], env, root)
    print("Release checks passed: install, update, checksum rejection, PATH, setup, daemon, TUI.")
