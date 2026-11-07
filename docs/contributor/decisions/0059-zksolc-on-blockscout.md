# 0059: Verify zksolc through the ZKsync Blockscout instances

Status: Accepted (2026-11-07). Extends [decision 0057](0057-zksolc-compiler-kind.md).

Research: [Blockscout zksolc mapping](../research/2026-11-07-blockscout-zksolc.md).

## Context

The compiler union can describe zksolc input. The routing table already lists the Blockscout
instances on chains 324 and 300. Blockscout's ZKsync RPC controller accepts the usual long solc
version and an extra `zksolcVersion` field. Recorded REST lookups identify verified zksolc builds.

## Decision

Enable `kind: "zksolc"` only for backend `blockscout` on chains 324 and 300. Send
`compilerversion=v<solcVersion>` and `zksolcVersion=v<version>` in the existing Standard JSON
form. Keep the supplied constructor arguments and input. Do not send `solcFork` as a form field.

Other backend and chain pairs fail with `unsupported-compiler` before routing or requests.
Both the default and core entries apply the same capability check. The hosted Blockscout API
is a separate backend and stays outside this mapping.

Keep the existing REST verification verdict: `zk_compiler_version` identifies the compiler,
while the verification flags decide whether a match is exact, partial or absent. No new grading
rule follows from the presence of a compiler version.

## Consequences

Callers can pass checked zksolc input directly. The build helpers still refuse EraVM documents,
and constructor arguments must be supplied when needed. Recorded lookups and form tests cover
the mapping. They do not prove a live submission succeeds; issue #208 tracks that probe.
