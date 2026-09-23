# Build and release

## Local builds

```bash
make check
make package
```

Build on the target host: macOS arm64 produces `artifacts/releases/<version>/Anchi-darwin-arm64/Anchi.app`; Linux x64 produces the Linux directory and archive below. Cross-platform packaging is unsupported. Quit the running app before rebuilding the same version.

Version comes from `desktop/package.json`; lockfiles pin Electron and dependencies. Assembly uses a temporary system directory and cleans it afterwards, without writing local paths into source files.

Runtime resources include only allowlisted file types from scripts/services/guest/systemd/lima/pi, excluding dependencies, keys, workspaces and sessions. The resource manifest records size and SHA-256; the build manifest records version, platform, Electron and the resource-manifest digest. Hashes track content; they do not replace signing or supply-chain validation.

Packaged setup includes scripts to install dependencies and Pi and create `secure-vm`. Users complete Homebrew system installation and browser login themselves. macOS configuration is in `~/Library/Application Support/Anchi/`, including `directory-plans.json` and `activity.jsonl`, outside the app. Guest installation writes `/opt/secure-vm/installed.json` so setup can compare runtime and app versions.

## Linux artifacts

`npm --prefix desktop run package` on Linux x64 creates `artifacts/releases/<version>/Anchi-linux-x64/`, `Anchi-linux-x64.tar.gz` and its `.sha256`. Linux has no signing path; `ANCHI_RELEASE=1` fails with `RELEASE_UNSUPPORTED_PLATFORM`. Packaging smoke tests run on both host platforms.

Tool versions are pinned in `desktop/host-tools.json`. To update: change version and URL, download the exact artifact, recompute SHA-256 with `shasum -a 256`, compare Lima with published `SHA256SUMS`, and run `linux-live` to verify fresh VM installation. Only SHA-256 is checked; Lima GPG and Codex sigstore verification are not implemented.

## Public-release gates

Current outputs are development builds. The following checklist records release requirements, not a claim they are all complete:

- License, third-party notices and privacy documentation reviewed.
- Developer ID signing, notarization, stapling and clean-machine Gatekeeper validation.
- Clean installation, cancellation, upgrade/downgrade, recovery and configuration migration.
- Real directory access/revocation, OAuth connection/revocation and task permission boundaries.
- Recoverable configuration backups and crash/power-loss recovery policy.
- Security/dependency review, verified updates and compatibility matrix.

After `make check`, run packaging and desktop acceptance appropriate to the change. Guest changes need explicit VM checks. CI runs offline checks on Linux/macOS and packaging smoke jobs; it does not store credentials, connect accounts, approve models or publish releases.

Manual package checks: launch from Finder or the Linux executable, inspect VM state, connect Pi, create/resume a session, open/cancel the native picker, inspect trusted approval details and exit. Do not automatically approve a model merely to prove the UI works.

## Developer ID signing and notarization

Formal releases require a valid Developer ID Application certificate and Keychain notarization profile. Without them, only unsigned development packages can be produced; ad-hoc signing must not masquerade as a formal release.

Install your Developer ID Application certificate with its private key. Save notarization credentials interactively with Apple's `notarytool store-credentials`. Never put secrets in the repository or chat. Configure these nonsecret values:

```bash
export ANCHI_RELEASE=1
export ANCHI_SIGN_IDENTITY='Developer ID Application: Your Company (TEAMID1234)'
export ANCHI_APPLE_TEAM='TEAMID1234'
export ANCHI_NOTARY_PROFILE='anchi-notary'
export ANCHI_BUNDLE_ID='com.yourcompany.anchi'
npm --prefix desktop run package
```

Legacy `QISUO_*` release variables remain accepted; `ANCHI_*` values take precedence when both are set.

Signed output goes under `artifacts/releases/<version>/signed/`. Failed builds do not retain an old success manifest or distribution ZIP. Release mode preflights identity/profile, signs all components with hardened runtime and Electron osx-sign default entitlements, then performs strict codesign verification, submits a ZIP to notarytool, waits for Accepted, staples, validates the staple, assesses Gatekeeper and rebuilds the ticket-bearing distribution ZIP plus SHA-256. Only complete success writes `signed: true, notarized: true`; Apple's receipt is saved as `notarization.json`. Downloaded external content must not be injected into the signed package.

References: [Electron signing](https://www.electronjs.org/docs/latest/tutorial/code-signing), [Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution). Real submission, clean-machine Gatekeeper and fresh install still require valid developer configuration and acceptance.

## File-broker live check

`node desktop/scripts/verify-files.cjs` uses an existing VM and synthetic temporary directory to test real cell-to-host JSONL round trips, read/write, path rejection, trash recovery for overwrite/delete, read-only mode and revocation. It calls no model and reads no Gmail. Exit Pi first because the test occupies the fixed cell unit.

The development Bundle ID is `local.anchi.desktop`; renaming and configuration migration are documented separately.
