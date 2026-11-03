# unexpected-response

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

Cause: the answer did not come from the explorer's API, or not in its format, after retries: a 5xx
status, an HTML page, a wrong content type, a redirect or a body that is too large or cannot be
read. `details.status` holds the status and `details.excerpt` the first 300 characters of the
body, redacted. `details.retryAfterMs` holds the wait the backend asked for, when its last answer
had a `Retry-After` header. A status or body that the backend's client does not recognise ends here
too, such as Sourcify's `400 invalid_parameter`, or an answer about another contract.

Fix: call again later. If the error persists, check the explorer's status page and report
`details.status` and `details.excerpt` in an issue.

Default hint: Call again later. If the error persists, check the explorer's status page and report
details.status and details.excerpt.

Retryable: yes.

Exit code: 5

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
