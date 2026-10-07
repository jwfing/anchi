#!/usr/bin/python3
"""Trusted guest-root task-cell and image manager for the agent team. Never expose it to a cell.

Installed as /usr/local/sbin/anchi-cell and /usr/local/sbin/anchi-image (the program name
selects the command set). The daemon calls fixed subcommands over `limactl shell ... sudo`.
Every command prints one JSON object; failures print {"error": CODE} and exit non-zero.
`start` is the exception: its stdin and stdout belong to the cell runner.
"""

import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import sys
import time

BASE = Path('/var/lib/secure-vm/rootfs')
ROOT = Path('/var/lib/anchi')
LAYERS = ROOT / 'layers'
HOMES = ROOT / 'agents'
CA_BUNDLE = ROOT / 'ca-bundle.pem'
PROXY_CA = ROOT / 'proxy-ca.pem'
# Written by build cells so package updates keep trusting the proxy; removed from every layer.
BUILD_CA_PATHS = (
    'usr/local/share/ca-certificates/anchi-proxy.crt',
    'etc/ssl/certs/anchi-proxy.pem',
    'etc/ssl/certs/ca-certificates.crt',
)
RUN = Path('/run/anchi')
CELLS = RUN / 'cells'
LIB = Path('/opt/secure-vm/anchi')
SERVICES = Path('/opt/secure-vm/services')
EGRESS_CONTROL = Path('/run/anchi-egress/control.sock')
EGRESS_CELLS = Path('/run/anchi-egress/cells')
CELL_ENV = Path('/opt/secure-vm/cell.env')
APPARMOR_PROFILE = Path('/etc/apparmor.d/anchi-cell-bwrap')
MAX_CELLS = int(os.environ.get('ANCHI_MAX_CELLS', '4'))
NAME = re.compile(r'^[a-z0-9][a-z0-9-]{0,39}$')
HASH = re.compile(r'^(base|[0-9a-f]{16})$')
# Credentials injected by the egress proxy, and services reached through per-cell sockets.
PROXY_CONNECTORS = ('github', 'aws', 'linear')
# Codex reads its MCP servers from config.toml; `anchi` is the in-cell Anchi tool server.
CODEX_CONFIG = '''cli_auth_credentials_store = "file"

[mcp_servers.anchi]
command = "/opt/node/bin/node"
args = ["/opt/anchi/mcp.mjs"]
startup_timeout_sec = 10
# Delegation tools wait for another agent's turn; the daemon bounds the wait (55 minutes).
tool_timeout_sec = 3600
'''
SERVICE_CONNECTORS = ('gmail', 'drive', 'notion', 'slack')
CONNECTORS = PROXY_CONNECTORS + SERVICE_CONNECTORS
SANDBOXES = ('cell', 'codex-workspace-write')
BASE_IMAGE = 'codex'
PROXY = 'http://127.0.0.1:3128'
CA_IN_CELL = '/etc/ssl/certs/ca-certificates.crt'
# Placeholders: recognizable to the proxy, useless anywhere else.
PLACEHOLDER = 'anchi-placeholder'
PLACEHOLDER_AWS_KEY = 'AKIAANCHIPLACEHOLDER'
SCAN_MAX_FILE = 32 * 1024 * 1024
SCAN_SKIP = ('proc', 'sys', 'dev', 'opt/codex', 'opt/node', 'usr/lib', 'usr/share')


class Failure(Exception):
    pass


def cell_env():
    values = {}
    for line in CELL_ENV.read_text().splitlines():
        key, sep, value = line.strip().partition('=')
        if sep and not key.startswith('#'):
            values[key] = value
    return values


def emit(value):
    print(json.dumps(value))


def name(value, code):
    if not NAME.fullmatch(value or ''):
        raise Failure(code)
    return value


def run(*args, check=True, **kwargs):
    return subprocess.run(args, check=check, text=True, capture_output=True, **kwargs)


def unit(task):
    return f'anchi-cell-{task}.service'


def active(unit_name):
    return run('systemctl', 'is-active', '--quiet', unit_name, check=False).returncode == 0


def mounted(path):
    return run('mountpoint', '-q', str(path), check=False).returncode == 0


# ── egress proxy control ────────────────────────────────────


def egress(request, timeout=15):
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
            conn.settimeout(timeout)
            conn.connect(str(EGRESS_CONTROL))
            conn.sendall(json.dumps(request).encode() + b'\n')
            data = b''
            while not data.endswith(b'\n'):
                block = conn.recv(65536)
                if not block:
                    break
                data += block
    except OSError:
        raise Failure('EGRESS_UNAVAILABLE') from None
    response = json.loads(data or b'{}')
    if not response.get('ok'):
        raise Failure(response.get('error', 'EGRESS_ERROR'))
    return response['result']


SKILLS = Path('/var/lib/anchi/skills')
SKILL_PATH = re.compile(r'^(\.claude-plugin/plugin\.json|skills/[a-z0-9][a-z0-9-]{0,39}/[A-Za-z0-9._ /-]{1,200})$')


