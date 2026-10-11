#!/bin/sh
# Runs inside an image build cell as cell root, on top of the base layer. Builds the Claude Code
# runtime layer, the first time an agent of that runtime starts a task. The only network path is
# the egress proxy with no credential injection; nothing here sees a credential.
# Downloads only, never apt: this layer is stacked with image recipes built on the base alone.
set -eu
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/node/bin
. /run/anchi-build/env

# Claude Code: the native binary from its npm platform package, pinned by version and hash.
case $(uname -m) in
  aarch64) cc_pkg=claude-code-linux-arm64 cc_sha=$ANCHI_CLAUDE_SHA256_ARM64 ;;
  x86_64) cc_pkg=claude-code-linux-x64 cc_sha=$ANCHI_CLAUDE_SHA256_X64 ;;
  *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
curl -fsSL --retry 3 -o /var/tmp/claude.tgz \
  "https://registry.npmjs.org/@anthropic-ai/$cc_pkg/-/$cc_pkg-$ANCHI_CLAUDE_VERSION.tgz"
echo "$cc_sha  /var/tmp/claude.tgz" | sha256sum -c - >/dev/null
rm -rf /opt/claude && install -d /opt/claude/bin
tar -xzf /var/tmp/claude.tgz -C /var/tmp package/claude
install -m 0755 /var/tmp/package/claude /opt/claude/bin/claude
rm -rf /var/tmp/claude.tgz /var/tmp/package
ln -sf /opt/claude/bin/claude /usr/local/bin/claude
echo "runtime: $(claude --version 2>&1 | head -1)"
echo "runtime: done"
