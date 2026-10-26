#!/usr/bin/python3
"""Keeps Anchi's guest data (agents' homes, image layers) on a chosen disk of a remote server.

Usage, as root, with the daemon stopped and no cell alive:
    anchi_data_dir.py <directory> --home <login user's HOME>

The directory is bind-mounted at /var/lib/anchi by a systemd mount unit, so the cell manager and
the checks keep their paths. Existing data is copied there with its owners (the agents' homes
belong to cell UIDs), the mount is checked, and only then is the old copy removed. Running it
again with the same directory changes nothing. Prints one JSON object; failures print
{"error": CODE, "detail": ...} and exit non-zero.
"""

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

TARGET = Path('/var/lib/anchi')
UNIT = Path('/etc/systemd/system/var-lib-anchi.mount')
EGRESS_DROPIN = Path('/etc/systemd/system/anchi-egress.service.d/anchi-data-dir.conf')
SAFE_PATH = re.compile(r'/[A-Za-z0-9._/-]{1,200}')
# Overlay layers and the cells' bind mounts need a local filesystem that keeps owners and modes.
LOCAL_FILESYSTEMS = {'ext2/ext3', 'xfs', 'btrfs'}


class Refused(Exception):
    def __init__(self, code, detail):
        super().__init__(code)
        self.code = code
        self.detail = detail


def validate(directory, home):
    """The directory as a Path, or Refused: absolute, plain, outside /var/lib/anchi and HOME."""
    if not SAFE_PATH.fullmatch(directory) or '//' in directory:
        raise Refused('BAD_DATA_DIR', 'use an absolute path of letters, digits, ".", "_", "-" and "/"')
    # Before Path, which drops a "." without a word.
    if any(part in ('.', '..') for part in directory.split('/')):
        raise Refused('BAD_DATA_DIR', 'the path cannot contain "." or ".."')
    path = Path(directory)
    if path == TARGET or TARGET in path.parents or path in TARGET.parents:
        raise Refused('BAD_DATA_DIR', f'choose a directory outside {TARGET}')
    if len(path.parts) < 3:
        raise Refused('BAD_DATA_DIR', 'choose a directory at least two levels deep, such as /data/anchi')
    home = Path(home)
    if path == home or home in path.parents or path in home.parents:
        # The login user owns HOME and could rename the directory away under the mount.
        raise Refused('BAD_DATA_DIR', f'choose a directory outside the login user\'s home ({home})')
    return path


def mount_unit(directory):
    return (
        '# Written by Anchi (guest/anchi_data_dir.py): its data on a disk of the user\'s choice.\n'
        '[Unit]\n'
        f'Description=Anchi data on {directory}\n'
        f'RequiresMountsFor={directory}\n'
        'Before=anchi-egress.service\n\n'
        '[Mount]\n'
        f'What={directory}\n'
        f'Where={TARGET}\n'
        'Type=none\n'
        'Options=bind\n\n'
        '[Install]\n'
        'WantedBy=local-fs.target\n'
    )


def egress_dropin(directory):
    """The egress proxy cannot read /var/lib/anchi; neither may it read it under its new path."""
    return (
        '# Written by Anchi (guest/anchi_data_dir.py).\n'
        '[Unit]\n'
        f'RequiresMountsFor={directory}\n\n'
        '[Service]\n'
        f'InaccessiblePaths={directory}\n'
    )


def unit_directory(text):
    """The What= of a mount unit Anchi wrote, or None."""
    match = re.search(r'^What=(.+)$', text, re.M)
    return match.group(1).strip() if match else None


def filesystem(path):
    return subprocess.run(
        ['stat', '-f', '-c', '%T', str(path)], capture_output=True, text=True, check=True
    ).stdout.strip()


def size(path):
    return sum(os.lstat(os.path.join(top, name)).st_size for top, dirs, files in os.walk(path) for name in dirs + files)


def entries(path):
    return sum(len(dirs) + len(files) for _, dirs, files in os.walk(path))


