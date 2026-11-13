# Tooling

Audience: contributors setting up or changing the toolchain. The toolchain mirrors [hardhat-kms](https://github.com/aelmanaa/hardhat-kms)
(decision 0006).

| Tool                          | Config                                                                 | Role                                                                                                                                                        |
| ----------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pnpm 12.16.1                  | `package.json` `packageManager`, `pnpm-workspace.yaml`                 | Workspace; tool versions live in the `catalog:`                                                                                                             |
| TypeScript 7                  | `tsconfig.base.json`                                                   | `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `isolatedDeclarations`, `erasableSyntaxOnly`, `verbatimModuleSyntax`; imports use `.ts` |
| oxlint (type-aware)           | `.oxlintrc.json`                                                       | Lint; `import/no-nodejs-modules` on `packages/*/src` except `packages/foundry/src`; TSDoc required on exports                                               |
| oxfmt                         | `.oxfmtrc.json`                                                        | Format, width 100                                                                                                                                           |
| knip                          | `knip.json`                                                            | Unused files, exports and dependencies                                                                                                                      |
| publint, are-the-types-wrong  | `pkg:check` script                                                     | Package manifest and type resolution                                                                                                                        |
| c8                            | `packages/*/.c8rc.json`                                                | Coverage, 95% floor per file                                                                                                                                |
| esbuild 0.28.2                | `scripts/bundle.ts`                                                    | Browser bundle for the size check and the browser smoke test                                                                                                |
| Rollup 4.67.4                 | `scripts/name-bundle.ts`                                               | The Rollup build of the per-name size check ([decision 0042](decisions/0042-every-exported-name-measured-in-real-bundlers.md))                              |
| Playwright 1.64.1             | `scripts/browser-smoke.ts`                                             | Headless Chromium for the browser smoke test                                                                                                                |
| TypeDoc 0.28.20               | `site/api-reference.ts`, `site/tsconfig.api.json`                      | The API reference of the docs site, from TSDoc, with typedoc-plugin-markdown 4.14.1 and the TypeScript 6 API ([API reference](#api-reference))              |
| StrykerJS 10.0.0 (tap runner) | `packages/explorer-verify/stryker.config.json`, `mutation-floors.json` | Mutation testing of the result mapping, the HTTP retry rules and the key redaction, with a score floor per file                                             |
| lefthook                      | `lefthook.yml`                                                         | pre-commit: lint fix, format, typecheck, type escapes; commit-msg: Conventional Commits                                                                     |
| pre-push hook                 | `scripts/install-git-hooks.ts`                                         | Refuses pushes to `main`, then runs unit tests                                                                                                              |
| changesets                    | `.changeset/config.json`                                               | Release notes and versions                                                                                                                                  |
| Dependabot                    | `.github/dependabot.yml`                                               | Weekly updates with a 7-day cooldown                                                                                                                        |

## Type-checking layout

`tsc -b` at the root builds these projects:

- `packages/explorer-verify/tsconfig.build.json`: `src/` only, `types: []`, DOM lib. Node APIs do
  not typecheck here, which keeps the shipped code runtime-neutral (decision 0002).
- `packages/explorer-verify/tsconfig.test.json`: `src/` and `test/` with Node types.
- `packages/foundry/tsconfig.build.json` and `tsconfig.test.json`: the Foundry build helper and
  its tests, with Node types (decision 0008). Both reference the core's build project, so the
  core's declarations are built first and the helper sees only its public entry point.
- `examples/tsconfig.test.json`: the example applications and their tests, with Node types and
  the DOM lib. `examples/tsconfig.worker.json` checks the Cloudflare Worker again with
  `types: []`, so it uses only web-platform globals. Both reference the core's build project: the
  examples import `explorer-verify` by name, as an application does, which resolves to `dist/`.
- `tsconfig.scripts.json`: repository scripts.

`tsconfig.test.json` maps the name `explorer-verify` to `src/index.ts` with `paths`, for types
only. `test/browser/scenario.ts` imports the package by that name. esbuild reads no tsconfig, so
the browser bundle still takes the built `dist/`, and the CI lint job, which does not build, still
type-checks the file.

## Type escapes

`node scripts/check-type-escapes.ts` fails on `any`, `@ts-` directives, casts, type predicates and
lint-disable comments in `packages/*/src`, unless `scripts/type-escapes.json` lists them with a
reason. The list starts empty; keep it that way where a typed alternative exists. Code under
`packages/*/src/internal/vendor/` is exempt, and oxlint ignores it too. Ported prior-art code is
rewritten into the normal tree, not vendored.

`node scripts/check-stryker-disables.ts` does the same for the comments that mark an equivalent
mutant: each one in `packages/*/src` must be
`// Stryker disable next-line <Mutator>[,<Mutator>]: <reason>`, and the table in
[testing.md](testing.md#when-a-mutant-survives) must list it. The script prints every comment with
its file and line.

## Blocked hosts

`node scripts/check-hosts.ts` fails when a tracked file links to a host on its blocklist. It exists
because the scaffold once linked a third-party GitHub mirror in place of github.com, including in
the package's `repository` field. Link GitHub as `https://github.com/...`.

## Agent docs

`node scripts/check-agent-docs.ts` enforces requirements R-AX-1 to R-AX-3, and `pnpm run check`
runs it. The rules live in `scripts/agent-docs.ts`. The check fails when:

- `llms.txt` at the repository root lacks an H1, a summary blockquote (`> ...`) before the first
  section, or the sections `## User docs` and `## Contributor docs`;
- `llms.txt` holds a relative link, or a link into this repository that is not a raw link to
  `main`, leaves the repository or names a file that does not exist;
- a Markdown file under `docs/user/` is not listed in `llms.txt`;
- `docs/user/` holds a symbolic link;
- `docs/user/guides/using-from-an-agent.md` is missing, or lacks one of the headings "Submit is
  permanent", "Safe steps", "API keys" and "Etherscan plan rule";
- a user page has no relative link to the root `llms.txt` in its first 10 lines;
- a user page has no version line in its first 10 lines, or the line names another version than
  `packages/explorer-verify/package.json`;
- a relative link in a Markdown file under `docs/` points to a missing file, or to a heading the
  target file does not have;
- a user page holds `{{` in prose, outside code spans, code blocks and HTML comments. The docs site
  compiles each page as a Vue template, which evaluates `{{ }}` (R-AX-17, decision 0015).

File names must match with the same case, so a link that works on macOS but not on Linux fails
everywhere. Anchors follow GitHub's slug rules: the rendered heading text (emphasis markers and
backticks dropped, entities decoded), lower case, punctuation other than `-` and `_` dropped, each
space a hyphen without collapsing runs, and `-1`, `-2` for repeated headings. Setext headings
count.

This check covers `docs/` only. The `site` job of pull request CI runs lychee offline, with
fragments, on every Markdown file that `git ls-files` lists, `docs/` included, except
`CHANGELOG.md` files, `.changeset/` and `site/pages/` (see
[Link check](testing.md#link-check)). A broken relative link or anchor in `README.md`, a package
README, `.github/` or `validation/` fails that job, not `pnpm run check`.

Links in `llms.txt` are raw links, so an agent gets Markdown, not HTML:
`https://raw.githubusercontent.com/aelmanaa/explorer-verify/main/<path>`.

### Decision and research sources

The same command checks the rule in [decisions](decisions/README.md) and
[research](research/README.md). The rules live in `scripts/decision-sources.ts`. The check fails
when:

- a decision record (`docs/contributor/decisions/NNNN-*.md`) has neither a relative link to a
  research note nor the line `Research: none (maintainer choice).`, or has both;
- a decision record links a path under `docs/contributor/research/` that is not a research note;
- a research note has no `## Sources` section, or that section has no http or https URL outside
  code (a Markdown link or a bare URL);
- a research note is not linked from `docs/contributor/research/README.md`.

A link from a decision to the research index (`research/README.md` or the folder) is allowed and
does not count as research. The `Research: none` line, links and URLs count only outside fenced
code and HTML comments. Every docs check skips HTML comments, so a link inside `<!-- -->` is not
checked either.

### Version line

Each user page has this line, alone, within its first 10 lines and outside a code block:

```text
Version: explorer-verify 0.0.0
```

The version is the `version` of `packages/explorer-verify/package.json`. `pnpm run
version-packages` runs `node scripts/check-agent-docs.ts --write-versions` after `changeset
version`, which sets the line on every user page. Do not edit the version by hand.

### Docs in the package

The package's `build` script runs `scripts/package-docs.ts`. It copies every file under
`docs/user/` to `packages/explorer-verify/docs/` and writes `packages/explorer-verify/llms.txt`
from the root one, with links to user pages made relative (`docs/<page>`). In the copied pages, a
link inside `docs/user/` stays as written, a link to the root `llms.txt` points to the packaged
one, and any other relative link becomes a raw GitHub URL. Both copies are build output and are
gitignored. The `files` field of the package lists them.

`pkg:check` runs `scripts/check-packed-files.ts`. It reads `npm pack --dry-run --json` and fails
when the tarball lacks `llms.txt` or a file from `docs/user/`, or when a relative link in a packaged
page or the packaged `llms.txt` points to a file that is not in the tarball.

### Docs site

The docs site is <https://aelmanaa.github.io/explorer-verify/> (R-AX-17, decisions 0015, 0028 and
0062). VitePress 1.6.4, pinned exactly in the catalogue, builds it from `docs/user/`, from the
generated [API reference](#api-reference) in `site/api/`, and from the site-only pages in
`site/pages/`. It sets `base` to `/explorer-verify/` and uses clean URLs and local search.

VitePress reads pages from `srcDir` only, so `srcDir` is the repository root (decision 0028).
`srcExclude` hides every other Markdown file, and `rewrites` serve `docs/user/` at the site root,
`site/api/` under `api/` and `site/pages/` at the root, so every URL stays the same. Vite's root is
`srcDir` as well, which
brings two rules: `envDir` is `site/`, so a `.env` file at the repository root never reaches the
build, and the repository must not have a root `public/` folder, because Vite would serve it.

The config is `site/.vitepress/config.ts`, outside `docs/user/`, so GitHub and the package never
see it. The pages in `docs/user/` stay plain Markdown: no frontmatter, Vue components or
containers. The link rules, the sidebar, the nav and the copies live in `scripts/site-docs.ts`:

- `README.md` becomes `index.md`, the page of its folder.
- A Markdown file in `site/pages/` is a site-only page (decision 0062). It may use frontmatter,
  `layout: home` and Vue, and it has no Markdown copy. `site/pages/index.md` is the site's home
  page; while it exists, `docs/user/README.md` is served at `/overview`.
- Before VitePress reads a page, a link inside `docs/user/` stays relative, a link to the root
  `llms.txt` points to the site's `llms.txt`, and any other link into the repository points to the
  file on GitHub at the tag `v<version>`, because the site is built from that tag. The HTML page
  drops the `Version:` and `Agents:` lines of the header; the nav shows the version, and the
  Markdown copy keeps both lines.
- The sidebar is the curated list `SIDEBAR`: groups of pages, each with a short label. A listed
  page that does not exist yet is skipped, so a pull request that adds a planned page needs no
  change to the list. `site:check` and a unit test fail when a user page is in no group or in two.
  The nav links the first page of the Get started, Guides by setup, Reference and API groups, and
  a version menu links the changelog at the release tag and the package on npm.
- Search boosts a match in a heading, ranks the API reference below the written pages, and treats
  a plural word as its singular, so "key" finds "API keys".
- A code block with a title, such as ` ```ts [verify.ts] `, gets a title bar on the site.
  VitePress 1.6.4 shows the title only inside a code group.
- The theme in `site/.vitepress/theme/` adds CSS (the code language label reaches 4.5:1 contrast
  in both themes) and a 404 page that links the overview, the Get started pages and the search.
- Headings get GitHub's anchors, the same ones the docs check uses, so a link with a fragment that
  passes the check works on the site too.
- Inline code is marked `v-pre`, as VitePress already marks code blocks, so `{{` in code is shown as
  written. `{{` in prose fails the docs check.

| Command                 | What it does                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm run site:api`     | `site/api-reference.ts`: generates the API reference into `site/api/`                                                                            |
| `pnpm run site:build`   | `site/api-reference.ts`, `vitepress build site`, then `scripts/site-copies.ts`, which writes the Markdown copies and `llms.txt` into `site/dist` |
| `pnpm run site:check`   | `scripts/check-site.ts` on the build: test 3 of decision 0015. Needs `pnpm run build` first                                                      |
| `pnpm run site:dev`     | Generates the API reference, then runs the VitePress dev server                                                                                  |
| `pnpm run site:preview` | Serves `site/dist`                                                                                                                               |

Dev-server advisories (2026-11-03): `pnpm audit` reports advisories against the Vite 5 and
esbuild versions that VitePress 1.6.4 depends on, for the dev server only. They are accepted,
because CI and the deploy only build. Run `site:dev` and `site:preview` on localhost only; never
pass `--host`.

`scripts/site-copies.ts` writes each user page next to its HTML as `<page>.md`, with the site's
links, copies every other file under `docs/user/` (images, JSON samples) as it is, writes a copy
of the skill at `skills/explorer-verify/SKILL.md`, copies each page of the API reference to `api/`,
and writes `site/dist/llms.txt`. That `llms.txt` is the root one with only the user pages and the
skill, each linked as its Markdown copy on the site,
plus a line that names the version and the jsDelivr URL of other versions, and an
`## API reference` section that links the copy of each API page. The root and packaged `llms.txt`
do not change.

`scripts/check-site.ts` reads the codes from the built package and builds an error for each. It
fails when a `docsUrl`, with the site address removed, has no HTML page or no `.md` copy in
`site/dist`; when a link in the site's `llms.txt` is not a built `.md` copy; when an HTML page
other than `404.html` and the site-only pages has no copy that `llms.txt` lists; when a file under
`docs/user/` that is not a page is missing from the build; or when a user page is in no sidebar
group or in two. The CI `site` job runs the core build, `site:build` and `site:check`. It never deploys. The job is not yet a required check; the
maintainer adds `Docs site build` to the `main` ruleset.

`scripts/smoke-site.ts` runs after a deploy: test 4 of decision 0015. It fetches each code page, its
`.md` copy, the site's `llms.txt`, every page that file lists and every file under `docs/user/`
that is not a page, and fails unless each returns 200 within 10 seconds and each JSON file parses
as JSON. It also fails unless the site's `llms.txt` names the package version at the
checked-out tag, so a site that still serves an older version fails. It tries up to five times, 15 seconds apart, because a new deployment can take a short time to
reach every edge. [Releasing](releasing.md#docs-deploy) describes the deploy.

### Search engines

What the site tells search engines is in `scripts/site-seo.ts`, and the site config applies it
(R-AX-17, issues #366 and #367). The maintainer's console steps are in
[Search console](search-console.md).

- **Titles.** VitePress writes the page's H1, then ` | explorer-verify`. The home page sets its
  title in its frontmatter. An API member that two entry points export, such as `verify()` in
  `explorer-verify` and `explorer-verify/core`, gets its entry point in brackets:
  `verify() (explorer-verify/core)`. The part before the suffix is at most 60 characters.
- **Descriptions.** Each page has its own, 40 to 160 characters, unique across the site. The pages
  in `docs/user/` hold no frontmatter (decision 0015), so their descriptions are in
  `site/descriptions.json`, keyed by the page's path under `docs/user/`. A new user page needs an
  entry there; `site:check` and a unit test fail without one. An API page's description is its
  name, its entry point and the first sentences of its TSDoc summary that fit, which
  `site/api-reference.ts` writes to `site/api/descriptions.json`. The home page sets the
  site-level description in its frontmatter; no other page may use it.
- **Canonical and social tags.** Each page except the 404 page has one canonical link: the
  absolute URL with the base and without `.html`, as the sitemap lists it. GitHub Pages answers
  for both `/page` and `/page.html`, so this says which one counts. `og:title`,
  `og:description`, `og:url` (the canonical URL), `og:type`, `og:site_name`, the social image
  tags and `twitter:card` (`summary_large_image`) follow it.
- **JSON-LD.** The home page has one schema.org `SoftwareSourceCode` block. Its version,
  description, license and repository are read from `packages/explorer-verify/package.json` at
  build time. Google shows no rich result for this type; it only describes the project.
- **Sitemap.** `sitemap.hostname` is the site URL, so `site/dist/sitemap.xml` lists every page by
  its absolute URL without `.html`. A page's `lastmod` is the date of the last commit that changed
  its source other than its `Version:` line, which every release rewrites: `git log -p` of
  `docs/user/` and `site/pages/`, skipping a diff whose changed lines are all `Version:` lines. An
  API page, generated from many sources, has no `lastmod`. A shallow checkout has no history, so
  the build leaves every `lastmod` out there; the docs deploy checks out the tag with
  `fetch-depth: 0`. There is no `robots.txt`: crawlers read it at the host root only.
- **Verification.** `site/verification.json` holds the Google and Bing tokens and the name of the
  Google verification file. A set token adds its meta tag to the home page. The files in
  `site/static/` are copied to the site root as they are by `scripts/site-copies.ts`, never as
  pages.

`scripts/check-site.ts` also fails when the sitemap is missing, misses a page, or lists a URL that
is not built, is relative, ends in `.html` or leaves out `/explorer-verify/`; when a page has no
title or description, shares one, has a description outside 40 to 160 characters or the site's
own, lacks exactly one canonical link equal to its sitemap URL, or lacks `og:title`,
`og:description` or an `og:url` equal to its canonical; when the home page's JSON-LD is missing,
does not parse or names another version; when a set verification tag is missing; when the Google
verification file is missing or differs; and when a `robots.txt` is built.
`scripts/smoke-site.ts` also fetches `sitemap.xml`, the Google verification file and the home
page's verification tags after a deploy.

### Icons, logo and social image

The icons, the header logo and the social image are files of `site/static/`, served from the site
root (#373). `favicon.svg` is the browser icon, drawn on a 16 px grid; `favicon-32.png` is its PNG
fallback; `apple-touch-icon.png` is the 180 px home screen icon; `logo.svg` is the mark in the
header and on the home page; `og-image.png` is the 1280×640 social image. Every page links the
icons, and every page except the 404 page names the social image in `og:image` and
`twitter:image` by its absolute URL, with `og:image:width`, `og:image:height` and
`og:image:alt`.

The PNGs are committed, so they look the same everywhere. Each has an SVG source next to it:
`favicon.svg`, `apple-touch-icon.svg` and `og-image.svg`. After editing a source, run
`pnpm run site:images` (`node site/render-images.ts`), which renders the PNGs in Chromium through Playwright. When
Playwright's own Chromium is not installed, pass the path of a Chrome binary as its argument.
Reduce the PNGs to an indexed palette with an optimiser before committing: `og-image.png` is
about 25 kB that way.

`site:check` fails when one of these files is missing from the build, when a PNG has another size,
or when a page lacks `og:image` or `twitter:image`, names a relative or another URL in one, or sets
`twitter:card` to anything but `summary_large_image`.

The maintainer uploads `og-image.png` as the repository's social preview, in the repository's
GitHub settings under General, Social preview.

The theme's colours come from the logo: stamp blue `#3346D3` and ink `#14161C` in the light theme,
and `#93A4FF` for text in the dark theme, where buttons keep the stamp blue. Both themes use the
system font stacks of the social image; no web font loads. `scripts/test/site-theme.test.ts`
reads VitePress's variables and the theme's overrides and fails when a text colour falls below
4.5:1 on its background, or the focus ring below 3:1, in either theme.

### API reference

The API reference on the site is generated from TSDoc (R-AX-2, R-DX-4, decision 0015).
`site/api-reference.ts` runs TypeDoc with typedoc-plugin-markdown and writes an index, a page per
package entry point and a page per exported member into `site/api/`. `site/api/` is gitignored
build output. It is never written to `docs/user/`, so the npm packages do not ship it; their
`.d.ts` files carry the same TSDoc.

- The entry points come from the `exports` of each `packages/*/package.json`: every export with a
  `types` condition, mapped from `dist/` back to its source (`scripts/site-api.ts`). Each entry
  point's page is titled as users import it, such as `explorer-verify/server`. Its folder name is
  flat, without the scope and with `-` for `/`, such as `api/explorer-verify-server/`. A page and
  a folder must never share a name, because a link to the page would reach the folder; the script
  fails if they do. The CLI exports no types, so it has no page; its reference is generated from
  its help ([CLI reference](#cli-reference)).
- The page of an entry point starts with the one-line summary of its `@packageDocumentation`
  comment, which the index also shows, then lists its members in tables: functions first, with
  `verify`, `dryRun`, `checkStatus`, `verifyEach` and `linkProxy` leading, then classes,
  interfaces, type aliases and variables. Each member has its own page, such as
  `api/explorer-verify/functions/verify`. The sidebar lists the index and the entry points only.
- No page is taller than ten desktop screens. A member inherited from a type outside the
  repository, such as `captureStackTrace` from `Error`, is left out, and nothing links into
  `node_modules`. A union of all the error codes shows as `ErrorCode`, and one of
  `ExplorerVerifyError` of each code as `AnyExplorerVerifyError`. Parameters, class properties and
  the members of a union are tables.
- TypeDoc reads `site/tsconfig.api.json`: the sources of every entry point, with `explorer-verify`
  mapped to the core's sources, so a type that a helper package takes from the core links to the
  core's page.
- The run fails before it writes a page when TypeDoc warns: an export or a member without TSDoc
  (`notDocumented`, for every package), an unresolved `{@link}` (`invalidLink`), or a type the API
  uses that no entry point exports (`notExported`). TypeDoc runs that last check only for the
  project's own package, so the script runs it once per package. The run also fails when a page
  holds `{{` in prose.
- Source links point at the version's tag:
  `https://github.com/aelmanaa/explorer-verify/blob/v<version>/<path>#L<line>`. `disableGit` is
  on, so TypeDoc reads no git state, and the same sources give the same pages on any checkout.
  The CI `site` job runs the script a second time into another folder and fails on any difference.
- Members get HTML anchors with the prefix `api-` (`useHTMLAnchors` and `anchorPrefix`), so a link
  to a member resolves whatever id VitePress gives its heading.

TypeScript 7.0 "does not ship with an API"
([announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/), 2026-07-08,
read 2026-11-04), and TypeDoc 0.28.20 accepts `typescript` 5.0.x to 6.0.x only (`npm view typedoc
peerDependencies`, 2026-11-04). TypeDoc support for TypeScript 7 is tracked in
[TypeStrong/typedoc#3098](https://github.com/TypeStrong/typedoc/issues/3098), which targets
TypeScript 7.1 and gives no date (read 2026-11-04). So TypeDoc lives in the `site` workspace
package (`site/package.json`), whose `typescript` is an npm alias to `@typescript/typescript6`
6.0.2, which installs `typescript` 6.0.3. That is the compatibility package the announcement
describes. The alias comes from the `typedoc`
named catalogue in `pnpm-workspace.yaml`. pnpm resolves TypeDoc's `typescript` peer from that
package, so only TypeDoc gets the TypeScript 6 API; `tsc -b` and the lint still run TypeScript 7.
A root `overrides` entry cannot do this: an `npm:` override leaves a peer range unchanged
([pnpm overrides](https://pnpm.io/settings/dependency-resolution), read 2026-11-04). When a TypeDoc
release supports the TypeScript 7.1 API, the `site` package and the alias go.

## CLI reference

Part of `docs/user/reference/cli.md` is generated from the CLI's help (R-AX-2): the usage, the
examples, the commands, the options, the environment variables and the exit codes, between two
HTML comment markers. `packages/cli/src/reference.ts` renders that part from the same help data
that `explorer-verify --help` prints. `pnpm run cli-reference` rewrites it, and `pnpm run check`
runs `node scripts/generate-cli-reference.ts --check`, which fails when the committed page
differs. Change a command, an option or its description in the command table, then run
`pnpm run cli-reference`. Text outside the markers is written by hand.

## Test runner

`scripts/node-test.ts` runs `node --test` for the package `test:unit` and `test:randomize` scripts
and for the script tests; it sets `--test-timeout` for the Node version and passes the other
arguments on. When the arguments include `--test-randomize` or `--test-random-seed` and the Node
lacks them (22.x, 24.0 to 24.15 and 26.0), `scripts/random-order.ts` decides the outcome:

- by default, it writes a note to stderr, skips the run and exits 0;
- with `REQUIRE_RANDOM_ORDER=1` in the environment, it writes an error that names the Node version
  and the first releases with the option, and exits 1. The CI step sets it.

`pnpm run test:randomize` builds, then runs the package unit tests and the script tests with
`--test-randomize`. The CI coverage job runs it on the latest Node 24 with `REQUIRE_RANDOM_ORDER=1`;
[deterministic tests](testing.md#deterministic-tests) explains how to replay a failing order.

## Browser bundle

`scripts/bundle.ts` bundles with esbuild for `platform: "browser"`, as ESM, minified, for
ES2023, with every tsconfig file ignored (`tsconfigRaw: "{}"`). An import of a Node built-in
(`node:fs` or `fs`) fails the build. So does any import esbuild leaves external, which catches a
built-in inside `try`/`catch` or a dynamic `import()`. `scripts/check-size.ts`
and `scripts/browser-smoke.ts` both use it, so the size check measures the bundle the browser
test runs. [testing.md](testing.md#browser-smoke-test) describes both commands. When the size
check leaves an import external, it writes the file's path relative to the entry's folder, so
the sizes are the same on any checkout path ([testing.md](testing.md#bundle-size)).

esbuild has an install script, which only checks that the binary from its platform package works.
`allowBuilds` in `pnpm-workspace.yaml` lists it as `false`, so the script does not run. Playwright
has no install script; its browser comes from `pnpm exec playwright install`.

The CI `browser` job caches `~/.cache/ms-playwright`, keyed on the runner and the Playwright
version that `node -p "require('playwright/package.json').version"` prints. The step fails when it
prints nothing, and a Playwright update downloads the browser again. It installs the headless shell only
(`--only-shell`), not the full Chrome for Testing build. The system libraries come from apt on
every run, because the cache holds only the browser. The job runs `pnpm run test:browser`, then
`pnpm run test:browser:harness`. The job is not yet a required check; the
maintainer adds `Browser smoke (Chromium)` to the `main` ruleset.

## Tests for scripts

Tests for the repository scripts live in `scripts/test/*.test.ts`. `pnpm run test:scripts` runs
them under c8, and `pnpm test` and `pnpm run test:unit` run it after the package tests. They build
small fixture trees in a temporary folder, and run the entry points as child processes against
them. c8 covers the agent-docs scripts (`scripts/agent-docs.ts`, `scripts/decision-sources.ts` and
the three scripts that use them), the docs site scripts (`scripts/site-docs.ts`,
`scripts/site-api.ts`,
`scripts/site-copies.ts`, `scripts/check-site.ts` and `scripts/smoke-site.ts`, the last against a
local server), `scripts/random-order.ts`, the size check
(`scripts/bundle.ts`, `scripts/size-budget.ts` and `scripts/check-size.ts`), the per-name size
check (`scripts/name-size.ts`, `scripts/name-bundle.ts` and `scripts/check-names.ts`), the release
scripts ([releasing.md](releasing.md)), the mutation score check
(`scripts/mutation-score.ts` and `scripts/check-mutation-score.ts`) and the mutation shards
(`scripts/mutation-shards.ts`, `scripts/plan-mutation-shards.ts`, `scripts/mutation-merge.ts` and
`scripts/merge-mutation-reports.ts`) with a 95% floor per file on lines, branches, functions and
statements. The release script tests create temporary git repositories, and the tag test signs
tags with keys it makes in a throwaway `GNUPGHOME`, so they need `git` and `gpg` on the `PATH`.
`scripts/browser-smoke.ts` needs a browser and
runs in its own CI job instead. The older scripts have no tests yet and are not in the
coverage list; a script gets added when it gets tests.

## Mutation testing

`pnpm run test:mutation` runs StrykerJS from `packages/explorer-verify`.
[testing.md](testing.md#mutation-testing) lists the mutated files, their floors and how to read the
report; this section covers the setup.

- Stryker has no runner for `node:test`. Its tap runner starts `node --test-reporter=tap` on each
  test file, with a hook that records which mutants the file covers, and reads the TAP output.
  Node strips the TypeScript types of the instrumented files as it does for the normal test run,
  so Stryker needs no build of its own. Coverage is per test file: a mutant runs only the files
  that reach it.
- Both commands build the package first. Some unit tests, such as
  `blackbox-34-resolve-bytecode.test.ts`, import `explorer-verify` by name, which resolves to
  `dist/`; they need the build to pass the dry run, and cannot kill a mutant in `src/`.
- `test/unit/skill.test.ts`, `test/unit/user-docs.test.ts` and `test/unit/options-types.test.ts`
  are left out: they test the built `dist/` and the helper packages, which Stryker does not mutate.
- Stryker runs in place (`inPlace`): it instruments the mutated files in `src/` itself, keeps the
  originals in `packages/explorer-verify/.stryker-tmp/` and puts them back when the run ends, also
  on Ctrl+C. A copy of the package would break tests that read `../../../../docs/` or another
  package's fixtures by relative path. During a local run, do not edit or commit the mutated
  files. If a run is killed hard (`kill -9`), restore them with
  `git checkout -- packages/explorer-verify/src`.
- No checker runs: a mutant that would not type-check runs anyway, fails or survives, and counts.
- A test that reads the source text of a mutated file cannot pass on the instrumented copy, which
  holds every mutant at once. Such a test is skipped when the file it reads contains
  `stryMutAct_`, the name of Stryker's instrumentation call. One test in `verify.test.ts` does
  this.
- `concurrency` is 4: four test processes at a time, which keeps a local run from taking over a
  shared machine. The `Mutation` workflow passes `--concurrency "$(nproc)"`, one process per core
  of the runner.
- `timeoutFactor` is 2 and `timeoutMS` is 15000; Stryker's defaults are 1.5 and 5000. A mutant
  times out when its tests run longer than their time in the dry run, times the factor, plus
  `timeoutMS` and Stryker's overhead. With the defaults, a mutant that only slowed a test down
  counted as a timeout (detected) on a loaded machine and survived on an idle one. The tap runner
  runs every test file that covers a mutant in one timed run, so a mutant that hangs costs the
  factor times the dry-run time of all those files: on 0.2.0, with a factor of 3, eight
  `build.ts` mutants each took 30 minutes. A factor of 2 cuts that by a third.
- `scripts/check-mutation-score.ts` reads `reports/mutation/mutation.json`, prints one Markdown row
  per file and exits 1 when a file is below its floor in `mutation-floors.json`, when a mutated
  file has no floor, or when a file with a floor is missing from the report. Stryker's own
  `thresholds.break` is one number for the whole run, so the per-file check is a script. A file
  can have `maxUndetected`, a maximum count of survived and not-covered mutants, instead of a
  `floor`; it suits a file with few mutants, where one mutant moves the score by several points.
- `incremental` is on: each run writes `reports/stryker-incremental.json`.
  `pnpm run test:mutation` passes `--force` and tests every mutant;
  `pnpm run test:mutation:incremental` reuses the results of mutants and test files that did not
  change. It sees changes to the mutated files and to `test/unit/*.test.ts` only. A change to any
  other file is invisible to it: `test/helpers/`, fixtures, `schema/`, `docs/`, the `src/` files
  the mutated code calls, `package.json`, the lockfile or a Stryker update. Only a full run
  catches those; run `pnpm run test:mutation` after changing one.
- The `@stryker-mutator/*` packages are devDependencies of the package and are pinned in the
  catalog, like the other tools. They add no runtime dependency. `typed-rest-client`, a
  dependency of `@stryker-mutator/core`, pins `qs` 6.15.1, which has four moderate advisories; an
  override in `pnpm-workspace.yaml` raises it to 6.16.1.

## Public declaration comments

Builds use `stripInternal` to omit dependency injection seams from package declarations. Source
comments keep requirement and decision IDs with `//`; public TSDoc describes the API without
those IDs. `pnpm run pkg:check` runs `scripts/check-declaration-docs.ts` after the build and fails
when any built declaration contains a contributor ID. The CLI and SDK README examples run in
the documentation tests.

`pnpm run check` builds the type-checking projects before type-aware lint, so lint can resolve
the public declarations from a clean checkout. Live probe scripts use internal flow helpers from source. The scripts project checks those
sources with DOM types; the separate core build still checks them without Node types.
