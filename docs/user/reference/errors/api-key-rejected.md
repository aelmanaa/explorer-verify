# api-key-rejected

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

From the Etherscan v2, Routescan and standalone clients on ([#61](https://github.com/aelmanaa/explorer-verify/issues/61), [#62](https://github.com/aelmanaa/explorer-verify/issues/62), [#63](https://github.com/aelmanaa/explorer-verify/issues/63)): in this release the routing table sends every chain it lists to Sourcify, which takes no key, so the library does not
throw this code yet.

Cause: the explorer refused the API key, as Etherscan's `Invalid API Key (#err2)`. The key may be
mistyped, revoked, or issued by another explorer. `details.backend` names the backend. The error
never holds the key.

Fix: check the key on the explorer's account page, then pass a valid key in `apiKeys` or
`route.apiKey` and call again. [API keys](../api-keys.md) describes where each key goes.

Default hint: Check the key on the explorer's account page: it may be mistyped, revoked or issued
by another explorer. Pass a valid key, then call again.

Retryable: no.

Exit code: 3

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
