# Verify a proxy

Version: explorer-verify 0.2.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

For: developers who deployed an upgradeable contract behind a proxy, such as an ERC-1967, UUPS or
transparent proxy, and want the explorer to show the implementation's functions on the proxy's
page.

You need: Node.js 22.18 or later, the build of both contracts, their addresses, and an Etherscan
API key for the link. A dry run needs no key.

A proxy holds no logic: calls run the implementation's code. An explorer shows the
implementation's functions on the proxy's page once it knows which implementation the proxy
points at. That takes two verifications and one link:

1. Verify the implementation with `verify()`.
2. Verify the proxy with `verify()`. Its source is the proxy contract, such as OpenZeppelin's
   `ERC1967Proxy`, with its own constructor arguments.
3. Link the proxy to the implementation with `linkProxy()`. It verifies nothing itself.

## Install

Install the core, and the helper for your build tool:

```bash
npm install explorer-verify @explorer-verify/foundry
```

For Hardhat, install `@explorer-verify/hardhat` and call `buildVerifyInputFromHardhat`.

## Dry run both contracts

Build the input of each contract and dry run it. Pass the proxy's ABI-encoded constructor
arguments in `constructorArgs`. This example assumes a constructor that takes only the
implementation address, which encodes as that address padded to 32 bytes:

<!-- no-run: it reads a Foundry build of a proxy, which the test fixtures do not hold -->

```ts no-run [dry-run.ts]
import { buildVerifyInputFromFoundry } from "@explorer-verify/foundry";
import { dryRun } from "explorer-verify";
import type { Hex, VerifyInput } from "explorer-verify";

const implementation: Hex = "0x75038a8c55f5ec7196b54384fdbcffb1f2ce9920";
const proxy: Hex = "0xed5b8413e605598ef86cd7617f12701f74ca255c";
const options = { apiKeys: { "etherscan-v2": etherscanKey } };

const inputs: VerifyInput[] = [
  {
    chainId: 11155111,
    address: implementation,
    ...(await buildVerifyInputFromFoundry({ root: ".", contract: "Box" })),
  },
  {
    chainId: 11155111,
    address: proxy,
    ...(await buildVerifyInputFromFoundry({ root: ".", contract: "BoxProxy" })),
    constructorArgs: `0x${implementation.slice(2).padStart(64, "0")}`,
  },
];
for (const input of inputs) {
  const result = await dryRun(input, options);
  console.log(input.contractName, result.backend, result.lookup);
}
```

`lookup` is `none` for a contract the explorer lacks: `verify()` will submit it. `exact` or
`partial` means it is already verified.

## Verify and link

Replace `dryRun` with `verify`, then call `linkProxy()`:

<!-- no-run: it sends requests to Etherscan with a real key -->

```ts no-run [verify-and-link.ts]
import { linkProxy } from "explorer-verify";

const implementation = "0x75038a8c55f5ec7196b54384fdbcffb1f2ce9920";
const proxy = "0xed5b8413e605598ef86cd7617f12701f74ca255c";
const options = { apiKeys: { "etherscan-v2": etherscanKey } };

// After verify() on both inputs:
const result = await linkProxy(
  {
    chainId: 11155111,
    address: proxy,
    expectedImplementation: implementation,
  },
  options,
);
if (result.status === "linked") {
  console.log(`linked to ${result.implementation}`);
  if (!result.implementationVerified) {
    console.log("verify the implementation, then call linkProxy() again");
  }
} else if (result.status === "mismatch") {
  console.log(
    `the proxy points at ${result.implementation ?? "another address"}`,
  );
} else {
  console.log(`not linked: ${result.reason}`);
}
```

> [!WARNING]
> A submit publishes the source on the explorer and cannot be undone.

Set `expectedImplementation` to the implementation the proxy points at now: the address in its
EIP-1967 slot. After an upgrade it differs from the one the proxy was deployed with. Etherscan
receives it as `expectedimplementation`.

The slot is `0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`. The target
takes `chainId`, `address` and `expectedImplementation`; other fields are ignored.

## Results

`linkProxy()` returns one of three results, each with `backend`:

- `linked`: the explorer links the proxy to `implementation`, in lower case. `explorerUrl` is the
  proxy's public page, when the library knows one.
- `mismatch`: the explorer holds another implementation than `expectedImplementation`. Read the
  proxy's EIP-1967 slot, then call `linkProxy()` with that address.
- `not-linked`: the explorer refused, with its reason in `reason`, keys removed and cut to 300
  characters. The proxy is not verified there, or the explorer detects no implementation.

With `linked`, `implementationVerified` is `false` when the explorer holds no verified source for
the implementation. The proxy page then shows no functions: verify the implementation, then call
`linkProxy()` again.

With `mismatch`, `implementation` is the one the explorer holds. Etherscan's refusal does not name
it, so the library reads it from Etherscan's record of the proxy. It is absent when that record
holds none or the lookup fails.

## Errors

| Error                                                                         | When                                                                                                                        |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| [`proxy-link-pending`](../reference/errors/proxy-link-pending.md)             | The link is still pending when `timeoutMs` runs out. Resume it with `details.jobId`                                         |
| [`unexpected-response`](../reference/errors/unexpected-response.md)           | The link request or a lookup got an answer in a form the library does not know                                              |
| [`proxy-link-unknown-state`](../reference/errors/proxy-link-unknown-state.md) | A status check gave a state the library cannot classify, or not one address                                                 |
| [`not-indexed`](../reference/errors/not-indexed.md)                           | Through a server handler with `deployers` set, Etherscan has no creation record for the address yet. Call again in a minute |

