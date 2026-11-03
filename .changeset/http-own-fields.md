---
"explorer-verify": patch
---

The HTTP layer no longer reads `signal`, `requestTimeoutMs`, `maxResponseBytes`, the request `body` or any other field of its context and request from the prototype chain. It reads each field once, as an own property. A getter or Proxy trap that throws while these fields are read gives `invalid-input`, and the error does not repeat the thrown text. An aborted signal still rejects with its reason first. The `RequestInit` passed to `fetch` has no prototype, so an injected `fetch` cannot read a `body` or `headers` added to `Object.prototype`. The platform's own `fetch` may still read inherited `RequestInit` members: Node's does.

[#72](https://github.com/aelmanaa/explorer-verify/issues/72)
