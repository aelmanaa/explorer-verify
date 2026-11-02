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
| c8                           | `packages/*/.c8rc.json`                                | Coverage, 95% floor                                                                                                                                         |
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

- `llms.txt` at the repository root lacks an H1, a summary blockquote (`> ...`) or an H2 section,
  or holds a relative link;
- a Markdown file under `docs/user/` is not listed in `llms.txt`, or `llms.txt` links a file in
  this repository that does not exist;
- `docs/user/guides/using-from-an-agent.md` is missing;
- a user page has no relative link to the root `llms.txt` in its first 10 lines;
- a user page has no version line in its first 10 lines, or the line names another version than
  `packages/explorer-verify/package.json`;
- a relative link in a Markdown file under `docs/` points to a missing file, or to a heading the
  target file does not have. Anchors follow GitHub's slug rules: lower case, punctuation dropped,
  each space a hyphen, `-1` and `-2` for repeated headings.

Links in `llms.txt` are absolute: `https://github.com/aelmanaa/explorer-verify/blob/main/<path>`.

### Version line

Each user page has this line, alone, within its first 10 lines:

```text
Version: explorer-verify 0.0.0
```

The version is the `version` of `packages/explorer-verify/package.json`. `pnpm run
version-packages` runs `node scripts/check-agent-docs.ts --write-versions` after `changeset
version`, which sets the line on every user page. Do not edit the version by hand.

### Docs in the package

The package's `build` script runs `scripts/package-docs.ts`. It copies `docs/user/` to
`packages/explorer-verify/docs/` and writes `packages/explorer-verify/llms.txt` from the root one,
with links to user pages made relative (`docs/<page>`). In the copied pages, a link inside
`docs/user/` stays as written, a link to the root `llms.txt` points to the packaged one, and any
other relative link becomes a GitHub URL. Both copies are build output and are gitignored. The
`files` field of the package lists them.

`pkg:check` runs `scripts/check-packed-files.ts`, which reads `npm pack --dry-run --json` and fails
when the tarball lacks `llms.txt` or a user page under `docs/`.

## Tests for scripts

Tests for the repository scripts live in `scripts/test/*.test.ts`. `pnpm run test:scripts` runs
them, and `pnpm test` and `pnpm run test:unit` run them after the package tests. They build small
fixture trees in a temporary folder. The coverage floor applies to the packages only.
