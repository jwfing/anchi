"""Pinned release layers. Only trusted guest administration calls this module."""

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import stat
import sys
import tarfile
import tempfile
import time
import urllib.request

MAX_ARCHIVE = 2 * 1024**3
MAX_CONTENT = 8 * 1024**3
MAX_MEMBERS = 200_000
RELEASES = 'https://github.com/jwfing/anchi/releases/download'


def compatibility(lib, env):
    """Include the lower-root recipe and every pin, not just the runtime's own script."""
    digest = hashlib.sha256(env.read_bytes())
    for name in (
        'bootstrap.sh',
        'install-anchi.sh',
        'build-base.sh',
        'build-runtime-codex.sh',
        'build-runtime-claude-code.sh',
        'build-runtime-hermes.sh',
    ):
        script = lib / name
        if name.startswith('build-') and not script.exists():
            script = lib / f'anchi-{name}'  # source/package layout, before guest installation
        digest.update(name.encode() + b'\0' + script.read_bytes())
    return digest.hexdigest()


def entry_for(manifest, image, identity, arch=None):
    arch = arch or platform.machine()
    if (
        not isinstance(manifest, dict)
        or set(manifest) != {'schema', 'version', 'arch', 'compatibility', 'layers'}
        or manifest['schema'] != 1
        or not isinstance(manifest['version'], str)
        or not re.fullmatch(r'\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?', manifest['version'])
    ):
        raise ValueError('PREBUILT_BAD_MANIFEST')
    if manifest['arch'] != arch or manifest['compatibility'] != identity:
        raise ValueError('PREBUILT_INCOMPATIBLE')
    layers = manifest['layers']
    if not isinstance(layers, dict) or set(layers) != {
        'codex',
        'runtime-codex',
        'runtime-claude-code',
        'runtime-hermes',
    }:
        raise ValueError('PREBUILT_BAD_MANIFEST')
    entry = layers[image]
    if (
        not isinstance(entry, dict)
        or set(entry) != {'file', 'sha256', 'bytes'}
        or entry['file'] != f'anchi-layer-{arch}-{image}.tar.gz'
        or not isinstance(entry['sha256'], str)
        or not re.fullmatch('[a-f0-9]{64}', entry['sha256'])
        or type(entry['bytes']) is not int
        or not 0 < entry['bytes'] <= MAX_ARCHIVE
    ):
        raise ValueError('PREBUILT_BAD_MANIFEST')
    return entry


def verify(path, entry):
    if path.stat().st_size != entry['bytes']:
        raise ValueError('PREBUILT_CHECKSUM')
    with path.open('rb') as source:
        if hashlib.file_digest(source, 'sha256').hexdigest() != entry['sha256']:
            raise ValueError('PREBUILT_CHECKSUM')


def member_path(value):
    path = PurePosixPath(value)
    if path.is_absolute() or '..' in path.parts or '\x00' in value or len(value) > 4096:
        raise ValueError('PREBUILT_UNSAFE_PATH')
    return path


