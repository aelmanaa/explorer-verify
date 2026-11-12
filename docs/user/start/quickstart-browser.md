# Quickstart: browser dapp

Check a deployed contract from a web page, with no API key and no server.

Version: explorer-verify 0.2.1

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

For: developers who add contract verification to a dapp.

You need: Node.js 22.12 or later and npm. The page uses Vite; any bundler works.

## 1. Install

Create a Vite project and add the package:

```sh
npm create vite@latest greeter-dapp -- --template vanilla-ts
cd greeter-dapp
npm install
npm install explorer-verify
```

## 2. Get the sample request

Download a request for a Greeter contract that is already verified on Sepolia:

```sh
repo=https://raw.githubusercontent.com/aelmanaa/explorer-verify/main
curl -o src/greeter-sepolia.json "$repo/docs/user/start/greeter-sepolia.json"
```

## 3. Write the dry run

Replace the contents of `src/main.ts`. A dry run checks the request and looks the contract up. It
never submits:

```ts [src/main.ts]
import { dryRun, validateInput } from "explorer-verify";

import sample from "./greeter-sepolia.json" with { type: "json" };

const plan = await dryRun(validateInput(sample));
console.log(plan.status, plan.backend, plan.lookup);
```

## 4. Run it

Start the dev server and open `http://localhost:5173` in a browser:

```sh
npm run dev
```

The browser console shows:

```text
dry-run sourcify exact
```

Sourcify already holds an exact match, so a real run would submit nothing.

## 5. Verify for real

Replace `dryRun` with `verify`. With your own contract's request, this submits the source:

```ts [src/main.ts]
import { validateInput, verify } from "explorer-verify";

import sample from "./greeter-sepolia.json" with { type: "json" };

const result = await verify(validateInput(sample));
console.log(result.status, result.backend);
```

```text
already-verified sourcify
```

## Next steps

- [Verify from a browser](../guides/verify-from-a-browser.md): Etherscan through a server, and a
  job that survives a reload.
- [Deploy a contract from a dapp and verify it](../tutorials/deploy-and-verify-from-a-dapp.md):
  deploy from a wallet, then verify.
- [Run the server handler](../guides/run-the-server-handler.md): keep an Etherscan key off the
  browser.
