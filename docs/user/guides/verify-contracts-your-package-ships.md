# Verify contracts your package ships

Version: explorer-verify 0.4.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

For: authors of an SDK or library that deploys its own contracts, who want each deployment
verified right after it lands.

You need: Node.js 22.18 or later, and a Foundry or Hardhat project for the contracts your package
deploys. A dry run needs no API key.

The package ships two JSON files per contract: the Standard JSON input of the compile, and a
manifest with the contract name and the full compiler version. After a deployment, the package
loads both, builds the input and calls `verify()`. An application that never verifies never loads
them.

For build files of unknown origin, see
[Verify a contract shipped in an npm package](verify-a-contract-from-an-npm-package.md). For
another team's package that ships only sources, see
[Verify contracts from a package that ships only sources](verify-contracts-from-a-package-that-ships-only-sources.md).

## Install

The package depends on the core, and its build script on the Foundry helper:

```bash
npm install explorer-verify
npm install --save-dev @explorer-verify/foundry
```

For Hardhat, install `@explorer-verify/hardhat` instead. Its `buildVerifyInputFromHardhat`
returns the same shape.

## Write the files when you build the package

After `forge build --build-info`, run this script in the root of the contracts project:

```ts [write-verification-files.ts]
import { mkdir, writeFile } from "node:fs/promises";

import { buildVerifyInputFromFoundry } from "@explorer-verify/foundry";

const built = await buildVerifyInputFromFoundry({
  root: ".",
  contract: "src/Greeter.sol:Greeter",
});

const standardJson = JSON.stringify(built.compiler.input);
const manifest = JSON.stringify({
  contract: built.contractName,
  compilerVersion: built.compiler.version,
});

await mkdir("verification", { recursive: true });
await writeFile("verification/Greeter.input.json", standardJson);
await writeFile("verification/Greeter.manifest.json", manifest);

const bytes = new TextEncoder().encode(standardJson).length;
console.log(manifest);
console.log(`Greeter.input.json: ${String(bytes)} bytes`);
```

On this project's Foundry test fixture, it prints:

```text
{"contract":"src/Greeter.sol:Greeter","compilerVersion":"0.8.24+commit.e11b9ed9"}
Greeter.input.json: 2267 bytes
```

The manifest keys are options of `buildVerifyInput`: `contract` is `path:Name`, and
`compilerVersion` the full version with the commit. A Standard JSON input names neither.

Write the files from the builder's result, not by copying a build-info file. The builder keeps
only `language`, `sources` and `settings`, and drops fields such as Foundry's `basePath`, which
holds a local path. Keep each source's exact bytes: do not run the files through a formatter.

## Dry run the shipped files

Before you publish, check that the files load and route. This dry run builds the input from them
for the sample Greeter on Sepolia:

<!-- code-width: an import with attributes does not break -->

```ts [dry-run.ts]
import { buildVerifyInput, dryRun } from "explorer-verify";

import standardJson from "./verification/Greeter.input.json" with { type: "json" };
import manifest from "./verification/Greeter.manifest.json" with { type: "json" };

const built = buildVerifyInput([standardJson], manifest);
const result = await dryRun({
  chainId: 11155111,
  address: "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc",
  ...built,
});
console.log(result.status, result.backend, result.lookup);
```

```text
dry-run sourcify exact
```

`lookup` is `exact`: Sourcify holds this contract, so `verify()` would submit nothing. `none`
means `verify()` would submit the input.

## Ship the files

Put the `verification` folder where the deploy module's relative `import()` finds it after your
build. If your build does not copy JSON files to `dist/`, copy the folder there. The `files` field
of `package.json` must include it.

Measure the size. The Standard JSON input holds every source of the compile, not only the
contract's own files. In the fixture above, five of the seven files are not part of `Greeter`.
Two ways keep the input to what the contract needs:

