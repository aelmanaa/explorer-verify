---
"explorer-verify": patch
---

`Logger` methods now take `(message, fields?)`. `fields` is a flat object whose values are strings, numbers, booleans or `null`. `console` still fits the type, and a logger that reads only the message keeps working. The library removes API keys from the message and from every field name and value. A field named like a key, such as `apikey` or `token`, has its string value replaced whole. A logger method that throws, or returns a promise that rejects, is ignored and does not change the outcome. The library never logs at `error` a failure it throws.

Add `VerifyOptions.onEvent`, typed `(event: VerifyEvent) => void | Promise<void>`. It receives the stage events: `verify.validated`, `verify.routed`, `verify.lookup`, `verify.submitted` with the handle, `verify.poll`, `verify.retry` and `verify.result`. Each event is a new, frozen, flat object with API keys removed. In the handle, only the job id is redacted, as in the envelope. When `onEvent` throws or its promise rejects, the first failure in a call is logged at `warn` and the call goes on. A returned promise is not awaited. Without `logger` and `onEvent` the library writes nothing.

Add the `LogValue`, `LogFields` and `VerifyEvent` types. The package ships a JSON Schema for the events as `explorer-verify/event.schema.json`, with `state` and `reason` as enums.

The HTTP layer and the Sourcify client log through one observer per call. Log lines carry the backend, method, URL and attempt as fields, and the HTTP layer emits `verify.retry` before each retry wait. Redaction now also covers a known key that was URL-encoded twice. The new reference page "Logging and events" describes both outputs.

[#53](https://github.com/aelmanaa/explorer-verify/issues/53)
