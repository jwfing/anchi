"""Round-trip release layers through the guest extractor, then run their tools without accounts.

Run only in the disposable release build container, on its private ext4 build filesystem.
"""

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import signal
import time

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('anchi_prebuilt', root / 'guest/anchi_prebuilt.py')
prebuilt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prebuilt)


def main():
    manifest_file = Path(sys.argv[1])
    manifest = json.loads(manifest_file.read_text())
    layers = Path('/buildfs/restored')
    merged = Path('/buildfs/verify')
    merged.mkdir()
    identity = prebuilt.compatibility(Path('/opt/secure-vm/anchi'), root / 'guest/cell.env')
    pins = dict(
        line.split('=', 1)
        for line in (root / 'guest/cell.env').read_text().splitlines()
        if '=' in line and not line.startswith('#')
    )
    uid = pins['SECURE_CELL_AGENT_UID']
    probes = {
        'codex': ['/usr/local/bin/go', 'version'],
        'runtime-codex': ['/opt/codex/bin/codex', '--version'],
        'runtime-claude-code': ['/opt/claude/bin/claude', '--version'],
        'runtime-hermes': ['/opt/hermes/venv/bin/python', '-c', 'import acp; print("Hermes ACP available")'],
    }
    for image, probe in probes.items():
        entry = prebuilt.entry_for(manifest, image, identity)
        archive = manifest_file.parent / entry['file']
        prebuilt.verify(archive, entry)
        layer = layers / image
        layer.mkdir(parents=True)
        prebuilt.extract(archive, layer, 0, int(pins['SECURE_CELL_UID_COUNT']))
        lower = f'{layer}:/buildfs/rootfs' if image == 'codex' else f'{layer}:{layers / "codex"}:/buildfs/rootfs'
        subprocess.run(['mount', '-t', 'overlay', 'overlay', '-o', f'lowerdir={lower},ro', str(merged)], check=True)
        try:
            subprocess.run(['mount', '-t', 'proc', 'proc', str(merged / 'proc')], check=True)
            subprocess.run(
                ['mount', '-t', 'tmpfs', '-o', f'uid={uid},gid={uid},mode=700', 'tmpfs', str(merged / 'home/agent')],
                check=True,
            )
            process = subprocess.Popen(
                [
                    'chroot',
                    f'--userspec={uid}:{uid}',
                    str(merged),
                    '/usr/bin/env',
                    '-i',
                    'HOME=/home/agent',
                    'PATH=/opt/node/bin:/usr/local/bin:/usr/bin:/bin',
                    *probe,
                ],
                start_new_session=True,
            )
            try:
                if process.wait(timeout=30):
                    raise RuntimeError(f'Runtime probe failed: {image}')
            finally:
                # Version probes can leave helper processes behind; no process may retain
                # the restored root when the next runtime's overlay is mounted.
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
        finally:
            time.sleep(0.1)
            subprocess.run(['umount', str(merged / 'home/agent')], check=False)
            subprocess.run(['umount', str(merged / 'proc')], check=False)
            subprocess.run(['umount', str(merged)], check=True)
    print('Prebuilt archives verified and runtime probes passed.')


if __name__ == '__main__':
    main()
