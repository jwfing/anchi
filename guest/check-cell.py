"""P1 negative tests: run inside the actual unprivileged runtime cell."""
import errno
import json
import os
from pathlib import Path
import socket
import subprocess

checks = []

def check(name, condition):
    checks.append({"check": name, "passed": bool(condition)})

check("agent_uid_gid", os.getuid() == 1000 and os.getgid() == 1000)
mapping = Path('/proc/self/uid_map').read_text().split()
check("uid_namespace_mapping", mapping == ['0', '524288', '65536'])
status = dict(line.split(':', 1) for line in Path('/proc/self/status').read_text().splitlines() if ':' in line)
check("no_effective_capabilities", int(status['CapEff'].strip(), 16) == 0)
check("no_bounding_capabilities", int(status['CapBnd'].strip(), 16) == 0)
check("no_new_privileges", status['NoNewPrivs'].strip() == '1')
check("seccomp_filter_active", status['Seccomp'].strip() == '2')
check("no_host_canary", not Path('/var/lib/secure-vm-host-only/canary').exists())
check("no_macos_users_mount", not Path('/Users').exists())
check("no_docker_socket", not Path('/var/run/docker.sock').exists())
check("no_host_systemd_socket", not Path('/run/systemd/private').exists())
mounts = Path('/proc/self/mountinfo').read_text().splitlines()
root_mount = next(line.split() for line in mounts if line.split()[4] == '/')
check("rootfs_mounted_readonly", 'ro' in root_mount[5].split(','))
testfile = Path('/workspace/.isolation-write-test')
testfile.write_text('workspace writable\n')
check("workspace_writable", testfile.read_text() == 'workspace writable\n')
testfile.unlink()
interfaces = json.loads(subprocess.check_output(['ip', '-j', 'link']))
check("only_loopback_interface", {i['ifname'] for i in interfaces} == {'lo'})
attempt = subprocess.run(['ip', 'link', 'add', 'escape0', 'type', 'dummy'], capture_output=True)
check("cannot_administer_network", attempt.returncode != 0)
for family, name in [(socket.AF_VSOCK, 'vsock'), (socket.AF_PACKET, 'packet')]:
    blocked = False
    try:
        sock = socket.socket(family, socket.SOCK_STREAM if family == socket.AF_VSOCK else socket.SOCK_RAW)
        sock.close()
    except OSError as exc:
        blocked = exc.errno in (errno.EAFNOSUPPORT, errno.EPERM, errno.EACCES)
    check(f"no_{name}_socket", blocked)
for family, address in [
    (socket.AF_INET, '1.1.1.1'),
    (socket.AF_INET, '192.168.5.2'),
    (socket.AF_INET, '169.254.169.254'),
    (socket.AF_INET6, '2606:4700:4700::1111'),
]:
    for kind, port in [(socket.SOCK_STREAM, 443), (socket.SOCK_DGRAM, 53)]:
        s = socket.socket(family, kind)
        s.settimeout(2)
        blocked = False
        try:
            s.connect((address, port))
            if kind == socket.SOCK_DGRAM:
                s.send(b'isolation-test')
        except OSError as exc:
            blocked = exc.errno in (errno.ENETUNREACH, errno.EHOSTUNREACH, errno.EACCES, errno.EPERM)
        finally:
            s.close()
        check(f"no_egress_{address}_{port}", blocked)
print(json.dumps({"checks": checks, "passed": all(c['passed'] for c in checks)}, indent=2))
raise SystemExit(0 if all(c['passed'] for c in checks) else 1)