- Compile the contracts you deploy in a build of their own, and write the files from it.
- Ship the contract's Solidity metadata and its source files instead. `buildVerifyInput` rebuilds
  the input from them: see
  [Rebuild the input from Solidity metadata](verify-a-contract-from-an-npm-package.md#rebuild-the-input-from-solidity-metadata).

The explorer publishes each verification input with the verified contract.

## Verify after a deployment

The deploy function knows the chain, the address and the creation transaction hash. Pass all
three. Sourcify receives the hash as `creationTransactionHash` and uses it to match the creation
bytecode:

```ts [verify-greeter.ts]
import { buildVerifyInput, verify } from "explorer-verify";
import type { Hex, VerifyOptions, VerifyResult } from "explorer-verify";

/**
 * Verifies a Greeter this package deployed. The application picks the options.
 */
export async function verifyGreeter(
  deployment: { chainId: number; address: Hex; creationTxHash: Hex },
  options?: VerifyOptions,
): Promise<VerifyResult> {
  // Loaded only when verification runs.
  const [{ default: standardJson }, { default: manifest }] = await Promise.all([
    import("./verification/Greeter.input.json", { with: { type: "json" } }),
    import("./verification/Greeter.manifest.json", { with: { type: "json" } }),
  ]);
  const built = buildVerifyInput([standardJson], manifest);
  return await verify({ ...deployment, ...built }, options);
}

// A Greeter deployed on Sepolia, with its creation transaction.
const result = await verifyGreeter({
  chainId: 11155111,
  address: "0x8275D36F64F047D2D8a1F42c79Bf80Caea39D7cC",
  creationTxHash:
    "0xbde6884cf580e2b10b46bf5f02138b989ad23b0d1619700baf46ee3cc1f31cf2",
});
if (result.status === "failed") {
  console.error(`Rejected: ${result.reason}`);
} else {
  console.log(result.status, result.match, result.explorerUrl ?? "");
}
```

When Sourcify already has the contract, `verify()` submits nothing:

```text
already-verified exact https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc
```

When Sourcify lacks it, `verify()` submits, waits for the job and prints `verified exact` with
the same URL.

> [!WARNING]
> A submit publishes the source on the explorer and cannot be undone. When an agent deploys with
> your package, see [Using explorer-verify from an agent](using-from-an-agent.md).

## Handle a slow explorer

Call `verifyGreeter` after the creation transaction is mined. Right after a deployment, the
explorer may not see the contract yet:

- Sourcify ends the job with `contract_not_deployed`, and `verify()` throws
  [`verification-inconclusive`](../reference/errors/verification-inconclusive.md). Wait a minute
  and call it again.
- A verification that does not finish in time throws `not-confirmed` with a handle.
  [checkStatus()](../reference/check-status.md) resumes it.

Decide whether a failed verification fails the deployment: the contract is deployed either way.

## Where it runs

`buildVerifyInput` and `verify()` use no Node API, so the same deploy function runs on a backend
and in a browser:

- On a backend, Node.js reads each JSON file when `import()` runs.
- In a browser, bundlers put a module loaded only through `import()` in its own chunk, fetched the
  first time `verifyGreeter` runs. Check that your bundler accepts `with { type: "json" }`.
- TypeScript needs `resolveJsonModule`. With `module: "nodenext"`, it also needs the
  `with { type: "json" }` attribute.

## Let the application choose the explorer

`verifyGreeter` passes its options to `verify()`, so the application picks the explorer, the key
and the `fetch`. Without `route`, the routing table picks the first backend in the chain's row
that works with the keys passed. On Sepolia the row lists Etherscan v2, then Sourcify, so with no
key the call goes to Sourcify. [Routing](../reference/routing.md#how-a-chain-resolves) gives the
full rule.

On a backend, pass the Etherscan key in `apiKeys`, and the Sepolia call goes to Etherscan:

<!-- code-width: an import with attributes does not break -->

```ts [verify-with-etherscan.ts]
import { buildVerifyInput, verify } from "explorer-verify";
import type { VerifyInput, VerifyOptions } from "explorer-verify";

import standardJson from "./verification/Greeter.input.json" with { type: "json" };
import manifest from "./verification/Greeter.manifest.json" with { type: "json" };

// On a backend. Never ship an Etherscan key to a browser.
const options: VerifyOptions = {
  apiKeys: { "etherscan-v2": etherscanKey },
  onEvent: (event) => {
    if (event.type === "verify.routed") {
      console.log(`routed to ${event.backend} by ${event.routedBy}`);
    }
  },
};
const input: VerifyInput = {
  chainId: 11155111,
  address: "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc",
  ...buildVerifyInput([standardJson], manifest),
};
const result = await verify(input, options);
console.log(result.status, result.backend);
```

When Etherscan already has the contract, it prints:

```text
routed to etherscan-v2 by table
already-verified etherscan-v2
```

In a browser, never ship the key. Pass `handlerUrl`, the URL of the
[server handler](../reference/server-handler.md) on your own server, which adds the key.
[Run the server handler](run-the-server-handler.md) shows it in Next.js and a Cloudflare Worker.

> [!IMPORTANT]
> A public dapp, or any use by a business, needs an Etherscan Advanced plan or higher. See the
> [Etherscan plan rule](../reference/api-keys.md#etherscan-plan-rule).

## Next steps

- [Etherscan](../reference/etherscan.md): what the client sends and how it reads each answer.
- [API keys](../reference/api-keys.md): which host gets each key.
- [checkStatus()](../reference/check-status.md): resume a verification that did not finish.
- [Wrap explorer-verify in your tool](wrap-explorer-verify-in-your-tool.md): expose verification
  in your own API.
