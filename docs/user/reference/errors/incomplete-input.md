# incomplete-input

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

Cause: `buildVerifyInput` found no way to build part of the input from the documents passed.
`details.field` names the part:

- `input`: no document holds the compiler input. A Foundry build-info written without
  `--build-info` holds only `id`, `source_id_to_path` and `language`; a Hardhat 3 `.output.json`
  holds the output but not the input. Solidity metadata rebuilds the input only when it has
  `language`, `compiler.version`, `settings.compilationTarget` and a `keccak256` for each source.
- `compilerVersion`: no document holds the full version with its commit, such as
  `0.8.24+commit.e11b9ed9`. Foundry build-info records only `0.8.24` in `solcLongVersion`; the full
  version is in each contract's metadata.
- `contract`: the documents hold several contracts and none was chosen, or a bare name matches
  more than one. `details.candidates` lists the fully qualified names found, sorted, at most 20.
- `sources`: the input is rebuilt from Solidity metadata, and some sources it lists have no
  content: the metadata does not embed them and `options.sources` does not hold them.
  `details.candidates` lists the missing source paths, sorted, at most 1,000; the message gives the
  full count.

Fix: for `input`, rebuild with build-info enabled (`forge build --build-info`) and pass the new
build-info file. For `compilerVersion`, add the artifact or build-info output that holds the
contract metadata, or pass `options.compilerVersion`. For `contract`, pass `options.contract` as
`path:Name` or as a name that matches one entry of `details.candidates`. For `sources`, pass each
path in `details.candidates` as a key of `options.sources`, with the file's content.

Default hint: Add what details.field names: a build-info with its input, the full compiler version,
the contract as path:Name, or the source files listed in details.candidates.

Retryable: no. Nothing was sent to an explorer.

Exit code: 2

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
