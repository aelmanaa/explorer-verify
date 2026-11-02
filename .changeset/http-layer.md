---
"explorer-verify": patch
---

Add the HTTP layer that every backend uses. Each request goes through the `fetch` you pass, or `globalThis.fetch`. A request is tried at most 5 times after a network error, a request that took longer than 30 seconds, or HTTP 429, 502, 503 or 504. A submit is retried only after a network error, a request that took longer than 30 seconds, or HTTP 429 or 503. The wait between tries starts at 1 second, doubles each time and follows `Retry-After` when the explorer sends it. A `Retry-After` above 30 seconds stops the retries. An abort stops every request and wait at once, and the call rejects with `signal.reason`. Log lines never show the query string of a request URL.

The `rate-limited` error has a new optional field, `details.attempts`, with the number of requests tried.

[#14](https://github.com/aelmanaa/explorer-verify/issues/14)
