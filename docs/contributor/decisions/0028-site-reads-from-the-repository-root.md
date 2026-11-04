# 0028: The docs site reads its pages from the repository root

Status: Accepted (2026-11-04). Amends the `srcDir` part of
[decision 0015](0015-docs-site-versioning-and-error-pages.md).

Research: [research/2026-11-03-docs-site-and-versioning.md](../research/2026-11-03-docs-site-and-versioning.md).

## Context

Decision 0015 sets VitePress's `srcDir` to `docs/user`. It also says the API reference is generated
from TSDoc into the site build only, never into `docs/user/`, so the npm package does not ship it.
Issue [#85](https://github.com/aelmanaa/explorer-verify/issues/85) adds that reference: TypeDoc
writes its Markdown pages to `site/api/`, a gitignored folder.

VitePress builds only the Markdown files under `srcDir`. VitePress 1.6.4 finds them with one glob
of `**.md` in `srcDir`, minus `**/node_modules/**`, `**/dist/**` and `srcExclude`, and `rewrites`
can only map pages that glob found (`resolvePages` in VitePress 1.6.4, read 2026-11-04). A folder
outside `docs/user/` therefore cannot become a page while `srcDir` is `docs/user`.

## Decision

`srcDir` is the repository root.

- `srcExclude` hides every Markdown file outside `docs/user/` and `site/api/`. The list is computed
  from the tree when the config loads (`siteSourceExcludes` in `scripts/site-docs.ts`): each
  top-level Markdown file, and each folder that holds neither of the two. Hidden folders are left
  out, because VitePress's glob skips them.
- `rewrites` map each page under `docs/user/` to the same path it had before, with `README.md` as
  `index.md`, and each page under `site/api/` to `api/`. Every URL of decision 0015 stays as it
  was, so every `docsUrl` resolves as before, and `site:check` tests it.
- Vite's `envDir` is the `site/` folder, so a `.env` file at the repository root never reaches the
  build.
- A `public/` folder at the repository root would be served as static files, because VitePress
  reads `public/` from `srcDir`. The repository has none, and must not add one without a site
  change.

## Alternatives considered

- Write the reference into `docs/user/api/` during the site build only. Not taken: decision 0015
  and R-AX-2 keep it out of `docs/user/`, and the docs check and the package copy read that folder.
- Copy `docs/user/` and the reference into a staging folder and point `srcDir` there. Not taken:
  the dev server would no longer reload on an edit to `docs/user/`, and the link rewriting, which
  keys on the source path, would need a second path map.
- Serve TypeDoc's HTML output under `site/dist/api/` after the VitePress build. Not taken: the
  pages would have another theme, no site search, and no Markdown copies for `llms.txt`.

## Consequences

- A new top-level folder with Markdown files is excluded automatically. A Markdown file that slips
  through becomes an HTML page without a copy in `llms.txt`, and `site:check` fails on it.
- The VitePress config depends on two folders instead of one. A move to VitePress 2.0 or to
  Starlight has to keep the same URL map.