def skills_set(agent):
    """Replaces the agent's skill bundle: {"files": {path: base64}} on stdin. Root-owned and
    bound read-only into the agent's cells; the content is untrusted like any cell input."""
    import base64

    name(agent, 'BAD_AGENT')
    raw = sys.stdin.buffer.read(8 * 1024 * 1024 + 1)
    if len(raw) > 8 * 1024 * 1024:
        raise Failure('INPUT_TOO_LARGE')
    files = json.loads(raw).get('files')
    if not isinstance(files, dict) or len(files) > 2000:
        raise Failure('BAD_SKILLS')
    SKILLS.mkdir(parents=True, exist_ok=True, mode=0o755)
    target, staged = SKILLS / agent, SKILLS / f'.{agent}.new'
    shutil.rmtree(staged, ignore_errors=True)
    total = 0
    for path, data in files.items():
        if not isinstance(path, str) or not SKILL_PATH.fullmatch(path) or '..' in path.split('/') or '//' in path:
            raise Failure('BAD_SKILL_PATH')
        content = base64.b64decode(data, validate=True)
        total += len(content)
        if total > 6 * 1024 * 1024:
            raise Failure('SKILLS_TOO_LARGE')
        out = staged / path
        out.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        out.write_bytes(content)
        out.chmod(0o644)
    shutil.rmtree(target, ignore_errors=True)
    if files:
        staged.rename(target)
    else:
        shutil.rmtree(staged, ignore_errors=True)
    emit({'agent': agent, 'files': len(files)})


def approvals_watch():
    """Relays the proxy's approval stream to stdout (the daemon's watcher) until it ends."""
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
            conn.settimeout(60)
            conn.connect(str(EGRESS_CONTROL))
            conn.sendall(b'{"op": "approvals.watch"}\n')
            while block := conn.recv(65536):
                sys.stdout.buffer.write(block)
                sys.stdout.buffer.flush()
    except OSError:
        raise Failure('EGRESS_UNAVAILABLE') from None


def approvals_decide(approval_id, verdict):
    if not re.fullmatch(r'[0-9a-f]{16}', approval_id) or verdict not in ('allow', 'deny'):
        raise Failure('USAGE')
    emit(egress({'op': 'approvals.decide', 'id': approval_id, 'allow': verdict == 'allow'}))


# ── images ──────────────────────────────────────────────────


def base_version():
    env = cell_env()
    return f'codex-{env["ANCHI_CODEX_VERSION"]}-claude-{env["ANCHI_CLAUDE_VERSION"]}'


def layer_dir(image, digest):
    if image == BASE_IMAGE:
        return LAYERS / BASE_IMAGE / base_version()
    return LAYERS / image / digest


def layer_meta(image, digest):
    try:
        meta = json.loads((layer_dir(image, digest) / 'meta.json').read_text())
    except (OSError, ValueError):
        return None
    # A recipe layer only fits the base it was built on.
    if not meta.get('ok') or (image != BASE_IMAGE and meta.get('base') != base_version()):
        return None
    return meta


def lowerdirs(image, digest):
    base = layer_meta(BASE_IMAGE, 'base')
    if base is None:
        raise Failure('BASE_IMAGE_NOT_BUILT')
    dirs = [layer_dir(BASE_IMAGE, 'base') / 'upper']
    if image != BASE_IMAGE:
        if layer_meta(image, digest) is None:
            raise Failure('IMAGE_NOT_BUILT')
        dirs.insert(0, layer_dir(image, digest) / 'upper')
    return ':'.join(str(d) for d in [*dirs, BASE])


def recipe_script(recipe):
    """Shell script for a recipe. Package names are validated; commands are the user's own."""
    packages = recipe.get('packages', [])
    commands = recipe.get('run', [])
    if not isinstance(packages, list) or not all(
        isinstance(p, str) and re.fullmatch(r'[a-z0-9][a-z0-9+.-]{0,99}', p) for p in packages
    ):
        raise Failure('BAD_PACKAGES')
    if not isinstance(commands, list) or not all(isinstance(c, str) and 0 < len(c) <= 4000 for c in commands):
        raise Failure('BAD_COMMANDS')
    lines = [
        '#!/bin/sh',
        'set -eu',
        'export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/node/bin',
        'export DEBIAN_FRONTEND=noninteractive HOME=/root',
        '. /run/anchi-build/env',
    ]
    if packages:
        lines += [
            'apt-get update -qq',
            'apt-get install -y -qq --no-install-recommends ' + ' '.join(packages),
            'rm -rf /var/lib/apt/lists/* /var/cache/apt/*.bin',
        ]
    for i, command in enumerate(commands):
        lines += [f'echo "recipe: step {i + 1}/{len(commands)}"', f"sh -ec {shell_quote(command)}"]
    lines.append('echo "recipe: done"')
    return '\n'.join(lines) + '\n'


def shell_quote(value):
    return "'" + value.replace("'", "'\"'\"'") + "'"


