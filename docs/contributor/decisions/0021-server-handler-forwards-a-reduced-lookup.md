# 0021: The server handler forwards a reduced lookup

Status: Accepted (2026-11-03). Amends [decision 0003](0003-etherscan-only-through-a-self-hosted-handler.md):
the handler no longer forwards only verify-submit and status calls.

Research: [2026-11-02-etherscan-terms.md](../research/2026-11-02-etherscan-terms.md) for the proxy
clause; [2026-11-03-api-key-placement.md](../research/2026-11-03-api-key-placement.md) for
`getsourcecode` with the key in a form-encoded POST body.

## Context

Decision 0003 has `createVerifyHandler` forward only the verify-submit and status calls, and
R-SRV-3 said the same. `verify()` reads the contract before it submits (R-FLOW-1), and again for a
forgotten job and to grade a result. On Etherscan that read is `getsourcecode`. A handler that
refuses it makes `verify()` throw before its first submit when the browser goes through the
handler, so the proxied path differs from the direct one, which R-SRV-5 forbids.

Etherscan's terms forbid operating a proxy "that passes API Data through to third parties". A
`getsourcecode` answer holds the contract's source, its ABI and other fields: relaying it whole
would pass that data through.

## Decision

1. The handler forwards `module=contract&action=getsourcecode` for one address, with the same
   guards as a submit: the field allowlist, the size and field limits, the rate-limit hook, and the
   deployer check when `deployers` is set. It may retry it once, as a read.
2. It reduces the answer to what the client classifies: `status`, `message`, and of the first
   result only `SourceCode`, `SimilarMatch`, `ContractName` and `CompilerVersion`. A non-empty
   `SourceCode` is replaced by a fixed marker, `SOURCE_MARKER`; an empty one stays empty. A text
   `result`, such as a key error, is kept. Every other field and result is dropped, so no source
   and no ABI is relayed. The answer is read up to the HTTP layer's 16 MiB limit, then reduced.
3. R-SRV-3 names `verifyproxycontract` and `checkproxyverification` for M3
   ([#94](https://github.com/aelmanaa/explorer-verify/issues/94)). The handler does not forward
   them yet.

## Alternatives considered

- Keep the two actions, and have the Etherscan client skip its lookup when it goes through a
  handler. Rejected: the client cannot tell that its `fetch` leads to a handler, and the two paths
  would behave differently (R-SRV-5).
- Relay the lookup answer whole. Rejected: it passes the source and the ABI through, which the
  terms' proxy clause covers.
- Answer the lookup with a handler-specific shape, such as `{ verified: true }`. Rejected: the
  client would need a second parser; the reduced answer keeps Etherscan's shape.

## Consequences

- The Etherscan v2 client ([#61](https://github.com/aelmanaa/explorer-verify/issues/61)) reads only
  whether `SourceCode` is empty, never its text, and reads `SimilarMatch`, `ContractName` and
  `CompilerVersion`. A non-empty `SourceCode` may be the marker.
- The last clause of R-SEC-5 and the server handler docs name three forwarded actions.
- Whether a handler that forwards these three calls counts as a proxy under the terms is still
  this project's reading, not legal advice.
