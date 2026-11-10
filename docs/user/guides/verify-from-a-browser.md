# Verify from a browser

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

For: developers who call `verify()` from a web page, with a bundler or from a CDN.

You need: a web project with a bundler such as Vite, or a page that loads ES modules. No API key.

The page calls the keyless explorers directly and keeps the job's handle across a reload. For a
walk-through that starts with a wallet deployment, follow the tutorial
[Deploy a contract from a dapp and verify it](../tutorials/deploy-and-verify-from-a-dapp.md).

## Install

Add the package to the web project:

```sh
npm install explorer-verify
```

The core package uses only web-platform globals and imports no Node built-in. It is ESM only. Any
bundler that handles ES modules and JSON imports works, such as Vite, Rollup, esbuild or webpack.

## Run a dry run on the sample contract

Save [greeter-sepolia.json](../start/greeter-sepolia.json) next to your module. It is a verify
request for a Greeter contract on Sepolia that Sourcify already holds. A dry run checks the input,
picks the explorer and looks the contract up once. It submits nothing:

```ts [dry-run.ts]
import { dryRun, validateInput } from "explorer-verify";

import greeter from "./greeter-sepolia.json" with { type: "json" };

// validateInput() checks the parsed JSON and returns a typed VerifyInput.
const input = validateInput(greeter);
const plan = await dryRun(input);
console.log(plan.status, plan.backend, plan.apiHost, plan.lookup);
```

It prints:

```text
dry-run sourcify sourcify.dev exact
```

With no key, the routing table picks the first backend of the chain's row that needs none, here
Sourcify. `exact` means Sourcify already holds the contract, so a real run submits nothing new.

## Verify and keep the handle

The module below loads the library with `import()` on first use, so a page that never verifies does
not download it. It saves the handle as soon as the explorer accepts the submission. After a
reload, `resumeOnLoad()` polls the saved job with `checkStatus()`, which never submits:

```ts [verify-button.ts]
import type { VerifyInput } from "explorer-verify";

import greeter from "./greeter-sepolia.json" with { type: "json" };

const PENDING_KEY = "pending-verification";

/** Verifies `input`, loading the library on first use. Returns a line to show the user. */
export async function verifyFromPage(input: VerifyInput): Promise<string> {
  const { ExplorerVerifyError, verify } = await import("explorer-verify");
  try {
    const result = await verify(input, {
      onEvent: (event) => {
        if (event.type === "verify.submitted") {
          // Saved before the first poll, so a reload can resume the job.
          localStorage.setItem(PENDING_KEY, event.handle);
        }
      },
    });
    localStorage.removeItem(PENDING_KEY);
    return result.status === "failed"
      ? `rejected: ${result.reason}`
      : `${result.status} on ${result.backend}`;
  } catch (error) {
    if (error instanceof ExplorerVerifyError && error.code === "not-confirmed") {
      return "still checking: the handle stays saved";
    }
    localStorage.removeItem(PENDING_KEY);
    throw error;
  }
}

/** On page load: polls the saved job with checkStatus(), which never submits. */
export async function resumeOnLoad(): Promise<string | undefined> {
  const handle = localStorage.getItem(PENDING_KEY);
  if (handle === null) {
    return undefined;
  }
  const { checkStatus } = await import("explorer-verify");
  const result = await checkStatus(handle, { timeoutMs: 60_000 });
  localStorage.removeItem(PENDING_KEY);
  return result.status;
}

// Runs the module once. In the page, call verifyFromPage() from your button
// and resumeOnLoad() when the page loads.
const { validateInput } = await import("explorer-verify");
console.log(await verifyFromPage(validateInput(greeter)));
console.log((await resumeOnLoad()) ?? "nothing to resume");
```

For the sample contract, it prints:

```text
already-verified on sourcify
nothing to resume
```

For a contract of your own that Sourcify does not hold yet, the first line is
`verified on sourcify`. When the time budget runs out first, the handle stays in `localStorage`,
and `resumeOnLoad()` finishes the job on the next load:

```text
still checking: the handle stays saved
verified
```

## Keep the handle safe across a reload

The handle holds no key and no URL, so it is safe to store, show or paste into a support request.
`checkStatus()` resolves the route from the handle's chain and the options you pass. Pass it the
same `route`, `fetch` and `handlerUrl` the submit used. A Sourcify handle from `verifyEach()`, on a
chain where `handlerUrl` makes Etherscan the choice, resumes only with
`route: { backend: "sourcify" }`.

