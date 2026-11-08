# explorer-verify

Verify deployed smart-contract source on Etherscan, Blockscout, Sourcify and Routescan from a
browser, backend or CLI.

Status: experimental. The API may change before 1.0.

## CLI

The command ships in `@explorer-verify/cli` and needs Node.js 22.18 or later.

In a Foundry project, first run `forge build --build-info`. These commands use its Greeter
build and the deployed address on Sepolia; replace the address and contract with your deployment.
The dry run reads the explorer. The second command can publish source. Output below is from an
already verified contract; progress goes to stderr.

```sh
explorer-verify verify 0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc --chain sepolia --foundry . --contract src/Greeter.sol:Greeter --backend sourcify --dry-run
# exit code 0
```

```text
dry run on sourcify at sourcify.dev: exact match already, so a run without --dry-run would not submit.
https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc
```

```sh
explorer-verify verify 0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc --chain sepolia --foundry . --contract src/Greeter.sol:Greeter --backend sourcify
# exit code 0
```

```text
already-verified: exact match on sourcify
https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc
```

## SDK

This example uses the Foundry helper. The core also accepts compiler Standard JSON directly and
runs in browsers and edge runtimes.

After compiling the project, install `explorer-verify` next to `@explorer-verify/foundry`.
Pass the build with the deployed address and chain. `verify()` validates the input before requests.

```ts
import { buildVerifyInputFromFoundry } from "@explorer-verify/foundry";
import { verify } from "explorer-verify";

const built = await buildVerifyInputFromFoundry({
  root: ".",
  contract: "src/Greeter.sol:Greeter",
});
const result = await verify(
  {
    chainId: 11155111,
    address: "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc",
    ...built,
  },
  { route: { backend: "sourcify" } },
);
console.log(result.status);
```

```text
already-verified
```

For Etherscan in a browser, host the [server handler](https://github.com/aelmanaa/explorer-verify/blob/main/docs/user/guides/run-the-server-handler.md)
and pass `handlerUrl`; the key stays on your server.

## Guides

- [Browser](https://github.com/aelmanaa/explorer-verify/blob/main/docs/user/guides/verify-from-a-browser.md)
- [Node.js](https://github.com/aelmanaa/explorer-verify/blob/main/docs/user/guides/verify-from-node.md)
- [Foundry](https://github.com/aelmanaa/explorer-verify/blob/main/docs/user/guides/verify-from-a-foundry-project.md)
- [Hardhat](https://github.com/aelmanaa/explorer-verify/blob/main/docs/user/guides/verify-from-a-hardhat-project.md)
- [CI and CLI](https://github.com/aelmanaa/explorer-verify/blob/main/docs/user/guides/verify-from-ci-with-the-cli.md)
- [Agents](https://github.com/aelmanaa/explorer-verify/blob/main/docs/user/guides/using-from-an-agent.md)
- [Tools that wrap verification](https://github.com/aelmanaa/explorer-verify/blob/main/docs/user/guides/wrap-explorer-verify-in-your-tool.md)
