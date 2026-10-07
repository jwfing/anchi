# Releases

Anchi is released as tagged source: there is no packaged app. A release is a commit on `main` with a version, a changelog entry and the checks below.

## Version

The version is `version` in `anchi/package.json`. `scripts/up.sh` records it in the VM's `/opt/secure-vm/installed.json` with the install time.

## Release gates

Current releases are development builds. Before tagging:

- `make check` passes on macOS and Linux (CI runs it on every push).
- On a VM installed from the release commit: `make verify-vm` and `make verify-anchi` pass.
- The Linux live workflow (`linux-live`) passes: a fresh VM installs and passes the service checks.
- Changes to boundaries, credentials, approvals or guest commands have live evidence, and `scripts/anchi-acceptance.sh` has been run for the affected scenarios with real accounts.
- `CHANGELOG.md` describes user-visible changes and anything users must do (re-import a token, rebuild images, rerun `scripts/anchi setup install`).

Not yet in place for public distribution: a security review, signed artifacts, verified updates and a compatibility matrix.

## Pinned versions

| Pin | Where | Update |
|---|---|---|
| Node, Codex, Claude Code in cells | `guest/cell.env` | Download the exact artifact for both architectures, recompute SHA-256, rebuild the base image (`anchi-image build codex base`) and run `make verify-anchi` and a live turn per runtime |
| mitmproxy, botocore in the egress service | `guest/cell.env` | Reinstall with `scripts/install-anchi.sh`; run `tests/test_egress.py` and `make verify-anchi` |
| Codex and Claude Agent SDKs, other workspace packages | `anchi/pnpm-lock.yaml` | Choose versions older than pnpm's minimum release age; keep the SDK and the CLI in the image on matching versions |
| Lima for Linux CI | `.github/workflows/linux-live.yml` | Change version and SHA-256 together; compare with Lima's published `SHA256SUMS` |

Only SHA-256 is checked; publisher signatures (Lima GPG, Codex sigstore) are not verified.
