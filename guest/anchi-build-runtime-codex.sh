#!/bin/sh
# Runs inside an image build cell as cell root, on top of the base layer. Builds the Codex
# runtime layer, the first time an agent of that runtime starts a task. The only network path is
# the egress proxy with no credential injection; nothing here sees a credential.
# Downloads only, never apt: this layer is stacked with image recipes built on the base alone.
set -eu
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/node/bin
. /run/anchi-build/env

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
echo "runtime: $(codex --version)"
echo "runtime: done"
