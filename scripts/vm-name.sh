#!/bin/bash
# The Lima VM's name and the vault key's place on the host, and their move from the names used
# before 0.3 (`secure-vm`, ~/.config/secure-vm/vault.key). Host scripts source it; the daemon and
# vault.py run `bash scripts/vm-name.sh migrate` before they use the VM.
ANCHI_VM_DEFAULT=anchi-vm
ANCHI_LEGACY_VM=secure-vm
ANCHI_VAULT_KEY=${HOME}/.config/anchi/vault.key
ANCHI_LEGACY_VAULT_KEY=${HOME}/.config/secure-vm/vault.key
ANCHI_MIGRATE_LOCK=${HOME}/.config/anchi/migrate.lock
# How long to wait for another migration before giving up (the daemon allows its own 15 minutes).
ANCHI_MIGRATE_WAIT_S=${ANCHI_MIGRATE_WAIT_S:-900}

# The VM to use: ANCHI_INSTALL_VM (anchi-vm or anchi-vm-<suffix>), else anchi-vm.
anchi_vm_name() {
  local name=${ANCHI_INSTALL_VM:-$ANCHI_VM_DEFAULT}
  if [[ ! "$name" =~ ^anchi-vm(-[a-z0-9-]+)?$ ]]; then
    echo "Invalid VM name $name: use anchi-vm or anchi-vm-<suffix>" >&2
    return 1
  fi
  echo "$name"
}

# One migration at a time: the daemon at start, scripts/up.sh and vault.py each ask for one, and
# two renames (or a rename next to a `limactl start`) would fight over the same VM. A second
# caller waits for the first, after which it finds nothing left to move. Fails rather than
# proceeding when the wait runs out, so no caller creates a second, empty VM meanwhile.
take_migrate_lock() {
  local waited=0 dir
  dir=$(dirname "$ANCHI_MIGRATE_LOCK")
  mkdir -p "$dir" || return 1
  chmod 0700 "$dir" || return 1
  until mkdir "$ANCHI_MIGRATE_LOCK" 2>/dev/null; do
    # Older than any migration can take (a VM restart): the holder is gone.
    if [[ -n $(find "$ANCHI_MIGRATE_LOCK" -maxdepth 0 -mmin +30 2>/dev/null) ]]; then
      rmdir "$ANCHI_MIGRATE_LOCK" 2>/dev/null || true
      continue
    fi
    if ((waited >= ANCHI_MIGRATE_WAIT_S)); then
      echo "Gave up after ${waited}s waiting for another Anchi VM migration ($ANCHI_MIGRATE_LOCK)." >&2
      echo "Remove that directory if no migration is running, then try again." >&2
      return 1
    fi
    if ((waited == 0)); then
      echo "Another Anchi VM migration is running; waiting for it to finish." >&2
    fi
    sleep 2
    waited=$((waited + 2))
  done
}

