#!/bin/sh
# Runs inside an image build cell as cell root (user-namespaced, no capabilities on the VM).
# Builds the built-in `codex` image layer. The only network path is the egress proxy with no
# credential injection; nothing here sees a credential.
set -eu
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/node/bin
export DEBIAN_FRONTEND=noninteractive
. /run/anchi-build/env

if ! ls /etc/apt/sources.list.d/*.sources /etc/apt/sources.list >/dev/null 2>&1; then
  printf 'deb http://deb.debian.org/debian bookworm main\ndeb http://deb.debian.org/debian-security bookworm-security main\n' >/etc/apt/sources.list
fi
apt-get update -qq
# git and gh for developer agents; bubblewrap for the codex-workspace-write sandbox opt-in.
apt-get install -y -qq --no-install-recommends \
  git gh bubblewrap curl ca-certificates jq less procps unzip xz-utils openssh-client >/dev/null
rm -rf /var/lib/apt/lists/* /var/cache/apt/*.bin
echo "base: $(git --version); $(gh --version | head -1)"

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

# Agent home mount point; Codex refuses to create helpers under /tmp.
install -d -o 1000 -g 1000 -m 0700 /home/agent
usermod -d /home/agent agent 2>/dev/null || true
git config --system url."https://github.com/".insteadOf git@github.com:
git config --system --add url."https://github.com/".insteadOf ssh://git@github.com/
echo "base: done"
