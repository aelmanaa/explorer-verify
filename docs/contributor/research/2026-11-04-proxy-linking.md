# 2026-11-04: How Etherscan, Blockscout and Sourcify link a proxy

Audience: whoever changes `linkProxy()` (`packages/explorer-verify/src/flow/link-proxy.ts`) or the
proxy-link code in `packages/explorer-verify/src/backends/proxy-*.ts`. Assumes the
[Etherscan client note](2026-11-04-etherscan-client.md) and the
[Blockscout client note](2026-11-04-blockscout-client.md).

This note records what each explorer answers when it is asked to link a proxy to its
implementation, and how `linkProxy()` maps each answer (issue
[#94](https://github.com/aelmanaa/explorer-verify/issues/94), R-FLOW-8).

## The live run

On 2026-11-04, forge 1.8.1 with solc 0.8.26 (optimizer on, 200 runs) deployed three contracts on
Ethereum Sepolia (chain 11155111) from a funded testnet account:

| Contract        | Address                                      | What it is                                                                                  |
| --------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `Box`           | `0x75038a8c55f5ec7196b54384fdbcffb1f2ce9920` | The implementation: one storage slot, a setter and an event                                 |
| `BoxProxy`      | `0xed5b8413e605598ef86cd7617f12701f74ca255c` | A minimal ERC-1967 proxy: it stores `Box` in the EIP-1967 slot and delegates                |
| `OtherBoxProxy` | `0xfa0e910758d502780263871f92a85736597b87f4` | The same proxy with one more constant, so its bytecode differs; never verified on Etherscan |

The implementation slot is `0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`,
`keccak256("eip1967.proxy.implementation") - 1` ([EIP-1967](https://eips.ethereum.org/EIPS/eip-1967),
read 2026-11-03). The constructor stores the implementation there and emits `Upgraded`.

Each request was sent with the `fetch` of Node.js 24.21.0 and saved under
`packages/explorer-verify/test/fixtures/<backend>/2026-11-04-<call>.json`, with the key replaced by
`[redacted]`. The contracts were verified with this library's `verify()` from the build in the
pull request. The deployment needed about 566,000 gas for `Box` by the node's `eth_estimateGas`,
more than forge's local estimate: a first broadcast with forge's estimate ran out of gas.

## Etherscan

Etherscan v2 takes two actions ([`verifyproxycontract`](https://docs.etherscan.io/api-reference/endpoint/verifyproxycontract)
and [`checkproxyverification`](https://docs.etherscan.io/api-reference/endpoint/checkproxyverification),
read 2026-11-03 and 2026-11-04). `verifyproxycontract` takes `address` and an optional
`expectedimplementation`, and answers a guid in `result` with `status` `"1"`. Both were sent as
form-encoded POSTs with the key in the body, as the other Etherscan calls are (decision 0016); both
answered.

| When                                                    | `checkproxyverification` answer (`status`, `result`)                                                                                     | Maps to                                                  | Fixture                                            |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------- |
| Proxy verified, implementation not verified             | `"1"`, `The proxy's (<proxy>) implementation contract is found at <implementation> and implementation saved (unverified - without ABI).` | `linked`, `implementationVerified` false                 | `checkproxyverification-unverified-implementation` |
| Proxy not verified (`OtherBoxProxy`)                    | The same answer: Etherscan linked it                                                                                                     | `linked`                                                 | `checkproxyverification-unverified-proxy`          |
| After `Box` was verified, with `expectedimplementation` | `"1"`, `The proxy's (<proxy>) implementation contract is found at <implementation> and is successfully updated.`                         | `linked`, `implementationVerified` true                  | `checkproxyverification-linked`                    |
| `expectedimplementation` is another address             | `"0"`, `The provided expected results are different than the retrieved implementation address!`                                          | `mismatch`, with the implementation from `getsourcecode` | `checkproxyverification-expected-mismatch`         |
| A verified contract that is not a proxy (the Greeter)   | `"0"`, `This contract does not look like it contains any delegatecall opcode sequence.`                                                  | `not-linked`                                             | `checkproxyverification-not-a-proxy`               |
| An address with no code                                 | The same delegatecall answer, twice 20 seconds apart                                                                                     | `not-linked`                                             | `checkproxyverification-no-code`                   |
| A guid Etherscan never gave                             | `"0"`, `Error!`                                                                                                                          | `proxy-link-unknown-state`                               | `checkproxyverification-unknown-guid`              |

Every answer above came at the first check. A `linkProxy()` run on 2026-11-04 at 19:59 UTC with a
mismatched `expectedimplementation` saw one pending check before the mismatch answer. On 2026-11-03,
curl 8.7.1 saw `{"status":"0","message":"NOTOK","result":"Pending in queue"}` for more than 60
seconds for an address with no code (issue #94). So `status` alone means nothing: `Pending in queue`
with `status` `"0"` is pending. The fixture
`2026-11-03-documented-checkproxyverification-pending-status-0` holds that body.

The only example answer in Etherscan's documentation of `checkproxyverification` is a refusal:
`The proxy contract at 0xcbdcd3815b5f975e1a2c944a9b2cd1c985a1cb7f does not seem to be verified.
Please verify and publish the contract source before proceeding with this proxy verification.`
It was not seen live, since Etherscan linked the unverified `OtherBoxProxy`; the client maps it to
`not-linked` from the documentation (fixture `2026-11-03-documented-checkproxyverification-proxy-not-verified`).

`getsourcecode` for `OtherBoxProxy`, not verified, answered `Proxy` `"1"` and `Implementation` set
to `Box` after the link (fixture `getsourcecode-other-box-proxy`).

A status text the client does not know, `Error!` included, throws `proxy-link-unknown-state` with
no handle: a link has no job the library could resume. A `linked` text that names another proxy
than the target, or an implementation that is not exactly `0x` and 40 hex digits (a longer run,
several, or the zero address), also throws. A link request answered with anything but a guid of
the documented form, 50 lowercase letters and digits, throws `unexpected-response`: nothing
started. The mismatch refusal does not name the implementation Etherscan holds, so the client reads
the `Implementation` of `getsourcecode` for the proxy.

## Blockscout

The instance was `https://eth-sepolia.blockscout.com`, with no key. Its RPC API takes the same two
actions. The strings come from `contract_controller.ex` at commit
[`4386ef39`](https://github.com/blockscout/blockscout/blob/4386ef39e0103fe35ca7e57280d93e2f4d9f64d7/apps/block_scout_web/lib/block_scout_web/controllers/api/rpc/contract_controller.ex),
read 2026-11-04, and were checked live where the table says so.

| When                                     | Answer                                                                                                                                      | Seen live | Maps to                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------- |
| Request for a proxy not verified there   | `status` `"0"`, `message` `Smart-contract not found or is not verified`, `result` null                                                      | Yes       | `not-linked`                                            |
| Request within the minimum interval      | `status` `"0"`, `message` `Only one attempt in 12000ms`. The interval follows the chain's block time (`get_fresh_time_distance`)            | Yes       | wait 12000 ms once, then read the REST lookup           |
| Request accepted                         | `status` `"1"`, `result` a 48-character uid                                                                                                 | Yes       | check it                                                |
| Check while it works                     | `status` `"1"`, `result` `Verification in progress`                                                                                         | Yes       | pending                                                 |
| Check after the link                     | `status` `"1"`, `result` `The proxy's (<proxy>) implementation contract is found at <implementation> and is successfully updated.`          | Yes       | `linked`                                                |
| Several implementations                  | `The proxy's (<proxy>) implementation contracts are found at [<…>] and they've been successfully updated.`                                  | No        | `proxy-link-unknown-state`; none (`[]`) is `not-linked` |
| Check when no implementation is detected | `status` `"0"`, `message` `NOTOK`, `result` `A corresponding implementation contract was unfortunately not detected for the proxy address.` | No        | `not-linked`                                            |
| Check of an unknown uid                  | `status` `"1"`, `result` `Unknown UID`                                                                                                      | Yes       | `proxy-link-unknown-state`                              |

The first link request for `BoxProxy`, sent right after `verify()` had verified it there, was
refused with `Only one attempt in 12000ms`: verifying had read the implementation moments before. A
request 15 seconds later was accepted, so the client waits the stated interval once in this case, and reads the REST lookup of the proxy when it is refused again. For the Greeter, a verified contract that is not a proxy,
the check answered `Verification in progress` at once, after about 10 seconds and after more than a
minute, so `linkProxy()` ends with `proxy-link-pending` there. The answer does not say whether the
implementation is verified, so the client then looks it up with the REST API, as `verify()` does.

The REST lookup of the unverified `BoxProxy` already held `proxy_type` `eip1967` and the
implementation (fixture `lookup-box-proxy-before`): Blockscout detects proxies on its own.

## Sourcify

Sourcify takes no request to link. `GET /v2/contract/{chainId}/{address}?fields=proxyResolution`
([Sourcify API v2](https://sourcify.dev/server/api-docs/), read 2026-11-04) returned:

| Contract                      | Answer                                                                                                | Maps to      |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- | ------------ |
| `BoxProxy`, verified          | 200, `proxyResolution` `{ isProxy: true, proxyType: "EIP1967Proxy", implementations: [{ address }] }` | `linked`     |
| The Greeter, not a proxy      | 200, `{ isProxy: false, proxyType: null, implementations: [] }`                                       | `not-linked` |
| `OtherBoxProxy`, not verified | 404, `match` null                                                                                     | `not-linked` |

`BoxProxy` was verified on Sourcify at 18:59:55 UTC, three seconds before the Blockscout
verification of it finished, with no request from this run to Sourcify. A `verify()` on Sourcify
then answered `already-verified`. After `Box` was verified on Sourcify, the proxy's
`implementations` entry still held only `address`, with no name: the resolution is recorded when
the proxy is verified. The client therefore looks the implementation up with a second request to
learn whether it is verified (fixture `lookup-box`, a 404 before it was).

## Routescan

On 2026-11-03, Routescan's `verifyproxycontract` for an address with no code answered
`{"status":"1","message":"OK","result":"OK"}`, with no guid, and `checkproxyverification` with an
unknown guid answered an empty `result` (issue #94). What a link does there is not known, so
`linkProxy()` throws `invalid-input` naming Routescan.

## linkProxy() end to end

The build in the pull request ran `linkProxy()` against the live explorers on 2026-11-04 between
19:59:25 and 19:59:56 UTC:

| Backend        | Target                                               | Result                                                           |
| -------------- | ---------------------------------------------------- | ---------------------------------------------------------------- |
| `etherscan-v2` | `BoxProxy`, `expectedImplementation` `Box`           | `linked`, `implementationVerified` true, with the Etherscan page |
| `etherscan-v2` | `BoxProxy`, `expectedImplementation` `OtherBoxProxy` | `not-linked`, after one pending check                            |
| `sourcify`     | `BoxProxy`                                           | `linked`, `implementationVerified` true                          |
| `sourcify`     | The Greeter                                          | `not-linked`: Sourcify does not detect a proxy                   |
| `blockscout`   | `BoxProxy`                                           | `linked`, `implementationVerified` true                          |

That build mapped the mismatch to `not-linked`. After review, the build in the pull request maps it
to `mismatch` and waits once after Blockscout's repeat-interval refusal. It ran again between
22:56:45 and 22:57:05 UTC on 2026-11-04:

| Backend        | Target                                               | Result                                                                           |
| -------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| `etherscan-v2` | `BoxProxy`, `expectedImplementation` `OtherBoxProxy` | `mismatch`, `implementation` `Box` from `getsourcecode`, after one pending check |
| `blockscout`   | `BoxProxy`                                           | `linked`, `implementationVerified` true                                          |
| `blockscout`   | `BoxProxy`, again at once                            | `linked` after 16 seconds, which matches one wait of the 12-second interval      |

## Sources

- [Etherscan API: `verifyproxycontract`](https://docs.etherscan.io/api-reference/endpoint/verifyproxycontract), read 2026-11-03 and 2026-11-04.
- [Etherscan API: `checkproxyverification`](https://docs.etherscan.io/api-reference/endpoint/checkproxyverification), read 2026-11-03 and 2026-11-04.
- [Blockscout `contract_controller.ex` at `4386ef39`](https://github.com/blockscout/blockscout/blob/4386ef39e0103fe35ca7e57280d93e2f4d9f64d7/apps/block_scout_web/lib/block_scout_web/controllers/api/rpc/contract_controller.ex), read 2026-11-04.
- [Blockscout `rpc_view.ex` at `4386ef39`](https://github.com/blockscout/blockscout/blob/4386ef39e0103fe35ca7e57280d93e2f4d9f64d7/apps/block_scout_web/lib/block_scout_web/views/api/rpc/rpc_view.ex), read 2026-11-04: an error answer puts its text in `message` and its data in `result`.
- [Sourcify API v2](https://sourcify.dev/server/api-docs/), read 2026-11-04.
- [EIP-1967: Proxy Storage Slots](https://eips.ethereum.org/EIPS/eip-1967), read 2026-11-03.
- Issue [#94](https://github.com/aelmanaa/explorer-verify/issues/94), with the 2026-11-03 Etherscan and Routescan probes.
- Live run: forge 1.8.1, solc 0.8.26 and Node.js 24.21.0, Ethereum Sepolia, 2026-11-04 18:57 to 19:59 UTC; fixtures under `packages/explorer-verify/test/fixtures/{etherscan,blockscout,sourcify}/2026-11-04-*`.