A browser tab has no fixed limit on how long a call may run, but the user can close it. Keep the
default budget of 120 seconds (`timeoutMs`) or shorter, and rely on the saved handle for the rest.
[checkStatus()](../reference/check-status.md) describes the handle, and step 5 of the
[tutorial](../tutorials/deploy-and-verify-from-a-dapp.md#step-5-resume-after-a-page-reload) shows a
resume that also handles `not-confirmed`.

## Choose the explorer

Sourcify and Blockscout instances need no key, and Routescan takes one only optionally, so the page
calls them directly:

| Explorer           | How the page reaches it                                                             |
| ------------------ | ----------------------------------------------------------------------------------- |
| Sourcify           | The default on a chain whose row lists it, with no key                              |
| Blockscout         | `route: { backend: "blockscout" }` on a chain whose row lists an instance           |
| Routescan          | `route: { backend: "routescan" }`; it comes last in the rows that list it           |
| Blockscout, hosted | Not from a browser: the hosted API sends no CORS headers                            |
| Etherscan          | Through your [server handler](run-the-server-handler.md), never with a key in pages |

On a chain whose row lists no instance, add `route.apiUrl`.
[Routing](../reference/routing.md#how-a-chain-resolves) shows how a chain resolves.

## Load the library from a CDN

Without a bundler, map the bare name `explorer-verify` to a CDN URL with an import map. Put the map
before any module script that imports the name, and pin the exact version you tested:

```html [index.html]
<script type="importmap">
  {
    "imports": {
      "explorer-verify": "https://esm.sh/explorer-verify@0.1.0"
    }
  }
</script>
<script type="module" src="/src/verify.js"></script>
```

esm.sh builds the npm package as ES modules and rewrites its imports to its own URLs. It keeps each
module of the package as a file of its own. Your module scripts then import `explorer-verify` as
they would with a bundler.

To serve the package's own files instead, copy `node_modules/explorer-verify/dist/src/` to your
site and map `explorer-verify` to its `index.js`. The browser then loads the routing table as a
JSON module, so serve `.json` files as `application/json`.

> [!NOTE]
> The repository's tests do not load either setup. The esm.sh build of 0.1.0 was checked by hand:
> a page with the import map above ran `dryRun()` on the sample in Chromium. The browser smoke test
> runs the library bundled with esbuild in headless Chromium.

## Etherscan from a browser

Never put an Etherscan key in browser code: Etherscan's API terms forbid exposing a key in
client-side applications. Run the [server handler](run-the-server-handler.md) on your server
instead, at `/api/verify` on the page's origin or on a host of its own. The page passes the
handler's URL as `handlerUrl`:

<!-- no-run: it posts to /api/verify on the page's own origin, which a test run does not serve. -->

```ts no-run [verify-etherscan.ts]
import { validateInput, verify } from "explorer-verify";

import greeter from "./greeter-sepolia.json" with { type: "json" };

// Your server runs createVerifyHandler at /api/verify and holds the key.
const input = validateInput(greeter);
const result = await verify(input, { handlerUrl: "/api/verify" });
console.log(`${result.status} on ${result.backend}`);
```

Each Etherscan request goes to the handler with no key, and the handler adds it. With `handlerUrl`
set, the routing table chooses as it does with an Etherscan key: a chain whose row lists Etherscan
first goes to the handler. Without `handlerUrl`, a call routed to Etherscan with no key throws
`missing-api-key` before any request.

A public dapp, or any use by a business, protocol, foundation or DAO, needs an Etherscan Advanced
plan or higher and its own key. It must show "Powered by Etherscan.io APIs" when it displays
Etherscan data. [Etherscan plans and attribution](../explanation/etherscan-plans-and-attribution.md)
explains the rule.

## Errors

The errors a page meets most often:

| Code                                                            | What to do in the page                                               |
| --------------------------------------------------------------- | -------------------------------------------------------------------- |
| [`not-confirmed`](../reference/errors/not-confirmed.md)         | Keep the handle and resume it with `checkStatus()` on a later load   |
| [`network`](../reference/errors/network.md)                     | The explorer did not answer, or the browser blocked the request      |
| [`missing-api-key`](../reference/errors/missing-api-key.md)     | The route needs a key and the page has none. Set `handlerUrl`        |
| [`unsupported-chain`](../reference/errors/unsupported-chain.md) | The routing table has no row for the chain                           |
| [`in-progress`](../reference/errors/in-progress.md)             | Another submission of the contract is being checked. Try again later |

Every error has a `hint` to show the user and a `retryable` flag.
[Errors](../reference/errors/index.md) lists every code.

## Sources

- MDN, [`<script type="importmap">`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/script/type/importmap):
  an import map maps bare names to URLs and must come before the modules that use it. Read on
  2026-11-04 (page modified 2026-10-12).
- MDN, [Import attributes](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/import/with):
  `with { type: "json" }` needs `application/json`; Baseline since April 2025. Read on 2026-11-04
  (page modified 2026-09-11).
- esbuild, [Content types](https://esbuild.github.io/content-types/): the JSON loader is on by
  default for `.json` and accepts `with { type: 'json' }`. Read on 2026-11-04.
- Vite, [Features](https://vite.dev/guide/features): JSON imports and async chunks from dynamic
  imports. v8.3.4, read on 2026-11-04.
- esm.sh, [home page](https://esm.sh/): builds npm packages as ES modules and rewrites their
  imports. Read on 2026-11-04.
- esm.sh, [`explorer-verify@0.1.0`](https://esm.sh/explorer-verify@0.1.0): serves the package, one
  module per source file. Checked on 2026-11-10, with a `dryRun()` in Chromium.
- Etherscan, [API terms](https://etherscan.io/apiterms): no keys in client-side applications. Read
  on 2026-11-04 (page updated 2026-10-01).

## Next steps

- [Bundle size](../advanced/bundle-size.md): what the library adds to a page, by client.
- [Run the server handler](run-the-server-handler.md): verify on Etherscan with the key on your
  server.
- [Deploy a contract from a dapp and verify it](../tutorials/deploy-and-verify-from-a-dapp.md): the
  full flow, from a wallet deployment to a verified contract.
- [verify()](../reference/verify.md): every option, result and error.
