# Quickstart: Node.js script

Check a deployed contract from a Node.js script, without an API key.

Version: explorer-verify 0.3.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

For: developers who verify contracts from a Node.js script or backend.

You need: Node.js 22.18 or later, which runs TypeScript files directly.

## 1. Install

Create a project and install the package:

```sh
mkdir greeter-check && cd greeter-check
npm install explorer-verify
npm pkg set type=module
```

## 2. Get the sample request

Download a request for a Greeter contract that is already verified on Sepolia:

```sh
repo=https://raw.githubusercontent.com/aelmanaa/explorer-verify/main
curl -O "$repo/docs/user/start/greeter-sepolia.json"
```

## 3. Write the dry run

A dry run checks the request and looks the contract up. It never submits:

```ts [verify.ts]
import { readFile } from "node:fs/promises";

import { dryRun, validateInput } from "explorer-verify";

const text = await readFile("greeter-sepolia.json", "utf8");
const input = validateInput(JSON.parse(text));

const plan = await dryRun(input);
console.log(plan.status, plan.backend, plan.lookup);
```

## 4. Run it

Run the script:

```sh
node verify.ts
```

```text
dry-run sourcify exact
```

Sourcify already holds an exact match, so a real run would submit nothing.

## 5. Verify for real

Replace `dryRun` with `verify`. With your own contract's request, this submits the source:

```ts [verify.ts]
import { readFile } from "node:fs/promises";

import { validateInput, verify } from "explorer-verify";

const text = await readFile("greeter-sepolia.json", "utf8");
const input = validateInput(JSON.parse(text));

const result = await verify(input);
console.log(result.status, result.backend);
```

```text
already-verified sourcify
```

## Next steps

- [Verify from Node.js](../guides/verify-from-node.md): API keys, logging and resuming a job.
- [Verify a contract from a Foundry project](../guides/verify-from-a-foundry-project.md): build
  the request from your own build.
- [verify()](../reference/verify.md): every option, result and error.
