# Quickstart: SDK wrapper

Call explorer-verify from your own SDK, with one explorer client and your own error type.

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

For: authors of an SDK or a tool that verifies contracts for its users.

You need: Node.js 22.18 or later, which runs TypeScript files directly.

## 1. Install

Create a project and install the package:

```sh
mkdir my-tool && cd my-tool
npm install explorer-verify
npm pkg set type=module
```

## 2. Get the sample request

Download a request for a Greeter contract that is already verified on Sepolia:

```sh
repo=https://raw.githubusercontent.com/aelmanaa/explorer-verify/main
curl -O "$repo/docs/user/start/greeter-sepolia.json"
```

## 3. Write the wrapper

`explorer-verify/core` loads only the clients you pass, here Sourcify. The wrapper maps the
`invalid-input` error onto its own error class:

```ts [my-tool.ts]
import { readFile } from "node:fs/promises";

import type { VerifyInput } from "explorer-verify";
import { sourcify } from "explorer-verify/clients/sourcify";
import { dryRun } from "explorer-verify/core";
import { ExplorerVerifyError } from "explorer-verify/errors";

export class MyToolError extends Error {}

export async function checkContract(input: VerifyInput): Promise<string> {
  try {
    const plan = await dryRun(input, {
      clients: [sourcify()],
      route: { backend: "sourcify" },
    });
    return `${plan.status} ${plan.backend} ${plan.lookup}`;
  } catch (error) {
    if (!(error instanceof ExplorerVerifyError)) {
      throw error;
    }
    if (error.code === "invalid-input") {
      throw new MyToolError(`Bad contract details: ${error.message}`);
    }
    throw error;
  }
}

const sample = await readFile("greeter-sepolia.json", "utf8");
console.log(await checkContract(JSON.parse(sample)));
```

## 4. Run the dry run

The dry run looks the contract up and never submits:

```sh
node my-tool.ts
```

```text
dry-run sourcify exact
```

## 5. Verify for real

Call `verify` from `explorer-verify/core` with the same options. The
[wrap guide](../guides/wrap-explorer-verify-in-your-tool.md) shows it with every error code mapped.

## Next steps

- [Wrap explorer-verify behind your tool's API](../guides/wrap-explorer-verify-in-your-tool.md):
  settings, every error code and replay tests.
- [Core entry](../reference/core.md): every client and option of `explorer-verify/core`.
- [Errors](../reference/errors/index.md): each error code, its cause and fix.
