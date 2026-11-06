# Verify a proxy

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers who deployed an upgradeable contract behind a proxy, such as an ERC-1967,
UUPS or transparent proxy, and want the explorer to show the implementation's functions on the
proxy's page. Nothing is released yet. `linkProxy` and [`verify`](../reference/verify.md) exist.

A proxy holds no logic of its own: calls run the implementation's code. An explorer shows the
implementation's functions on the proxy's page only once it knows which implementation the proxy
points at. That takes two verifications and one link.

## Steps

1. Verify the implementation with `verify()`.
2. Verify the proxy with `verify()`. Its source is the proxy contract, such as OpenZeppelin's
   `ERC1967Proxy`, with its own constructor arguments: the implementation address and the
   initialisation call data.
3. Link the proxy to the implementation with `linkProxy()`. It verifies nothing itself.

<!-- no-run: it sends requests to Etherscan with a real key. -->

```ts no-run
import { linkProxy, verify } from "explorer-verify";

const options = { apiKeys: { "etherscan-v2": etherscanKey } };
const implementation = "0x75038a8c55f5ec7196b54384fdbcffb1f2ce9920";
const proxy = "0xed5b8413e605598ef86cd7617f12701f74ca255c";

await verify({ ...input, address: implementation }, options);
await verify({ ...input, address: proxy }, options);

const result = await linkProxy(
  { chainId: 11155111, address: proxy, expectedImplementation: implementation },
  options,
);
if (result.status === "linked") {
  console.log(`linked to ${result.implementation}`);
  if (!result.implementationVerified) {
    console.log("verify the implementation, then call linkProxy() again");
  }
} else if (result.status === "mismatch") {
  console.log(`the proxy points at ${result.implementation ?? "another implementation"}`);
} else {
  console.log(`not linked: ${result.reason}`);
}
```

In this example `input` stands for each contract's own verification input: the compiler input is
shared, while `contractName` and the constructor arguments differ.

Set `expectedImplementation` to the implementation the proxy points at now: the address in its
EIP-1967 slot, `0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`. After an
upgrade it differs from the one the proxy was deployed with. Etherscan also receives it as
`expectedimplementation`. The target takes `chainId`, `address` and `expectedImplementation`;
other fields are ignored, as `verify()` ignores fields its input does not declare.

## Results

`linkProxy()` returns one of three results, each with `backend`:

- `linked`: the explorer links the proxy to `implementation`, `0x` and 40 lowercase hex digits,
  the expected one when `expectedImplementation` is set. `implementationVerified` is `false` when
  the explorer holds no verified source for the implementation: Etherscan answers "implementation
  saved (unverified - without ABI)". The proxy page then shows no functions. Verify the
  implementation, then call `linkProxy()` again. `explorerUrl` is the proxy's public page, when
  the library knows one.
- `mismatch`: the explorer holds another implementation than `expectedImplementation`, which the
  result repeats. `implementation` is the one the explorer holds. Etherscan's refusal does not name
  it, so the library reads it from Etherscan's record of the proxy; it is absent when that record
  holds none or the lookup fails. Read the proxy's EIP-1967 slot, then call `linkProxy()` with that address.
- `not-linked`: the explorer refused, with its reason in `reason`, API keys removed and cut to 300
  characters. It means the proxy is not verified there, or the explorer detects no implementation.

A link still pending when `timeoutMs` runs out throws
[`proxy-link-pending`](../reference/errors/proxy-link-pending.md): call `linkProxy()` again later.
A new call is safe; it undoes nothing.

Unknown answers are reported in one of two ways, by when they come:

- An answer to the link request in a form the library does not know, such as a `result` that is
  not a job id of the documented form, throws
  [`unexpected-response`](../reference/errors/unexpected-response.md). Nothing started.
- A status check answered with a link state the library cannot classify throws
  [`proxy-link-unknown-state`](../reference/errors/proxy-link-unknown-state.md), with no handle.
  So does an implementation that is not exactly one address, in any answer: a longer run of hex
  digits, several addresses, or the zero address. The proxy is never reported as linked from such
  an answer.
- A lookup, such as Blockscout's or Sourcify's record of the proxy, answered in a form the library
  does not know throws `unexpected-response`.

`linkProxy()` takes the options of `verify()`; its type, `LinkProxyOptions`, leaves out `rpcUrl`, which it does not use. It also throws `invalid-input`, `missing-api-key`,
`unsupported-chain`, `timeout`, `network`, `rate-limited` and `unexpected-response` as `verify()`
does. It emits `verify.routed`, then one `verify.poll` for each pending status check, and
`verify.retry` for an HTTP retry; it emits no `verify.validated` and no `verify.result`. See
[Logging and events](../reference/logging-and-events.md).

## What each explorer does

| Backend                                | Requests                                                                                                                                                                                                 | What it changes                                                          |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `etherscan-v2`, `etherscan-compatible` | `verifyproxycontract` with `address`, and `expectedimplementation` when it is set, then `checkproxyverification` every `pollIntervalMs`. After a mismatch, one `getsourcecode`. The key goes in the body | The proxy's page on the explorer                                         |
| `blockscout`                           | `verifyproxycontract` with `address` (Blockscout takes no expected implementation), then `checkproxyverification`, then one lookup of the implementation                                                 | Blockscout reads the implementation again; it also detects it on its own |
| `sourcify`                             | One lookup with `fields=proxyResolution`, then one lookup of the implementation                                                                                                                          | Nothing: Sourcify detects proxies when it verifies them                  |
| `routescan`                            | None: `linkProxy()` throws `invalid-input` on `route.backend` before any request. Pass another `route.backend`, such as `etherscan-compatible` with `route.apiUrl`                                       | Nothing                                                                  |

### Blockscout right after verify()

Blockscout refuses a second request for the same proxy within a short interval, 12 seconds on the
Sepolia instance on 2026-11-04, and verifying the proxy counts as the first. So in the order of the
steps above, the first link request is usually refused with `Only one attempt in <n>ms`.
`linkProxy()` then waits `<n>` milliseconds once, when that fits `timeoutMs`, and sends the request
again. When it is refused again, or the wait does not fit, it reads the implementation Blockscout
already holds for the proxy from its REST lookup, and returns `linked`, `mismatch` or `not-linked`
from it.

### Behaviour seen live

On Ethereum Sepolia on 2026-11-04:

- Etherscan linked a proxy whose own source it had not verified. Its documentation shows a refusal
  for that case, which gives `not-linked`.
- Etherscan answers `Pending in queue` with `status` `"0"` while it works. The library reads it as
  pending, whatever `status` says.
- For an address that is not a proxy, Etherscan answers that the contract "does not look like it
  contains any delegatecall opcode sequence": `not-linked`. Blockscout instead stayed at
  `Verification in progress` for more than a minute, so the call ends with `proxy-link-pending`.
- Sourcify records the implementation when it verifies the proxy. After an upgrade it can name the
  earlier one, and `expectedImplementation` then gives `mismatch`.

## From a browser

Etherscan needs your key, so a browser links through the [server handler](../reference/server-handler.md),
as it verifies. The handler forwards `verifyproxycontract` and `checkproxyverification` only when
you create it with `allowProxyLink: true`. After a mismatch, `linkProxy()` also sends one
`getsourcecode` through the handler, which forwards that lookup reduced, `Implementation` included.
Pass the same `fetch` and `route` you pass to `verify()`.

## See also

- [verify()](../reference/verify.md#options-of-each-function) for the options, which `linkProxy()`
  shares except `rpcUrl`.
- [Errors](../reference/errors/index.md) for every error code and exit code.
