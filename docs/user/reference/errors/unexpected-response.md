# unexpected-response

<!-- docs-style: legacy -->

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

Cause: the answer did not come from the explorer's API, or not in its format, after retries: a 5xx
status, an HTML page, a wrong content type, a redirect or a body that is too large or cannot be
read. `details.status` holds the status and `details.excerpt` the first 300 characters of the
body, redacted. `details.retryAfterMs` holds the wait the backend asked for, when its last answer
had a `Retry-After` header, and `details.attempts` the number of requests tried, when the error
came after retries. A status or body that the backend's client does not recognise ends here
too, such as Sourcify's `400 invalid_parameter`, or an answer about another contract.

Fix: call again later. If the error persists, check the explorer's status page and report
`details.status` and `details.excerpt` in an issue.

Default hint: Call again later. If the error persists, check the explorer's status page and report
the status and the answer (details.status, details.excerpt).

For end users: The explorer gave an answer that could not be read. Try again later; if it keeps
failing, check the explorer's status page.

When an explorer with an Etherscan-style API (Etherscan, Routescan or an Etherscan-compatible
explorer) found no contract code at the address after its tries, `hintFor(error, "user")` says
instead that the explorer has not found the contract yet, and asks the user to check the chain and
the address, or to try again in a minute.

From the CLI: Run the command again later. If it persists, check the explorer's status page and
report the status and excerpt that --json prints.

Through your server handler (`handlerUrl`), a refusal with a known code and its status throws its
own error, such as [`handler-refused`](handler-refused.md) for a 403 `chain-not-allowed`. This code
remains for an answer with no code, an unknown code or another status, which the message does not
repeat, for the handler's `address-not-indexed` and `internal-error`, and for a redirect or an
unreadable body
([how the client reads a refusal](../server-handler.md#how-the-client-reads-a-refusal)).

Retryable: yes, except a 4xx answer of your server handler other than 408 and 429, with or without
a code: it holds until something changes, so it is not retryable and its hint says to check
`handlerUrl` and the `createVerifyHandler` options.

Exit code: 5

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
