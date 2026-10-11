#!/bin/bash
# The Lima VM's name and the vault key's place on the host, and their move from the names used
# before 0.3 (`secure-vm`, ~/.config/secure-vm/vault.key). Host scripts source it; the daemon and
# vault.py run `bash scripts/vm-name.sh migrate` before they use the VM.
ANCHI_VM_DEFAULT=anchi-vm
ANCHI_LEGACY_VM=secure-vm
ANCHI_VAULT_KEY=${HOME}/.config/anchi/vault.key
ANCHI_LEGACY_VAULT_KEY=${HOME}/.config/secure-vm/vault.key

# The VM to use: ANCHI_INSTALL_VM (anchi-vm or anchi-vm-<suffix>), else anchi-vm.
anchi_vm_name() {
  local name=${ANCHI_INSTALL_VM:-$ANCHI_VM_DEFAULT}
  if [[ ! "$name" =~ ^anchi-vm(-[a-z0-9-]+)?$ ]]; then
    echo "Invalid VM name $name: use anchi-vm or anchi-vm-<suffix>" >&2
    return 1
  fi
  echo "$name"
}

# Renames a `secure-vm` instance to `anchi-vm` (stopping and restarting it if it runs) and moves
# the vault key to ~/.config/anchi. Does nothing when there is nothing to move; never replaces an
# existing `anchi-vm` or key. Returns 2 when the VM was restarted, so its vault is locked.
migrate_legacy_vm() {
  local restarted=0 list old_status
  if [[ -f $ANCHI_LEGACY_VAULT_KEY && ! -e $ANCHI_VAULT_KEY ]]; then
    mkdir -p "$(dirname "$ANCHI_VAULT_KEY")"
    chmod 0700 "$(dirname "$ANCHI_VAULT_KEY")"
    mv -n "$ANCHI_LEGACY_VAULT_KEY" "$ANCHI_VAULT_KEY"
    rmdir "$(dirname "$ANCHI_LEGACY_VAULT_KEY")" 2>/dev/null || true
    echo "Moved the vault key to $ANCHI_VAULT_KEY; update your backup notes." >&2
  elif [[ -f $ANCHI_LEGACY_VAULT_KEY ]]; then
    echo "Both $ANCHI_LEGACY_VAULT_KEY and $ANCHI_VAULT_KEY exist; using the second." >&2
  fi
  command -v limactl >/dev/null || return 0
  list=$(limactl list --format '{{.Name}} {{.Status}}' 2>/dev/null) || return 0
  old_status=$(awk -v n="$ANCHI_LEGACY_VM" '$1 == n { print $2 }' <<<"$list")
  [[ -n $old_status ]] || return 0
  if awk -v n="$ANCHI_VM_DEFAULT" '$1 == n { found = 1 } END { exit !found }' <<<"$list"; then
    echo "Both Lima VMs $ANCHI_LEGACY_VM and $ANCHI_VM_DEFAULT exist; Anchi uses $ANCHI_VM_DEFAULT." >&2
    return 0
  fi
  echo "Renaming the Lima VM $ANCHI_LEGACY_VM to $ANCHI_VM_DEFAULT (its disk and vault stay as they are)." >&2
  if [[ $old_status == Running ]]; then
    # shellcheck source=guest/arch.sh
    source "$(dirname "${BASH_SOURCE[0]}")/../guest/arch.sh"
    refuse_if_tasks_running "$ANCHI_LEGACY_VM" || return 1
    limactl stop "$ANCHI_LEGACY_VM" >&2
    restarted=1
  fi
  limactl rename "$ANCHI_LEGACY_VM" "$ANCHI_VM_DEFAULT" >&2
  if ((restarted)); then
    limactl start --tty=false "$ANCHI_VM_DEFAULT" >&2
    return 2
  fi
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  set -euo pipefail
  case ${1:-} in
    migrate)
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
