# Verify contracts your package ships

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: authors of an SDK or library that deploys its own contracts, who want each deployment
verified right after it lands.

The package ships two JSON files per contract: the Standard JSON input of the compile and a
manifest with the contract name and the full compiler version. After a deployment, the package
loads both files, builds the verification input and calls `verify()`. The files load only when
verification runs. An application that never verifies does not load them, and a browser does not
fetch them.

[Verify a contract shipped in an npm package](verify-a-contract-from-an-npm-package.md) covers the
other side: build files of unknown origin, in a package you did not write.

## Steps

1. When you build the package, write the Standard JSON input and the manifest of each contract it
   deploys.
2. Publish them in the package.
3. In the deploy function, after the creation transaction is mined, load the two files with
   `import()`, build the input and call `verify()`.

## Write the files when you build the package

Build the contracts, then run a script that writes the two files. This one reads a Foundry build
with `@explorer-verify/foundry`; for Hardhat, `buildVerifyInputFromHardhat` from
`@explorer-verify/hardhat` returns the same shape. See
[Verify a contract from a Foundry project](verify-from-a-foundry-project.md) and
[Verify a contract from a Hardhat project](verify-from-a-hardhat-project.md).

```ts
import { mkdir, writeFile } from "node:fs/promises";

import { buildVerifyInputFromFoundry } from "@explorer-verify/foundry";

// After `forge build --build-info`, in the root of the contracts project.
const built = await buildVerifyInputFromFoundry({ root: ".", contract: "src/Greeter.sol:Greeter" });

const standardJson = JSON.stringify(built.compiler.input);
const manifest = JSON.stringify({
  contract: built.contractName,
  compilerVersion: built.compiler.version,
});

await mkdir("verification", { recursive: true });
await writeFile("verification/Greeter.input.json", standardJson);
await writeFile("verification/Greeter.manifest.json", manifest);

console.log(manifest);
console.log(`Greeter.input.json: ${String(new TextEncoder().encode(standardJson).length)} bytes`);
```

This project's Foundry test fixture compiles seven source files in one build, and `Greeter`
imports only two of them. The script prints:

```text
{"contract":"src/Greeter.sol:Greeter","compilerVersion":"0.8.24+commit.e11b9ed9"}
Greeter.input.json: 2267 bytes
```

All seven files are in the input; the size section below explains why, and how to keep them
out.

The manifest keys are the options of `buildVerifyInput`: `contract` is the fully qualified name,
`path:Name`, and `compilerVersion` is the full version with the commit. A Standard JSON input names
neither, so `buildVerifyInput` needs both.

Write the files from the builder's result, not by copying a build-info file. The builder keeps only
`language`, `sources` and `settings`, and only `content` and `keccak256` of each source. It drops
fields such as Foundry's `basePath`, which holds an absolute path on the build machine, and it
rejects an input that still holds a local path. Each source keeps its exact bytes: do not run the
files through a formatter.

## Ship the files

Put the folder where the deploy module's relative `import()` finds it after your own build. If
your build does not emit the imported JSON files to `dist/`, copy the folder there. The `files`
field of `package.json` must include it.

Measure the size. The Standard JSON input holds the full text of every source in the compile, not
only the files of the contract you deploy, so a contract that imports a large library ships that
library's sources too. A build that compiles more files than the deployed
contracts adds those files as well: tests, scripts, or other contracts, as in the fixture above,
where five of the seven files are not part of `Greeter`. Two ways keep the input to what the
contract needs:

- Compile the contracts you deploy in a build of their own. Ship the bytecode of that build, and
  write the files from it.
- Ship the contract's Solidity metadata and the source files it lists instead.
  `buildVerifyInput` rebuilds the Standard JSON input from them. See
  [Rebuild the input from Solidity metadata](verify-a-contract-from-an-npm-package.md#rebuild-the-input-from-solidity-metadata).

Each verification input is sent to the explorer and published there with the verified contract.

## Verify after a deployment

The deploy function knows the chain, the deployed address and the creation transaction hash. Pass
all three. Backends that support it use the creation transaction hash to match the creation
bytecode; Sourcify receives it as `creationTransactionHash`.

```ts
import { buildVerifyInput, verify } from "explorer-verify";
import type { Hex, VerifyOptions, VerifyResult } from "explorer-verify";

/** Verifies a Greeter that this package deployed. The application chooses the options. */
export async function verifyGreeter(
  deployment: { chainId: number; address: Hex; creationTxHash: Hex },
  options?: VerifyOptions,
): Promise<VerifyResult> {
  // Loaded only when verification runs: an application that never verifies never loads them.
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
  creationTxHash: "0xbde6884cf580e2b10b46bf5f02138b989ad23b0d1619700baf46ee3cc1f31cf2",
});
if (result.status === "failed") {
  console.error(`Rejected: ${result.reason}`);
} else {
  console.log(result.status, result.match, result.explorerUrl ?? "");
}
```

When Sourcify already has the contract, `verify()` submits nothing. It prints:

```text
already-verified exact https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc
```

When Sourcify does not have it, `verify()` submits the input, waits for the job and prints
`verified exact` with the same URL. The project's tests run this example against recorded Sourcify
answers for this deployment, both ways.

Call it after the creation transaction is mined. Right after a deployment, the explorer may not see
the contract yet. Sourcify then ends the job with `contract_not_deployed`, and `verify()` throws
[`verification-inconclusive`](../reference/errors/verification-inconclusive.md): wait a minute and
call it again. A verification that does not finish in time throws `not-confirmed` with a handle;
[checkStatus()](../reference/check-status.md) resumes it. Decide whether a failed verification
fails the deployment: the contract is deployed either way.

The submit is outward and permanent: the explorer publishes the source. When an agent deploys with
your package, see [Using explorer-verify from an agent](using-from-an-agent.md).

## Where it runs

`buildVerifyInput` and `verify()` use no Node API, so the same deploy function runs
on a backend and in a browser.

- On a backend, Node 22.18 or later reads each JSON file when `import()` runs.
- In a browser, bundlers put a module that is loaded only through `import()` in a separate chunk.
  The browser fetches it the first time `verifyGreeter` runs. Check that your bundler accepts the
  `with { type: "json" }` import attribute.
- In TypeScript, the JSON import needs `resolveJsonModule`. With `module: "nodenext"`, it also
  needs the `with { type: "json" }` attribute shown above.

`verifyGreeter` passes its options through to `verify()`, so the application that uses your
package chooses the explorer, the key and the `fetch`. Without options, `verify()` uses the
routing table, which in this release sends every chain it lists to Sourcify, with no API key.

The table lists no Etherscan rows yet, so a key in `apiKeys` alone does not reach Etherscan
([#122](https://github.com/aelmanaa/explorer-verify/issues/122)). To verify on Etherscan:

- On a backend, pass
  `route: { backend: "etherscan-v2", apiUrl: "https://api.etherscan.io/v2/api", apiKey }`.
- In a browser, never ship the key. Pass `route: { backend: "etherscan-v2", apiUrl }` without a key,
  and a `fetch` that sends the requests to the
  [server handler](../reference/server-handler.md) on your own server, which adds the key.
  [Run the server handler](run-the-server-handler.md) shows it in a Next.js route and a Cloudflare
  Worker.

[Etherscan](../reference/etherscan.md) lists what the client sends and how it reads each answer,
and [API keys](../reference/api-keys.md) says which host gets each key. A public dapp, or any use
by a business, needs an Etherscan Advanced plan or higher: see the
[Etherscan plan rule](../reference/api-keys.md#etherscan-plan-rule).
