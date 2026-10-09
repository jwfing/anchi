#!/bin/sh
# curl -fsSL https://anchi.elseward.xyz/install.sh | sh
set -eu

die() { printf 'anchi: %s\n' "$*" >&2; exit 1; }
fetch() { curl -fsSL --retry 3 --connect-timeout 15 --max-time 300 "$1" -o "$2"; }
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

main() {
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) target=darwin-arm64 ;;
    Linux-x86_64) target=linux-x64 ;;
    *) die 'Supported platforms: Apple Silicon macOS and glibc Linux x86_64.' ;;
  esac
  for tool in curl tar awk sed grep mktemp; do
    command -v "$tool" >/dev/null 2>&1 || die "Required command not found: $tool"
  done
  if command -v sha256sum >/dev/null 2>&1; then
    checksum() { sha256sum "$1" | awk '{print $1}'; }
  elif command -v shasum >/dev/null 2>&1; then
    checksum() { shasum -a 256 "$1" | awk '{print $1}'; }
  else
    die 'SHA-256 verification requires sha256sum or shasum.'
  fi

  base=${ANCHI_INSTALL_ROOT:-$HOME/.local/share/anchi}
  bin=${ANCHI_BIN_DIR:-$HOME/.local/bin}
  # Prefer a writable directory already on PATH so `anchi` works in this shell.
  if [ -z "${ANCHI_BIN_DIR:-}" ]; then
    for candidate in "$HOME/.local/bin" /opt/homebrew/bin /usr/local/bin; do
      case ":$PATH:" in
        *":$candidate:"*)
          if [ -d "$candidate" ] && [ -w "$candidate" ]; then bin=$candidate; break; fi ;;
      esac
    done
  fi
  case "$base:$bin" in *'
'*) die 'Install paths cannot contain line breaks.' ;; esac
  case "$base" in /*) ;; *) die 'ANCHI_INSTALL_ROOT must be absolute.' ;; esac
  case "$bin" in /*) ;; *) die 'ANCHI_BIN_DIR must be absolute.' ;; esac
  mkdir -p "$base/versions" "$bin"
  base=$(CDPATH='' cd -- "$base" && pwd)
  bin=$(CDPATH='' cd -- "$bin" && pwd)
  if [ -e "$bin/anchi" ] || [ -L "$bin/anchi" ]; then
    [ -f "$bin/anchi" ] && grep -q '^# Anchi release launcher$' "$bin/anchi" \
      || die "$bin/anchi already exists and is not managed by this installer. Set ANCHI_BIN_DIR."
  fi
  mkdir "$base/.install-lock" 2>/dev/null || die "Another installation is running (lock: $base/.install-lock)."
  tmp=$(mktemp -d "$base/versions/.install.XXXXXX")
  trap 'rm -rf "$tmp"; rmdir "$base/.install-lock"' EXIT
  trap 'exit 1' HUP INT TERM

  release=${ANCHI_VERSION:-latest}
  case "$release" in
    latest) url=https://github.com/jwfing/anchi/releases/latest/download ;;
    v[0-9]*)
      case "$release" in *[!a-zA-Z0-9.+-]*) die 'Invalid ANCHI_VERSION.' ;; esac
      url=https://github.com/jwfing/anchi/releases/download/$release ;;
    *) die 'ANCHI_VERSION must be latest or a release tag such as v0.2.0.' ;;
  esac
  archive=anchi-$target.tar.gz
  printf 'Downloading Anchi (%s)…\n' "$target"
  fetch "$url/$archive.sha256" "$tmp/checksum" || die 'Release checksum unavailable. No installation was changed.'
  expected=$(awk -v name="$archive" '$2 == name {print $1}' "$tmp/checksum")
  [ "${#expected}" -eq 64 ] || die 'Invalid release checksum.'
  case "$expected" in *[!a-fA-F0-9]*) die 'Invalid release checksum.' ;; esac
  fetch "$url/$archive" "$tmp/package.tar.gz" || die 'Release download failed.'
  [ "$(checksum "$tmp/package.tar.gz")" = "$expected" ] || die 'Checksum mismatch; installation cancelled.'
  tar -xzf "$tmp/package.tar.gz" -C "$tmp"
  for file in runtime/node lib/cli.mjs lib/daemon.mjs manifest.json bin/anchi; do
    [ -f "$tmp/anchi/$file" ] || die "Incomplete release: $file"
  done
  version=$("$tmp/anchi/bin/anchi" --version) || die 'This release cannot run on this system.'
  dest=$(mktemp -d "$base/versions/release.XXXXXX")
  # The version directory is never overwritten: existing daemons can finish their work.
  mv "$tmp/anchi" "$dest/app"
  ln -s "$dest/app" "$tmp/current"
  # rename(2) replaces a symlink atomically on both supported operating systems.
  "$dest/app/runtime/node" -e 'require("fs").renameSync(process.argv[1], process.argv[2])' "$tmp/current" "$base/current"
  {
    printf '#!/bin/sh\n# Anchi release launcher\n'
    printf 'exec %s %s "$@"\n' "$(quote "$base/current/runtime/node")" "$(quote "$base/current/lib/cli.mjs")"
  } > "$tmp/launcher"
  chmod +x "$tmp/launcher"
  # Copy through a temporary file on the bin filesystem, then rename it into place.
  launcher=$(mktemp "$bin/.anchi.XXXXXX")
  cp "$tmp/launcher" "$launcher"
  chmod +x "$launcher"
  mv -f "$launcher" "$bin/anchi"
  printf 'Installed Anchi %s: %s/anchi\n' "$version" "$bin"
  case ":$PATH:" in
    *":$bin:"*) printf 'Run: anchi\n' ;;
    *)
      line="export PATH=$(quote "$bin"):\$PATH"
      case "${SHELL:-}" in
        */zsh) rc=${ZDOTDIR:-$HOME}/.zshrc ;;
        */bash)
          case "$target" in
            darwin-*) rc=$HOME/.bash_profile ;;
            *) rc=$HOME/.bashrc ;;
          esac ;;
        */fish)
          rc=${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/anchi.fish
          mkdir -p "$(dirname "$rc")"
          line="fish_add_path $(quote "$bin")" ;;
        *) rc=$HOME/.profile ;;
      esac
      if ! grep -Fqx "$line" "$rc" 2>/dev/null; then
        printf '\n# Anchi\n%s\n' "$line" >> "$rc"
      fi
      printf 'PATH configured in %s. Open a new terminal, or run:\n  %s\nThen run: anchi\n' "$rc" "$line"
      ;;
  esac
  printf '\nFirst use: open Runtimes in the TUI to install the VM and connect a runtime.\n'
  if ! command -v limactl >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1; then
    case "$target" in
      darwin-*) printf 'VM prerequisites: brew install lima python\n' ;;
      *) printf 'VM prerequisites: Lima, Python 3.11+, QEMU and access to /dev/kvm.\n' ;;
    esac
  fi
  printf 'To update, rerun this installer. After tasks finish, run anchi daemon stop.\nIf login startup is enabled, also rerun anchi daemon install.\n'
}

# Execute only after the complete script has arrived over the pipe.
main "$@"
