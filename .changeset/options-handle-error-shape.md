---
"explorer-verify": patch
---

Add the `VerifyOptions`, `Logger`, `RouteOverride` and `Handle` types. Every option is optional.

Add `ExplorerVerifyError`, the one error class the library throws. It has a stable `code`, a `hint`, a `docsUrl`, a `retryable` flag and `details`. Checking `details.code` narrows `details`. `JSON.stringify(error)` prints no cause and no stack.

Add `parseHandle`, which reads a stored handle and rejects any field it does not know, such as a URL.

[#11](https://github.com/aelmanaa/explorer-verify/issues/11)
