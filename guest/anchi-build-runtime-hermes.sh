#!/bin/sh
# Runs inside an image build cell as cell root, on top of the base layer. Builds the Hermes
# runtime layer, the first time an agent of that runtime starts a task. The only network path is
# the egress proxy with no credential injection; nothing here sees a credential.
# Downloads only, never apt: this layer is stacked with image recipes built on the base alone.
set -eu
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/node/bin
. /run/anchi-build/env

case $(uname -m) in
  aarch64) uv_target=aarch64-unknown-linux-gnu uv_sha=$ANCHI_UV_SHA256_ARM64 ;;
  x86_64) uv_target=x86_64-unknown-linux-gnu uv_sha=$ANCHI_UV_SHA256_X64 ;;
  *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
work=/var/tmp/hermes-build
rm -rf "$work" && mkdir -p "$work"

# uv, pinned by version and hash; used at build time only.
curl -fsSL --retry 3 -o "$work/uv.tgz" \
  "https://github.com/astral-sh/uv/releases/download/$ANCHI_UV_VERSION/uv-$uv_target.tar.gz"
echo "$uv_sha  $work/uv.tgz" | sha256sum -c - >/dev/null
tar -xzf "$work/uv.tgz" -C "$work"
uv="$work/uv-$uv_target/uv"

# Hermes's source at the pinned commit, checked by hash.
curl -fsSL --retry 3 -o "$work/hermes.tgz" \
  "https://codeload.github.com/NousResearch/hermes-agent/tar.gz/$ANCHI_HERMES_COMMIT"
echo "$ANCHI_HERMES_SHA256  $work/hermes.tgz" | sha256sum -c - >/dev/null
rm -rf /opt/hermes && install -d /opt/hermes
tar -xzf "$work/hermes.tgz" -C /opt/hermes --strip-components=1

# Its dependencies exactly as uv.lock pins them (hashes included), with the ACP extra the cell
# runner drives it through, on the base's Python; no interpreter is downloaded.
(cd /opt/hermes && UV_NO_CONFIG=1 UV_PROJECT_ENVIRONMENT=/opt/hermes/venv UV_PYTHON_DOWNLOADS=never \
  UV_CACHE_DIR="$work/cache" "$uv" sync -q --frozen --no-dev --extra acp --python /usr/bin/python3)
ln -sf /opt/hermes/venv/bin/hermes /usr/local/bin/hermes
rm -rf "$work"
echo "runtime: hermes $ANCHI_HERMES_VERSION; $(/opt/hermes/venv/bin/python --version)"
echo "runtime: done"
