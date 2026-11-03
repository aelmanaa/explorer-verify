# Tooling

Audience: contributors setting up or changing the toolchain. The toolchain mirrors [hardhat-kms](https://github.com/aelmanaa/hardhat-kms)
(decision 0006).

| Tool                         | Config                                                 | Role                                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pnpm 12.16.1                 | `package.json` `packageManager`, `pnpm-workspace.yaml` | Workspace; tool versions live in the `catalog:`                                                                                                             |
| TypeScript 7                 | `tsconfig.base.json`                                   | `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `isolatedDeclarations`, `erasableSyntaxOnly`, `verbatimModuleSyntax`; imports use `.ts` |
| oxlint (type-aware)          | `.oxlintrc.json`                                       | Lint; `import/no-nodejs-modules` on `packages/*/src` except `packages/foundry/src`; TSDoc required on exports                                               |
| oxfmt                        | `.oxfmtrc.json`                                        | Format, width 100                                                                                                                                           |
| knip                         | `knip.json`                                            | Unused files, exports and dependencies                                                                                                                      |
| publint, are-the-types-wrong | `pkg:check` script                                     | Package manifest and type resolution                                                                                                                        |
| c8                           | `packages/*/.c8rc.json`                                | Coverage, 95% floor per file                                                                                                                                |
| esbuild 0.28.2               | `scripts/bundle.ts`                                    | Browser bundle for the size check and the browser smoke test                                                                                                |
| Playwright 1.64.1            | `scripts/browser-smoke.ts`                             | Headless Chromium for the browser smoke test                                                                                                                |
| lefthook                     | `lefthook.yml`                                         | pre-commit: lint fix, format, typecheck, type escapes; commit-msg: Conventional Commits                                                                     |
| pre-push hook                | `scripts/install-git-hooks.ts`                         | Refuses pushes to `main`, then runs unit tests                                                                                                              |
| changesets                   | `.changeset/config.json`                               | Release notes and versions                                                                                                                                  |
| Dependabot                   | `.github/dependabot.yml`                               | Weekly updates with a 7-day cooldown                                                                                                                        |

## Type-checking layout

`tsc -b` at the root builds these projects:

- `packages/explorer-verify/tsconfig.build.json`: `src/` only, `types: []`, DOM lib. Node APIs do
  not typecheck here, which keeps the shipped code runtime-neutral (decision 0002).
- `packages/explorer-verify/tsconfig.test.json`: `src/` and `test/` with Node types.
- `packages/foundry/tsconfig.build.json` and `tsconfig.test.json`: the Foundry build helper and
  its tests, with Node types (decision 0008). Both reference the core's build project, so the
  core's declarations are built first and the helper sees only its public entry point.
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

The docs site is <https://aelmanaa.github.io/explorer-verify/> (R-AX-17, decision 0015). VitePress
1.6.4, pinned exactly in the catalogue, builds it from `docs/user/` (`srcDir`), with `base` set to
`/explorer-verify/`, clean URLs and local search. The config is `site/.vitepress/config.ts`, outside
`docs/user/`, so GitHub and the package never see it. The pages stay plain Markdown: no
frontmatter, Vue components or containers. The link rules, the sidebar and the copies live in
`scripts/site-docs.ts`:

- `README.md` becomes `index.md`, the page of its folder.
- Before VitePress reads a page, a link inside `docs/user/` stays relative, a link to the root
  `llms.txt` points to the site's `llms.txt`, and any other link into the repository points to the
  file on GitHub at the tag `v<version>`, because the site is built from that tag.
- Headings get GitHub's anchors, the same ones the docs check uses, so a link with a fragment that
  passes the check works on the site too.
- Inline code is marked `v-pre`, as VitePress already marks code blocks, so `{{` in code is shown as
  written. `{{` in prose fails the docs check.

| Command                 | What it does                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `pnpm run site:build`   | `vitepress build site`, then `scripts/site-copies.ts`, which writes the Markdown copies and `llms.txt` into `site/dist` |
| `pnpm run site:check`   | `scripts/check-site.ts` on the build: test 3 of decision 0015. Needs `pnpm run build` first                             |
| `pnpm run site:dev`     | VitePress dev server                                                                                                    |
| `pnpm run site:preview` | Serves `site/dist`                                                                                                      |

Dev-server advisories (2026-11-03): `pnpm audit` reports advisories against the Vite 5 and
esbuild versions that VitePress 1.6.4 depends on, for the dev server only. They are accepted,
because CI and the deploy only build. Run `site:dev` and `site:preview` on localhost only; never
pass `--host`.

`scripts/site-copies.ts` writes each user page next to its HTML as `<page>.md`, with the site's
links, and `site/dist/llms.txt`. That `llms.txt` is the root one with only the user pages, each
linked as its Markdown copy on the site, plus a line that names the version and the jsDelivr URL of
other versions. The root and packaged `llms.txt` do not change.

`scripts/check-site.ts` reads the codes from the built package and builds an error for each. It
fails when a `docsUrl`, with the site address removed, has no HTML page or no `.md` copy in
`site/dist`; when a link in the site's `llms.txt` is not a built `.md` copy; or when an HTML page
other than `404.html` has no copy that `llms.txt` lists. The CI `site` job runs the core build,
`site:build` and `site:check`. It never deploys. The job is not yet a required check; the
maintainer adds `Docs site build` to the `main` ruleset.

`scripts/smoke-site.ts` runs after a deploy: test 4 of decision 0015. It fetches each code page, its
`.md` copy, the site's `llms.txt` and every page that file lists, and fails unless each returns 200
within 10 seconds. It also fails unless the site's `llms.txt` names the package version at the
checked-out tag, so a site that still serves an older version fails. It tries up to five times, 15 seconds apart, because a new deployment can take a short time to
reach every edge. [Releasing](releasing.md#docs-deploy) describes the deploy.

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
test runs. [testing.md](testing.md#browser-smoke-test) describes both commands.

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
`scripts/site-copies.ts`, `scripts/check-site.ts` and `scripts/smoke-site.ts`, the last against a
local server), `scripts/random-order.ts` and the size check
(`scripts/bundle.ts`, `scripts/size-budget.ts` and `scripts/check-size.ts`) with a 95% floor per
file on lines, branches, functions and statements. `scripts/browser-smoke.ts` needs a browser and
runs in its own CI job instead. The older scripts have no tests yet and are not in the
coverage list; a script gets added when it gets tests.
