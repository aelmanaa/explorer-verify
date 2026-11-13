# Core entry

Version: explorer-verify 0.3.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers who bundle explorer-verify into one file, such as a wrapper SDK, a Cloudflare
Worker or a CommonJS build, and want only the explorer clients they use in it.

`explorer-verify/core` exports the same five functions as `explorer-verify`, with the same steps,
results and errors:

- `verify` and `dryRun`
- `checkStatus`
- `verifyEach`
- `linkProxy`

The difference is where the explorer clients and the routing table come from.

## Why a core entry

The default entry loads each client and the table with a dynamic `import()` when a call needs
them. The core takes them from your options and holds no dynamic `import()`. A bundle that does
not split code then holds only the clients you import, and the table only if you import it.

[Ship only the clients your tool uses](../guides/wrap-explorer-verify-in-your-tool.md#ship-only-the-clients-your-tool-uses)
shows when to choose it. [Bundle size](../advanced/bundle-size.md) lists what each part weighs.

## A minimal call

Pass one client in `clients` and the table in `table`. This script dry-runs the sample request,
[greeter-sepolia.json](../start/greeter-sepolia.json), a Greeter already verified on Sepolia:

```ts [dry-run.ts]
import { readFile } from "node:fs/promises";

import type { VerifyInput } from "explorer-verify";
import { sourcify } from "explorer-verify/clients/sourcify";
import { dryRun } from "explorer-verify/core";
import { routingTable } from "explorer-verify/table";

const text = await readFile("greeter-sepolia.json", "utf8");
const input: VerifyInput = JSON.parse(text);

const plan = await dryRun(input, {
  clients: [sourcify()],
  table: routingTable,
});
console.log(plan.status, plan.backend, plan.lookup);
```

```text
dry-run sourcify exact
```

The `import type` line costs nothing in the bundle. The call checks the input as `verify()` does.

## Verify with more than one client

The table chooses only among the backends of the clients you pass. With no key set, this call on
Sepolia goes to Sourcify, as the default entry's would:

```ts [verify.ts]
import { readFile } from "node:fs/promises";

import type { VerifyInput } from "explorer-verify";
import { etherscanV2 } from "explorer-verify/clients/etherscan-v2";
import { sourcify } from "explorer-verify/clients/sourcify";
import { verify } from "explorer-verify/core";
import { routingTable } from "explorer-verify/table";

const text = await readFile("greeter-sepolia.json", "utf8");
const input: VerifyInput = JSON.parse(text);

const result = await verify(input, {
  clients: [sourcify(), etherscanV2()],
  table: routingTable,
});
console.log(result.status, result.backend);
```

```text
already-verified sourcify
```

## Without the table

Leave `table` out to keep the table's rows out of the bundle. Each call then names its backend in
one of two ways:

- `route.backend` set to a backend with one public host: `sourcify`, `etherscan-v2` or
  `blockscout-hosted`.
- `route.apiUrl` set to the server to call.

A call with neither throws `invalid-input` before any request:

```text
The options are invalid: table.
Hint: Add table from explorer-verify/table, or set route.apiUrl.
```

Without the table, no row is read:

- A result has no explorer page from a row. Etherscan's page, for instance, comes from the row.
  Set `route.explorerUrl`, such as `https://sepolia.etherscan.io`, to give the result its page
  without the table ([Routing](routing.md#the-explorer-page)).
- A standalone Etherscan-compatible explorer's row says whether it needs a key. Without it, the
  early `missing-api-key` check does not apply, and the explorer refuses a keyless request itself.
- Requests go only to the hosts of the backends with one public host, or of your `route.apiUrl`.

`checkStatus` without `table` and without `route` takes the handle's backend as `route.backend`
when that backend has one public host. A handle of another backend needs the table or
`route.apiUrl`.

## Errors and handles from their own entries

Take the error class, the error codes, the handle functions and the backend names from these
entries, which reach no dynamic `import()` either:

- `explorer-verify/errors`
- `explorer-verify/handle`
- `explorer-verify/backends`

The same names from `explorer-verify` also work in a one-file bundle. Under esbuild with
`splitting: true`, though, they bring the default entry's shared chunk and its client chunks into
the build.

This call names its backend instead of passing the table, and prints the handle when the job is
still pending:

```ts [pending.ts]
import { readFile } from "node:fs/promises";

import type { VerifyInput } from "explorer-verify";
import { sourcify } from "explorer-verify/clients/sourcify";
import { verify } from "explorer-verify/core";
import { ExplorerVerifyError } from "explorer-verify/errors";
import { formatHandle } from "explorer-verify/handle";

const text = await readFile("greeter-sepolia.json", "utf8");
const input: VerifyInput = JSON.parse(text);

try {
  await verify(input, {
    clients: [sourcify()],
    route: { backend: "sourcify" },
  });
} catch (error) {
  if (error instanceof ExplorerVerifyError && error.code === "not-confirmed") {
    console.log(formatHandle(error.details.handle));
  } else {
    throw error;
  }
}
```

## Options

Each function takes the options of the same function in `explorer-verify`
([verify()](verify.md)), plus these two:

| Option    | Required | Value                                       |
| --------- | -------- | ------------------------------------------- |
| `clients` | Yes      | A non-empty array of clients                |
| `table`   | No       | `routingTable` from `explorer-verify/table` |

- `clients` holds the clients the call may use. The table chooses only among their backends.
  `linkProxy` takes the proxy-link clients; the other four functions take the others.
- `table` is the routing table. Leave it out only as [Without the table](#without-the-table)
  describes.

`explorer-verify` refuses `clients` and `table` as unknown keys, with a hint that points here.

## Clients

Each client is a function that returns a new frozen object with `kind` and `backend` (or
`backends`). Call it where you build the options. Each module exports these clients:

- `explorer-verify/clients/sourcify`: `sourcify()` and `sourcifyProxyLink()`.
- `explorer-verify/clients/etherscan-v2`: `etherscanV2()` and `etherscanV2ProxyLink()`. It also
  brings the constructor argument code and the `handlerUrl` code.
- `explorer-verify/clients/etherscan-compatible`: `etherscanCompatible()` and
  `etherscanCompatibleProxyLink()`. It also brings the constructor argument code.
- `explorer-verify/clients/routescan`: `routescan()`, with the constructor argument code. Routescan
  has no proxy-link client.
- `explorer-verify/clients/blockscout`: `blockscout()`, `blockscoutHosted()` and
  `blockscoutProxyLink()`, with the constructor argument code.

Only Etherscan v2 requests go through your server handler. So `handlerUrl` needs `etherscanV2()` in
`clients`. For `linkProxy`, it needs `etherscanV2ProxyLink()`.

A list built in code, rather than written in the call, takes the type `ClientList<ExplorerClient>`
from `explorer-verify/core`. It is a non-empty list, as `clients` requires:

<!-- no-run: `useEtherscan` stands for a setting of your tool, which the docs test does not define -->

```ts no-run [clients.ts]
import { etherscanV2 } from "explorer-verify/clients/etherscan-v2";
import { sourcify } from "explorer-verify/clients/sourcify";
import type { ClientList, ExplorerClient } from "explorer-verify/core";

declare const useEtherscan: boolean;
const clients: ClientList<ExplorerClient> = useEtherscan
  ? [sourcify(), etherscanV2()]
  : [sourcify()];
```

A client works only with the copy of explorer-verify that made it. A wrapper declares
`explorer-verify` as a peer dependency and builds its clients itself, rather than take them from
its own callers.

## Errors

Each of these throws before any request, with a hint that names the fix. An unknown option key is
named in the same error:

| What the call left out or got wrong                | Error                                    |
| -------------------------------------------------- | ---------------------------------------- |
| `clients`, an empty list, or an entry not a client | `invalid-input` naming `clients[i]`      |
| A client from another copy of explorer-verify      | `invalid-input` naming the entry         |
| A `table` that is not `routingTable`               | `invalid-input` naming `table`           |
| `table`, for a route that needs it                 | `invalid-input` naming `table`           |
| A client for `route.backend`                       | `invalid-input` naming `route.backend`   |
| A client for any backend the chain's row lists     | `unsupported-chain`, naming each backend |
| A client for a handle's backend, in `checkStatus`  | `invalid-input` naming `clients`         |
| The Etherscan v2 client, with `handlerUrl`         | `invalid-input` naming `handlerUrl`      |
| The proxy-link client `linkProxy` routes to        | `invalid-input` naming `clients`         |

A missing or empty `clients` names `clients`; a bad entry names `clients[i]`.

## TypeScript setup

explorer-verify ships ES modules only. Its entries, such as `explorer-verify/core`, are listed in
the `exports` field of `package.json`. These `moduleResolution` settings find their types:

| `moduleResolution`   | Supported | How TypeScript finds the types |
| -------------------- | --------- | ------------------------------ |
| `bundler`            | Yes       | `exports`                      |
| `node16`, `nodenext` | Yes       | `exports`                      |
| `node` (`node10`)    | Yes       | `typesVersions`                |
| `classic`            | No        |                                |

`typesVersions` maps each entry to the same `.d.ts` files. It changes type resolution only: the
package still ships ES modules and no CommonJS build.

Use `bundler`, `node16` or `nodenext`. TypeScript 6.0 deprecates `node10` and reports an error
unless `ignoreDeprecations` is set, and TypeScript 7.0 removes it. A project that still sets
`"moduleResolution": "node"` can switch:

```jsonc [tsconfig.json]
{
  "compilerOptions": {
    // A web project that a bundler builds
    "module": "esnext",
    "moduleResolution": "bundler",
    // A Node.js project: "module": "nodenext" instead
  },
}
```

## Sources

- [microsoft/TypeScript#62200](https://github.com/microsoft/TypeScript/issues/62200), read
  2026-11-10: the deprecation of `node10` in TypeScript 6.0 and its removal in 7.0.
