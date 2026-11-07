# Core entry

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers who bundle explorer-verify into one file, such as a wrapper SDK, a Cloudflare
Worker or a CommonJS build, and want only the explorer clients they use in it.

`explorer-verify/core` exports `verify`, `dryRun`, `checkStatus`, `verifyEach` and `linkProxy`.
They run the same steps as the functions of `explorer-verify` and give the same results and errors
for the same explorer answers. The difference is where the explorer clients and the routing table
come from: the default entry loads them with a dynamic `import()` when a call needs them; the core
takes them from your options, and no module behind it holds a dynamic `import()`. A bundle that
does not split code then holds only the clients you import, and the rows only if you import the
table. [Ship only the clients your tool uses](../guides/wrap-explorer-verify-in-your-tool.md#ship-only-the-clients-your-tool-uses)
shows when to choose it.

```ts
import { etherscanV2 } from "explorer-verify/clients/etherscan-v2";
import { sourcify } from "explorer-verify/clients/sourcify";
import { verify } from "explorer-verify/core";
import { routingTable } from "explorer-verify/table";

const result = await verify(input, {
  clients: [sourcify(), etherscanV2()],
  table: routingTable,
});
console.log(result.status, result.backend);
```

Take the error class, the error codes, the handle functions and the backend names from
`explorer-verify/errors`, `explorer-verify/handle` and `explorer-verify/backends`. Like the core,
these entries reach no dynamic `import()`. The same names from `explorer-verify` also work in a
one-file bundle, but under esbuild with `splitting: true` they bring the default entry's shared
chunk and its client chunks into the build.

```ts
import { sourcify } from "explorer-verify/clients/sourcify";
import { verify } from "explorer-verify/core";
import { ExplorerVerifyError } from "explorer-verify/errors";
import { formatHandle } from "explorer-verify/handle";

try {
  await verify(input, { clients: [sourcify()], route: { backend: "sourcify" } });
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
([verify()](verify.md)), plus:

| Option    | Type                                        | What it does                                                                                                                                                                        |
| --------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clients` | a non-empty array of clients, required      | The clients the call may use. The routing table chooses only among their backends. `linkProxy` takes the proxy-link clients; the other four take the others.                        |
| `table`   | `routingTable` from `explorer-verify/table` | The routing table. Leave it out when every call sets `route.apiUrl`, or names a backend with one public host in `route.backend`: `sourcify`, `etherscan-v2` or `blockscout-hosted`. |

Without `table`, no row is read. A result then has no explorer page from a row: Etherscan's page,
for instance, comes from the row. A standalone Etherscan-compatible explorer's row says whether it
needs a key, so without the table that early `missing-api-key` check does not apply, and the
explorer refuses a keyless request itself. Requests go only to the hosts of the table you pass, of
the backends with one public host, or of your `route.apiUrl`.

`checkStatus` without `table` and without `route` takes the handle's backend as `route.backend`
when that backend has one public host: `sourcify`, `etherscan-v2` or `blockscout-hosted`. A handle
of another backend needs the table or `route.apiUrl`.

## Clients

Each client is a function that returns a new frozen object with `kind` and `backend` (or
`backends`). Call it where you build the options. A list built in code, rather than written
in the call, takes the type `ClientList<ExplorerClient>`, which `explorer-verify/core` exports: a
non-empty list, as `clients` requires.

<!-- no-run: `useEtherscan` stands for a setting of your tool, which the docs test does not define -->

```ts no-run
import { etherscanV2 } from "explorer-verify/clients/etherscan-v2";
import { sourcify } from "explorer-verify/clients/sourcify";
import type { ClientList, ExplorerClient } from "explorer-verify/core";

declare const useEtherscan: boolean;
const clients: ClientList<ExplorerClient> = useEtherscan
  ? [sourcify(), etherscanV2()]
  : [sourcify()];
```

| Module                                         | Clients                                                       | Brings                                               |
| ---------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------- |
| `explorer-verify/clients/sourcify`             | `sourcify()`, `sourcifyProxyLink()`                           | Nothing else                                         |
| `explorer-verify/clients/etherscan-v2`         | `etherscanV2()`, `etherscanV2ProxyLink()`                     | The constructor argument code; the `handlerUrl` code |
| `explorer-verify/clients/etherscan-compatible` | `etherscanCompatible()`, `etherscanCompatibleProxyLink()`     | The constructor argument code                        |
| `explorer-verify/clients/routescan`            | `routescan()`                                                 | The constructor argument code                        |
| `explorer-verify/clients/blockscout`           | `blockscout()`, `blockscoutHosted()`, `blockscoutProxyLink()` | The constructor argument code                        |

`handlerUrl` needs `etherscanV2()` in `clients`, or `etherscanV2ProxyLink()` for `linkProxy`, since only Etherscan v2 requests go through your
server handler. Routescan has no proxy-link client.

A client works only with the copy of explorer-verify that made it. A wrapper declares
`explorer-verify` as a peer dependency and builds its clients itself, rather than take them from
its own callers.

## Errors

Each of these throws before any request, with a hint that names the fix.

| What the call left out                                                          | Error                                                   |
| ------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `clients`, an empty list, or an entry that is not a client                      | `invalid-input` naming `clients` or `clients[i]`        |
| A client from another copy of explorer-verify                                   | `invalid-input` naming the entry                        |
| A `table` that is not `routingTable`                                            | `invalid-input` naming `table`                          |
| A client for `route.backend`                                                    | `invalid-input` naming `route.backend`                  |
| A client for any backend the chain's row lists                                  | `unsupported-chain`, naming every backend the row lists |
| A client for the backend a handle names, in `checkStatus`                       | `invalid-input` naming `clients`                        |
| `table`, for a route that needs it                                              | `invalid-input` naming `table`                          |
| `etherscanV2()`, or `etherscanV2ProxyLink()` for `linkProxy`, with `handlerUrl` | `invalid-input` naming `handlerUrl`                     |
| The proxy-link client of the backend `linkProxy` routes to                      | `invalid-input` naming `clients`                        |

An unknown option key is named in the same error as these. `explorer-verify` refuses `clients` and
`table` as unknown keys, with a hint that points here.
