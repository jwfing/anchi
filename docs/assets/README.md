# TUI preview

`tui-team.svg` contains text rendered by the real Ink `App` component with synthetic agents
and finished tasks. It is an interface example, not evidence of live model or account execution.
The image uses one text color for readability on GitHub.

Regenerate from the repository root after installing workspace development dependencies:

```bash
node --import ./anchi/node_modules/tsx/dist/loader.mjs anchi/packages/tui/test/render-demo.tsx
```

The generator uses an in-memory fake client and never contacts the daemon, VM or an account.
Review the rendered SVG after changes to the TUI layout.
