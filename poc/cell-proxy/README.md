# PoC: egress proxy inside the VM, reached from a `--private-network` cell

Moves the [egress-proxy](../egress-proxy/) addon into `secure-vm` and checks three things:

- whether a cell with only loopback networking can reach the proxy through a Unix socket
- whether every other route stays closed
- how long a per-task cell takes to start

Only fake credentials are used. A 401 from GitHub proves the request went through the proxy and was injected.

| File | Role |
|---|---|
| `vm-setup.sh` | Guest root. Installs mitmproxy into `/opt/anchi-poc/venv` with a dedicated `anchi-poc` user; touches no existing service, rootfs or nftables rule |
| `vm-run.sh` | Guest root. Starts proxy + bridge as transient units, runs in-cell checks and timing, then stops them |
| `fwd.py` | TCP ⇄ Unix socket forwarder, used on both sides |
| `cell_client.py` | Runs inside the cell |

```bash
limactl copy ../egress-proxy/anchi_inject.py fwd.py cell_client.py vm-setup.sh vm-run.sh secure-vm:/tmp/
limactl shell secure-vm -- sudo bash /tmp/vm-setup.sh /tmp
limactl shell secure-vm -- sudo bash /tmp/vm-run.sh
```

Remove: `limactl shell secure-vm -- sudo bash -c 'userdel anchi-poc; rm -rf /opt/anchi-poc'`.

## Path

```text
cell (loopback only)                         VM
client --HTTPS_PROXY--> 127.0.0.1:3128
  fwd.py tcp-to-unix --> /run/anchi-poc/proxy.sock (bind-ro)
                           fwd.py unix-to-tcp (anchi-poc) --> mitmdump 127.0.0.1:18080 --> internet
```

## Results (2026-10-06, Ubuntu 24.04 guest, systemd 255, Apple Silicon)

All 10 in-cell checks pass:

| Check | Result |
|---|---|
| Unmatched host (`example.com`) through the proxy | 200, logged `passthrough` |
| `api.github.com/user` with placeholder | 401 from GitHub, logged `injected client=placeholder` |
| `POST /user/keys` | 403 from anchi, logged `denied` |
| Direct TCP to `1.1.1.1:443` | `Network is unreachable` |
| DNS lookup | Fails |
| HTTPS without proxy | Fails (no DNS, no route) |
| Proxy to VM `127.0.0.1:22`, VM `127.0.0.1:18080`, Lima host `192.168.5.2`, `169.254.169.254` | 403 `non-public destination` |

Cell start-up, from `systemd-nspawn` to `/bin/true` exit:

| Variant | Time |
|---|---|
| Read-only shared rootfs (current `cell-run`) | 28–48 ms |
| `--volatile=overlay` (tmpfs upper, discarded on exit) | 29–48 ms |
| `--ephemeral` full copy (ext4, no reflink) | 1.6 s warm cache, 9.2 s cold |

With `--volatile=overlay`, writes inside the cell succeed, the shared rootfs is unchanged afterwards and the next cell starts clean.

## Findings

1. **The unix-socket path works.** The cell keeps `--private-network` (loopback only). It reaches the internet only through the proxy, and there is no raw TCP, UDP or DNS. Clients that ignore `HTTPS_PROXY` fail closed. No veth, NAT or nftables change is needed.
2. **SSRF was real, and is now fixed in the PoC.** Before the fix, the passthrough proxy connected to the VM's sshd on the cell's behalf and returned the `SSH-2.0-OpenSSH_9.6p1` banner. It also routed to the Lima host gateway. The addon now refuses every non-public destination. Remaining gap: the proxy checks the resolved address but then lets mitmproxy resolve again on connect, so DNS rebinding is still possible. The production proxy must connect to the address it checked. The proxy UID also needs its own nftables rule that rejects private ranges, as a kernel-level backstop.
3. **Per-task cells cost about 30 ms.** `--volatile=overlay` is as fast as the current read-only cell and gives each task a disposable writable root. Never use `--ephemeral` on ext4. Runtime start-up (Node, Codex) is not included and will dominate.
4. **Per-cell identity can come from the socket.** Give each cell its own socket path, such as `/run/anchi/cells/<task>/proxy.sock`, bound only into that cell. The proxy then knows which agent sent a request without per-cell IPs or UIDs. Not yet built: the PoC uses one shared socket with mode 0666.

## Not covered yet

- **Per-agent image layers.** Test `--overlay=base:agent-layer:/` with a volatile upper layer on top.
- **Real tools inside the cell.** The rootfs has no `git` or `curl`, and the Node/Codex CA environment is unchecked.
- **Real credentials.** That run belongs to the [host PoC](../egress-proxy/README.md) and needs the user's proxy.
- **Concurrent cells.** `cell-run` currently fixes the unit name, which blocks concurrent cells.
