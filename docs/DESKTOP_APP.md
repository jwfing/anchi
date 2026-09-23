# Anchi desktop development build

Version 0.1.1 uses Electron 44.4.3. macOS on Apple Silicon is the primary platform; Linux x86_64 is experimental.

## Launch and packaging

On macOS, open `artifacts/releases/0.1.1/Anchi-darwin-arm64/Anchi.app`. It is a development build without a validated Developer ID signature, notarization or distribution installer.

Setup can inspect/install dependencies, create the VM and Pi, initialize/unlock the vault and launch Codex browser login or import existing subscription authentication. See [getting started](GETTING_STARTED.md). If Homebrew is absent, the user installs its official `.pkg` through the system installer.

The package includes allowlisted scripts under `Resources/runtime`; moving the app does not depend on a developer checkout. Runtime resources exclude credentials, user workspaces, `node_modules` and VM images. Source mode uses repository scripts.

```bash
cd desktop
npm ci
npm start
# Quit the running application before repackaging.
npm run package
npm test
```

## Workspace and current features

- English is the default interface language. Switch between English and Simplified Chinese using the button beside the sidebar expand/collapse control. The preference is saved in `preferences.json` in the app configuration directory and restored on restart. Language changes preserve the active session and draft; user content and approval payloads are not translated.

- Setup checks real dependency, VM, Pi and authentication state. Installation/repair follows native confirmation and can retry failures or interruptions without deleting existing workspaces or credentials.
- Chat uses real Pi JSONL RPC: send, cancel, create sessions, list/resume sessions and load history.
- The navigation stays in place and can collapse to icons. Agent uses a compact environment bar, a conversation area and a bottom composer with session controls. Task status appears as a small toast. Connection tips are separate from status and authorization controls.
- Native directory selection supports read-only/read-write grants. Version 2 plans record device and inode, reject overlapping and sensitive directories, and restore only unchanged identities. Version 1 and unversioned plans remain readable; corrupt/future versions are preserved and cannot be overwritten.
- Plans live in `~/Library/Application Support/Anchi/directory-plans.json` on macOS. An existing `Qisuo` directory migrates once when `Anchi` is absent; if migration fails, the app uses the old directory to preserve access. Linux uses `~/.config/Anchi`.
- Approvals reads pending requests and full actions directly from policy. Approval binds the digest, rechecks current state and uses native confirmation before invoking policy administration.
- Requests can be denied or revoked. Closing the app asks before ending the local Pi connection; the VM remains running.
- Desktop activity metadata persists in `activity.jsonl`. The activity page groups events by date and exposes technical identifiers in expandable details; it can also read VM policy audit. Chat and approval bodies are not stored in this log.
- Opening approvals loads pending requests; navigation shows their count. Details include a structured summary and expandable full JSON.
- Setup displays authentication expiry and VM service version. Expired model authentication can be reimported without disconnecting Pi.

## Directory grants

Under Connectors, choose a directory and mode, then confirm in the native dialog. Only successful broker activation is shown as authorized. Unchanged identities restore on startup; moved, replaced or inaccessible directories show a reason and require reconfirmation. Changing mode revokes the old capability before activating the new one. Removing a grant blocks new requests, waits for in-flight operations, then removes the plan.

Pi calls `host_files` with `op=grants` to obtain IDs, then uses an ID and relative path for `list/read/write/mkdir/delete`. Shell cannot open host paths directly; the VM has no host mounts. Limits: 24,000 UTF-8 bytes, at most 100 directory entries, no binary/hidden files, symlinks, hard links or recursive deletion. Overwritten and deleted regular files move into hidden `.anchi-trash` for host-side recovery. The agent cannot access that directory. Writes use atomic replacement; revocation does not retract content already read.

`scripts/host-files.py` runs on the host using the installed host Python (Homebrew Python on macOS, with system fallback). Upgrade the Pi adapter with `bash scripts/install-pi.sh` after closing sessions occupying the cell.

## Account connectors and Google OAuth

Gmail, Drive, Notion and Slack cards come from `desktop/src/shared/connectors.cjs`. Each shows status/account, connection or token entry, disconnect and authorization-mode controls. Static tokens use a separate modal main-process window and never pass through the main page. Write approval includes a banner, target and full body. See [connectors](CONNECTORS.md).

1. Start the VM, unlock the vault and refresh account status.
2. If needed, import a Google Desktop OAuth client JSON. It goes through stdin into the encrypted VM vault, not desktop configuration.
3. Connect Google in the system browser. The random loopback callback validates state, Host and path; PKCE verifier remains in the VM. The main process sends the code directly to auth; neither Pi nor the renderer receives tokens.
4. Refresh status. Connecting grants standing authorization immediately; switch the connector to per-request approval to review each operation.
5. Switching modes revokes unconsumed grants. Restoring automatic authorization requires native confirmation. Disconnect also stops Pi and attempts remote revocation; failed revocation can be retried.

OAuth waiting can be cancelled and expires after ten minutes. The account owner must complete real browser consent. Task-scoped mail restrictions, a budget UI and automatic updates are not implemented.

## A real task

Check the environment and start an existing stopped VM. Unlock after VM restart; refresh subscription authentication using [Pi authentication](PI_AGENT.md). Connect Pi and wait for its session ID; only one cell runs at a time, so close any terminal Pi first.

Send a task. Automatic mode proceeds under policy; in approval mode, open Approvals, refresh from policy, inspect the actual model, resource, content and digest, and confirm approval in the native dialog. Return to chat for the result. Cancellation neither rolls back completed tool actions nor guarantees an already submitted upstream request stops billing.

## Desktop trust boundary

The renderer uses sandbox/contextIsolation without Node integration. HTML, CSS and modules load only through the allowlisted `anchi://app/` protocol. CSP blocks networking, frames and inline scripts; new windows, navigation and browser permissions are denied.

Preload exposes fixed IPC. Main validates window, top-level frame, origin and operation. RPC rejects arbitrary shell, endpoint or credential fields. Child processes use fixed commands/argument arrays and minimal environments; stdout is bounded JSONL. Agent text is escaped and cannot manufacture approval controls.

Approval never trusts details in an agent notification: main fetches the action from policy, compares the digest the user reviewed, and submits only after native confirmation. Main, the development checkout and host administrator remain trusted. Renderer hardening is not proof of a complete security audit. See [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security).

## Development and release checks

Run `npm test` in `desktop/` for offline behavior tests. For a package check, launch the app, inspect setup and VM state, connect Pi, create/resume a session, open/cancel the native picker, inspect independent approval details and exit. A successful launch does not establish signed distribution or crash-recovery guarantees.

See [module responsibilities](architecture/REPOSITORY.md) and [release gates](engineering/RELEASE.md). The development Bundle ID is `local.anchi.desktop`; release variables use `ANCHI_*` with `QISUO_*` compatibility. Configuration migration preserves accounts and the vault. The Lima instance and guest runtime paths retain the internal name `secure-vm`.