def systemctl(*args):
    subprocess.run(['systemctl', *args], check=True, capture_output=True, text=True)


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.new')
    tmp.write_text(text)
    tmp.chmod(0o644)
    tmp.replace(path)


def live_cells():
    try:
        out = subprocess.run(['anchi-cell', 'list'], capture_output=True, text=True, timeout=60).stdout
        return json.loads(out.strip().splitlines()[-1]).get('cells', [])
    except (OSError, ValueError, IndexError, subprocess.TimeoutExpired):
        return []


def apply(path):
    if UNIT.exists():
        current = unit_directory(UNIT.read_text())
        if current != str(path):
            raise Refused('DATA_DIR_IN_USE', f'Anchi\'s data is on {current}; moving it again is not supported')
    elif os.path.ismount(TARGET):
        raise Refused('DATA_DIR_IN_USE', f'{TARGET} is already a mount point that Anchi did not make')
    if live_cells():
        raise Refused('CELLS_ALIVE', 'stop the daemon first; task cells use the data')

    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    kind = filesystem(path)
    if kind not in LOCAL_FILESYSTEMS:
        raise Refused('BAD_DATA_DIR', f'{path} is on {kind}; choose a local ext4, xfs or btrfs disk')
    mounted = os.path.ismount(TARGET) and UNIT.exists()
    moved = 0
    old = TARGET.with_name(TARGET.name + '.moving')
    if not mounted:
        has_data = TARGET.is_dir() and any(TARGET.iterdir())
        if has_data and any(path.iterdir()):
            raise Refused('DATA_DIR_NOT_EMPTY', f'{path} already holds files, and so does {TARGET}')
        if has_data:
            need = size(TARGET)
            if shutil.disk_usage(path).free < need + 512 * 1024 * 1024:
                raise Refused('DATA_DIR_TOO_SMALL', f'{path} needs {need // 2**20} MB and 512 MB to spare')
            subprocess.run(['cp', '-a', f'{TARGET}/.', f'{path}/'], check=True)
            moved = entries(TARGET)
            if entries(path) != moved:
                raise Refused('COPY_INCOMPLETE', f'{path} does not hold every file of {TARGET}; {TARGET} is unchanged')
            TARGET.rename(old)
        TARGET.mkdir(mode=0o700, exist_ok=True)
    # Root's alone, as /var/lib/anchi is; the copy brings the old directory's mode along.
    os.chown(path, 0, 0)
    path.chmod(0o700)

    write(UNIT, mount_unit(path))
    write(EGRESS_DROPIN, egress_dropin(path))
    systemctl('daemon-reload')
    try:
        systemctl('enable', '--now', UNIT.name)
        if not os.path.ismount(TARGET) or (moved and entries(TARGET) != moved):
            raise Refused('MOUNT_FAILED', f'{TARGET} does not show {path}')
    except (subprocess.CalledProcessError, Refused) as err:
        # Back to how it was: the data stays where it was found.
        subprocess.run(['systemctl', 'disable', '--now', UNIT.name], capture_output=True)
        UNIT.unlink(missing_ok=True)
        EGRESS_DROPIN.unlink(missing_ok=True)
        subprocess.run(['systemctl', 'daemon-reload'], capture_output=True)
        if old.exists():
            TARGET.rmdir()
            old.rename(TARGET)
        if isinstance(err, Refused):
            raise
        raise Refused('MOUNT_FAILED', (err.stderr or str(err)).strip()[-300:]) from None
    if old.exists():
        shutil.rmtree(old)
    # A running egress proxy picks up its drop-in.
    subprocess.run(['systemctl', 'try-restart', 'anchi-egress.service'], capture_output=True)
    return {'data_dir': str(path), 'moved_entries': moved}


def main(argv):
    if len(argv) != 4 or argv[2] != '--home':
        print(json.dumps({'error': 'USAGE', 'detail': 'anchi_data_dir.py <directory> --home <HOME>'}))
        return 64
    try:
        result = apply(validate(argv[1], argv[3]))
    except Refused as err:
        print(json.dumps({'error': err.code, 'detail': err.detail}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
