# Previews

## Desktop app

`desktop.png` is a screenshot of the real desktop app, connected to a stand-in daemon that answers
with synthetic agents, tasks and a transcript. It is an interface example, not evidence of live
model or account execution. The landing page shows the same file as `landing/dist/desktop.png`.

Regenerate both from the repository root after installing workspace development dependencies:

```bash
node anchi/packages/desktop/scripts/build.mjs
node --import ./anchi/node_modules/tsx/dist/loader.mjs anchi/packages/desktop/scripts/demo.ts
```

The script listens on the daemon socket of a new temporary `ANCHI_HOME`, drives the app with
`scripts/drive.mjs` at 1440 × 900 (2×) and never contacts a daemon, VM or account.

## TUI

`tui-team.svg` contains text rendered by the real Ink `App` component with synthetic agents
and finished tasks. It is an interface example, not evidence of live model or account execution.
The image uses one text color for readability on GitHub.

Regenerate from the repository root after installing workspace development dependencies:

```bash
node --import ./anchi/node_modules/tsx/dist/loader.mjs anchi/packages/tui/test/render-demo.tsx
```

The generator uses an in-memory fake client and never contacts the daemon, VM or an account.
Review the rendered SVG after changes to the TUI layout.
