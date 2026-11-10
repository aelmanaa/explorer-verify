# 0062: Site-only pages for the docs site

Status: Accepted (2026-11-10). Amends the "Generator" part of
[decision 0015](0015-docs-site-versioning-and-error-pages.md) for pages that exist only on the
site. Pages in `docs/user/` stay plain Markdown.

Research: [research/2026-11-10-docs-audit.md](../research/2026-11-10-docs-audit.md).

## Context

Issue [#307](https://github.com/aelmanaa/explorer-verify/issues/307), part of
[#303](https://github.com/aelmanaa/explorer-verify/issues/303). Decision 0015 builds the site from
the Markdown in `docs/user/`, the same files that GitHub renders and the npm package ships, and
keeps them free of frontmatter, Vue components and VitePress containers.

The 2026-11-10 audit found that the site root, `docs/user/README.md`, routes no reader: no pitch,
no install line, no start per persona, and a long table of pages (finding F1). The benchmark sites
with the best routing use a landing page with a hero and a grid of cards. VitePress builds that
with `layout: home` and frontmatter, which a page in `docs/user/` must not hold. The site build
also had no place for a page outside `docs/user/` and the generated API reference.

## Decision

- A Markdown file in `site/pages/` is a site-only page. The site serves it at its path under that
  folder: `site/pages/index.md` is the site root.
- A site-only page may use frontmatter, `layout: home` and Vue. It is not in `docs/user/`, so
  GitHub and the npm package never see it, and the docs check does not read it.
- When `site/pages/index.md` exists, `docs/user/README.md` is served at `/overview` instead of the
  site root. Links to it, the sidebar, the Markdown copy and the site's `llms.txt` follow. Without
  that file, the root stays `docs/user/README.md`.
- A site-only page has no Markdown copy, and the site's `llms.txt` does not list it. The site
  check (decision 0015, test 3) skips it. Every user page keeps its HTML page, its Markdown copy
  and its `llms.txt` line.
- Content that readers need outside the site stays in `docs/user/`. A site-only page holds
  navigation and presentation, such as the home page's hero and cards, that repeat what a user
  page says in plain Markdown.
- A site-only page must not take the path of a user page. The build fails when two pages would
  get the same path, and every `docsUrl` keeps its path.

The 404 page is part of the theme, not a site-only page: VitePress shows its theme's not-found
slot for a missing page both in the built `404.html` and when the browser loads a missing route,
while a `404.md` page covers only the first.

## Alternatives considered

- Keep the landing page in `docs/user/README.md` as plain Markdown, the benchmark's option with no
  decision change. Not taken alone: it gives the same routing as a table, but no hero, cards or
  buttons on the site. The README still gets that plain routing for GitHub and npm readers
  (issue #324).
- Allow frontmatter in `docs/user/`. Not taken: GitHub shows frontmatter as a table at the top of
  the page, the npm package ships it, and decision 0015 keeps a later move to another generator
  cheap.
- A site-only page with a Markdown copy listed in `llms.txt`. Not taken: the home page repeats the
  overview, which `llms.txt` already lists, and its frontmatter and Vue mean nothing to an agent.

## Consequences

- Issue #324 fills the home page in `site/pages/index.md`. This change ships a placeholder with
  the `layout: home` hero, so `docs/user/README.md` moves to `/overview` now.
- `scripts/site-docs.ts` maps the pages (`sitePages`, `hasSiteHome`, `siteRewrites`), and the site
  check passes their paths to `siteProblems`.
- A link to the site root from outside still works: it shows the home page, which links the
  overview.
