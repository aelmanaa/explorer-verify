# quota-exceeded

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

The Etherscan v2 and Routescan clients throw this code; they read the same answers. The
standalone client will throw it too ([#63](https://github.com/aelmanaa/explorer-verify/issues/63));
it is not in this release yet.

Cause: the API key's daily limit is spent. Etherscan answers `Max daily rate limit reached` when a
key has used its daily calls, and `Daily limit of 500 source code submissions reached` when it has
used its daily submissions. Another request in the same call cannot succeed, so the library does not
retry. `details.backend` names the backend. The error never holds the key.

Fix: call again after the explorer resets the limit, or use a key on a plan with a higher limit.
[API keys](../api-keys.md) describes the Etherscan plan rules.

Default hint: The key's daily limit is spent. Call again after the explorer resets the limit, or
use a key on a plan with a higher limit.

Retryable: no.

Exit code: 3

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
