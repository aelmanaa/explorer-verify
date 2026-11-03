---
"explorer-verify": patch
---

Add the HTTP layer that every backend uses. Each request goes through the `fetch` you pass, or `globalThis.fetch`. A lookup or a poll is tried at most 5 times after a network error, a request that took longer than 30 seconds, or HTTP 429, 502, 503 or 504. A submit is retried only after HTTP 429 or 503. A submit that got no answer is not sent again, because the explorer may have received it. The wait between tries starts at 1 second, doubles each time and follows `Retry-After` when the explorer sends it. A `Retry-After` above 30 seconds stops the retries. An abort stops every request and wait at once, and the call rejects with `signal.reason`.

The library never follows a redirect. A redirect, a response body above 16 MiB, or a body that fails after the headers arrived ends the call with `unexpected-response`. Log lines never show the query string of a request URL.

The `rate-limited` error has a new optional field, `details.attempts`, with the number of requests tried. The `unexpected-response` error has a new optional field, `details.retryAfterMs`, set when the explorer's last answer had a `Retry-After` header.

Errors and logs now also redact the API key in the form the URL parser writes it in a query string or a path.

[#14](https://github.com/aelmanaa/explorer-verify/issues/14)
