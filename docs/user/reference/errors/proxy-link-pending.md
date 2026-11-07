# proxy-link-pending

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

Cause: `linkProxy()` asked the explorer to link a proxy to its implementation, and the explorer had
not finished when the time budget (`timeoutMs`) ran out, or 3 status checks in a row failed.
Etherscan can answer `Pending in queue` for more than a minute. A Blockscout instance can stay at
`Verification in progress` for an address it does not detect as a proxy. The error has no handle:
a link is not resumed, it is requested again.

Fix: call `linkProxy()` again later with the same target. A new call sends a new request and
undoes nothing. If it keeps ending with this error on Blockscout, check that the address is a
proxy.

Default hint: Call linkProxy() again later: the explorer had not finished linking the proxy. A new
call is safe.

From the CLI: The explorer had not finished linking the proxy. Link it again later; a new request is
safe.

Retryable: yes. Call `linkProxy()` again.

Exit code: 4

See [Verify a proxy](../../guides/verify-a-proxy.md) for the steps and what each explorer does.

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
