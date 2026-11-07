---
"explorer-verify": minor
"@explorer-verify/cli": patch
---

Breaking: `verify.lookup` events use `lookup` instead of `match`. Every event from `verifyEach()` carries `entry`, its zero-based index in `backends`, including one validation event per entry. Successful `verify.result` events carry `explorerUrl` when known. Proxy linking emits `proxy.routed`, `proxy.poll`, `proxy.retry` and `proxy.result`.

`toEnvelope()` and `exitCodeOf()` accept proxy results. A linked proxy exits 0; a mismatch or refusal exits 1. `Envelope<Result>` preserves the result type. `BackendOutcome` makes `result` and `error` mutually exclusive, and `ok: true` narrows every outcome in a multi-backend envelope to a success.

What should I do? Read `event.lookup` for a lookup event, use `event.entry` to group concurrent events, and handle the `proxy.*` event types in exhaustive switches. Check `outcome.error !== undefined` to distinguish an error from a result. Failed verification results keep their existing envelope shape.

Issue: https://github.com/aelmanaa/explorer-verify/issues/224