def extract(archive, target, uid_base, uid_count, *, ownership=True):
    """Validate the entire index before writing; links are installed last, never traversed.

    UIDs in releases are cell-relative. Only overlay whiteouts (character device 0:0) and
    opaque-directory markers are accepted; arbitrary devices and filesystem xattrs are not.
    """
    with tarfile.open(archive, 'r:gz') as source:
        entries = {}
        total = 0
        for count, member in enumerate(source, 1):
            if count > MAX_MEMBERS:
                raise ValueError('PREBUILT_TOO_LARGE')
            path = member_path(member.name)
            if str(path) == '.':
                if not member.isdir():
                    raise ValueError('PREBUILT_UNSAFE_PATH')
                continue
            total += member.size
            if len(entries) >= MAX_MEMBERS or total > MAX_CONTENT or member.size < 0:
                raise ValueError('PREBUILT_TOO_LARGE')
            if path in entries or not 0 <= member.uid < uid_count or not 0 <= member.gid < uid_count:
                raise ValueError('PREBUILT_BAD_MEMBER')
            whiteout = member.ischr() and member.devmajor == member.devminor == 0
            if not (member.isfile() or member.isdir() or member.issym() or member.islnk() or whiteout):
                raise ValueError('PREBUILT_BAD_MEMBER')
            if member.islnk():
                member_path(member.linkname)
            if member.issym() and ('\x00' in member.linkname or len(member.linkname) > 4096):
                raise ValueError('PREBUILT_BAD_MEMBER')
            for key, value in member.pax_headers.items():
                if 'xattr' in key and (
                    key != 'SCHILY.xattr.trusted.overlay.opaque' or value != 'y' or not member.isdir()
                ):
                    raise ValueError('PREBUILT_BAD_XATTR')
            entries[path] = member
        for path, member in entries.items():
            if any(p in entries and not entries[p].isdir() for p in path.parents):
                raise ValueError('PREBUILT_UNSAFE_PATH')
            if member.islnk():
                linked = entries.get(member_path(member.linkname))
                if linked is None or not linked.isfile():
                    raise ValueError('PREBUILT_UNSAFE_LINK')
        # All implicit directories belong to mapped cell root too.
        # Preserve archive order: seeking backwards through gzip for every file would
        # decompress the same layer repeatedly. Parents can be made before their entries.
        for path, member in entries.items():
            dest = target / path
            for parent in reversed(dest.relative_to(target).parents):
                directory = target / parent
                if not directory.exists():
                    directory.mkdir()
                if ownership:
                    os.chown(directory, uid_base, uid_base)
            if member.isdir():
                dest.mkdir(exist_ok=True)
            elif member.isfile():
                with source.extractfile(member) as reader, dest.open('xb') as writer:
                    shutil.copyfileobj(reader, writer, 1024 * 1024)
            elif member.ischr():
                os.mknod(dest, stat.S_IFCHR | 0o600, os.makedev(0, 0))
        for path, member in entries.items():
            dest = target / path
            if member.issym():
                dest.symlink_to(member.linkname)
            elif member.islnk():
                os.link(target / member_path(member.linkname), dest, follow_symlinks=False)
        for path, member in sorted(entries.items(), key=lambda pair: -len(pair[0].parts)):
            dest = target / path
            if ownership:
                os.chown(dest, uid_base + member.uid, uid_base + member.gid, follow_symlinks=False)
            if not member.issym():
                os.chmod(dest, member.mode & 0o7777)
                if member.pax_headers.get('SCHILY.xattr.trusted.overlay.opaque') == 'y':
                    os.setxattr(dest, 'trusted.overlay.opaque', b'y')
    return total


def install(image, digest, target, base_version, lib, env_file):
    """No manifest means a source build. A bad or unavailable pinned artifact fails closed."""
    manifest_file = lib / 'prebuilt.json'
    if not manifest_file.exists():
        return False
    if manifest_file.stat().st_size > 32 * 1024:
        raise ValueError('PREBUILT_BAD_MANIFEST')
    manifest = json.loads(manifest_file.read_text())
    entry = entry_for(manifest, image, compatibility(lib, env_file))
    env = dict(
        line.split('=', 1) for line in env_file.read_text().splitlines() if '=' in line and not line.startswith('#')
    )
    target.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix='.prebuilt-', dir=target.parent) as tmp:
        stage = Path(tmp)
        archive = stage / 'download.tar.gz'
        url = f'{RELEASES}/v{manifest["version"]}/{entry["file"]}'
        print(f'Downloading release layer: {image}', file=sys.stderr, flush=True)
        with urllib.request.urlopen(url, timeout=60) as response, archive.open('xb') as output:
            received = 0
            while block := response.read(1024 * 1024):
                received += len(block)
                if received > entry['bytes']:
                    raise ValueError('PREBUILT_CHECKSUM')
                output.write(block)
        verify(archive, entry)
        layer = stage / 'layer'
        upper = layer / 'upper'
        upper.mkdir(parents=True)
        size = extract(archive, upper, int(env['SECURE_CELL_UID_BASE']), int(env['SECURE_CELL_UID_COUNT']))
        meta = {
            'image': image,
            'hash': digest,
            'ok': True,
            'base': base_version,
            'built_at': time.time(),
            'seconds': round(time.monotonic() - started, 1),
            'size': size,
            'source': 'release',
            'log': str(target / 'build.log'),
        }
        (layer / 'meta.json').write_text(json.dumps(meta))
        (layer / 'build.log').write_text('Installed a checksum-verified release layer.\n')
        if target.exists():
            shutil.rmtree(target)
        layer.rename(target)
    return True
