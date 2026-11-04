# 0026: The bytecode-metadata resolver: sources, hash checks, errors and entry point

Status: Accepted (2026-11-04). Amends the error code list of
[decision 0009](0009-options-handle-and-errors.md) and the entry points of
[decision 0008](0008-package-split-and-bundle-budget.md).

Research: [2026-11-04: Where the metadata behind a bytecode hash can be fetched](../research/2026-11-04-bytecode-metadata-sources.md).

## Context

Issue [#34](https://github.com/aelmanaa/explorer-verify/issues/34) adds the first input resolver
(R-IN-5): from a deployed contract's bytecode, find the metadata its hash names and the sources,
and rebuild the Standard JSON input with `buildVerifyInput` (R-IN-7). The library may call only
hosts from the routing table or the caller's configuration (R-SEC-2), so it ships no IPFS gateway.

The research found three facts that shape the design:

- No public path gateway served the metadata of a verified Sepolia contract on 2026-11-04.
  `ipfs.io` and `dweb.link` answer 429 and announce a move to a service-worker-only gateway.
- Sourcify has no lookup by metadata hash, but `all-chains/{address}` lists every chain on which
  an address is verified. A contract deployed with CREATE2 has the same address and bytecode on
  every chain.
- `JSON.stringify` of the metadata object Sourcify returns gives the bytes solc hashed, so the
  CID can be checked against the bytecode.

## Decision

### Where the bytecode and the metadata come from

- The bytecode comes from the caller (`bytecode`) or from `eth_getCode` at the caller's `rpcUrl`,
  after `eth_chainId` confirms the chain. The routed explorer is not asked: the Sourcify API
  serves bytecode only for verified contracts, and the other clients do not expose it yet.
  Bytecode above 65536 bytes is refused before it is parsed; EIP-170 caps deployed code at
  24 KiB.
- Sourcify is asked first, unless `sourcify: false`: `all-chains/{address}`, then
  `fields=metadata,sources` for at most three listed chains, the call's chain first, then exact
  matches. Its host is the routing table's Sourcify API. `sourcify: false` without `ipfsGateway`
  is `invalid-input`, because no source would be left to ask.
- The caller's `ipfsGateway`, when set, is asked next, as a path gateway: `<gateway>/ipfs/<CID>`
  for the metadata, then the `dweb:/ipfs/` CIDv0 of each source the metadata lists without
  content, six at a time. There is no default gateway.
- `rpcUrl` and `ipfsGateway` follow the `route.apiUrl` rules: `https`, or `http` on `localhost`,
  `127.0.0.1` or `[::1]`, with no user name, password or fragment. Their path segments and query
  values of eight or more characters are treated as keys and redacted, because providers put keys
  there. The host name is not redacted; the option docs say so.
- Every request goes through the HTTP layer: no redirect is followed, transient failures are
  retried, and `timeoutMs` and `signal` bound the whole call. Bodies are capped per source: 1 MiB
  for a JSON-RPC answer, 4 MiB for a gateway answer, 16 MiB (the layer's default) for a Sourcify
  answer, and Sourcify metadata above 4 MiB is not hashed. Hashing is synchronous, so these caps
  bound how long one answer can block the event loop.
- When the time budget runs out during a request, the attempt is recorded as `timeout` and the
  call ends at once with `metadata-unavailable`: every later request would time out too.
- Requests to Sourcify carry the call's logger, retries included. Requests to `rpcUrl` and
  `ipfsGateway` do not, because the HTTP layer would name a backend in each line; only the
  outcome of each attempt is logged.

### What is trusted

- Metadata from the gateway is used only when its CIDv0, computed as solc computes it, equals the
  hash in the bytecode. Metadata from Sourcify is used only when the CID of its `JSON.stringify`
  form equals that hash. A copy that fails the check is skipped and reported as `hash-mismatch`.
  A file with the right hash that is not Solidity metadata is skipped as `not-metadata`, so the
  caller never sees the builder's wording for a file it did not pass.
- For a Swarm hash (`bzzr0`, `bzzr1`, solc before 0.6.0) the library does not compute the Swarm
  hash and does not compare it with the copy's bytecode. Only an exact match on Sourcify for the
  same chain and address is used: the library relies on Sourcify having found the same hash in the
  same bytecode. This is a known limit; the guide states it.
- A Sourcify source whose keccak-256 differs from the metadata is dropped before the build, so the
  gateway or the caller's `sources` can supply it. With neither, the builder reports it as missing
  (`incomplete-input`).
- Every other source goes through `buildVerifyInput`, which checks its keccak-256 against the
  metadata (decision 0012). A source no one holds is `incomplete-input`; a changed one from the
  gateway or the caller is `source-mismatch`.
- SHA-256 is written in the core, `src/internal/sha256.ts`, as keccak-256 is: `crypto.subtle` is
  asynchronous, missing in insecure browser contexts, and needs the DOM types. It is tested
  against `node:crypto` for every length from 0 to 300 bytes and for inputs up to 300 KiB.
- The CID uses one level of parent block. solc adds a second level above 174 chunks, about
  43 MiB; the HTTP layer never reads more than 16 MiB, so that case cannot occur.

### Errors

Two codes are added to the end of `ERROR_CODES`:

| Code                   | When                                                                                                                                          | Exit | Retryable |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---- | --------- |
| `no-metadata-hash`     | The bytecode holds no hash: no code (`no-code`), no CBOR block (`no-metadata`), or only the version (`version-only`)                          | 2    | no        |
| `metadata-unavailable` | The JSON-RPC endpoint gave no bytecode, no source returned matching metadata, the gateway failed on a source file, or the time budget ran out | 5    | yes       |

`metadata-unavailable` carries `hash` (`ipfs:<CID>`, `bzzr0:<hex>` or `bzzr1:<hex>`, empty when the
bytecode was not read) and `attempts`, one entry per source tried, with `source` (`rpc`, `ipfs`,
`sourcify`), `outcome` (`not-found`, `hash-mismatch`, `not-metadata`, `unavailable`, `timeout`)
and the last HTTP status when there was one. The default hints are kept short, because every
entry carries the error catalogue. Failures of the caller's endpoints are not reported as `network` or
`unexpected-response`: those codes name a backend, and a gateway or a JSON-RPC endpoint is not one.

### Entry point and size

The resolver is exported from a new subpath, `explorer-verify/resolve`, not from the package
entry point, so `verify()` and the index do not carry it. The new size entry follows decision
0014: the measured size plus 20%, rounded up. It is measured with the routing table, as users ship
it; the bundler drops the rows, which the resolver does not read. Measured with esbuild 0.28.2 and
Node 24.21.0 zlib on 2026-11-04, on main at 22f60f4 with this change:

| Entry                      | Main (22f60f4) | After  | Ceiling            |
| -------------------------- | -------------- | ------ | ------------------ |
| `resolveInputFromBytecode` | none           | 21,076 | 25,292 (new)       |
| `verify`                   | 19,080         | 19,334 | 20,195 (unchanged) |
| `checkStatus`              | 17,123         | 17,374 | 18,351 (unchanged) |
| `buildVerifyInput`         | 11,627         | 11,870 | 13,310 (unchanged) |
| `index`                    | 26,558         | 26,827 | 28,979 (unchanged) |
| `createVerifyHandler`      | 12,084         | 12,347 | 14,429 (unchanged) |

The other entries grow by about 250 bytes each, for the two codes' hints and details in the error
class that every entry carries.

## Alternatives considered

| Option                                                                   | For                         | Against                                                                                              |
| ------------------------------------------------------------------------ | --------------------------- | ---------------------------------------------------------------------------------------------------- |
| A built-in public IPFS gateway                                           | Works with no configuration | R-SEC-2 forbids it; the public gateways answered 429 on 2026-11-04                                   |
| Trust gateway content without a CID check                                | No SHA-256 code             | A wrong gateway answer would surface only as a failed verification, with no source named             |
| Use `crypto.subtle` for SHA-256                                          | No code to maintain         | Asynchronous, absent in insecure browser contexts, needs DOM types in every caller                   |
| Ask Sourcify only for the call's chain                                   | One request fewer           | Misses the CREATE2 case, where the same bytecode is verified on another chain                        |
| Report gateway failures as `network` or `unexpected-response`            | No new code                 | Those codes name a backend; a gateway or JSON-RPC endpoint is not one, and the attempts list is lost |
| Export the resolver from the package entry point                         | One import path             | The index grows by about 5 KB and passes its ceiling                                                 |
| Let `sourcify: false` without a gateway fail with `metadata-unavailable` | No extra check              | The error would list no attempt; the options already say no source is left                           |
| Let a Sourcify source that fails its hash end in `source-mismatch`       | Simpler                     | The gateway may hold the right file; dropping the source lets it be used                             |

## Consequences

- `explorer-verify/resolve` exports `resolveInputFromBytecode` and its types. `MetadataAttempt`
  is exported from the package entry point with the other error types.
- Each new code has its page in `docs/user/reference/errors/`, and the user guide
  "Verify from deployed bytecode" describes the resolver.
- A later resolver (R-EXT-2) goes in `src/input/resolvers/` and is exported from the same subpath.
