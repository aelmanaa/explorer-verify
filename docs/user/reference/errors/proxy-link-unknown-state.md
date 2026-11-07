# proxy-link-unknown-state

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

Cause: `linkProxy()` asked about a proxy link and the explorer answered, in its format, with a
state the library cannot classify. Examples: Etherscan's `Error!` for a link it had just accepted,
Blockscout's `Unknown UID`, an answer that names another proxy, or an implementation that is not
exactly one address of `0x` and 40 hex digits, such as a longer run of digits, several addresses
or the zero address. The library does not report the proxy as linked. The explorer may still have
changed the proxy's page. `details.backend` names the explorer, and `details.excerpt` holds the
first 300 characters of its answer, redacted. The error has no handle: a link has none.

A link request answered in a form the library does not know throws
[`unexpected-response`](unexpected-response.md) instead: nothing started.

Fix: do not retry automatically. Open the proxy's page on the explorer, check which implementation
it shows, then report `details.excerpt` in an issue.

Default hint: Do not retry automatically. Check the proxy's page on the explorer and report
details.excerpt.

From the CLI: Do not retry automatically. Check the proxy's page on the explorer, and report the
excerpt that --json prints.

Retryable: no.

Exit code: 6

See [Verify a proxy](../../guides/verify-a-proxy.md) for the steps and what each explorer does.

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
