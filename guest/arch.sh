#!/bin/bash
# Architecture and host mapping shared by guest installers and host scripts. Source it; do not execute.
node_arch() {
  case "$1" in
    aarch64 | arm64) echo arm64 ;;
    x86_64 | amd64) echo x64 ;;
    *)
      echo "Unsupported guest architecture: $1" >&2
      return 1
      ;;
  esac
}
node_sha256() {
  case "$1" in
    arm64) echo "$SECURE_NODE_SHA256_ARM64" ;;
    x64) echo "$SECURE_NODE_SHA256_X64" ;;
    *) return 1 ;;
  esac
}
host_vm_type() {
  case "$1" in
    Darwin) echo vz ;;
    Linux) echo qemu ;;
    *)
      echo "Unsupported host OS: $1" >&2
      return 1
      ;;
  esac
}
