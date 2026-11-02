---
"explorer-verify": patch
---

Add routing for `VerifyOptions.route`. Every chain goes to Sourcify at `https://sourcify.dev/server`, and `route.apiUrl` can point at another Sourcify server, such as a self-hosted one or a local test server. `verify()` uses this routing when it lands.

`route.apiUrl` must use `https:`, or `http:` on `localhost`, `127.0.0.1` or `[::1]`. A URL with a user name, a password or a fragment is rejected. A query string is sent with requests and redacted in logs. A bad route throws `invalid-input`, and the error never repeats the value. In this version `route.backend` accepts only `sourcify`.

[#15](https://github.com/aelmanaa/explorer-verify/issues/15)
