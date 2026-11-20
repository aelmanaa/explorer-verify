# 0076: Build Vyper input from build documents, with a release table

Status: Accepted (2026-11-17). Extends R-IN-7 and [decision 0075](0075-vyper-compiler-kind.md).

Research: [Vyper support on each explorer](../research/2026-11-15-vyper-support.md).

## Context

Issue [#425](https://github.com/aelmanaa/explorer-verify/issues/425), part of epic
[#430](https://github.com/aelmanaa/explorer-verify/issues/430). Decision 0075 added
`kind: "vyper"`, but `buildVerifyInput` still threw `unsupported-compiler` for any language but
Solidity. A Vyper caller holds one of three documents: the output of `vyper -f solc_json`, a
Foundry build-info, or a bare Vyper Standard JSON. The research note and the fixtures of #425
record these problems:

- Foundry 1.8.1 writes `solcLongVersion: "0.4.3"` for Vyper, with no commit, and decision 0075
  requires `0.4.3+commit.bff19ea2`.
- The PyPI builds print a 7-character commit: the 0.4.0 wheel writes
  `compiler_version: "v0.4.0+commit.e9db8d9"`, and 0.3.10 prints `9136169` (research note;
  observed again on 2026-11-17 and 2026-11-19). The release assets name `e9db8d9f` and `91361694`.
- `-f solc_json` keys a module found on `sys.path` by the path of the Python environment: after
  an index run for an environment outside the project, or as `.venv/lib/…/site-packages/…` for
  one inside it (observed with Vyper 0.4.3 on 2026-11-19). Sent as is, the first publishes the
  user's home directory with the source.
- `-f solc_json --storage-layout-file` writes a top-level `storage_layout_overrides`, which the
  compiler reads. Dropping it gives other bytecode.

## Decision

1. `buildVerifyInput` returns `kind: "vyper"` for a compiler input with `language: "Vyper"`, in a
   bare input, a `solc_json` output or a build-info. The input keeps only `language`, `sources`,
   `interfaces` and `settings`; each source only `content` and `keccak256`; each interface only
   `content`, or `abi` without `content`.
2. The version is `compiler_version` without its `v`, else a build-info's `solcLongVersion`, else
   `options.compilerVersion`. A version without a commit, or with a 7-character commit, is
   completed from a static table of the stable releases from the floor (option A of the issue,
   decided 2026-11-15): 0.3.10 `91361694`, 0.4.0 `e9db8d9f`, 0.4.1 `8a93dd27`, 0.4.2 `c216787f`,
   0.4.3 `bff19ea2`. The commits are the ones in the names of the
   [release assets](https://github.com/vyperlang/vyper/releases), read 2026-11-15 and again on
   2026-11-17. The same applies to `options.compilerVersion`.
   - A version the table does not list throws `incomplete-input` on `compilerVersion`, with a hint
     that asks for the 8-character commit.
   - A 7-character commit that is not the start of the table's commit throws `invalid-input`.
   - `validateInput` keeps its rule: the version it checks has the 8-character commit.
3. The table lives in `src/input/vyper.ts`, which only the builder imports, so the `verify` entry
   does not hold it. The weekly live check compares it with the GitHub releases API: each row must
   name its assets' commit, and each stable release from 0.3.10 must have a row.
4. A key with a `site-packages` segment becomes the part after its last `site-packages` segment,
   in `sources`, `interfaces` and `settings.outputSelection`, with or without an index run before
   it. A `search_paths` entry that ends in `site-packages` becomes `.`; repeated entries are
   dropped. Any other indexed key, an absolute key or a climbing key throws `invalid-input` naming
   the field and the position, never the path. Two keys that become one throw too. `dist-packages`
   keys stay refused.
5. A path counts as indexed when its first segment is `0` after `.` and empty segments are dropped,
   each segment is read without surrounding spaces, and each `name/..` is folded, with either
   separator. So `.//0/1/x`, `./ ./0/1/x` and `src/../0/1/x` are indexed. `validateInput` uses the
   same rule, from `src/input/paths.ts`. A project folder named `0` is refused.
6. An input with `storage_layout_overrides` throws `invalid-input` on
   `compiler.input.storage_layout_overrides`: storage layout overrides are not supported.
   `validateInput` refuses the field on a `kind: "vyper"` input too, with the same message and
   hint, so `verify()` refuses raw `solc_json` output that holds it before any request.
7. The contract name is `options.contract`, else the one contract an artifact names, else the one
   `.vy` target of `settings.outputSelection` or of the build-info output, named after its file.
   `details.candidates` leaves out a name whose path is local or indexed, such as an artifact's
   absolute `sourceName`.
8. A Hardhat 2 Vyper artifact (`hh-vyper-artifact-1`) on its own throws `insufficient-artifact`
   with a hint that names the Vyper routes: `solc_json`, a Foundry build-info, or the Standard
   JSON with the version and the contract. Next to an input, it gives the name and the creation
   bytecode.
9. The `buildVerifyInput` size ceiling rises to the measured size plus 20% (decision 0014): from
   16,026 to 20,027 bytes gzipped, measured at 16,689 with `pnpm run size` (esbuild) on 2026-11-19
   on main c22594d plus #425. The entry measured 15,313 bytes on main before the change.
   `buildVerifyInputFromBytecode` rebuilds its input with `buildVerifyInput`, so its per-name rows
   in `name-budget.json` rise the same way: 26,930 bytes gzipped with esbuild (ceiling 32,316)
   and 27,033 with Rollup (ceiling 32,440), from 25,471 before. The index-run rule and the
   storage-layout refusal in `validateInput` grow the entries that validate input: `verify` from
   20,226 to 20,366 bytes, under its ceiling of 24,292, and `verifyEach` from 22,067 to 22,191,
   past its ceiling of 22,178, which rises to 26,630.

## Why

- A rewritten key compiles to the same bytecode, since the integrity hash does not cover paths
  (research note, observed). The fixtures repeat that with a real module installed in a Python
  environment, outside the project and in its `.venv`.
- Vyper publishes no official release list like solc's `list.json`; the lists that exist are
  third-party mirrors (research note, read 2026-11-15). Five rows are a small upkeep, of the same
  kind as the routing table, and the live check names a new release when it lands.
- A 7-character commit names one release only when it is the start of that release's commit, so
  the table can complete it; any other one is a different build.
- A version the table lacks fails with the field to add, rather than guessing a commit.
- The compiler reads paths with `.`, empty and `name/..` segments folded, so a spelling that hides
  an index run would still publish the path.
- Storage layout overrides change the bytecode, and no explorer request carries them today.
- The Vyper paths, the version table and the hints add about 1 KB gzipped. Cutting the hints or
  the path checks would weaken R-SEC-1 and R-AX-10.

## Alternatives considered

| Alternative                                              | Why not                                                                                 |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| No table: the caller passes `compilerVersion` (option B) | Every Foundry Vyper build-info would need an option the documents almost hold           |
| Fetch the release list at build time                     | The builder sends nothing (R-IN-7); a request would need a host and a fetch             |
| Keep a `site-packages` key as it is                      | It publishes the user's home directory with the source                                  |
| Rewrite every index-run key to its last segments         | A key outside `site-packages` has no package root to keep; guessing one may not compile |
| Drop `storage_layout_overrides` silently                 | The submitted input would not compile to the deployed bytecode                          |

## Consequences

- Each new stable Vyper release fails the weekly live check until a pull request adds its row.
- A caller of the builder, the CLI's `--input` included, now gets a Vyper input; the backends
  still refuse it until their own issues land.
- A Vyper key outside `site-packages` with an index run needs the caller to compile from the
  project root.
