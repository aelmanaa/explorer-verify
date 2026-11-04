# 2026-11-04: Where the metadata behind a bytecode hash can be fetched

Audience: whoever works on the bytecode-metadata resolver (R-IN-5,
[#34](https://github.com/aelmanaa/explorer-verify/issues/34)) or its decision,
[0026](../decisions/0026-bytecode-metadata-resolver.md). Checked on 2026-11-04 with curl 8.7.1,
Node 24.21.0, Foundry 1.8.1 and the `solc` npm package 0.8.26. Each claim names its source; the
links are listed under [Sources](#sources).

## The hash in the bytecode

- solc appends a CBOR map to the runtime bytecode, followed by its length in two bytes,
  big-endian. The map holds `ipfs` (a 34-byte multihash) or `bzzr0`/`bzzr1` (a 32-byte Swarm
  hash), `solc` (the version) and, for experimental features, `experimental`. With
  `bytecodeHash: "none"` the map holds only `solc`; with `appendCBOR: false` there is no map
  ([Solidity docs, metadata](https://docs.soliditylang.org/en/v0.8.30/metadata.html), read
  2026-11-04). The four cases were compiled with solc-js 0.8.26 on 2026-11-04; the output is the
  fixture `packages/explorer-verify/test/fixtures/ipfs/solc-0.8.26-greeter.json`.
- solc computes the IPFS hash itself: chunks of 256 KiB, one UnixFS file node per chunk in a
  DAG-PB block, and parent blocks of at most 174 links
  ([IpfsHash.cpp at v0.8.26](https://github.com/ethereum/solidity/blob/v0.8.26/libsolutil/IpfsHash.cpp),
  read 2026-11-04). A JavaScript port of that algorithm with `node:crypto` SHA-256 gave the CIDs
  solc wrote for a 1,351-byte metadata file (one chunk) and a 301,560-byte one (two chunks), and
  the `dweb:/ipfs/` CIDs solc wrote for each source (Node 24.21.0, 2026-11-04).

## Public IPFS gateways

- `https://ipfs.io/ipfs/<CID>` answered HTTP 429 with `retry-after: 900`, a
  `sunset: Mon, 21 Sep 2026 00:00:00 GMT` header, a `link` header to
  <https://gatewaychanges.ipfs.io/> with `rel="sunset"`, and the body "This IPFS gateway is
  switching to a service worker gateway only". `https://dweb.link/ipfs/<CID>` answered 429 too
  (curl 8.7.1, 2026-11-04). The ipfs.io answer is the fixture
  `test/fixtures/ipfs/2026-11-04-ipfs-io-sunset.json`.
- `https://trustless-gateway.link/ipfs/<CID>` answered 521 and 525, with and without
  `Accept: application/vnd.ipld.raw`; `https://4everland.io/ipfs/<CID>` answered a 301 to a
  subdomain gateway; `gateway.pinata.cloud` and `cloudflare-ipfs.com` did not answer within
  25 seconds (curl 8.7.1, 2026-11-04). The CID was
  `QmQXfzJLPTjPUD1LWY6XQHqnWgqgDYEravjDpAMCtW4Uvb`, the metadata of the Sepolia Greeter at
  `0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc`.
- So no public path gateway served that metadata on 2026-11-04. Whether any gateway holds a given
  file depends on who pinned it; nothing in the build pins metadata by default.

## Sourcify

- The v2 API lists `GET /v2/contract/all-chains/{address}`, "all verified deployments at an
  address on all Sourcify chains", with `chainId` as a string and `match`, `creationMatch` and
  `runtimeMatch` for each, and `GET /v2/contract/{chainId}/{address}` with a `fields` parameter
  that selects `metadata` and `sources` among others
  ([Sourcify OpenAPI document](https://sourcify.dev/server/api-docs/swagger.json), read
  2026-11-04). There is no lookup by metadata hash.
- `all-chains` answered 200 with one exact match for the Sepolia Greeter, and 404 with
  `{"results":[]}` for an address with no verified contract. `fields=metadata,sources` answered
  200 with `metadata` as an object and `sources` as `{ path: { content } }`
  (Node 24.21.0 `fetch`, 2026-11-04; fixtures `test/fixtures/sourcify/2026-11-04-*.json`).
- `JSON.stringify` of that `metadata` object gave bytes whose CID is the one in the deployed
  bytecode (Node 24.21.0, 2026-11-04). solc writes the metadata as compact JSON with sorted keys,
  and `JSON.parse` keeps the key order of a document without integer-like keys.
- Two cases can make that check fail for a genuine copy, so the copy is skipped as
  `hash-mismatch` and the gateway is tried next. Neither was seen in the runs above; both follow
  from how `JSON.parse` and `JSON.stringify` work
  ([ECMA-262, OrdinaryOwnPropertyKeys](https://tc39.es/ecma262/#sec-ordinaryownpropertykeys),
  read 2026-11-04):
  - an object with two or more integer-like keys, such as source paths `"1"` and `"10"`:
    JavaScript lists them in numeric order, solc in string order;
  - a metadata file that starts with a byte order mark or carries other bytes `JSON.parse` drops:
    the re-serialised text differs from the bytes solc hashed.

## A live run from bytecode alone

- On 2026-11-04 a contract `Echo` (solc 0.8.24, optimizer 200 runs, `evmVersion` paris) was
  deployed through the deterministic deployer `0x4e59b44847b379578588920ca78fbf26c0b4956c` with
  the same salt on Sepolia (transaction
  `0x10ff75d06d76b89b933bd36cac19abf2bca3dfa503f9243054a6c7f08903247a`) and Base Sepolia
  (transaction `0x67e6466b10ea62624b5670ace90863ae468ee53cefb32e1dc5727b6871b4b879`), at
  `0x06dC80b924F113D9b6758c95aa9854B46936f2C0` on both (Foundry 1.8.1).
- At 08:42 UTC, `verify()` with the Foundry build verified it on Sourcify for Sepolia, exact
  match. `resolveInputFromBytecode` then read the bytecode on Base Sepolia over JSON-RPC, found
  the Sepolia copy through `all-chains`, checked its CID, and `verify()` with that input verified
  the Base Sepolia contract on Sourcify, exact match
  ([Sourcify repository page](https://repo.sourcify.dev/84532/0x06dC80b924F113D9b6758c95aa9854B46936f2C0)).

## Sources

- Solidity docs, contract metadata: https://docs.soliditylang.org/en/v0.8.30/metadata.html
- solc `IpfsHash.cpp` at v0.8.26:
  https://github.com/ethereum/solidity/blob/v0.8.26/libsolutil/IpfsHash.cpp
- IPFS gateway changes: https://gatewaychanges.ipfs.io/
- Sourcify OpenAPI document: https://sourcify.dev/server/api-docs/swagger.json
- ECMA-262, OrdinaryOwnPropertyKeys: https://tc39.es/ecma262/#sec-ordinaryownpropertykeys
- Sourcify repository, the Base Sepolia contract:
  https://repo.sourcify.dev/84532/0x06dC80b924F113D9b6758c95aa9854B46936f2C0
- Local runs with curl 8.7.1, Node 24.21.0, Foundry 1.8.1 and solc-js 0.8.26, 2026-11-04, as
  described above.
