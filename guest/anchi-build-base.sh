#!/bin/sh
# Runs inside an image build cell as cell root (user-namespaced, no capabilities on the VM).
# Builds the built-in `codex` image layer: the runtimes and common developer toolchains. The only network path is the egress proxy with no
# credential injection; nothing here sees a credential.
set -eu
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/node/bin
export DEBIAN_FRONTEND=noninteractive
. /run/anchi-build/env

if ! ls /etc/apt/sources.list.d/*.sources /etc/apt/sources.list >/dev/null 2>&1; then
  printf 'deb http://deb.debian.org/debian bookworm main\ndeb http://deb.debian.org/debian-security bookworm-security main\n' >/etc/apt/sources.list
fi
apt-get update -qq
# git and gh for developer agents; bubblewrap for the codex-workspace-write sandbox opt-in;
# a C toolchain, Python packaging and search tools for building and testing code.
apt-get install -y -qq --no-install-recommends \
  git gh bubblewrap curl ca-certificates jq less procps unzip xz-utils openssh-client \
  build-essential pkg-config libssl-dev python3-dev python3-pip python3-venv \
  ripgrep fd-find sqlite3 zip file patch tree >/dev/null
rm -rf /var/lib/apt/lists/* /var/cache/apt/*.bin
ln -sf /usr/bin/fdfind /usr/local/bin/fd
echo "base: $(git --version); $(gh --version | head -1); $(gcc --version | head -1)"

case $(uname -m) in
  aarch64) target=aarch64-unknown-linux-musl sha=$ANCHI_CODEX_SHA256_ARM64 ;;
  x86_64) target=x86_64-unknown-linux-musl sha=$ANCHI_CODEX_SHA256_X64 ;;
  *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
url="https://github.com/openai/codex/releases/download/rust-v$ANCHI_CODEX_VERSION/codex-package-$target.tar.gz"
curl -fsSL --retry 3 -o /var/tmp/codex.tgz "$url"
echo "$sha  /var/tmp/codex.tgz" | sha256sum -c - >/dev/null
rm -rf /opt/codex && install -d /opt/codex
tar -xzf /var/tmp/codex.tgz -C /opt/codex
rm -f /var/tmp/codex.tgz
# Voice support is unused in cells and is most of the package size.
rm -rf /opt/codex/codex-resources/voice
# Codex finds its helpers next to its own path and re-executes itself as codex-linux-sandbox.
ln -sf codex /opt/codex/bin/codex-linux-sandbox
ln -sf /opt/codex/bin/codex /usr/local/bin/codex
ln -sf /opt/codex/bin/codex-linux-sandbox /usr/local/bin/codex-linux-sandbox
echo "base: $(codex --version)"

# Claude Code: the native binary from its npm platform package, pinned by version and hash.
case $(uname -m) in
  aarch64) cc_pkg=claude-code-linux-arm64 cc_sha=$ANCHI_CLAUDE_SHA256_ARM64 ;;
  x86_64) cc_pkg=claude-code-linux-x64 cc_sha=$ANCHI_CLAUDE_SHA256_X64 ;;
esac
curl -fsSL --retry 3 -o /var/tmp/claude.tgz \
  "https://registry.npmjs.org/@anthropic-ai/$cc_pkg/-/$cc_pkg-$ANCHI_CLAUDE_VERSION.tgz"
echo "$cc_sha  /var/tmp/claude.tgz" | sha256sum -c - >/dev/null
rm -rf /opt/claude && install -d /opt/claude/bin
tar -xzf /var/tmp/claude.tgz -C /var/tmp package/claude
install -m 0755 /var/tmp/package/claude /opt/claude/bin/claude
rm -rf /var/tmp/claude.tgz /var/tmp/package
ln -sf /opt/claude/bin/claude /usr/local/bin/claude
echo "base: $(claude --version 2>&1 | head -1)"

# pnpm, from its npm package (no dependencies), pinned by version and hash.
curl -fsSL --retry 3 -o /var/tmp/pnpm.tgz \
  "https://registry.npmjs.org/pnpm/-/pnpm-$ANCHI_PNPM_VERSION.tgz"
echo "$ANCHI_PNPM_SHA256  /var/tmp/pnpm.tgz" | sha256sum -c - >/dev/null
/opt/node/bin/npm install -g --prefix /usr/local --no-audit --no-fund --no-update-notifier /var/tmp/pnpm.tgz >/dev/null
rm -f /var/tmp/pnpm.tgz
echo "base: node $(/opt/node/bin/node --version); pnpm $(pnpm --version)"

# Go, from go.dev, pinned by version and hash. GOPATH and caches default to the agent home.
case $(uname -m) in
  aarch64) go_arch=arm64 go_sha=$ANCHI_GO_SHA256_ARM64 ;;
  x86_64) go_arch=amd64 go_sha=$ANCHI_GO_SHA256_X64 ;;
esac
curl -fsSL --retry 3 -o /var/tmp/go.tgz "https://go.dev/dl/go$ANCHI_GO_VERSION.linux-$go_arch.tar.gz"
echo "$go_sha  /var/tmp/go.tgz" | sha256sum -c - >/dev/null
rm -rf /usr/local/go && tar -xzf /var/tmp/go.tgz -C /usr/local
rm -f /var/tmp/go.tgz
ln -sf /usr/local/go/bin/go /usr/local/bin/go
ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt
echo "base: $(go version)"

# Rust: rustup pinned by version and hash installs a pinned toolchain into /opt/rustup, read-only
# in task cells (RUSTUP_HOME); cargo's registry and installs go to the agent home (~/.cargo).
case $(uname -m) in
  aarch64) rust_target=aarch64-unknown-linux-gnu rustup_sha=$ANCHI_RUSTUP_SHA256_ARM64 ;;
  x86_64) rust_target=x86_64-unknown-linux-gnu rustup_sha=$ANCHI_RUSTUP_SHA256_X64 ;;
esac
curl -fsSL --retry 3 -o /var/tmp/rustup-init \
  "https://static.rust-lang.org/rustup/archive/$ANCHI_RUSTUP_VERSION/$rust_target/rustup-init"
echo "$rustup_sha  /var/tmp/rustup-init" | sha256sum -c - >/dev/null
chmod 0755 /var/tmp/rustup-init
rm -rf /opt/rustup /opt/cargo
RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo /var/tmp/rustup-init -y -q --no-modify-path \
  --profile minimal --default-toolchain "$ANCHI_RUST_VERSION" -c clippy -c rustfmt >/dev/null
rm -f /var/tmp/rustup-init
for bin in /opt/cargo/bin/*; do ln -sf "$bin" "/usr/local/bin/$(basename "$bin")"; done
echo "base: $(RUSTUP_HOME=/opt/rustup rustc --version); $(RUSTUP_HOME=/opt/rustup cargo --version)"

# Agent home mount point; Codex refuses to create helpers under /tmp.
install -d -o 1000 -g 1000 -m 0700 /home/agent
usermod -d /home/agent agent 2>/dev/null || true
git config --system url."https://github.com/".insteadOf git@github.com:
git config --system --add url."https://github.com/".insteadOf ssh://git@github.com/
echo "base: done"