def proxy_env():
    env = {
        'HTTPS_PROXY': PROXY,
        'HTTP_PROXY': PROXY,
        'https_proxy': PROXY,
        'http_proxy': PROXY,
        'NO_PROXY': 'localhost,127.0.0.1',
        'no_proxy': 'localhost,127.0.0.1',
    }
    for var in (
        'SSL_CERT_FILE',
        'NODE_EXTRA_CA_CERTS',
        'REQUESTS_CA_BUNDLE',
        'AWS_CA_BUNDLE',
        'CURL_CA_BUNDLE',
        'GIT_SSL_CAINFO',
    ):
        env[var] = CA_IN_CELL
    return env


def image_build(image, digest):
    name(image, 'BAD_IMAGE')
    if not HASH.fullmatch(digest) or (digest == 'base') != (image == BASE_IMAGE):
        raise Failure('BAD_HASH')
    if image == BASE_IMAGE:
        script = (LIB / 'build-base.sh').read_text()
        lower = str(BASE)
    else:
        raw = sys.stdin.buffer.read(256 * 1024 + 1)
        if len(raw) > 256 * 1024:
            raise Failure('INPUT_TOO_LARGE')
        recipe = json.loads(raw)
        if not isinstance(recipe, dict) or set(recipe) - {'packages', 'run'}:
            raise Failure('BAD_RECIPE')
        script = recipe_script(recipe)
        lower = lowerdirs(BASE_IMAGE, 'base')
    target = layer_dir(image, digest)
    building = target.with_name(target.name + '.building')
    task = 'build-' + hashlib.sha256(f'{image}/{digest}/{time.time()}'.encode()).hexdigest()[:12]
    work = CELLS / task
    shutil.rmtree(building, ignore_errors=True)
    building.mkdir(parents=True)
    (building / 'upper').mkdir()
    (building / 'work').mkdir()
    work.mkdir(parents=True, mode=0o700)
    merged = work / 'root'
    merged.mkdir()
    build_dir = work / 'build'
    build_dir.mkdir()
    (build_dir / 'build.sh').write_text(script)
    env = cell_env()
    (build_dir / 'env').write_text(
        ''.join(
            f'export {k}={shell_quote(v)}\n' for k, v in env.items() if k.startswith(('ANCHI_CODEX', 'ANCHI_CLAUDE'))
        )
        + ''.join(f'export {k}={shell_quote(v)}\n' for k, v in proxy_env().items())
    )
    log_path = building / 'build.log'
    started = time.time()
    ok = False
    registered = False
    try:
        run(
            'mount',
            '-t',
            'overlay',
            'overlay',
            '-o',
            f'lowerdir={lower},upperdir={building / "upper"},workdir={building / "work"}',
            str(merged),
        )
        egress({'op': 'register', 'task': task, 'agent': 'image-builder', 'connectors': []})
        registered = True
        command = [
            'systemd-run',
            '--quiet',
            f'--unit={unit(task)}',
            '--collect',
            '--wait',
            '--pipe',
            '--service-type=exec',
            '--property=MemoryMax=3G',
            '--property=MemorySwapMax=0',
            '--property=TasksMax=1024',
            '--property=RuntimeMaxSec=3600',
            '/usr/bin/systemd-nspawn',
            '--quiet',
            '--register=no',
            '--settings=no',
            f'--machine=anchi-{task}',
            f'--directory={merged}',
            f'--private-users={env["SECURE_CELL_UID_BASE"]}:{env["SECURE_CELL_UID_COUNT"]}',
            '--private-users-ownership=off',
            '--private-network',
            '--no-new-privileges=yes',
            '--console=pipe',
            f'--bind-ro={EGRESS_CELLS / task}:/run/anchi',
            f'--bind-ro={build_dir}:/run/anchi-build',
            f'--bind-ro={LIB}:/opt/anchi',
            f'--bind-ro={CA_BUNDLE}:/run/anchi-ca/bundle.pem',
            f'--bind-ro={PROXY_CA}:/run/anchi-ca/proxy.pem',
            '--tmpfs=/tmp:mode=1777',
            '--',
            '/bin/sh',
            '-c',
            # Copied, not bound: a package update that regenerates the bundle keeps the proxy CA.
            'install -D -m 0644 /run/anchi-ca/proxy.pem /usr/local/share/ca-certificates/anchi-proxy.crt; '
            'cp /run/anchi-ca/bundle.pem /etc/ssl/certs/ca-certificates.crt; '
            # apt pipelines requests by default, which stalls behind an intercepting proxy.
            'printf \'Acquire::http::Pipeline-Depth "0";\\nAcquire::http::Proxy "%s";\\n\' '
            f'{PROXY} >/etc/apt/apt.conf.d/90anchi-proxy; '
            '/opt/node/bin/node /opt/anchi/forward.mjs & sleep 0.3; sh /run/anchi-build/build.sh',
        ]
        with log_path.open('w') as log:
            result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
        ok = result.returncode == 0
    finally:
        if mounted(merged):
            run('umount', str(merged), check=False)
        if registered:
            try:
                egress({'op': 'unregister', 'task': task})
            except Failure:
                pass
        shutil.rmtree(work, ignore_errors=True)
    shutil.rmtree(building / 'work', ignore_errors=True)
    # Layers never carry the proxy CA; task cells get the current bundle bound read-only.
    for relative in BUILD_CA_PATHS:
        stale = building / 'upper' / relative
        if stale.is_symlink() or stale.is_file():
            stale.unlink()
    size = int(run('du', '-sb', str(building / 'upper')).stdout.split()[0])
    meta = {
        'image': image,
        'hash': digest,
        'ok': ok,
        'base': base_version(),
        'built_at': started,
        'seconds': round(time.time() - started, 1),
        'size': size,
        'log': str(target / 'build.log'),
    }
    (building / 'meta.json').write_text(json.dumps(meta))
    if ok:
        shutil.rmtree(target, ignore_errors=True)
        building.rename(target)
    else:
        meta['log'] = str(log_path)
    emit(meta if ok else {**meta, 'error': 'IMAGE_BUILD_FAILED', 'tail': log_path.read_text()[-4000:]})
    if not ok:
        sys.exit(1)


