#!/bin/bash
# The size of a new VM. scripts/up.sh sources it when it creates the VM; an existing VM keeps its
# size (`limactl edit anchi-vm --cpus … --memory …` changes it).

# This computer's logical CPUs and memory in whole GiB: "cpus gib".
anchi_host_resources() {
  local cpus bytes
  if [[ $(uname -s) == Darwin ]]; then
    cpus=$(sysctl -n hw.logicalcpu)
    bytes=$(sysctl -n hw.memsize)
  else
    cpus=$(nproc)
    bytes=$(($(awk '/^MemTotal:/ {print $2}' /proc/meminfo) * 1024))
  fi
  echo "$cpus $((bytes / 1073741824))"
}

# Prints "cpus gib" for a computer with $1 CPUs and $2 GiB: ANCHI_VM_CPUS and
# ANCHI_VM_MEMORY_GIB when set, else half of each (at least 1 CPU and 2 GiB). Fails on a value
# that is not a whole number or exceeds the computer.
anchi_vm_size() {
  local host_cpus=$1 host_gib=$2 half_cpus half_gib
  half_cpus=$((host_cpus / 2 > 1 ? host_cpus / 2 : 1))
  half_gib=$((host_gib / 2 > 2 ? host_gib / 2 : 2))
  local cpus=${ANCHI_VM_CPUS:-$half_cpus} gib=${ANCHI_VM_MEMORY_GIB:-$half_gib}
  # The pattern first: arithmetic on an unchecked string would evaluate it.
  if [[ ! $cpus =~ ^[1-9][0-9]{0,3}$ ]] || ((cpus > host_cpus)); then
    echo "Invalid ANCHI_VM_CPUS $cpus: use a whole number from 1 to $host_cpus" >&2
    return 1
  fi
  if [[ ! $gib =~ ^[1-9][0-9]{0,4}$ ]] || ((gib < 2 || gib > host_gib)); then
    echo "Invalid ANCHI_VM_MEMORY_GIB $gib: use a whole number from 2 to $host_gib" >&2
    return 1
  fi
  echo "$cpus $gib"
}
