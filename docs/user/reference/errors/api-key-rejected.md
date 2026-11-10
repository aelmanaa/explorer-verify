# api-key-rejected

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

The Etherscan v2, Routescan and [Etherscan-compatible](../etherscan-compatible.md) clients throw
this code; they read the same answers.

Cause: the explorer refused the API key, as Etherscan's `Invalid API Key (#err2)`. The key may be
mistyped, revoked, or issued by another explorer. `details.backend` names the backend. The error
never holds the key.

The client also throws this code for Etherscan's answer
`Free API access is not supported for this chain`: the key is on a free plan and the chain needs a
paid one. The Etherscan chainlist marks those chains "Paid
Plan required" ([Routing](../routing.md#etherscan-rows-and-paid-plans)). The hint then says to use
a key on a paid plan, or to verify on Sourcify, which needs no key, with
`route: { backend: "sourcify" }`.

Fix: check the key on the explorer's account page, then pass a valid key in `apiKeys` or
`route.apiKey` and call again. [API keys](../api-keys.md) describes where each key goes.

Default hint: Check the key on the explorer's account page: it may be mistyped, revoked or issued by
another explorer. Pass a valid key, then call again.

For end users: The explorer refused the API key. Check the key: it may be mistyped, revoked or
issued by another explorer.

From the CLI: etherscan-v2 refused the key. Check the key in ETHERSCAN_API_KEY on the explorer's
account page: it may be mistyped, revoked or issued by another explorer.

Retryable: no.

Exit code: 3

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
