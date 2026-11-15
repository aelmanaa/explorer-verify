# Deploy a contract from a dapp and verify it

Version: explorer-verify 0.4.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

For: developers who build a web dapp that deploys contracts from the user's wallet.

You need: Node 22.18 or later, [Foundry](https://getfoundry.sh/), a bundler, and a browser wallet
with some Sepolia ETH. An Etherscan key only for step 5.

This tutorial deploys a small contract, `Greeter`, from the user's wallet on Sepolia, then
verifies it. It builds on [Verify a contract from a dapp](verify-from-a-dapp.md), which covers the
verify, resume and result steps without a wallet. The finished dapp is in
[`examples/dapp/`](../../../examples/dapp/src/main.ts); each module this page shows is a file there.

## Step 1: Build the contract and ship its files

The contract stores an owner and a greeting. It inherits from a second file, so its source has two
files. In a Foundry project, save both under `src/`.

<details>
<summary>The two Solidity files</summary>

The base contract:

```solidity [src/Base.sol]
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

abstract contract Base {
    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }
}
```

Then the contract the dapp deploys:

```solidity [src/Greeter.sol]
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.sol";

contract Greeter is Base {
    string public greeting;

    constructor(address owner_, string memory greeting_) Base(owner_) {
        greeting = greeting_;
    }
}
```

</details>

Pin the compiler, so every build uses the same solc and gives the same bytecode:

```toml [foundry.toml]
[profile.default]
src = "src"
out = "out"
solc_version = "0.8.24"
```

Build it with build-info, so the compiler input is kept as solc received it:

```bash
forge build --build-info
```

The dapp needs two files from this build:

| File                  | Holds                                                       | Used to |
| --------------------- | ----------------------------------------------------------- | ------- |
| `Greeter.deploy.json` | The ABI and the creation bytecode                           | Deploy  |
| `Greeter.verify.json` | The compiler version and the Standard JSON input, all files | Verify  |

Add a `package.json` with `"type": "module"`, and install `explorer-verify` and
`@explorer-verify/foundry` as development dependencies. Save this script and run it after each
build with `node scripts/export-contracts.ts`. It writes both files to `public/contracts/`, which
the dapp serves as static files:

```ts [scripts/export-contracts.ts]
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { buildVerifyInputFromFoundry } from "@explorer-verify/foundry";

// The ABI and the creation bytecode, from Foundry's artifact.
const artifact: unknown = JSON.parse(
  await readFile("out/Greeter.sol/Greeter.json", "utf8"),
);
if (
  typeof artifact !== "object" ||
  artifact === null ||
  !("abi" in artifact) ||
  !("bytecode" in artifact) ||
  typeof artifact.bytecode !== "object" ||
  artifact.bytecode === null ||
  !("object" in artifact.bytecode)
) {
  throw new Error("out/Greeter.sol/Greeter.json holds no ABI and bytecode.");
}
// The compiler version, the contract name and the Standard JSON input, from the
// build-info.
const built = await buildVerifyInputFromFoundry({
  root: ".",
  contract: "src/Greeter.sol:Greeter",
});

await mkdir("public/contracts", { recursive: true });
await writeFile(
  "public/contracts/Greeter.deploy.json",
  JSON.stringify({ abi: artifact.abi, bytecode: artifact.bytecode.object }),
);
await writeFile("public/contracts/Greeter.verify.json", JSON.stringify(built));
process.stdout.write(`${built.contractName} ${built.compiler.version}\n`);
```

It prints:

```text
src/Greeter.sol:Greeter 0.8.24+commit.e11b9ed9
```

The verify file holds every source file of the compile, so it is often much larger than the deploy
file. Most users never verify, so the dapp loads it only when verification runs (step 3). Serving
it publishes your sources, which verification does anyway.

## Step 2: Deploy from the browser

This step uses [viem](https://viem.sh/) to talk to the wallet. explorer-verify does not need viem:
any library that sends a contract creation and returns the transaction hash works, such as ethers.
Install it with `npm install viem`. The module exports two functions:

- `deployGreeter(greeting)` asks the wallet to deploy, then waits for the receipt;
- `resumeDeployment()` finishes a deployment that a page reload interrupted.

<details>
<summary>The deploy module</summary>

Save it as `src/deploy.ts`:

<!-- fragment: it needs viem and a browser wallet; the test project has neither. -->

```ts fragment [src/deploy.ts]
import { createPublicClient, createWalletClient, custom, isHex } from "viem";
import type { Abi, EIP1193Provider, Hex } from "viem";
import { sepolia } from "viem/chains";

declare global {
  interface Window {
    /** The provider that most browser wallets inject (EIP-1193). */
    ethereum?: EIP1193Provider;
  }
}

export interface Deployment {
  chainId: number;
  address: Hex;
  creationTxHash: Hex;
}

const CREATION_TX_KEY = "greeter-creation-tx";

function clients() {
  if (window.ethereum === undefined) {
    throw new Error("Install a browser wallet to deploy.");
  }
  const transport = custom(window.ethereum);
  return {
    wallet: createWalletClient({ chain: sepolia, transport }),
    reader: createPublicClient({ chain: sepolia, transport }),
  };
}

/**
 * Loads the ABI and the creation bytecode that the build script wrote in step
 * 1.
 */
async function loadArtifact(): Promise<{ abi: Abi; bytecode: Hex }> {
  const response = await fetch("/contracts/Greeter.deploy.json");
  if (!response.ok) {
    throw new Error(
      `Could not load the contract: HTTP ${String(response.status)}`,
    );
  }
  const artifact: unknown = await response.json();
  if (
    typeof artifact !== "object" ||
    artifact === null ||
    !("abi" in artifact) ||
    !Array.isArray(artifact.abi) ||
    !("bytecode" in artifact) ||
    !isHex(artifact.bytecode)
  ) {
    throw new Error("Greeter.deploy.json holds no ABI and bytecode.");
  }
  return { abi: artifact.abi, bytecode: artifact.bytecode };
}

/**
 * Waits until the creation transaction is mined, then returns the deployment.
 */
async function waitForDeployment(creationTxHash: Hex): Promise<Deployment> {
  const { reader } = clients();
  const receipt = await reader.waitForTransactionReceipt({
    hash: creationTxHash,
  });
  localStorage.removeItem(CREATION_TX_KEY);
  const address = receipt.contractAddress;
  if (
    receipt.status !== "success" ||
    address === null ||
    address === undefined
  ) {
    throw new Error(`The deployment failed in transaction ${creationTxHash}.`);
  }
  return { chainId: sepolia.id, address, creationTxHash };
}

/**
 * Deploys Greeter from the user's wallet, owned by the user, and waits until it
 * is mined.
 */
export async function deployGreeter(greeting: string): Promise<Deployment> {
  const { wallet } = clients();
  const [account] = await wallet.requestAddresses();
  if (account === undefined) {
    throw new Error("The wallet shared no account.");
  }
  await wallet.switchChain({ id: sepolia.id });
  const artifact = await loadArtifact();

  // The wallet asks the user to confirm. The hash comes back before the
  // transaction is mined.
  const creationTxHash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    account,
    args: [account, greeting],
  });
  localStorage.setItem(CREATION_TX_KEY, creationTxHash);
  return await waitForDeployment(creationTxHash);
}

/**
 * After a reload: the deployment whose transaction was sent but not yet seen
 * mined, if any.
 */
export async function resumeDeployment(): Promise<Deployment | undefined> {
  const stored = localStorage.getItem(CREATION_TX_KEY);
  return isHex(stored) ? await waitForDeployment(stored) : undefined;
}
```

</details>

`deployGreeter` returns the contract's address and the creation transaction hash. explorer-verify
sends the hash to Sourcify as `creationTransactionHash`, and it lets the user find the deployment
again.

The module saves the hash in `localStorage` as soon as the wallet returns it, before the
transaction is mined. If the page reloads while the transaction is pending, `resumeDeployment`
waits for the receipt of the saved hash and returns the deployment.

> [!TIP]
> When a user has several wallets installed, use [EIP-6963](https://eips.ethereum.org/EIPS/eip-6963)
> discovery to let them choose one. If the wallet does not know Sepolia, `switchChain` fails
> (MetaMask answers with error code 4902): call `wallet.addChain({ chain: sepolia })`, then switch
> again.

## Step 3: Load the verification input when the user verifies

When the user asks to verify, load explorer-verify and the verify file with a dynamic import and
`fetch`. Neither is part of the dapp's first page load. Then add the chain, the address and the
creation transaction hash, and check the whole input. Save this module:

<!-- no-run: it fetches a file from the dapp's own origin, which a test run does not serve. -->

```ts no-run [src/load-input.ts]
import type { VerifyInput } from "explorer-verify";

export interface Deployment {
  chainId: number;
  address: string;
  creationTxHash: string;
}

/**
 * Loads explorer-verify and the verify file, and returns the checked input for
 * a deployment.
 */
export async function loadVerifyInput(
  deployment: Deployment,
): Promise<VerifyInput> {
  const { validateInput } = await import("explorer-verify");
  const response = await fetch("/contracts/Greeter.verify.json");
  if (!response.ok) {
    throw new Error(
      `Could not load the verification input: HTTP ${String(response.status)}`,
    );
  }
  const built: unknown = await response.json();
  if (typeof built !== "object" || built === null) {
    throw new Error("The verification input is not a JSON object.");
  }
  // Throws invalid-input, naming each bad field, before anything is sent.
  return validateInput({ ...built, ...deployment });
}
```

`validateInput` checks every field and returns a new input with the address in lower case. A bad
field throws [`invalid-input`](../reference/errors/invalid-input.md), and nothing is sent.

## Step 4: Verify on Sourcify from a button

Sepolia's row in the [routing table](../reference/routing.md) sends it to Sourcify, which needs no
key. Add the two modules of the first tutorial to `src/`:

- `src/verify.ts`, from [Verify and save the handle](verify-from-a-dapp.md#step-3-verify-and-save-the-handle);
- `src/resume.ts`, from [Resume after a page reload](verify-from-a-dapp.md#step-5-resume-after-a-page-reload).

The page's entry module runs the steps in order when the user clicks the button with the id
`deploy`, and writes each line into the element with the id `status`. On load, it finishes a
deployment that a reload interrupted:

<!-- fragment: it imports the dapp's own modules of steps 2 to 4. -->

```ts fragment [src/main.ts]
import { deployGreeter, resumeDeployment } from "./deploy.ts";
import type { Deployment } from "./deploy.ts";
import { loadVerifyInput } from "./load-input.ts";
import { verifyOnSourcify } from "./verify.ts";

const status = document.querySelector("#status");

function show(line: string): void {
  const paragraph = document.createElement("p");
  paragraph.textContent = line;
  status?.append(paragraph);
}

async function verifyDeployment(deployment: Deployment): Promise<void> {
  show(
    `Deployed at ${deployment.address} ` +
      `in transaction ${deployment.creationTxHash}`,
  );
  const input = await loadVerifyInput(deployment);
  show(`Loaded ${input.contractName}, compiled with ${input.compiler.version}`);
  await verifyOnSourcify(input, show);
}

document.querySelector("#deploy")?.addEventListener("click", () => {
  deployGreeter("Hello, Sepolia")
    .then(verifyDeployment)
    .catch((error: unknown) => {
      show(error instanceof Error ? error.message : String(error));
    });
});

const pending = await resumeDeployment();
if (pending !== undefined) {
  await verifyDeployment(pending);
}
```

Point your bundler at `src/main.ts`. A bundler that splits code puts each explorer client in a
chunk of its own, and this page loads only the Sourcify client: see
[client chunks](../reference/routing.md#client-chunks). The example's `src/main.ts` also calls
`resumeVerification(show)` on load. [Verify a contract from a dapp](verify-from-a-dapp.md#step-6-read-the-result)
says how to read each result and error.

## Step 5: Verify on Etherscan through your server

Etherscan needs an API key, and the key must never reach the browser. The server handler keeps it
on your server: the browser sends its Etherscan requests to the handler, which adds the key and
forwards them.

> [!IMPORTANT]
> A public dapp, or any use by a business, protocol, foundation or DAO, needs an Etherscan Advanced
> plan or higher and its own key. A dapp that displays Etherscan data must show "Powered by
> Etherscan.io APIs". See [Etherscan plans and attribution](../explanation/etherscan-plans-and-attribution.md).

[Run the server handler](../guides/run-the-server-handler.md) shows the handler in Next.js and in a
Cloudflare Worker. Whatever the platform, set these options for this dapp:

| Option      | Value for this dapp                                                         |
| ----------- | --------------------------------------------------------------------------- |
| `chains`    | `[11155111]`: Sepolia, the only chain the dapp deploys on                   |
| `rateLimit` | A check that refuses requests a browser sends from another site             |
| `deployers` | None: users deploy from their own wallets, so limit callers with your login |

The browser passes the handler's URL to `verify()` as `handlerUrl`, and each Etherscan request
goes to the handler with no key. To try the path before you deploy a server, run both halves in
one Node script.

<details>
<summary>Try the handler in Node</summary>

The script runs on the sample request. Save
[greeter-sepolia.json](../start/greeter-sepolia.json) next to it, and set `ETHERSCAN_API_KEY`:

```ts [try-the-handler.ts]
import { validateInput, verify } from "explorer-verify";
import { createVerifyHandler } from "explorer-verify/server";
import type { RateLimit } from "explorer-verify/server";

import greeter from "./greeter-sepolia.json" with { type: "json" };

const DAPP_ORIGIN = "https://your-dapp.example";

// Server side: refuse requests that a browser sends from another site.
const fromDapp: RateLimit = (request) => {
  const site = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  return site !== "cross-site" && (origin === null || origin === DAPP_ORIGIN);
};
const handler = createVerifyHandler({
  // From your server's secrets, never from the request.
  apiKey: process.env["ETHERSCAN_API_KEY"] ?? "",
  chains: [11155111],
  rateLimit: fromDapp,
});

// Browser side: handlerUrl sends each Etherscan request to the handler,
// with no key. Here the handler is called directly, not over the network.
const toHandler: typeof fetch = async (target, init) => {
  const headers = new Headers(init?.headers);
  headers.set("origin", DAPP_ORIGIN);
  const url = target instanceof Request ? target.url : String(target);
  return await handler(new Request(url, { ...init, headers }));
};

const result = await verify(validateInput(greeter), {
  handlerUrl: `${DAPP_ORIGIN}/api/verify`,
  fetch: toHandler,
});
console.log(`${result.status} ${result.backend}`);
```

The sample Greeter is already verified on Etherscan, so it prints:

```text
already-verified etherscan-v2
```

</details>

In the dapp, the handler runs on your server and the browser's `fetch` posts to it. Save this
module, and call `verifyOnEtherscan(input)` with the input of step 3:

<!-- no-run: it posts to /api/verify on the dapp's own origin, which a test run does not serve. -->

```ts no-run [src/verify-etherscan.ts]
import { verify } from "explorer-verify";
import type { VerifyInput, VerifyResult } from "explorer-verify";

/**
 * Verifies on Etherscan through the dapp's server at /api/verify, which adds
 * the key. Etherscan may need a minute to index a contract deployed moments
 * ago: indexWaitMs waits for it.
 */
export async function verifyOnEtherscan(
  input: VerifyInput,
): Promise<VerifyResult> {
  return await verify(input, {
    handlerUrl: "/api/verify",
    indexWaitMs: 60_000,
  });
}
```

Etherscan may not have indexed a contract deployed seconds ago, and then answers that it finds no
contract code at the address. `verify()` sends the submit again every `pollIntervalMs`, and
`indexWaitMs: 60_000` lets it go on for a minute, within the default `timeoutMs` of two minutes.
If the contract is still not indexed, the call throws
[`not-indexed`](../reference/errors/not-indexed.md): show it to the user, and try again a minute
later.

The routing table still decides the route, so the result carries the Etherscan page as
`explorerUrl`. A redirect from your server ends the call with `unexpected-response`.
[Server handler](../reference/server-handler.md) lists the handler's options and refusals.

> [!NOTE]
> `handlerUrl` and the fix for [issue #183](https://github.com/aelmanaa/explorer-verify/issues/183)
> come with the next release. The example builds explorer-verify from the repository, which has
> both.

## Step 6: Run the example

[`examples/dapp/`](../../../examples/dapp/src/main.ts) is the dapp of this page. From a clone of
the repository, with Node 22.18 or later and pnpm:

```bash
pnpm install
pnpm run build
pnpm --filter explorer-verify-examples run dapp:build
pnpm --filter explorer-verify-examples run dapp:serve
```

Open `http://127.0.0.1:8080` in a browser with a wallet that holds some Sepolia ETH, and click
**Deploy and verify**. Tick the Etherscan box to run step 5 too. The server reads the key from
`ETHERSCAN_API_KEY`; without it, `/api/verify` answers 503 and the rest of the page works.

> [!WARNING]
> The example's `server.ts` is for loopback only. Before you bind it to another address, add a
> rate limit, an `Origin` and `Host` check and your own sign-in.

After a change to a contract, run the build and the export script of step 1 again in
`examples/dapp/`.

## Sources

- viem docs, read on 2026-11-04: [Wallet Client](https://viem.sh/docs/clients/wallet),
  [`deployContract`](https://viem.sh/docs/contract/deployContract),
  [`switchChain`](https://viem.sh/docs/actions/wallet/switchChain),
  [`addChain`](https://viem.sh/docs/actions/wallet/addChain) and
  [`waitForTransactionReceipt`](https://viem.sh/docs/actions/public/waitForTransactionReceipt).
- [EIP-1193](https://eips.ethereum.org/EIPS/eip-1193): the provider that most browser wallets
  inject as `window.ethereum`.
- MetaMask, [Add a network](https://docs.metamask.io/wallet/how-to/manage-networks/add-network/):
  error code 4902 for an unknown chain. Read on 2026-11-04.

## Next steps

- [Run the server handler](../guides/run-the-server-handler.md): the handler in Next.js and a
  Cloudflare Worker, with the key in the platform's secret store.
- [Verify a contract from a Foundry project](../guides/verify-from-a-foundry-project.md): the
  options of the build helper.
- [Verify a contract shipped in an npm package](../guides/verify-a-contract-from-an-npm-package.md):
  Hardhat files and other build formats.
- [Etherscan](../reference/etherscan.md): what the client sends and how it reads each answer.
