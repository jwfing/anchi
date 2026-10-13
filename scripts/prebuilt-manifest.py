"""Record the exact release archives; this manifest is embedded in the matching app."""

import hashlib
import importlib.util
import json
from pathlib import Path
import platform
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('anchi_prebuilt', root / 'guest/anchi_prebuilt.py')
prebuilt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prebuilt)


def main():
    output = Path(sys.argv[1])
    arch = platform.machine()
    layers = {}
    for image in ('codex', 'runtime-codex', 'runtime-claude-code', 'runtime-hermes'):
        archive = output / f'anchi-layer-{arch}-{image}.tar.gz'
        with archive.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        layers[image] = {'file': archive.name, 'sha256': digest, 'bytes': archive.stat().st_size}
    manifest = {
        'schema': 1,
        'version': json.loads((root / 'anchi/package.json').read_text())['version'],
        'arch': arch,
        'compatibility': prebuilt.compatibility(Path('/opt/secure-vm/anchi'), root / 'guest/cell.env'),
        'layers': layers,
    }
    for image in layers:
        prebuilt.entry_for(manifest, image, manifest['compatibility'])
    target = output / f'prebuilt-{arch}.json'
    temp = target.with_suffix('.tmp')
    temp.write_text(json.dumps(manifest, indent=2) + '\n')
    temp.replace(target)
    subprocess.run([sys.executable, str(root / 'scripts/check-prebuilt.py'), str(target)], check=True)


if __name__ == '__main__':
    main()