def image_status(image, digest):
    name(image, 'BAD_IMAGE')
    if not HASH.fullmatch(digest):
        raise Failure('BAD_HASH')
    meta = layer_meta(image, digest)
    emit({'present': meta is not None, 'meta': meta})


def image_list():
    out = []
    for meta_file in sorted(LAYERS.glob('*/*/meta.json')):
        try:
            out.append(json.loads(meta_file.read_text()))
        except ValueError:
            continue
    emit({'images': out})


def image_remove(image):
    name(image, 'BAD_IMAGE')
    if image == BASE_IMAGE:
        raise Failure('BASE_IMAGE_PROTECTED')
    in_use = [m for m in cell_metas() if m.get('image') == image]
    if in_use:
        raise Failure('IMAGE_IN_USE')
    shutil.rmtree(LAYERS / image, ignore_errors=True)
    emit({'removed': image})


# ── cells ──────────────────────────────────────────────────


def cell_metas():
    out = []
    for meta_file in sorted(CELLS.glob('*/meta.json')):
        try:
            out.append(json.loads(meta_file.read_text()))
        except ValueError:
            continue
    return out


def agent_home(agent, uid):
    home = HOMES / agent / 'home'
    if not home.exists():
        home.mkdir(parents=True, mode=0o700)
        os.chown(home, uid, uid)
    # Root-owned parents; the home itself belongs to the mapped agent user.
    os.chmod(HOMES / agent, 0o755)
    return home


def write_owned(path, text, uid, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    os.chown(path.parent, uid, uid)
    if path.is_symlink() or (path.exists() and not path.is_file()):
        path.unlink()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'w') as file:
        os.fchown(file.fileno(), uid, uid)
        file.write(text)


def fake_jwt(claims):
    import base64

    def enc(obj):
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b'=').decode()

    return f'{enc({"alg": "none", "typ": "JWT"})}.{enc(claims)}.{PLACEHOLDER}'


def codex_placeholder(account):
    """auth.json with placeholders only. The account id is an identifier, not an authenticator:
    Codex checks it locally against routing discovery, so the cell gets the real value."""
    exp = int(time.time()) + 30 * 86400
    claims = {'chatgpt_plan_type': 'plus', 'chatgpt_account_id': account}
    tokens = {
        'id_token': fake_jwt(
            {'email': f'{PLACEHOLDER}@example.invalid', 'exp': exp, 'https://api.openai.com/auth': claims}
        ),
        'access_token': fake_jwt({'exp': exp, 'https://api.openai.com/auth': claims}),
        'refresh_token': PLACEHOLDER,
        'account_id': account,
    }
    now = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    return json.dumps({'OPENAI_API_KEY': None, 'tokens': tokens, 'last_refresh': now})


def cell_environment(task, agent, connectors, identifiers, runtime='codex'):
    env = {
        'HOME': '/home/agent',
        'USER': 'agent',
        'PATH': '/usr/local/bin:/usr/bin:/bin:/opt/codex/bin:/opt/node/bin',
        'LANG': 'C.UTF-8',
        'CODEX_HOME': '/home/agent/.codex',
        'ANCHI_TASK': task,
        'ANCHI_AGENT': agent,
        'GIT_AUTHOR_NAME': f'{agent} (Anchi agent)',
        'GIT_AUTHOR_EMAIL': f'{agent}@agents.anchi.invalid',
        'GIT_COMMITTER_NAME': f'{agent} (Anchi agent)',
        'GIT_COMMITTER_EMAIL': f'{agent}@agents.anchi.invalid',
        'GIT_TERMINAL_PROMPT': '0',
        'ANCHI_RUNTIME': runtime,
        **proxy_env(),
    }
    if runtime == 'claude-code':
        name, placeholder = CLAUDE_PLACEHOLDERS[identifiers['claude_kind']]
        env[name] = placeholder
        env['PATH'] = '/opt/claude/bin:' + env['PATH']
        env['CLAUDE_CONFIG_DIR'] = '/home/agent/.claude'
        # No auto-update (the image is pinned) and no telemetry or error reporting.
        env['DISABLE_AUTOUPDATER'] = '1'
        env['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'] = '1'
        # Delegation tools wait for another agent's turn (bounded by the daemon at 55 minutes).
        env['MCP_TOOL_TIMEOUT'] = '3600000'
    if 'github' in connectors:
        env['GH_TOKEN'] = f'{PLACEHOLDER}-github'
        env['GH_PROMPT_DISABLED'] = '1'
    if 'aws' in connectors:
        env['AWS_ACCESS_KEY_ID'] = PLACEHOLDER_AWS_KEY
        env['AWS_SECRET_ACCESS_KEY'] = f'{PLACEHOLDER}-aws-secret'
        env['AWS_EC2_METADATA_DISABLED'] = 'true'
        if identifiers.get('aws_region'):
            env['AWS_REGION'] = env['AWS_DEFAULT_REGION'] = identifiers['aws_region']
    if 'linear' in connectors:
        env['LINEAR_API_KEY'] = f'lin_api_{PLACEHOLDER.replace("-", "")}0000'
    return env


