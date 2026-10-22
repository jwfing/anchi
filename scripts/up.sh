#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/vm-name.sh
source scripts/vm-name.sh
vm_name=$(anchi_vm_name)
# shellcheck source=scripts/vm-size.sh
source scripts/vm-size.sh
# shellcheck source=guest/arch.sh
source guest/arch.sh
runtime_version=$(anchi_runtime_version)
if guest_local; then
  # Anchi runs inside the guest (a remote server): no VM to create, the machine is the guest.
  refuse_if_tasks_running "$vm_name"
else
  vm_type=$(host_vm_type "$(uname -s)")
  if [[ $vm_type == qemu ]]; then
    command -v limactl >/dev/null || { echo 'Install Lima 2.2.0+ from https://github.com/lima-vm/lima/releases (see docs/GETTING_STARTED.md)' >&2; exit 1; }
    # Lima falls back to slow software emulation without KVM; refuse instead.
    # shellcheck disable=SC2016  # $USER is for the user to type
    [[ -r /dev/kvm && -w /dev/kvm ]] || { echo '/dev/kvm is missing or not accessible: enable CPU virtualization, then: sudo usermod -aG kvm "$USER" and log in again' >&2; exit 1; }
    qemu=qemu-system-$(uname -m)
    command -v "$qemu" >/dev/null || { echo "Install QEMU first ($qemu), for example: sudo apt-get install -y qemu-system-x86 qemu-utils" >&2; exit 1; }
  else
    command -v limactl >/dev/null || { echo 'Install Lima first: brew install lima' >&2; exit 1; }
  fi
  # An older Lima refuses the template (minimumLimaVersion) only after the download; say it now.
  lima_min=$(awk '/^minimumLimaVersion:/ {print $2}' lima/anchi-vm.yaml)
  lima_have=$(limactl --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  if [[ -n $lima_min && -n $lima_have && $(printf '%s\n%s\n' "$lima_min" "$lima_have" | sort -V | head -1) != "$lima_min" ]]; then
    echo "Lima $lima_have is older than the $lima_min Anchi needs: upgrade it (macOS: brew upgrade lima; Linux: see docs/GETTING_STARTED.md)" >&2
    exit 1
  fi
  # A VM created as secure-vm is renamed rather than replaced by a second, empty VM.
  if [[ $vm_name == "$ANCHI_VM_DEFAULT" ]]; then
    bash scripts/vm-name.sh migrate
  fi
  if limactl list --format '{{.Name}} {{.Status}}' | grep -Fqx "$vm_name Running"; then
    refuse_if_tasks_running "$vm_name"
  fi
  if limactl list --format '{{.Name}}' | grep -Fqx "$vm_name"; then
    limactl start --tty=false "$vm_name"
  else
    read -r host_cpus host_gib < <(anchi_host_resources)
    read -r vm_cpus vm_gib < <(anchi_vm_size "$host_cpus" "$host_gib") || exit 1
    echo "Creating $vm_name with $vm_cpus CPUs and $vm_gib GiB of memory (this computer: $host_cpus CPUs, $host_gib GiB)"
    limactl start --tty=false --name="$vm_name" --vm-type="$vm_type" --cpus="$vm_cpus" --memory="$vm_gib" lima/anchi-vm.yaml
  fi
fi
# Explicit copy, never a host-home or project filesystem mount. The staging directory is
# cleared first: a VM running since an older release keeps /tmp, and a stale copy would
# reinstall files this release removed.
guest_root "$vm_name" rm -rf /tmp/secure-vm-bootstrap
guest_sh "$vm_name" mkdir -p /tmp/secure-vm-bootstrap
guest_copy "$vm_name" /tmp/secure-vm-bootstrap guest/cell.env guest/arch.sh guest/bootstrap.sh guest/cell-run guest/check-cell.py guest/check-gmail.py guest/gmail-cli.py guest/install-gmail.sh
guest_copy "$vm_name" /tmp/secure-vm-bootstrap guest/check-security.py guest/check-connectors.py services systemd
guest_root "$vm_name" bash /tmp/secure-vm-bootstrap/bootstrap.sh
guest_root "$vm_name" env SECURE_VM_RUNTIME_VERSION="$runtime_version" bash /tmp/secure-vm-bootstrap/install-gmail.sh