A new call after `proxy-link-pending` is safe: it undoes nothing. To check the same link instead,
see [Resume a pending link](#resume-a-pending-link). After `unexpected-response` on
the link request, nothing started. `proxy-link-unknown-state` has no handle, and the proxy is
never reported as linked from such an answer.

`linkProxy()` also throws the errors of `verify()`, such as `invalid-input` and
`missing-api-key`. See [Errors](../reference/errors/index.md).

## Resume a pending link

`proxy-link-pending` carries `details.jobId`, the job id the explorer gave for the link request.
An error of an earlier release has none. Pass it as `resumeJobId`, with the same target and route.
The call then sends only `checkproxyverification`: at once, then every `pollIntervalMs`.

An IDE or another tool that shows progress can store the job id and resume after a reload. On
Blockscout, resuming also avoids the refusal of a second link request within its interval. To
store the job id and resume:

<!-- no-run: it sends requests to Etherscan with a real key. -->

```ts no-run [resume.ts]
import { ExplorerVerifyError, linkProxy } from "explorer-verify";
import type { LinkProxyTarget } from "explorer-verify";

const options = { apiKeys: { "etherscan-v2": etherscanKey } };
const target: LinkProxyTarget = {
  chainId: 11155111,
  address: "0xed5b8413e605598ef86cd7617f12701f74ca255c",
  expectedImplementation: "0x75038a8c55f5ec7196b54384fdbcffb1f2ce9920",
};
try {
  await linkProxy(target, options);
} catch (error) {
  if (ExplorerVerifyError.is(error, "proxy-link-pending")) {
    // Store error.details.jobId; later, or after a reload:
    const result = await linkProxy(target, {
      ...options,
      resumeJobId: error.details.jobId,
    });
    console.log(result.status);
  }
}
```

`resumeJobId` takes 1 to 100 letters and digits, of the form the backend gives for this proxy: 50
lowercase letters and digits on Etherscan, the proxy's 40 hex digits and a hex timestamp on
Blockscout. Sourcify starts no job and takes none.

Any other value throws `invalid-input` on `resumeJobId` before any request, and the error never
repeats it. When the explorer no longer knows the job, it answers `Error!` (Etherscan) or
`Unknown UID` (Blockscout): the call throws `proxy-link-unknown-state`. Call again without
`resumeJobId` to send a new link request.

## Options and events

`linkProxy()` takes the options of `verify()` except `rpcUrl`, plus `resumeJobId`. Its type is
`LinkProxyOptions`.

It emits `verify.routed`, then one `verify.poll` for each pending status check, and
`verify.retry` for an HTTP retry. It emits no `verify.validated` and no `verify.result`. See
[Logging and events](../reference/logging-and-events.md).

## What each explorer does

| Backend                                | Requests                                                                    | What it changes                  |
| -------------------------------------- | --------------------------------------------------------------------------- | -------------------------------- |
| `etherscan-v2`, `etherscan-compatible` | `verifyproxycontract`, then `checkproxyverification` every `pollIntervalMs` | The proxy's page on the explorer |
| `blockscout`                           | `verifyproxycontract`, `checkproxyverification`, then one lookup            | Blockscout reads it again        |
| `sourcify`                             | One lookup with `fields=proxyResolution`, then one of the implementation    | Nothing                          |
| `routescan`                            | None: `invalid-input` before any request                                    | Nothing                          |

Details per backend:

- **Etherscan.** The key goes in the body. `expectedimplementation` is sent when set. After a
  mismatch, one `getsourcecode` reads the implementation.
- **Blockscout** takes no expected implementation. It also detects the implementation on its own.
- **Sourcify** detects proxies when it verifies them.
- **Routescan.** Pass another `route.backend`, such as `etherscan-compatible` with `route.apiUrl`.

## Blockscout right after verify()

Blockscout refuses a second request for the same proxy within a short interval, and verifying the
proxy counts as the first. So the first link request after `verify()` is usually refused with
`Only one attempt in <n>ms`.

`linkProxy()` then waits `<n>` milliseconds once, when that fits `timeoutMs`, and sends again. If
it is refused again, or the wait does not fit, it reads the implementation Blockscout holds from
its REST lookup. It returns `linked`, `mismatch` or `not-linked` from that.

## From a browser

Etherscan needs your key, so a browser links through the
[server handler](../reference/server-handler.md), as it verifies. Create the handler with
`allowProxyLink: true` to forward `verifyproxycontract` and `checkproxyverification`. A call with
`resumeJobId` needs it too.

After a mismatch, `linkProxy()` also sends one `getsourcecode` through the handler, which forwards
that lookup reduced, `Implementation` included. Pass the same `fetch` and `route` you pass to
`verify()`.

## Sources

Seen live on Ethereum Sepolia on 2026-11-04:

- Etherscan linked a proxy whose own source it had not verified. Its documentation shows a refusal
  for that case, which gives `not-linked`.
- Etherscan answers `Pending in queue` with `status` `"0"` while it works. The library reads it
  as pending, whatever `status` says.
- For an address that is not a proxy, Etherscan answers that the contract "does not look like it
  contains any delegatecall opcode sequence": `not-linked`. Blockscout stayed at
  `Verification in progress` for more than a minute, so the call ends with `proxy-link-pending`.
- Sourcify records the implementation when it verifies the proxy. After an upgrade it can name the
  earlier one, and `expectedImplementation` then gives `mismatch`.
- The Blockscout Sepolia instance refused a second request within 12 seconds.
- The addresses above are the `Box` and `BoxProxy` contracts of that run, recorded in the
  [proxy-linking research note](../../contributor/research/2026-11-04-proxy-linking.md).

## Next steps

- [verify()](../reference/verify.md#options-of-each-function): the options, which `linkProxy()`
  shares except `rpcUrl`.
- [Run the server handler](run-the-server-handler.md): link from a browser.
- [Errors](../reference/errors/index.md): each code and its fix.
