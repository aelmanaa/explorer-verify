# insufficient-artifact

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

Cause: the documents passed to `buildVerifyInput` hold only ABI and bytecode, with no compiler
input, settings or metadata. The explorer needs the sources and the exact settings, and these
files do not have them. `details.field` is `input`.

Fix: three routes remain.

1. Ask the publisher to ship the build-info or the Solidity metadata of the build.
2. Use the bytecode-metadata resolver (planned), when the deployed bytecode carries a
   metadata hash and the metadata is published.
3. Rely on the explorer's own matching (Etherscan Similar Match, Sourcify similarity; see
   [automatic matching](../../../contributor/research/2026-11-02-explorer-apis.md#automatic-matching-no-submission-needed)),
   when an identical contract is already verified.

Default hint: ABI and bytecode are not enough to verify. Routes left: (1) ask the publisher to ship
build-info or metadata; (2) the bytecode-metadata resolver, when the bytecode carries a metadata
hash and the metadata is published; (3) the explorer's own matching (Etherscan Similar Match,
Sourcify similarity), when an identical contract is already verified.

From the CLI: ABI and bytecode are not enough to verify. Pass the build-info or the Solidity
metadata of the same build with --input.

Retryable: no. Nothing was sent to an explorer.

Exit code: 2

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
