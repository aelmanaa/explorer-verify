---
"explorer-verify": patch
---

Add routing for `VerifyOptions.route`. Calls go to Sourcify at `https://sourcify.dev/server`, and `route.apiUrl` can point at another Sourcify server, such as a self-hosted one or a local test server. `verify()` uses this routing when it lands.

`route` must be a plain object. `route.apiUrl` must be a string of at most 8192 characters that uses `https:`, or `http:` on `localhost`, `127.0.0.1` or `[::1]`. A URL with a user name, a password or a fragment is rejected. A query string is sent with every request and redacted in logs. Only the query is redacted, so never put a key in the host or path. A bad route throws `invalid-input`, and the error never repeats the value. In this version `route.backend` accepts only `sourcify`.

`explorerUrl` in a `verified` or `already-verified` result is now optional. It is absent when the route points at a server other than the public Sourcify API, because the public Sourcify repository does not show contracts verified elsewhere.

[#15](https://github.com/aelmanaa/explorer-verify/issues/15)
