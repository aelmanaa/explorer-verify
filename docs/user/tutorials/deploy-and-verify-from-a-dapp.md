# Deploy a contract from a dapp and verify it

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers new to explorer-verify who build a web dapp that deploys contracts for its
users. Nothing is published to npm yet.

In this tutorial you build the parts of a dapp that deploy a small contract, `Greeter`, from the
user's browser wallet on the Sepolia testnet, then verify its source on Sourcify. Sourcify needs no
API key, so no secret reaches the browser. You will:

1. build the contract and ship its files with the dapp;
2. deploy it from the browser and keep the creation transaction hash;
3. load the verification input only when the user verifies;
4. verify on Sourcify, show the handle, and wire the steps to a button;
5. resume the verification after a page reload;
6. read the result and the errors;
7. verify on Etherscan through your own server, which keeps the API key.

You need Node 22.18 or later, [Foundry](https://getfoundry.sh/), a bundler for the browser code
(any one that handles ES modules and dynamic `import()`), and a browser wallet with some Sepolia
ETH. Steps 1 to 6 need no account and no API key.

The code blocks are plain TypeScript modules with no framework. Each one names the file it goes in.
The finished dapp is in the repository, in
[`examples/dapp/`](../../../examples/dapp/src/main.ts); each module it shares with this page is the
same file. [Run the example](#run-the-example) says how to start
it.

## Step 1: Build the contract and ship its files

The contract stores an owner and a greeting. It inherits from a second file, so its source has two
files. In a Foundry project, `src/Base.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

abstract contract Base {
    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }
}
```

And `src/Greeter.sol`:

```solidity
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

Pin the compiler in `foundry.toml`, so every build uses the same solc and gives the same bytecode:

```toml
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

- `Greeter.deploy.json`: the ABI and the creation bytecode, to deploy;
- `Greeter.verify.json`: the compiler version and the Standard JSON input, with every source file,
  to verify.

This tutorial keeps the dapp and the Foundry project in one folder, and the dapp serves `public/`
as static files. Add a `package.json` with `"type": "module"`, so Node runs the script below as an
ES module, and install `explorer-verify` and `@explorer-verify/foundry` as development
dependencies. Save the script as `scripts/export-contracts.ts` and run it after each build with
`node scripts/export-contracts.ts`:

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { verifyInputFromFoundry } from "@explorer-verify/foundry";

// The ABI and the creation bytecode, from Foundry's artifact.
const artifact: unknown = JSON.parse(await readFile("out/Greeter.sol/Greeter.json", "utf8"));
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
// The compiler version, the contract name and the Standard JSON input, from the build-info.
const built = await verifyInputFromFoundry({ root: ".", contract: "src/Greeter.sol:Greeter" });

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

The verify file holds every source file of the compile. It is often much larger than the deploy
file, and most users never verify, so the dapp loads it only when verification runs (step 3).
Serving it publishes your sources, which verification does anyway. See
[Verify a contract from a Foundry project](../guides/verify-from-a-foundry-project.md) for the
helper's options, and
[Verify a contract shipped in an npm package](../guides/verify-a-contract-from-an-npm-package.md)
for Hardhat files and other build formats.

## Step 2: Deploy from the browser

This step uses [viem](https://viem.sh/) to talk to the wallet. explorer-verify does not need viem:
any library that sends a contract creation and returns the transaction hash works, such as ethers.
Install it in the dapp with `npm install viem`, and save this module as `src/deploy.ts`:

<!-- fragment: it needs viem and a browser wallet; the test project has neither. -->

```ts fragment
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

/** Loads the ABI and the creation bytecode that the build script wrote in step 1. */
async function loadArtifact(): Promise<{ abi: Abi; bytecode: Hex }> {
  const response = await fetch("/contracts/Greeter.deploy.json");
  if (!response.ok) {
    throw new Error(`Could not load the contract: HTTP ${String(response.status)}`);
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

/** Waits until the creation transaction is mined, then returns the deployment. */
async function waitForDeployment(creationTxHash: Hex): Promise<Deployment> {
  const { reader } = clients();
  const receipt = await reader.waitForTransactionReceipt({ hash: creationTxHash });
  localStorage.removeItem(CREATION_TX_KEY);
  const address = receipt.contractAddress;
  if (receipt.status !== "success" || address === null || address === undefined) {
    throw new Error(`The deployment failed in transaction ${creationTxHash}.`);
  }
  return { chainId: sepolia.id, address, creationTxHash };
}

/** Deploys Greeter from the user's wallet, owned by the user, and waits until it is mined. */
export async function deployGreeter(greeting: string): Promise<Deployment> {
  const { wallet } = clients();
  const [account] = await wallet.requestAddresses();
  if (account === undefined) {
    throw new Error("The wallet shared no account.");
  }
  await wallet.switchChain({ id: sepolia.id });
  const artifact = await loadArtifact();

  // The wallet asks the user to confirm. The hash comes back before the transaction is mined.
  const creationTxHash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    account,
    args: [account, greeting],
  });
  localStorage.setItem(CREATION_TX_KEY, creationTxHash);
  return await waitForDeployment(creationTxHash);
}

/** After a reload: the deployment whose transaction was sent but not yet seen mined, if any. */
export async function resumeDeployment(): Promise<Deployment | undefined> {
  const stored = localStorage.getItem(CREATION_TX_KEY);
  return isHex(stored) ? await waitForDeployment(stored) : undefined;
}
```

`deployGreeter` returns the contract's address and the creation transaction hash. The page shows
both when the transaction is mined (see the button code in step 4).

The docs tests do not run this block, because it needs viem and a wallet. The example's tests run
the same module, `examples/dapp/src/deploy.ts`, against viem 2.57.8 with a fake EIP-1193 wallet.
The viem calls are those of
the viem docs, read on 2026-11-04: [Wallet Client](https://viem.sh/docs/clients/wallet),
[`deployContract`](https://viem.sh/docs/contract/deployContract),
[`switchChain`](https://viem.sh/docs/actions/wallet/switchChain) and
[`waitForTransactionReceipt`](https://viem.sh/docs/actions/public/waitForTransactionReceipt).

Keep the creation transaction hash. explorer-verify sends it to Sourcify as
`creationTransactionHash`, which names the transaction that created the contract, and it lets the
user find the deployment again. The module saves it in `localStorage` as soon as the wallet returns
it, before the transaction is mined. If the page reloads while the transaction is pending,
`resumeDeployment` waits for the receipt of the saved hash and returns the deployment.

`window.ethereum` is the provider that most browser wallets inject, as defined by
[EIP-1193](https://eips.ethereum.org/EIPS/eip-1193). When a user has several wallets installed, use
[EIP-6963](https://eips.ethereum.org/EIPS/eip-6963) discovery to let them choose one. If the wallet
does not know Sepolia, `switchChain` fails; MetaMask answers with error code 4902
([MetaMask docs](https://docs.metamask.io/wallet/how-to/manage-networks/add-network/), read on
2026-11-04). Call `wallet.addChain({ chain: sepolia })`
([viem `addChain`](https://viem.sh/docs/actions/wallet/addChain)), then switch again.

## Step 3: Load the verification input when the user verifies

When the user asks to verify, load explorer-verify and the verify file with a dynamic import and
`fetch`. Neither is part of the dapp's first page load. Then add the chain, the address and the
creation transaction hash, and check the whole input with `validateInput`. Save this module as
`src/load-input.ts`:

<!-- no-run: it fetches a file from the dapp's own origin, which a test run does not serve. -->

```ts no-run
import type { VerifyInput } from "explorer-verify";

export interface Deployment {
  chainId: number;
  address: string;
  creationTxHash: string;
}

/** Loads explorer-verify and the verify file, and returns the checked input for a deployment. */
export async function loadVerifyInput(deployment: Deployment): Promise<VerifyInput> {
  const { validateInput } = await import("explorer-verify");
  const response = await fetch("/contracts/Greeter.verify.json");
  if (!response.ok) {
    throw new Error(`Could not load the verification input: HTTP ${String(response.status)}`);
  }
  const built: unknown = await response.json();
  if (typeof built !== "object" || built === null) {
    throw new Error("The verification input is not a JSON object.");
  }
  // Throws invalid-input, naming each bad field, before anything is sent.
  return validateInput({ ...built, ...deployment });
}
```

`validateInput` checks the compiler version, the Standard JSON input, the contract name, the
address and the transaction hash, and returns a new input with the address in lower case. A bad
field throws [`invalid-input`](../reference/errors/invalid-input.md), and nothing is sent. The page
shows the contract name and the compiler version of the loaded input (see the button code in
step 4).

## Step 4: Verify on Sourcify

Sepolia is in the routing table, which sends it to Sourcify (see
[Routing](../reference/routing.md)).
`verify()` first looks the contract up. When Sourcify does not have it yet, it submits the source,
then polls the job until it ends.

Save this module as `src/verify.ts`. `show` writes a line where the user sees it. The last line
runs the function once on its own, with the console as `show` and `input` as `loadVerifyInput`
returns it; leave that line out in the dapp, where the button code calls the function.

```ts
import { ExplorerVerifyError, verify } from "explorer-verify";
import type { VerifyInput, VerifyResult } from "explorer-verify";

export const PENDING_KEY = "greeter-verification";

function summary(result: VerifyResult): string {
  if (result.status === "failed") {
    return `Sourcify rejected the source: ${result.reason}`;
  }
  return [result.status, `(${result.match})`, result.explorerUrl].join(" ");
}

/** Verifies on Sourcify, saves the handle for a reload, and shows each step with `show`. */
export async function verifyOnSourcify(
  input: VerifyInput,
  show: (line: string) => void,
): Promise<void> {
  try {
    const result = await verify(input, {
      onEvent: (event) => {
        if (event.type === "verify.submitted") {
          // Saved before the first poll, so a reload can resume the job (step 5).
          localStorage.setItem(PENDING_KEY, event.handle);
          show(`Submitted. Handle: ${event.handle}`);
        }
      },
    });
    localStorage.removeItem(PENDING_KEY);
    show(summary(result));
  } catch (error) {
    if (error instanceof ExplorerVerifyError && error.details.code === "not-confirmed") {
      show("Sourcify is still checking. Reload the page later to see the result.");
      return;
    }
    // Every other end leaves nothing to resume.
    localStorage.removeItem(PENDING_KEY);
    if (error instanceof ExplorerVerifyError) {
      show(`${error.details.code}: ${error.hint}`);
      return;
    }
    throw error;
  }
}

await verifyOnSourcify(input, console.log);
```

When Sourcify verifies the contract, it prints:

```text
Submitted. Handle: ev1:sourcify:11155111:0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc:ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718
verified (exact) https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc
```

Show the handle to the user. It is the one-line form of the job: backend, chain, address and job
id. It holds no key and no URL, so it is safe to display, store or paste into a support request.

The `explorerUrl` is the contract's page on Sourcify. When Sourcify already had the contract,
`verify()` submits nothing and prints `already-verified (exact)` with the same link. The call has
a time budget of 120 seconds by default (`timeoutMs`); see
[verify()](../reference/verify.md#options).

### Wire the steps to a button

The page's entry module, `src/main.ts`, runs the steps in order when the user clicks a button with
the id `deploy`, and writes each line into an element with the id `status`. On load, it finishes a
deployment that a reload interrupted:

<!-- fragment: it imports the dapp's own modules of steps 2 to 4. -->

```ts fragment
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
  show(`Deployed at ${deployment.address} in transaction ${deployment.creationTxHash}`);
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

Point your bundler at `src/main.ts`. The docs tests do not run this module. The example's
`src/main.ts` holds the same code, adds the steps that follow, and is tested on a fake page. A
bundler that splits code puts each
explorer client in a chunk of its own, and this page loads only the Sourcify client: see
[client chunks](../reference/routing.md#client-chunks).

## Step 5: Resume after a page reload

A reload, a closed tab or the call's time limit can end the page's wait while Sourcify still
checks the source. The job goes on. Because step 4 saved the handle when Sourcify accepted the
submission, the page can poll the same job again with `checkStatus()`, which never submits. Save
this module as `src/resume.ts`, and call `resumeVerification(show)` from `src/main.ts` when the page
loads. As in step 4, the last line runs it once on its own:

```ts
import { ExplorerVerifyError, checkStatus } from "explorer-verify";

const PENDING_KEY = "greeter-verification";

/** Polls the job whose handle a previous page load saved, if any. Never submits. */
export async function resumeVerification(show: (line: string) => void): Promise<void> {
  const stored = localStorage.getItem(PENDING_KEY);
  if (stored === null) {
    return;
  }
  show(`Resuming ${stored}`);
  try {
    const result = await checkStatus(stored, { timeoutMs: 60_000 });
    localStorage.removeItem(PENDING_KEY);
    show(result.status);
  } catch (error) {
    if (error instanceof ExplorerVerifyError && error.details.code === "not-confirmed") {
      show("Still checking. The handle stays saved for the next load.");
      return;
    }
    localStorage.removeItem(PENDING_KEY);
    throw error;
  }
}

await resumeVerification(console.log);
```

After a reload, with the job verified, it prints:

```text
Resuming ev1:sourcify:11155111:0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc:ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718
verified
```

`checkStatus()` takes the handle as stored and resolves the route from its chain; the handle never
chooses a host. See [checkStatus()](../reference/check-status.md).

## Step 6: Read the result

`verify()` and `checkStatus()` return one of three results:

| `status`           | What to tell the user                                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verified`         | The source is now public on Sourcify. Link `explorerUrl`                                                                                                                        |
| `already-verified` | Sourcify had the source already, so nothing was submitted. Link `explorerUrl`                                                                                                   |
| `failed`           | Sourcify rejected the source, for example because the compiled code differs from the deployed code. Show `reason`. A retry gives the same answer; the fix is in the build files |

`match` is `exact` when the metadata hash matches too, and `partial` when only the code matches.
[Match types](../explanation/match-types.md) explains the difference.

Every other end is an `ExplorerVerifyError`. Its `hint` says what to do next, and `retryable` says
whether trying again may help. The codes a dapp meets most often:

| Code                                                                            | What it means for the user                                                                       |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [`not-confirmed`](../reference/errors/not-confirmed.md)                         | Sourcify has the job but did not finish in time. Resume it with `checkStatus()` (step 5)         |
| [`invalid-input`](../reference/errors/invalid-input.md)                         | A field of the input or an option is malformed. Nothing was sent. Check the verify file (step 1) |
| [`unsupported-chain`](../reference/errors/unsupported-chain.md)                 | The wallet deployed on a chain the routing table does not list                                   |
| [`in-progress`](../reference/errors/in-progress.md)                             | Another submission for this contract is being checked. Try again in a minute                     |
| [`network`](../reference/errors/network.md)                                     | No answer from Sourcify. Check the connection and try again                                      |
| [`rate-limited`](../reference/errors/rate-limited.md)                           | Sourcify asked to slow down. Try again later                                                     |
| [`timeout`](../reference/errors/timeout.md)                                     | The time ran out before Sourcify accepted the submission. Nothing to resume; try again           |
| [`job-not-found`](../reference/errors/job-not-found.md)                         | Sourcify no longer knows the job and the contract is not verified. Call `verify()` again         |
| [`verification-inconclusive`](../reference/errors/verification-inconclusive.md) | The job ended without a verdict. Call `verify()` again later                                     |
| [`unknown-state`](../reference/errors/unknown-state.md)                         | Sourcify reported a state the library cannot classify. Check the contract on Sourcify by hand    |

[Errors](../reference/errors/index.md) lists every code, with its cause and fix.

## Step 7: Verify on Etherscan through your server

Etherscan needs an API key, and the key must never reach the browser. explorer-verify's server
handler keeps it on your server: the browser sends its Etherscan requests to the handler, which
adds the key and forwards them.

Before you use Etherscan from a dapp, check your plan. A public dapp, or any use by a business,
protocol, foundation or DAO, needs an Etherscan Advanced plan or higher and its own key. When the
dapp displays Etherscan data, it must show "Powered by Etherscan.io APIs".
[Etherscan plans and attribution](../explanation/etherscan-plans-and-attribution.md) explains the
rule and its sources.

[Run the server handler](../guides/run-the-server-handler.md) shows the handler as a Next.js route
and as a Cloudflare Worker, with the key in the platform's secret store. Whatever the platform, set
these options for this dapp:

- `chains`: `[11155111]`, Sepolia, the only chain the dapp deploys on.
- `rateLimit`: a check that refuses requests a browser sends from another site.
- No `deployers`. `deployers` fits a dapp that deploys from its own addresses or a factory it alone
  controls; here users deploy from their own wallets, so limit callers with `rateLimit` and your own
  sign-in.

The block below runs both halves in one Node script, so you can try the path before you deploy the
server. The handler is created as on the server; the browser's `fetch` calls it directly, as a
request from the dapp's origin:

```ts
import { verify } from "explorer-verify";
import { createVerifyHandler } from "explorer-verify/server";
import type { RateLimit } from "explorer-verify/server";

const DAPP_ORIGIN = "https://your-dapp.example";

// Server side: refuse requests that a browser sends from another site.
const fromDapp: RateLimit = (request) => {
  const site = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  return site !== "cross-site" && (origin === null || origin === DAPP_ORIGIN);
};
const handler = createVerifyHandler({
  apiKey: etherscanKey, // from your server's secrets, never from the request
  chains: [11155111],
  rateLimit: fromDapp,
});

// Browser side: send each Etherscan request to the handler. Here the handler is called directly.
const viaHandler: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== "https://api.etherscan.io") {
    return await fetch(input, init);
  }
  const headers = new Headers(init?.headers);
  headers.set("origin", DAPP_ORIGIN);
  return await handler(new Request(`${DAPP_ORIGIN}/api/verify${url.search}`, { ...init, headers }));
};

const result = await verify(input, {
  route: { backend: "etherscan-v2", apiUrl: "https://api.etherscan.io/v2/api" },
  fetch: viaHandler,
});
console.log(`${result.status} ${result.backend}`);
```

The Greeter of the recorded answers is already verified on Etherscan, so it prints:

```text
already-verified etherscan-v2
```

In the dapp, the handler runs on your server and the browser's `fetch` posts to it. Save this as
`src/verify-etherscan.ts`, and call `verifyOnEtherscan(input)` with the input of step 3.
This path from a page works from the next release of explorer-verify, which carries the fix for
[issue #183](https://github.com/aelmanaa/explorer-verify/issues/183). The fix is merged but not
yet published; an earlier build reads the handler's answer as a redirect and stops.

<!-- no-run: it posts to /api/verify on the dapp's own origin, which a test run does not serve. -->

```ts no-run
import { verify } from "explorer-verify";
import type { VerifyInput, VerifyResult } from "explorer-verify";

/** Sends each Etherscan request to the dapp's server, and any other request as it is. */
export const viaHandler: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== "https://api.etherscan.io") {
    return await fetch(input, init);
  }
  return await fetch(`/api/verify${url.search}`, init);
};

/** Verifies on Etherscan through the dapp's server, which adds the key. */
export async function verifyOnEtherscan(input: VerifyInput): Promise<VerifyResult> {
  return await verify(input, {
    route: { backend: "etherscan-v2", apiUrl: "https://api.etherscan.io/v2/api" },
    fetch: viaHandler,
  });
}
```

`verify()` sends no key when it has none: the handler adds yours. The answer comes from
`/api/verify` on the dapp's origin, and `verify()` reads it because `viaHandler` chose that URL; a
redirect from your server still ends the call with `unexpected-response`. A result reached through
the handler has no `explorerUrl`. The guide's `handlerFetch` also handles a `Request` passed as the
first argument. [Etherscan](../reference/etherscan.md) describes what the client sends and how it
reads each answer, and [Server handler](../reference/server-handler.md) lists the handler's
options and refusals.

## Run the example

[`examples/dapp/`](../../../examples/dapp/src/main.ts) is the dapp of this page. Its `src/main.ts` runs the
steps on a click, resumes on load (step 5), and verifies on Etherscan too when the page's box is
ticked (step 7). `server.ts` serves `public/` and runs the server handler at `/api/verify` for
Sepolia only, and answers 403 to a request a browser marks as cross-site. It is for loopback only:
before you bind it to another address, add a rate limit, an `Origin` and `Host` check and your
own sign-in. From a clone of the repository, with Node 22.18 or later and pnpm:

```bash
pnpm install
pnpm run build
pnpm --filter explorer-verify-examples run dapp:build
pnpm --filter explorer-verify-examples run dapp:serve
```

Open `http://127.0.0.1:8080` in a browser with a wallet that holds some Sepolia ETH, and click
**Deploy and verify**. Each line the page shows comes from one of the steps above. The server
reads the Etherscan key from `ETHERSCAN_API_KEY` in its environment; without it, `/api/verify`
answers 503 and the rest of the page works. The example builds explorer-verify from the
repository, which has the fix for issue #183, so the Etherscan box works; a dapp that installs
explorer-verify needs the next release, as
[step 7](#step-7-verify-on-etherscan-through-your-server) says.

The build files in `public/contracts/` come from the example's Foundry project. After a change to
a contract in `src/`, run `forge build --build-info` and `node scripts/export-contracts.ts` in
`examples/dapp/`.

## What you built

- A build script that writes the deploy file and the verify file for the dapp.
- A deploy module that keeps the creation transaction hash and recovers it after a reload.
- A verify flow that loads the input only when needed, needs no key, and shows the handle.
- A resume step that finishes a verification after a reload, without a second submission.
- Etherscan verification through your own server, with the key kept there.

## How the examples are tested

The tests of this repository run the TypeScript blocks of steps 1, 4 and 5 and the first block of
step 7 against the build, with Sourcify and Etherscan answers recorded on 2026-11-02 and
2026-11-04 for the Greeter contract at `0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc` on Sepolia.
Step 3 and the second block of step 7 are type-checked but not run, because they request files or
routes from the dapp's own origin. Step 2 and the button code are not run, because they need a
wallet, a live network or the dapp's own files.

The example's tests run every module of the example, with no network and no browser: a fake
EIP-1193 wallet, an in-memory `localStorage`, the example's server for the page's own files and
`/api/verify`, and the same recorded answers. They also check that each block above that names an
example file is that file, unchanged, and that the bundle puts each explorer client in a chunk of
its own.
