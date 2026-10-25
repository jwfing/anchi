#!/bin/sh
# curl -fsSL https://anchi.elseward.xyz/install.sh | sh
# With the desktop app: curl -fsSL https://anchi.elseward.xyz/install.sh | sh -s -- --desktop
set -eu

die() { printf 'anchi: %s\n' "$*" >&2; exit 1; }
fetch() { curl -fsSL --retry 3 --connect-timeout 15 --max-time 300 "$1" -o "$2"; }
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

main() {
  desktop=${ANCHI_DESKTOP:-0}
  for arg in "$@"; do
    case "$arg" in
      --desktop) desktop=1 ;;
      *) die "Unknown option: $arg (the only option is --desktop)" ;;
    esac
  done
  case "$desktop" in 0|1) ;; *) die 'Invalid ANCHI_DESKTOP.' ;; esac
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
  update_only=${ANCHI_UPDATE_ONLY:-0}
  case "$update_only" in 0|1) ;; *) die 'Invalid update mode.' ;; esac
  if [ "$update_only" = 1 ]; then
    [ -n "${ANCHI_INSTALL_ROOT:-}" ] && [ -L "$base/current" ] || die 'Self-update requires an existing managed installation.'
  fi
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
  mkdir -p "$base/versions"
  if [ "$update_only" = 0 ]; then mkdir -p "$bin"; fi
  base=$(CDPATH='' cd -- "$base" && pwd)
  if [ "$update_only" = 0 ]; then
    bin=$(CDPATH='' cd -- "$bin" && pwd)
    if [ -e "$bin/anchi" ] || [ -L "$bin/anchi" ]; then
      [ -f "$bin/anchi" ] && grep -q '^# Anchi release launcher$' "$bin/anchi" \
        || die "$bin/anchi already exists and is not managed by this installer. Set ANCHI_BIN_DIR."
    fi
  fi
  # A desktop app installed before is updated with the CLI.
  [ -f "$base/desktop" ] && desktop=1
  if [ "$desktop" = 1 ]; then
    case "$target" in
      darwin-*)
        apps=${ANCHI_DESKTOP_DIR:-$HOME/Applications}
        case "$apps" in /*) ;; *) die 'ANCHI_DESKTOP_DIR must be absolute.' ;; esac
        if [ -e "$apps/Anchi.app" ] || [ -L "$apps/Anchi.app" ]; then
          [ "$(plutil -extract CFBundleIdentifier raw "$apps/Anchi.app/Contents/Info.plist" 2>/dev/null)" = dev.anchi.desktop ] \
            || die "$apps/Anchi.app already exists and is not the Anchi desktop app. Set ANCHI_DESKTOP_DIR."
        fi ;;
      *)
        if [ "$update_only" = 0 ] && { [ -e "$bin/anchi-desktop" ] || [ -L "$bin/anchi-desktop" ]; }; then
          [ -f "$bin/anchi-desktop" ] && grep -q '^# Anchi desktop launcher$' "$bin/anchi-desktop" \
            || die "$bin/anchi-desktop already exists and is not managed by this installer. Set ANCHI_BIN_DIR."
        fi ;;
    esac
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
  if [ "$release" != latest ]; then
    [ "$version" = "${release#v}" ] || die 'Release version does not match the requested tag.'
  fi
  if [ "$desktop" = 1 ]; then
    desktop_archive=anchi-desktop-$target.tar.gz
    printf 'Downloading the desktop app (%s)…\n' "$target"
    fetch "$url/$desktop_archive.sha256" "$tmp/desktop-checksum" \
      || die 'Desktop app checksum unavailable (this release may have no desktop app). No installation was changed.'
    expected=$(awk -v name="$desktop_archive" '$2 == name {print $1}' "$tmp/desktop-checksum")
    [ "${#expected}" -eq 64 ] || die 'Invalid desktop app checksum.'
    case "$expected" in *[!a-fA-F0-9]*) die 'Invalid desktop app checksum.' ;; esac
    fetch "$url/$desktop_archive" "$tmp/desktop.tar.gz" || die 'Desktop app download failed.'
    [ "$(checksum "$tmp/desktop.tar.gz")" = "$expected" ] || die 'Desktop app checksum mismatch; installation cancelled.'
    mkdir "$tmp/desktop"
    tar -xzf "$tmp/desktop.tar.gz" -C "$tmp/desktop"
    case "$target" in
      darwin-*)
        [ -x "$tmp/desktop/Anchi.app/Contents/MacOS/Anchi" ] \
          && [ -f "$tmp/desktop/Anchi.app/Contents/Resources/app/main.cjs" ] || die 'Incomplete desktop app.' ;;
      *)
        [ -x "$tmp/desktop/anchi-desktop/anchi-desktop" ] \
          && [ -f "$tmp/desktop/anchi-desktop/resources/app/main.cjs" ] || die 'Incomplete desktop app.'
        # Inside the version directory, so the app switches with the CLI and matches its version.
        mv "$tmp/desktop/anchi-desktop" "$tmp/anchi/desktop" ;;
    esac
  fi
  dest=$(mktemp -d "$base/versions/release.XXXXXX")
  # The version directory is never overwritten: existing daemons can finish their work.
  mv "$tmp/anchi" "$dest/app"
  ln -s "$dest/app" "$tmp/current"
  # rename(2) replaces a symlink atomically on both supported operating systems.
  "$dest/app/runtime/node" -e 'require("fs").renameSync(process.argv[1], process.argv[2])' "$tmp/current" "$base/current"
  # Older versions are listed, never removed: a daemon or login service may still run from one.
  stale=
  for dir in "$base"/versions/release.*; do
    [ -d "$dir" ] || continue
    [ "$dir" = "$dest" ] && continue
    stale="$stale $(quote "$dir")"
  done
  if [ -n "$stale" ]; then
    printf 'Older versions remain under %s; remove them once no daemon or login service runs from them:\n  rm -rf%s\n' "$base/versions" "$stale"
  fi
  if [ "$desktop" = 1 ]; then
    case "$target" in
      darwin-*)
        mkdir -p "$apps"
        staged=$(mktemp -d "$apps/.anchi-desktop.XXXXXX")
        mv "$tmp/desktop/Anchi.app" "$staged/Anchi.app"
        if [ -e "$apps/Anchi.app" ]; then mv "$apps/Anchi.app" "$staged/previous.app"; fi
        mv "$staged/Anchi.app" "$apps/Anchi.app"
        rm -rf "$staged"
        desktop_path=$apps/Anchi.app ;;
      *) desktop_path=$base/current/desktop/anchi-desktop ;;
    esac
    printf '%s\n' "$desktop_path" > "$base/desktop"
    printf 'Installed the Anchi desktop app: %s\n' "$desktop_path"
  fi
  if [ "$update_only" = 1 ]; then
    printf 'Installed Anchi %s.\n' "$version"
    return
  fi
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
  if [ "$desktop" = 1 ] && [ "${target#darwin-}" = "$target" ]; then
    {
      printf '#!/bin/sh\n# Anchi desktop launcher\n'
      printf 'exec %s "$@"\n' "$(quote "$base/current/desktop/anchi-desktop")"
    } > "$tmp/desktop-launcher"
    launcher=$(mktemp "$bin/.anchi-desktop.XXXXXX")
    cp "$tmp/desktop-launcher" "$launcher"
    chmod +x "$launcher"
    mv -f "$launcher" "$bin/anchi-desktop"
    entries=${XDG_DATA_HOME:-$HOME/.local/share}/applications
    mkdir -p "$entries"
    printf '[Desktop Entry]\nType=Application\nName=Anchi\nComment=A secured agent team\nExec="%s"\nIcon=%s\nCategories=Development;\nTerminal=false\n' \
      "$bin/anchi-desktop" "$base/current/desktop/icon.png" > "$entries/anchi.desktop"
    printf 'Desktop app: %s/anchi-desktop, or Anchi in the applications menu.\n' "$bin"
    if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ]; then
      printf 'This system restricts the sandbox the desktop app needs; see\n  https://github.com/jwfing/anchi/blob/main/docs/DESKTOP.md#linux-sandbox\n'
    fi
  fi
  case ":$PATH:" in
    *":$bin:"*) ;;
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
      printf 'PATH configured in %s. Open a new terminal, or run:\n  %s\n' "$rc" "$line"
      ;;
  esac
  printf '\nFirst use: follow Getting started in the TUI to prepare your environment.\n'
  if ! command -v limactl >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1; then
    case "$target" in
      darwin-*) printf 'VM prerequisites: brew install lima python\n' ;;
      *) printf 'VM prerequisites: Lima, Python 3.11+, QEMU and access to /dev/kvm.\n' ;;
    esac
  fi
  printf 'To update, run anchi update (or rerun this installer). After tasks finish, run anchi daemon stop.\nIf login startup is enabled, also rerun anchi daemon install.\n'
  printf '\nRun: anchi\n'
}

# Execute only after the complete script has arrived over the pipe.
main "$@"
