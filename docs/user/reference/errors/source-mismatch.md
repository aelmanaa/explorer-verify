# source-mismatch

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

Cause: `buildVerifyInput` rebuilt the input from Solidity metadata, and a source file's content
does not match the keccak-256 hash the metadata records for it. Compiled from that content, the
input would not give the deployed bytecode. `details.path` names the file, `details.expected` holds
the hash in the metadata and `details.actual` the hash of the content passed. Each hash is `0x`
and 64 lowercase hex digits. `details.expected` is empty when the metadata holds a value of
another form.

Fix: pass the file exactly as it was compiled, byte for byte. A changed line ending, a trailing
newline or a formatter run changes the hash. Take the file from the same package version or commit
as the metadata.

Default hint: Pass the source file named in details.path exactly as it was compiled, byte for byte,
line endings included.

From the CLI: Pass the source file `<path>` exactly as it was compiled, byte for byte, line endings
included, or pass the build-info of the same build with --input.

Retryable: no. Nothing was sent to an explorer.

Exit code: 2

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
