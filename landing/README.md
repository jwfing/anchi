# Anchi landing page

Dependency-free static product site for `https://anchi.elseward.xyz`.

The deployable public directory is `dist/`. These are authored source files; keep them tracked. Serve this directory directly using any static host. No build step or environment variables are required.

Local preview: `python3 -m http.server 4173 --bind 127.0.0.1 --directory landing/dist` from the repository root. Open http://127.0.0.1:4173/.

Deploy to the linked InstaCloud project's `anchi` compute on `main` with
`insta --agent deploy landing --group anchi --branch main --port 8080` from the
repository root. The Dockerfile serves only `dist/` through nginx on port 8080.
Do not create a Sites project or attach a custom domain unless explicitly requested.

The page presents Anchi as a secured agent team and describes the current development preview. Keep product and security claims aligned with the root `README.md` and `SECURITY.md`. The canonical URL and sitemap target the intended custom domain; publishing and DNS configuration are separate from the page source.

## Setup guide redirects

`nginx.conf` redirects `/docs/connect/<name>` to that connector's section in `docs/` on GitHub (`main`). The desktop app links there, and an installed app cannot change its links, so when a guide moves or a heading changes, update the map rather than the app. Every connector the app lists must have an entry; `anchi/packages/desktop/test/desktop.test.tsx` checks that each target file and heading exists. Redirect changes reach users only after a landing deploy.

## Languages

`/zh/` and `/en/` are complete, independently accessible Chinese and English pages.
The root page provides Chinese by default. `language.js` remembers a selected
language when browser storage is available and applies it on the next visit to
`/`. Explicit language URLs always take precedence. The switch preserves the
current section and query string; both pages remain usable without JavaScript.
Keep the root `index.html` identical to `zh/index.html`, update both translations
when changing content, and keep the alternate-language metadata and sitemap in sync.

## Brand

`dist/logo.svg` is the split-diamond mark used in the header and footer. Its
upper and lower triangles have a 7:3 height ratio, with a clear vertical gap
between the two halves, and a point of light where the gap crosses the widest
line, shining out as a four-point star. `dist/favicon.svg` is the desktop app's
icon (`anchi/packages/desktop/assets/icon.svg`): the same mark in celadon on a blue-black
(黛) tile, the color of the app's rail.
The hero animations still draw the flat mark, without the light, for the trusted
gateway. The wordmark is live text so it stays crisp and accessible.

`dist/desktop.png` is the desktop app screenshot with example data; see
`docs/assets/README.md` to regenerate it.

## Page design

The page is a stack of screens (`.screen`, one viewport tall, parted by the page's hairline;
agent4.xyz was the layout reference). The hero fills the first screen: a headline that names
the thing and where it runs (AI agents on your computer, in a sealed room), one sentence about
an agent that thinks with your own ChatGPT or Claude account, works in a sealed cell and asks
before it sends, posts or merges, two text links, and the looping hero animation beside them.
Under it one line of facts (`.strip`: version, AI accounts, platforms, connections, licence).
Then one screen each: what Anchi protects (three rows, each with its flow in chips: lime marks
Anchi's step, amber the step that waits for you), the three steps of the app's guide beside the
desktop screenshot, the install command (`--desktop`, once on the page) with the platforms and
AI accounts, and the questions. The TUI and CLI get one answer with a link to the key bindings,
not a preview: the page is for people the desktop app is for.
Keep setup details and download alternatives in the guides, and the platform status and
security claims aligned with the root README.

The page uses the desktop app's words, not the protocol's: the secure room (the VM), a sealed
cell, the vault, an AI account (ChatGPT, Claude, Other provider; a runtime), a shared folder
(a workspace), a teammate (delegation), **Needs you** (approvals), **New agent** (the builder)
and **What it touched**. When the app renames something, rename it here in both languages
(`docs/DESKTOP.md` has the current words).

The hero animation is the vertical export from `hero-animation/hero-v.html`
(`dist/anchi-hero-vertical-{zh,en}-dark.mp4`, 880×928, 10.6s loop, no window frame). The matching
`.jpg` is its first frame, used as the poster. Re-export both from
`hero-animation/` when the diagram changes (see its README). Each language page
loads its own video, and its `aria-label` explains the credential flow.
`hero.js` pauses the video on the poster frame under `prefers-reduced-motion`; the page
has no other script besides `language.js` and `install.js`, and works without JavaScript.
Animations and smooth scrolling honor `prefers-reduced-motion`.

## Section icons and brand assets

The six feature icons in `dist/icons/` are original SVG drawings for Anchi:
`agent`, `team`, `task`, `isolation`, `credentials`, and `authorization`.

## Color

The lime accent (`--lime`) marks actions and keywords only: buttons, links, the
install prompt and copy control, hover/focus/selected states, and the highlighted
second line of headings. Section labels, notes, and all icons use the neutral
text colors (`--muted` / `--ink`).

The four active platform/runtime icons (`*-ascii.svg`) are custom, monochrome
character-grid illustrations for this page: an apple silhouette, a penguin,
the six-loop OpenAI knot for Codex, and a radial star for Claude. They share
the page's muted text color and a pixel grid treatment. Codex uses a 28×28 grid
to preserve its interwoven loops and central hexagon. These are stylized identifiers, not official
brand assets; platform and runtime names remain plain text alongside them.

The earlier official-source assets (`apple.svg`, `linux.png`, `openai.svg`, and
`claude.svg`) are retained as references but are not loaded by the page:

- Apple symbol: [Apple navigation](https://www.apple.com/).
- Tux: [kernel.org](https://www.kernel.org/theme/images/logos/tux.png),
  created by Larry Ewing with the GIMP.
- OpenAI Blossom: [Codex documentation](https://developers.openai.com/codex/).
- Claude symbol: [Claude Code page](https://claude.com/product/claude-code).

Brand marks belong to their respective owners. They identify supported platforms
and runtimes, not an endorsement.

## Installer

The hero contains a single install command with a clipboard button (`dist/install.js`);
keep it in sync across both languages and the root page, with `--desktop` as the recommended
installation. Launch instructions and terminal-only installation live in the setup guide.

`dist/install.sh` is the public POSIX installer. It downloads platform archives and SHA-256
files from GitHub Releases. Publish both platform assets before deploying the install call
to action. See `docs/engineering/RELEASE.md`; validate the installer with
`python3 scripts/check-release.py <archive>` before deployment.