# Renames a `secure-vm` instance to `anchi-vm` (stopping and restarting it if it runs) and moves
# the vault key to ~/.config/anchi. Does nothing when there is nothing to move; never replaces an
# existing `anchi-vm` or key, and moves nothing while task cells run in the VM to rename. Returns
# 2 when the VM was restarted, so its vault is locked.
#
# Callers capture the exit code, so `set -e` does not apply inside: every step is checked here,
# and a failed one stops the migration instead of leaving it half done.
migrate_legacy_vm() {
  local restarted=0 list='' old_status='' key_dir
  if command -v limactl >/dev/null; then
    list=$(limactl list --format '{{.Name}} {{.Status}}' 2>/dev/null) || list=''
  fi
  old_status=$(awk -v n="$ANCHI_LEGACY_VM" '$1 == n { print $2 }' <<<"$list")
  if [[ -n $old_status ]] &&
    awk -v n="$ANCHI_VM_DEFAULT" '$1 == n { found = 1 } END { exit !found }' <<<"$list"; then
    echo "Both Lima VMs $ANCHI_LEGACY_VM and $ANCHI_VM_DEFAULT exist; Anchi uses $ANCHI_VM_DEFAULT." >&2
    old_status=  # Nothing to rename, but the key may still have to move.
  fi
  # Before anything moves: a rename cuts live cells off the network when the VM restarts.
  if [[ $old_status == Running ]]; then
    # shellcheck source=guest/arch.sh
    source "$(dirname "${BASH_SOURCE[0]}")/../guest/arch.sh" || return 1
    refuse_if_tasks_running "$ANCHI_LEGACY_VM" || return 1
  fi
  # The VM first: a failed rename leaves the key where the VM it belongs to still looks for it.
  if [[ -n $old_status ]]; then
    echo "Renaming the Lima VM $ANCHI_LEGACY_VM to $ANCHI_VM_DEFAULT (its disk and vault stay as they are)." >&2
    if [[ $old_status == Running ]]; then
      limactl stop "$ANCHI_LEGACY_VM" >&2 || {
        echo "Could not stop $ANCHI_LEGACY_VM; it keeps its name. Stop it yourself and try again." >&2
        return 1
      }
      restarted=1
    fi
    limactl rename "$ANCHI_LEGACY_VM" "$ANCHI_VM_DEFAULT" >&2 || {
      echo "Could not rename $ANCHI_LEGACY_VM to $ANCHI_VM_DEFAULT; it keeps its name and data." >&2
      if ((restarted)); then echo "Start it again with: limactl start $ANCHI_LEGACY_VM" >&2; fi
      return 1
    }
    # Confirm the new name is really there before anything starts it: a caller that took the
    # migration for done would otherwise create a second, empty anchi-vm.
    limactl list --format '{{.Name}} {{.Status}}' 2>/dev/null |
      awk -v n="$ANCHI_VM_DEFAULT" '$1 == n { found = 1 } END { exit !found }' || {
      echo "The Lima VM $ANCHI_VM_DEFAULT is not there after the rename; check: limactl list" >&2
      return 1
    }
    if ((restarted)); then
      limactl start --tty=false "$ANCHI_VM_DEFAULT" >&2 || {
        echo "Renamed, but $ANCHI_VM_DEFAULT did not start again: limactl start $ANCHI_VM_DEFAULT" >&2
        return 1
      }
    fi
  fi
  if [[ -f $ANCHI_LEGACY_VAULT_KEY && ! -e $ANCHI_VAULT_KEY ]]; then
    key_dir=$(dirname "$ANCHI_VAULT_KEY")
    mkdir -p "$key_dir" || return 1
    chmod 0700 "$key_dir" || return 1
    mv -n "$ANCHI_LEGACY_VAULT_KEY" "$ANCHI_VAULT_KEY" || return 1
    rmdir "$(dirname "$ANCHI_LEGACY_VAULT_KEY")" 2>/dev/null || true
    echo "Moved the vault key to $ANCHI_VAULT_KEY; update your backup notes." >&2
  elif [[ -f $ANCHI_LEGACY_VAULT_KEY ]]; then
    echo "Both $ANCHI_LEGACY_VAULT_KEY and $ANCHI_VAULT_KEY exist; using the second." >&2
  fi
  if ((restarted)); then return 2; fi
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  set -euo pipefail
  case ${1:-} in
    migrate)
      take_migrate_lock
      trap 'rmdir "$ANCHI_MIGRATE_LOCK" 2>/dev/null || true' EXIT
      # Unlock the vault again after a restart, when the key is here.
      status=0
      migrate_legacy_vm || status=$?
      if ((status == 2)) && [[ -f $ANCHI_VAULT_KEY ]]; then
        ANCHI_VM_MIGRATING=1 python3 "$(dirname "$0")/vault.py" unlock >/dev/null && echo 'Vault unlocked.' >&2
      elif ((status != 0 && status != 2)); then
        exit "$status"
      fi
      ;;
    name) anchi_vm_name ;;
    *)
      echo "usage: $0 migrate|name" >&2
      exit 64
      ;;
  esac
fi
