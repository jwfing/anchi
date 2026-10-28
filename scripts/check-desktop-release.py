"""Install, update and open the packaged desktop app through the public installer, without a VM.

Usage: python3 scripts/check-desktop-release.py artifacts/releases/anchi-<target>.tar.gz \
           artifacts/releases/anchi-desktop-<target>.tar.gz

Downloads come from the given archives through a stand-in curl. The installed app is opened with
the minimal PATH a Finder or desktop-menu launch gets: it must find `anchi` through the login
shell, start the daemon and connect. Opening needs a display; on Linux run under xvfb-run, or set
ANCHI_CHECK_NO_OPEN=1 to skip it.
"""

import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import shutil
import subprocess
import sys
import tempfile

REPO = Path(__file__).resolve().parents[1]
CLI_ARCHIVE = Path(sys.argv[1]).resolve()
APP_ARCHIVE = Path(sys.argv[2]).resolve()
MAC = platform.system() == "Darwin"


def run(args, env, *, ok=True, timeout=120):
    result = subprocess.run(args, env=env, capture_output=True, text=True, timeout=timeout)
    if ok and result.returncode:
        raise AssertionError(f"{args}: {result.stdout}\n{result.stderr}")
    return result


def checksum(fixtures, archive, digest=None):
    digest = digest or hashlib.sha256(archive.read_bytes()).hexdigest()
    (fixtures / f"{archive.name}.sha256").write_text(f"{digest}  {archive.name}\n")