def ensure_bwrap_profile():
    """Opt-in for codex-workspace-write: lets bwrap (only) create user namespaces, which
    Ubuntu's apparmor_restrict_unprivileged_userns otherwise blocks. Loaded for the VM."""
    text = 'abi <abi/4.0>,\ninclude <tunables/global>\nprofile anchi-cell-bwrap /usr/bin/bwrap flags=(unconfined) {\n  userns,\n}\n'
    if not APPARMOR_PROFILE.exists() or APPARMOR_PROFILE.read_text() != text:
        APPARMOR_PROFILE.write_text(text)
        run('apparmor_parser', '-r', str(APPARMOR_PROFILE))


def cleanup(task):
    """Idempotent: stop the unit, unregister from the proxy, unmount, remove run state."""
    work = CELLS / task
    if active(unit(task)):
        run('systemctl', 'stop', unit(task), check=False)
    run('systemctl', 'reset-failed', unit(task), check=False)
    try:
        egress({'op': 'unregister', 'task': task})
    except Failure:
        pass
    root = work / 'root'
    for _ in range(5):
        if not mounted(root):
            break
        run('umount', str(root), check=False)
        time.sleep(0.2)
    if mounted(root):
        run('umount', '-l', str(root), check=False)
    shutil.rmtree(work, ignore_errors=True)


RUNTIMES = {'codex': 'codex', 'claude-code': 'claude'}  # agent runtime -> proxy grant
CLAUDE_PLACEHOLDERS = {
    'oauth': ('CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat01-anchi-placeholder-' + '0' * 40),
    'api_key': ('ANTHROPIC_API_KEY', 'sk-ant-api03-anchi-placeholder-' + '0' * 40),
}


WORKSPACE_ROOT = Path('/mnt/anchi-host')
WORKSPACE_SEGMENT = re.compile(r'^[A-Za-z0-9._ -]{1,100}$')
# Paths in a writable workspace that make the Mac run code later; mounted read-only over it.
WORKSPACE_MASKS = ('.gitattributes', '.envrc', '.vscode', '.idea')
GIT_MASKS = ('hooks', 'config', 'info')
MAX_REPO_DEPTH = 4


def parse_workspaces(arg):
    """[(name, absolute host path in the VM, mode)] from base64url JSON, checked again here: the
    daemon is trusted, but this command is the boundary the cell's mounts depend on."""
    import base64

    if arg == '-':
        return []
    try:
        items = json.loads(base64.urlsafe_b64decode(arg + '=' * (-len(arg) % 4)))
    except ValueError:
        raise Failure('BAD_WORKSPACES') from None
    if not isinstance(items, list) or len(items) > 10:
        raise Failure('BAD_WORKSPACES')
    if items and not os.path.ismount(WORKSPACE_ROOT):
        raise Failure('WORKSPACES_NOT_MOUNTED')
    out, names = [], set()
    for item in items:
        if not isinstance(item, dict) or set(item) != {'name', 'path', 'mode'}:
            raise Failure('BAD_WORKSPACES')
        name, path, mode = item['name'], item['path'], item['mode']
        parts = path.split('/') if isinstance(path, str) else []
        if (
            not isinstance(name, str)
            or not NAME.fullmatch(name)
            or name in names
            or mode not in ('ro', 'rw')
            or not parts
            or any(p in ('.', '..') or not WORKSPACE_SEGMENT.fullmatch(p) for p in parts)
        ):
            raise Failure('BAD_WORKSPACES')
        full = WORKSPACE_ROOT.joinpath(*parts)
        # No symlink anywhere on the way: the real path must be the path as written.
        if os.path.realpath(full) != str(full) or not full.is_dir():
            raise Failure(f'WORKSPACE_NOT_A_DIRECTORY:{name}')
        names.add(name)
        out.append((name, full, mode))
    return out


