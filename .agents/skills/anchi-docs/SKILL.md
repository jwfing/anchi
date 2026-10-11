---
name: anchi-docs
description: Documentation and changelog conventions for the Anchi repository — where guides live, how to describe behavior, CHANGELOG entries and the bilingual landing page. Use when writing or updating any Markdown in this repo, the changelog, or landing/dist.
---

# Writing Anchi documentation

## Where things go

| Content | Location |
|---|---|
| Project overview and status table | `README.md` (single overview; no translated copies) |
| Task guides (install, agents, connectors, keys) | `docs/*.md`, linked from `docs/README.md` |
| Architecture, contracts, design | `docs/architecture/` |
| Release procedure | `docs/engineering/` |
| Trust model and boundaries | `SECURITY.md` |
| Contributor process | `CONTRIBUTING.md`; agent-specific rules in `AGENTS.md` and `.agents/skills/` |

## Style

- English, present tense, describing what is implemented now. Mark prototypes and plans as such; do not document the future as if it shipped.
- Keep commands, paths, RPC methods, protocol fields and configuration keys exact and in backticks. TUI labels may stay localized in the app; the docs name the control in English and give its key in bold (**^X s**).
- State limits and what is not verified instead of test counts or dated acceptance reports. Remove superseded proposals; Git history keeps them.
- When a heading or file moves, update relative links and anchors.

## Changelog

`CHANGELOG.md` follows Keep a Changelog. Add a line under `## Unreleased` in `Added`, `Changed`, `Fixed` or `Removed` for every user-visible change, in one or two sentences: what the user can do now, the command or key, and any upgrade step (for example "needs `scripts/anchi setup install`"). Newest entries go first in their section.

## Landing page

`landing/dist/` is hand-written static HTML. `zh/index.html` and `en/index.html` are full translations, and the root `index.html` must stay byte-identical to `zh/index.html` (`cp landing/dist/zh/index.html landing/dist/index.html`). Keep claims aligned with `README.md` and `SECURITY.md`. See `landing/README.md`.
