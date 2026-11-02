# Tooling

Audience: contributors setting up or changing the toolchain. The toolchain mirrors [hardhat-kms](https://github.com/aelmanaa/hardhat-kms)
(decision 0006).

| Tool                         | Config                                                 | Role                                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pnpm 12.16.1                 | `package.json` `packageManager`, `pnpm-workspace.yaml` | Workspace; tool versions live in the `catalog:`                                                                                                             |
| TypeScript 7                 | `tsconfig.base.json`                                   | `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `isolatedDeclarations`, `erasableSyntaxOnly`, `verbatimModuleSyntax`; imports use `.ts` |
| oxlint (type-aware)          | `.oxlintrc.json`                                       | Lint; `import/no-nodejs-modules` on `packages/*/src`; TSDoc required on exports                                                                             |
| oxfmt                        | `.oxfmtrc.json`                                        | Format, width 100                                                                                                                                           |
| knip                         | `knip.json`                                            | Unused files, exports and dependencies                                                                                                                      |
| publint, are-the-types-wrong | `pkg:check` script                                     | Package manifest and type resolution                                                                                                                        |
| c8                           | `packages/*/.c8rc.json`                                | Coverage, 95% floor per file                                                                                                                                |
| lefthook                     | `lefthook.yml`                                         | pre-commit: lint fix, format, typecheck, type escapes; commit-msg: Conventional Commits                                                                     |
| pre-push hook                | `scripts/install-git-hooks.ts`                         | Refuses pushes to `main`, then runs unit tests                                                                                                              |
| changesets                   | `.changeset/config.json`                               | Release notes and versions                                                                                                                                  |
| Dependabot                   | `.github/dependabot.yml`                               | Weekly updates with a 7-day cooldown                                                                                                                        |

## Type-checking layout

`tsc -b` at the root builds three projects:

- `packages/explorer-verify/tsconfig.build.json`: `src/` only, `types: []`, DOM lib. Node APIs do
  not typecheck here, which keeps the shipped code runtime-neutral (decision 0002).
- `packages/explorer-verify/tsconfig.test.json`: `src/` and `test/` with Node types.
- `tsconfig.scripts.json`: repository scripts.

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
  target file does not have.

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

## Tests for scripts

Tests for the repository scripts live in `scripts/test/*.test.ts`. `pnpm run test:scripts` runs
them under c8, and `pnpm test` and `pnpm run test:unit` run it after the package tests. They build
small fixture trees in a temporary folder, and run the entry points as child processes against
them. c8 covers the agent-docs scripts (`scripts/agent-docs.ts`, `scripts/decision-sources.ts` and
the three scripts that use them) and `scripts/random-order.ts` with a 95% floor per file on lines,
branches, functions and statements. The older scripts have no tests yet and are not in the
coverage list; a script gets added when it gets tests.
