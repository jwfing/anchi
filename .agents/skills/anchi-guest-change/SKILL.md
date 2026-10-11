---
name: anchi-guest-change
description: Change the Anchi VM side — guest scripts, the cell manager (guest/anchi_cell.py), the base image build (guest/anchi-build-base.sh), version pins in guest/cell.env, systemd units or the Lima config. Use when bumping Codex, Claude Code, Node or a base-image toolchain, adding a tool to cells, or changing how cells start.
---

# Changing the guest

## Version pins

`guest/cell.env` is the single source of cell UIDs and pinned versions (Node, Codex, Claude Code, pnpm, Go, rustup and Rust), each download with its SHA-256 per architecture. Shell scripts source it, `services/common.py` and tests parse it. Never repeat a version or hash elsewhere.

To bump a pin:

1. Pick a release that is at least a few days old.
2. Get the hash from the publisher (`go.dev/dl/?mode=json`, `static.rust-lang.org/rustup/archive/<v>/<target>/rustup-init.sha256`, the GitHub release, or `sha256sum` of the npm tarball) for both `aarch64` and `x86_64`.
3. Update `cell.env` only. `tests/test_guest.py` checks that every `ANCHI_*` variable the build script uses is defined.

## Base image

`guest/anchi-build-base.sh` runs as root in a build cell whose only network path is the egress proxy without credentials. Every download is pinned and verified with `sha256sum -c`; apt packages come from Debian 12. Put binaries on `/usr/local/bin` (task cells use `PATH=/usr/local/bin:/usr/bin:/bin:/opt/codex/bin:/opt/node/bin`, plus `/opt/claude/bin` for Claude Code) and keep caches out of the layer.

The base layer is named from the Codex and Claude versions and a hash of the build script (`base_version()` in `guest/anchi_cell.py`), so any edit rebuilds it, and the recipe layers on it, at the next task. Mention the rebuild in the changelog.

Test a build script change without a VM in a container that resembles the build cell:

```bash
docker run --rm -v "$PWD/guest:/g:ro" debian:bookworm sh -c '
  apt-get update -qq && apt-get install -y -qq curl xz-utils ca-certificates >/dev/null
  . /g/cell.env
  curl -fsSL https://nodejs.org/dist/v$SECURE_NODE_VERSION/node-v$SECURE_NODE_VERSION-linux-x64.tar.xz | tar -xJ -C /opt && mv /opt/node-v* /opt/node
  useradd -m agent && mkdir -p /run/anchi-build && grep "^ANCHI_" /g/cell.env | sed "s/^/export /" >/run/anchi-build/env
  sh /g/anchi-build-base.sh'
```

Then run the tool as a non-root user, as cells do.

## Cell manager and guest commands

`guest/anchi_cell.py` runs as root in the VM. Every argument from the daemon is validated by regex (ids match `^[a-z0-9][a-z0-9-]{0,39}$`); secrets arrive on stdin; output is JSON. Errors are stable codes (`Failure('BAD_…')`) that the daemon maps to hints in `daemon/src/cell.ts`. Document new commands in the guest command table of `docs/architecture/AGENT_TEAM_CONTRACTS.md`.

## Checks

- Offline: `make check` (Ruff, shellcheck, syntax) and `tests/test_guest.py` for pure functions.
- Live, when you have a VM: `scripts/anchi setup install`, then `make verify-anchi` (cells, proxy, isolation, no credentials). State in the PR whether you ran them.
