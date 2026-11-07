# Event and envelope fields before schema v1

Date: 2026-11-07. Audience: contributors settling the public contract before 0.1.0.
Issue: [#224](https://github.com/aelmanaa/explorer-verify/issues/224).

## Findings from the existing contract

Read at commit `a8f5f1b` on 2026-11-07:

- `DryRunResult.lookup` and the `verify.lookup` event use the same four values under different
  field names. Verification results use `match` for the narrower exact-or-partial set.
- `verifyEach()` can run two entries of one backend at different hosts, but its events identify
  only the backend. Its outcomes retain entry order.
- A failed verification is a result, not an exception. The envelope retains it in `result` with
  `ok: false`; typed errors use `error`. Changing the failed result to an error would erase this
  distinction in the machine contract.
- Proxy results already distinguish `linked`, `mismatch` and `not-linked`. The envelope and its
  status-to-exit-code table do not accept them. Proxy linking emits verification event names.

These are source observations, not live explorer measurements. The implementation tests compare
event fields with results, group concurrent entries, and validate proxy envelopes against the
shipped JSON Schema.

## Sources

- [Public types at a8f5f1b](https://github.com/aelmanaa/explorer-verify/blob/a8f5f1baee639046687506c1f6fa5b4779f54f87/packages/explorer-verify/src/types.ts), read 2026-11-07.
- [Envelope at a8f5f1b](https://github.com/aelmanaa/explorer-verify/blob/a8f5f1baee639046687506c1f6fa5b4779f54f87/packages/explorer-verify/src/envelope.ts), read 2026-11-07.
- [Proxy flow at a8f5f1b](https://github.com/aelmanaa/explorer-verify/blob/a8f5f1baee639046687506c1f6fa5b4779f54f87/packages/explorer-verify/src/flow/link-proxy.ts), read 2026-11-07.
