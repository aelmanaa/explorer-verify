---
"@explorer-verify/cli": patch
"@explorer-verify/foundry": patch
"@explorer-verify/hardhat": patch
---

`explorer-verify verify` reads a Foundry or Hardhat project: `--foundry <dir>` or
`--hardhat <dir>` with `--contract path:Name` finds the contract's artifact and the build-info
file that lists it, whatever its hash name. `--contract` also takes a bare `Name` when one
contract has that name. `.` is the current folder, not the Git root. For example, in a Foundry
project after `forge build --build-info`:

```sh
explorer-verify verify 0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc --chain 11155111 \
  --foundry . --contract src/Greeter.sol:Greeter --backend sourcify --dry-run
```

- `--out-dir <dir>` names the build's output folder when the config moves it, and
  `--artifact <file>` names the artifact when Foundry wrote one for each compiler version or
  profile. Both are relative to the project folder, or absolute. `--compiler-version` is passed
  on.
- A project option with `--input` or `--input-json`, `--foundry` with `--hardhat`, a project
  without `--contract`, and `--out-dir` or `--artifact` without a project exit 2 before any
  request.
- Errors name these flags in place of the helpers' option names, list the matching contracts when
  a name is ambiguous, and name `--foundry` or `--hardhat` when the default output folder is
  missing.
- `--input` with a folder exits 2 and names `--foundry` and `--hardhat`. An extra argument after
  `--input`, as a shell glob such as `--input out/build-info/*.json` gives, exits 2 with
  `--input takes one file; repeat --input for each`; after `--artifact`, with
  `--artifact takes one file`. The generic issue now reads `verify takes at most 1 argument`.
- An `invalid-input` error whose hint pointed at `details.issues`, which the envelope does not
  carry, now has the CLI's usage hint.
- The CI guide's `scripts/verify.sh` adds the error message to its `::error::` line.

The CLI now depends on `@explorer-verify/foundry` and `@explorer-verify/hardhat`, and loads each
only when its option is given. The help examples, the CLI reference and the CI guide use project
mode.

In `findFoundryBuild` and `findHardhatBuild`, an error names a file outside the project root by
its absolute path instead of a path that starts with `..`. `files` in the result is unchanged.

[#221](https://github.com/aelmanaa/explorer-verify/issues/221)