def workspace_masks(full):
    """Existing paths under a writable workspace to mount read-only: git hooks, config and
    info of repositories near the top, and editor and shell configuration that runs commands."""
    masks = []
    for current, dirs, _files in os.walk(full):
        depth = len(Path(current).relative_to(full).parts)
        if '.git' in dirs and (Path(current) / '.git').is_dir() and not (Path(current) / '.git').is_symlink():
            masks += [Path(current) / '.git' / m for m in GIT_MASKS if (Path(current) / '.git' / m).exists()]
        masks += [Path(current) / m for m in WORKSPACE_MASKS if (Path(current) / m).exists()]
        dirs[:] = [d for d in dirs if depth < MAX_REPO_DEPTH and not d.startswith('.') and d != 'node_modules']
    return [m for m in masks if not m.is_symlink()]


def workspace_binds(workspaces):
    binds = []
    for name, full, mode in workspaces:
        inside = f'/home/agent/workspaces/{name}'
        binds.append(f'--bind{"" if mode == "rw" else "-ro"}={full}:{inside}')
        if mode == 'rw':
            binds += [f'--bind-ro={m}:{inside}/{m.relative_to(full)}' for m in workspace_masks(full)]
    return binds


def cell_start(task, agent, image, digest, connectors_arg, sandbox, runtime='codex', ask_arg='-', workspaces_arg='-'):
    name(task, 'BAD_TASK')
    name(agent, 'BAD_AGENT')
    name(image, 'BAD_IMAGE')
    if not HASH.fullmatch(digest):
        raise Failure('BAD_HASH')
    connectors = [] if connectors_arg == '-' else connectors_arg.split(',')
    if not all(c in CONNECTORS for c in connectors) or len(set(connectors)) != len(connectors):
        raise Failure('BAD_CONNECTORS')
    if sandbox not in SANDBOXES:
        raise Failure('BAD_SANDBOX')
    if runtime not in RUNTIMES or (runtime != 'codex' and sandbox != 'cell'):
        raise Failure('BAD_RUNTIME')
    workspaces = parse_workspaces(workspaces_arg)
    ask = [] if ask_arg == '-' else ask_arg.split(',')
    if not all(c in connectors for c in ask) or len(set(ask)) != len(ask):
        raise Failure('BAD_APPROVALS')
    env = cell_env()
    uid = int(env['SECURE_CELL_UID_BASE']) + int(env['SECURE_CELL_AGENT_UID'])
    work = CELLS / task
    CELLS.mkdir(parents=True, exist_ok=True)
    with (RUN / 'lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if work.exists() or active(unit(task)):
            raise Failure('TASK_CELL_EXISTS')
        if len([d for d in CELLS.iterdir() if d.is_dir()]) >= MAX_CELLS:
            raise Failure('TOO_MANY_CELLS')
        lower = lowerdirs(image, digest)
        work.mkdir(mode=0o700)
        (work / 'meta.json').write_text(
            json.dumps(
                {
                    'task': task,
                    'agent': agent,
                    'image': image,
                    'hash': digest,
                    'connectors': connectors,
                    'sandbox': sandbox,
                    'runtime': runtime,
                    'workspaces': [{'name': n, 'path': str(f), 'mode': m} for n, f, m in workspaces],
                    'started_at': time.time(),
                }
            )
        )
    try:
        root = work / 'root'
        root.mkdir()
        run('mount', '-t', 'overlay', 'overlay', '-o', f'ro,lowerdir={lower}', str(root))
        proxied = [c for c in connectors if c in PROXY_CONNECTORS]
        registration = egress(
            {
                'op': 'register',
                'task': task,
                'agent': agent,
                'connectors': proxied,
                'runtime': RUNTIMES[runtime],
                'ask': [c for c in ask if c in PROXY_CONNECTORS],
            }
        )
        identifiers = registration.get('identifiers', {})
        home = agent_home(agent, uid)
        if runtime == 'codex':
            if not identifiers.get('codex_account_id'):
                raise Failure('CODEX_NOT_CONFIGURED')
            write_owned(home / '.codex/auth.json', codex_placeholder(identifiers['codex_account_id']), uid)
            write_owned(home / '.codex/config.toml', CODEX_CONFIG, uid)
        elif identifiers.get('claude_kind') not in CLAUDE_PLACEHOLDERS:
            raise Failure('CLAUDE_NOT_CONFIGURED')
        if sandbox == 'codex-workspace-write':
            ensure_bwrap_profile()
        cell = cell_environment(task, agent, connectors, identifiers, runtime)
        if workspaces:
            # virtiofs shows files as owned by their reader; git would refuse every workspace.
            # The check protects a trusting user from an untrusted repository, and here the agent
            # is the untrusted side.
            cell.update(GIT_CONFIG_COUNT='1', GIT_CONFIG_KEY_0='safe.directory', GIT_CONFIG_VALUE_0='*')
        command = [
            'systemd-run',
            '--quiet',
            f'--unit={unit(task)}',
            '--collect',
            '--wait',
            '--pipe',
            '--service-type=exec',
            '--property=MemoryMax=2G',
            '--property=MemorySwapMax=0',
            '--property=TasksMax=512',
            '--property=CPUQuota=200%',
            '--property=RuntimeMaxSec=86400',
            '--property=RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK',
            '/usr/bin/systemd-nspawn',
            '--quiet',
            '--register=no',
            '--settings=no',
            f'--machine=anchi-{task}',
            f'--directory={root}',
            '--volatile=overlay',
            f'--private-users={env["SECURE_CELL_UID_BASE"]}:{env["SECURE_CELL_UID_COUNT"]}',
            '--private-users-ownership=off',
            '--private-network',
            '--user=agent',
            '--drop-capability=all',
            '--no-new-privileges=yes',
            '--console=pipe',
            '--chdir=/home/agent',
            f'--bind={home}:/home/agent',
            f'--bind-ro={EGRESS_CELLS / task}:/run/anchi',
            f'--bind-ro={LIB}:/opt/anchi',
            f'--bind-ro={CA_BUNDLE}:{CA_IN_CELL}',
            # The agent's skills: a Claude Code plugin root, whose skills/ Codex reads too.
            *(
                [
                    f'--bind-ro={SKILLS / agent}:/opt/anchi-skills',
                    f'--bind-ro={SKILLS / agent}/skills:/home/agent/.codex/skills',
                ]
                if (SKILLS / agent / 'skills').is_dir()
                else []
            ),
            # The agent's directories of the Mac, with the code-running paths of rw ones read-only.
            *workspace_binds(workspaces),
            # Only the agent's own connector services; their sockets check policy themselves.
            *[
                f'--bind-ro=/run/secure-{c}:/run/anchi-connectors/{c}'
                for c in connectors
                if c in SERVICE_CONNECTORS and Path(f'/run/secure-{c}').is_dir()
            ],
            '--tmpfs=/tmp:mode=1777,size=512M',
            '--tmpfs=/var/tmp:mode=1777,size=512M',
            '--system-call-filter=~io_uring_setup io_uring_enter io_uring_register bpf perf_event_open',
            *[f'--setenv={k}={v}' for k, v in cell.items()],
            '--',
            '/opt/node/bin/node',
            '/opt/anchi/runner.mjs',
        ]
    except BaseException:
        cleanup(task)
        raise

    def stop(signum, frame):
        cleanup(task)
        sys.exit(128 + signum)

    for signum in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(signum, stop)
    try:
        # The runner's stdin/stdout are ours: the daemon talks to it through this process.
        result = subprocess.run(command)
    finally:
        cleanup(task)
    sys.exit(result.returncode)


def cell_stop(task):
    name(task, 'BAD_TASK')
    existed = (CELLS / task).exists()
    cleanup(task)
    emit({'stopped': existed})


def cell_list():
    cells = []
    for meta in cell_metas():
        meta['active'] = active(unit(meta['task']))
        cells.append(meta)
    emit({'cells': cells})


def cell_reap(keep):
    for task in keep:
        name(task, 'BAD_TASK')
    reaped = []
    if CELLS.exists():
        for work in CELLS.iterdir():
            if work.is_dir() and work.name not in keep:
                cleanup(work.name)
                reaped.append(work.name)
    try:
        for task in egress({'op': 'list'}):
            if task not in keep and not (CELLS / task).exists():
                egress({'op': 'unregister', 'task': task})
                reaped.append(task)
    except Failure:
        pass
    stale = [
        line.split()[1]
        for line in Path('/proc/mounts').read_text().splitlines()
        if line.split()[1].startswith(str(CELLS) + '/')
    ]
    for mount_point in stale:
        run('umount', '-l', mount_point, check=False)
    emit({'reaped': sorted(set(reaped)), 'unmounted': stale})


def cell_leader(task):
    """Host PID of the cell's init process (PID 1 inside the cell): a child of systemd-nspawn."""
    pid = run('systemctl', 'show', '-p', 'MainPID', '--value', unit(task)).stdout.strip()
    if not pid or pid == '0':
        raise Failure('CELL_NOT_RUNNING')
    try:
        children = Path(f'/proc/{pid}/task/{pid}/children').read_text().split()
    except OSError:
        raise Failure('CELL_NOT_RUNNING') from None
    for candidate in children:
        try:
            status = Path(f'/proc/{candidate}/status').read_text()
        except OSError:
            continue
        nspid = re.search(r'^NSpid:\s+(.+)$', status, re.M)
        if nspid and len(nspid.group(1).split()) > 1 and nspid.group(1).split()[-1] == '1':
            return int(candidate)
    raise Failure('CELL_NOT_RUNNING')


def cell_pids(leader):
    namespace = os.readlink(f'/proc/{leader}/ns/pid')
    pids = []
    for entry in Path('/proc').iterdir():
        if entry.name.isdigit():
            try:
                if os.readlink(entry / 'ns/pid') == namespace:
                    pids.append(int(entry.name))
            except OSError:
                continue
    return pids


def cell_exec(task, command):
    name(task, 'BAD_TASK')
    if not command:
        raise Failure('BAD_COMMAND')
    leader = cell_leader(task)
    env = dict(line.split('=', 1) for line in Path(f'/proc/{leader}/environ').read_text().split('\0') if '=' in line)
    result = subprocess.run(
        [
            'nsenter',
            f'--target={leader}',
            '--all',
            '--setuid=1000',
            '--setgid=1000',
            '--wdns=/home/agent',
            'env',
            '-i',
            *[f'{k}={v}' for k, v in env.items()],
            *command,
        ],
        stdin=subprocess.DEVNULL,
    )
    sys.exit(result.returncode)


def real_secrets():
    """Real credential values from the vault, for the invariant scan only. Never printed."""
    sys.path.insert(0, str(SERVICES))
    import auth
    import vault

    secrets = {}
    with auth.locked():
        for label, file, keys in (
            ('github', 'github.json', ('token',)),
            ('linear', 'linear.json', ('token',)),
            ('aws', 'aws.json', ('access_key_id', 'secret_access_key', 'session_token')),
            ('codex', 'codex.json', ('access_token',)),
            ('claude', 'claude.json', ('token',)),
        ):
            if not vault.exists(auth.STORE, file):
                continue
            value = vault.read(auth.STORE, file)
            for key in keys:
                if isinstance(value.get(key), str) and len(value[key]) >= 12:
                    secrets[f'{label}.{key}'] = value[key].encode()
    return secrets


def cell_scan(task):
    """Credential-invariant scan of a running cell: process environments and command lines, and
    every readable file in the cell's root (its writable layers and the agent home)."""
    name(task, 'BAD_TASK')
    leader = cell_leader(task)
    secrets = real_secrets()
    if not secrets:
        raise Failure('NO_CREDENTIALS_TO_SCAN_FOR')
    findings, files, processes = [], 0, 0

    def check(blob, where):
        for label, secret in secrets.items():
            if secret in blob:
                findings.append({'where': where, 'credential': label})

    for pid in cell_pids(leader):
        processes += 1
        for part in ('environ', 'cmdline'):
            try:
                check(Path(f'/proc/{pid}/{part}').read_bytes(), f'process {pid} {part}')
            except OSError:
                continue
    root = Path(f'/proc/{leader}/root')
    for directory, dirnames, filenames in os.walk(root, followlinks=False):
        relative = os.path.relpath(directory, root)
        dirnames[:] = [d for d in dirnames if os.path.normpath(os.path.join(relative, d)) not in SCAN_SKIP]
        for filename in filenames:
            path = Path(directory, filename)
            try:
                if path.is_symlink() or not path.is_file() or path.stat().st_size > SCAN_MAX_FILE:
                    continue
                files += 1
                check(path.read_bytes(), '/' + str(path.relative_to(root)))
            except OSError:
                continue
    emit({'task': task, 'clean': not findings, 'findings': findings, 'files': files, 'processes': processes})


def main(argv):
    program = Path(argv[0]).name
    if os.getuid() != 0:
        raise Failure('GUEST_ADMIN_REQUIRED')
    args = argv[1:]
    if not args:
        raise Failure('USAGE')
    command, rest = args[0], args[1:]
    if program == 'anchi-image':
        if command == 'build' and len(rest) == 2:
            return image_build(*rest)
        if command == 'status' and len(rest) == 2:
            return image_status(*rest)
        if command == 'list' and not rest:
            return image_list()
        if command == 'remove' and len(rest) == 1:
            return image_remove(*rest)
        raise Failure('USAGE')
    if command == 'start' and len(rest) in (6, 7, 8, 9):
        return cell_start(*rest)
    if command == 'skills' and len(rest) == 2 and rest[0] == 'set':
        return skills_set(rest[1])
    if command == 'poll' and not rest:
        # The trigger spec arrives on stdin: {"kind": ..., "params": {...}}.
        spec = json.loads(sys.stdin.read(4096) or '{}')
        return emit(egress({'op': 'poll', 'kind': spec.get('kind'), 'params': spec.get('params')}, timeout=40))
    if command == 'approvals' and rest == ['watch']:
        return approvals_watch()
    if command == 'approvals' and len(rest) == 3 and rest[0] == 'decide':
        return approvals_decide(rest[1], rest[2])
    if command == 'stop' and len(rest) == 1:
        return cell_stop(*rest)
    if command == 'list' and not rest:
        return cell_list()
    if command == 'reap':
        return cell_reap(rest)
    if command == 'scan' and len(rest) == 1:
        return cell_scan(*rest)
    if command == 'verify' and len(rest) == 1 and rest[0] in PROXY_CONNECTORS:
        return emit(egress({'op': 'verify', 'connector': rest[0]}, timeout=40))
    if command == 'exec' and len(rest) >= 3 and rest[1] == '--':
        return cell_exec(rest[0], rest[2:])
    raise Failure('USAGE')


if __name__ == '__main__':
    try:
        main(sys.argv)
    except Failure as exc:
        emit({'error': str(exc)})
        sys.exit(1)
    except (OSError, subprocess.CalledProcessError, ValueError, KeyError) as exc:
        detail = exc.stderr.strip()[-300:] if isinstance(exc, subprocess.CalledProcessError) and exc.stderr else ''
        emit({'error': 'CELL_OPERATION_FAILED', 'detail': detail or type(exc).__name__})
        sys.exit(1)
