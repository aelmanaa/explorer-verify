---
"explorer-verify": patch
---

The Routescan client reads the wait in Routescan's `x-ratelimit-rpm-retry-after` header when a 429 has no `Retry-After` header. Routescan sends that header when a key passes its per-minute limit, with a wait of up to 60 seconds. A wait above 30 seconds now throws `rate-limited` at once, with `details.retryAfterMs` set. Before, the client sent four more requests within the same minute, and each one got the 429 again. A keyless 429 has no wait header and is still retried with backoff. Issue: https://github.com/aelmanaa/explorer-verify/issues/133
