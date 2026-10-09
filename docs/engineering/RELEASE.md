# Releases

Anchi releases include standalone archives for Apple Silicon macOS and glibc Linux x86_64.
Each archive contains the Node runtime, bundled TUI and daemon, prebuilt cell runners, VM
installation resources, and license notices. Users need neither a checkout nor pnpm.
A release is a commit on `main` with a version, a changelog entry and the checks below.

## Build and publish

```bash
pnpm --dir anchi install --frozen-lockfile
bash scripts/package-release.sh
python3 scripts/check-release.py artifacts/releases/anchi-darwin-arm64.tar.gz
```

Build on the target platform; Linux produces `anchi-linux-x64.tar.gz`. The packaging script
uses the Node version pinned in `guest/cell.env`, verifies the official download checksum,
and writes each archive plus its `.sha256` file under `artifacts/releases/`.

`.github/workflows/release.yml` builds both platforms and exercises installation, upgrade,
checksum rejection, PATH configuration, daemon startup and real TUI rendering. Manual
workflow runs produce downloadable CI artifacts without publishing. Pushing a `v<version>`
tag matching `anchi/package.json` publishes a GitHub development release after both jobs pass.
Complete the release gates below before pushing a tag. Published tags and assets are immutable;
fix a bad build by publishing a new version.

The public installer is `landing/dist/install.sh`, served at
`https://anchi.elseward.xyz/install.sh` by the existing landing-page deployment. Deploy it
alongside the website after the first release assets exist. It uses the latest GitHub release,
or the explicit `ANCHI_VERSION` tag, and verifies the archive before installing. Checksums
protect against corruption; they are not publisher signatures.

Updates retain previous version directories and do not restart running daemons or modify
VMs. Users stop the daemon after tasks finish and reinstall login startup if enabled.
See [Getting started](../GETTING_STARTED.md) for the exact commands.

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