with tempfile.TemporaryDirectory(prefix="anchi-desktop-release-", dir="/tmp") as temporary:
    root = Path(temporary)
    home = root / "home"
    home.mkdir()
    fixtures = root / "downloads"
    fixtures.mkdir()
    for archive in (CLI_ARCHIVE, APP_ARCHIVE):
        shutil.copyfile(archive, fixtures / archive.name)
        checksum(fixtures, archive)
    fakebin = root / "tools"
    fakebin.mkdir()
    curl = fakebin / "curl"
    curl.write_text(
        f"#!{sys.executable}\n"
        "import os, pathlib, shutil, sys\n"
        "args = sys.argv[1:]\n"
        "url = next(a for a in args if a.startswith('https://'))\n"
        "if url.endswith('/releases/latest'):\n"
        "    print((pathlib.Path(os.environ['FIXTURES']) / 'latest.json').read_text())\n"
        "    sys.exit(0)\n"
        "source = pathlib.Path(os.environ['FIXTURES']) / url.rsplit('/', 1)[1]\n"
        "if not source.exists():\n"
        "    sys.exit(22)\n"
        "shutil.copyfile(source, args[args.index('-o') + 1])\n"
    )
    curl.chmod(0o755)
    (fakebin / "limactl").write_text("#!/bin/sh\nexit 1\n")
    (fakebin / "limactl").chmod(0o755)
    bindir = home / ".local/bin"
    bindir.mkdir(parents=True)
    apps = home / "Applications"
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
        "XDG_DATA_HOME": str(home / ".local/share"),
    }
    env.pop("ANCHI_DESKTOP", None)
    env.pop("ANCHI_CLI", None)
    installer = (REPO / "landing/dist/install.sh").read_text()

    def install(*args, ok=True, custom_env=None):
        result = subprocess.run(
            ["sh", "-s", "--", *args],
            input=installer,
            text=True,
            capture_output=True,
            env=custom_env or env,
            cwd=root,
            timeout=180,
        )
        if ok and result.returncode:
            raise AssertionError(result.stdout + result.stderr)
        return result

    base = home / ".local/share/anchi"
    current = base / "current"
    cli = str(bindir / "anchi")

    def installed_app():
        """The installed app's executable and the version its resources/app says."""
        if MAC:
            resources = apps / "Anchi.app/Contents/Resources/app"
            executable = apps / "Anchi.app/Contents/MacOS/Anchi"
        else:
            resources = current / "desktop/resources/app"
            executable = bindir / "anchi-desktop"
        app_version = json.loads((resources / "package.json").read_text())["version"]
        assert (resources / "remote/version").read_text().strip() == app_version
        for bundled, source in {
            "bootstrap-server.sh": "scripts/bootstrap-server.sh",
            "install.sh": "landing/dist/install.sh",
            "anchi-bridge.py": "scripts/anchi-bridge.py",
            "anchi_data_dir.py": "guest/anchi_data_dir.py",
        }.items():
            assert (resources / "remote" / bundled).read_bytes() == (REPO / source).read_bytes()
        return executable, app_version

    # Unknown options are refused before anything is installed.
    assert install("--desktp", ok=False).returncode != 0 and not current.exists()
    # Without --desktop, no app.
    install()
    version = json.loads((current / "manifest.json").read_text())["version"]
    assert not (apps / "Anchi.app").exists() and not (bindir / "anchi-desktop").exists()
    assert not (base / "desktop").exists()

    # Another program's app or command of the same name is never replaced.
    if MAC:
        foreign = root / "other-apps"
        (foreign / "Anchi.app/Contents").mkdir(parents=True)
        info = foreign / "Anchi.app/Contents/Info.plist"
        info.write_bytes(plistlib.dumps({"CFBundleIdentifier": "com.example.other"}))
        result = install("--desktop", ok=False, custom_env={**env, "ANCHI_DESKTOP_DIR": str(foreign)})
        assert result.returncode != 0 and "not the Anchi desktop app" in result.stderr
        assert plistlib.loads(info.read_bytes())["CFBundleIdentifier"] == "com.example.other"
    else:
        (bindir / "anchi-desktop").write_text("unrelated command")
        assert install("--desktop", ok=False).returncode != 0
        assert (bindir / "anchi-desktop").read_text() == "unrelated command"
        (bindir / "anchi-desktop").unlink()
    assert not (base / "desktop").exists()

    # A corrupt desktop download changes nothing, the CLI included.
    before = current.resolve()
    checksum(fixtures, APP_ARCHIVE, "0" * 64)
    result = install("--desktop", ok=False)
    assert result.returncode != 0 and "checksum mismatch" in result.stderr, result.stderr
    assert current.resolve() == before and not (base / "desktop").exists()
    checksum(fixtures, APP_ARCHIVE)

    install("--desktop")
    executable, app_version = installed_app()
    assert app_version == version, (app_version, version)
    assert os.access(executable, os.X_OK)
    assert (base / "desktop").is_file()
    if not MAC:
        entry = (home / ".local/share/applications/anchi.desktop").read_text()
        assert f'Exec="{bindir}/anchi-desktop"' in entry and "Icon=" in entry
        assert "# Anchi desktop launcher" in (bindir / "anchi-desktop").read_text()

    # `anchi update` updates an installed app with the CLI. Pretend the installed version is older.
    (fixtures / "latest.json").write_text(json.dumps({"tag_name": "v" + version}))
    first = current.resolve()
    manifest = json.loads((first / "manifest.json").read_text())
    manifest["version"] = "0.0.0"
    (first / "manifest.json").write_text(json.dumps(manifest))
    if MAC:
        stale = apps / "Anchi.app/Contents/Resources/app/stale"
        stale.write_text("from the previous install")
    assert "Updated to Anchi" in run([cli, "update"], env, timeout=300).stdout
    assert current.resolve() != first
    executable, app_version = installed_app()
    assert app_version == version
    if MAC:
        assert not stale.exists(), "update must replace the app"
    else:
        assert (current / "desktop/anchi-desktop").is_file()

    if os.environ.get("ANCHI_CHECK_NO_OPEN") == "1":
        print("Desktop release checks passed: install, refusal, checksum, update (not opened).")
        sys.exit(0)

    # Open it as the Finder would: no installer directory on PATH. The login shell's has it.
    (home / ".profile").write_text(f"export PATH='{bindir}':\"$PATH\"\n")
    steps = root / "steps.json"
    steps.write_text(
        json.dumps(
            [
                {"waitFor": ".rail-dot.dot-connected"},
                {"eval": "document.querySelector('.rail-dot').className"},
            ]
        )
    )
    opened = {
        **env,
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "ANCHI_DRIVE_APP": str(executable),
    }
    try:
        result = run(
            [shutil.which("node") or "node", str(REPO / "anchi/packages/desktop/scripts/drive.mjs"), str(steps)],
            opened,
            ok=False,
            timeout=180,
        )
        if result.returncode or "dot-connected" not in result.stdout:
            log = home / ".anchi/data/daemon.log"
            raise AssertionError(result.stdout + result.stderr + (log.read_text() if log.exists() else ""))
    finally:
        run([cli, "daemon", "stop"], env, ok=False)
    print("Desktop release checks passed: install, refusal, checksum, update, open and connect.")
