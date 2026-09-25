# Anchi landing page

Dependency-free static product site for `https://anchi.elseward.xyz`.

The deployable public directory is `dist/`. These are authored source files; keep them tracked. Serve this directory directly using any static host. No build step or environment variables are required.

Local preview: `python3 -m http.server 4173 --bind 127.0.0.1 --directory landing/dist` from the repository root. Open http://127.0.0.1:4173/.

Keep this page local-only. Do not create or deploy a Sites project or attach a custom domain unless explicitly requested. The local Sites hosting configuration has been removed.

The page describes the current development preview. Keep product and security claims aligned with the root `README.md` and `SECURITY.md`. The canonical URL and sitemap target the intended custom domain; publishing and DNS configuration are separate from the page source.

## Languages

`/zh/` and `/en/` are complete, independently accessible Chinese and English pages.
The root page provides Chinese by default. `language.js` remembers a selected
language when browser storage is available and applies it on the next visit to
`/`. Explicit language URLs always take precedence. The switch preserves the
current section and query string; both pages remain usable without JavaScript.
Keep the root `index.html` identical to `zh/index.html`, update both translations
when changing content, and keep the alternate-language metadata and sitemap in sync.
