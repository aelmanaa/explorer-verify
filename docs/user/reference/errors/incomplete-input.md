# incomplete-input

Version: explorer-verify 0.2.1

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

The build documents lack part of the input: the compiler input, the version, the contract or
sources.

## How to fix

Add the part that `details.field` names:

| `details.field`   | What to add                                                                      |
| ----------------- | -------------------------------------------------------------------------------- |
| `input`           | Rebuild with build-info (`forge build --build-info`); pass the new build-info    |
| `compilerVersion` | The artifact or build-info that holds the metadata, or `options.compilerVersion` |
| `contract`        | `options.contract`, as `path:Name` or a name that matches one candidate          |
| `sources`         | Each path in `details.candidates`, as a key of `options.sources`                 |

For `sources`, the value of each key is the file's content.

From the CLI: Pass --contract with one of: `<names>`.

## Facts

Retryable: no.

Exit code: 2

Sent to an explorer: no.

Default hint: Add what is missing (details.field): a build-info with its input, the full compiler
version, the contract as path:Name, or the missing source files (details.candidates).

For end users: The build output lacks something the explorer needs: the compiler input, the full
compiler version, the choice of contract or some source files. Compile the project again and pick
the contract, then try again.

## Why

Cause: `buildVerifyInput` found no way to build part of the input from the documents passed.
`details.field` names the part:

- `input`: no document holds the compiler input. A Foundry build-info written without
  `--build-info` holds only `id`, `source_id_to_path` and `language`. A Hardhat 3 `.output.json`
  holds the output but not the input.
- `compilerVersion`: no document holds the full version with its commit, such as
  `0.8.24+commit.e11b9ed9`. Foundry build-info records only `0.8.24` in `solcLongVersion`; the full
  version is in each contract's metadata.
- `contract`: the documents hold several contracts and none was chosen, or a bare name matches
  more than one. `details.candidates` lists the fully qualified names found, sorted, at most 20.
- `sources`: the input is rebuilt from Solidity metadata, and some sources it lists have no
  content: the metadata does not embed them and `options.sources` does not hold them.

For `sources`, `details.candidates` lists the missing source paths, sorted, at most 1,000; the
message gives the full count.

Solidity metadata rebuilds the input only when it has these fields:

- `language` and `compiler.version`;
- `settings.compilationTarget`;
- a `keccak256` for each source.

## In code

Check the code, then read which part is missing and the candidates:

<!-- no-run: it defines a handler and calls nothing, so a run prints nothing. -->

```ts no-run [on-error.ts]
import { ExplorerVerifyError } from "explorer-verify/errors";

export function onError(error: unknown): void {
  if (ExplorerVerifyError.is(error, "incomplete-input")) {
    const { field, candidates } = error.details;
    console.error(`Missing ${field}: ${candidates.join(", ")}`);
  }
}
```

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
