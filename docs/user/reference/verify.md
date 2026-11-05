# verify()

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers and agents who call `verify()` and act on what it returns or throws.

`verify()` checks a contract's source on an explorer and submits it when the explorer does not
have it yet. The routing table sends each chain it lists to Etherscan v2 when you pass an
Etherscan key and the chain is on Etherscan's free tier, and to Sourcify, which needs no key,
otherwise. Routescan is reached with `route.backend` and `route.apiUrl`.
[Routing](routing.md) explains how a chain resolves. Nothing is published to npm yet.

<!-- fragment: the signature only; the example below runs. -->

```ts fragment
function verify(input: VerifyInput, options?: VerifyOptions): Promise<VerifyResult>;
```

The submit is outward and permanent: the explorer publishes the source. Read
[Using explorer-verify from an agent](../guides/using-from-an-agent.md) before you call `verify()`
on someone's behalf.

## Example

```ts
import { ExplorerVerifyError, verify } from "explorer-verify";

try {
  const result = await verify(input, { timeoutMs: 60_000 });
  if (result.status === "failed") {
    console.error(`Rejected: ${result.reason}`);
  } else {
    console.log(`${result.status} (${result.match}) ${result.explorerUrl ?? ""}`);
  }
} catch (error) {
  if (error instanceof ExplorerVerifyError && error.code === "not-confirmed") {
    localStorage.setItem("pending-verification", JSON.stringify(error.details.handle));
  } else {
    throw error;
  }
}
```

When Sourcify already has the contract, the call submits nothing. It prints:

```text
already-verified (exact) https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc
```

Build `input` with `buildVerifyInput` from build files, or write it by hand. See
[Verify a contract shipped in an npm package](../guides/verify-a-contract-from-an-npm-package.md).

## What it does

1. Validates the input with `validateInput`, checks the options and resolves the route. A problem
   throws `invalid-input`, and nothing is sent.
2. Looks the contract up. When the explorer already has an `exact` or `partial` match, it returns
   `already-verified` with that match and submits nothing.
3. When the backend sends constructor arguments and you passed none, derives them from the
   creation code (see [Constructor arguments](#constructor-arguments)). Then submits the source.
   When the explorer answers that the contract is already verified, it returns
   `already-verified`.
4. Waits `pollIntervalMs`, then asks for the job's state, until the job ends or `timeoutMs` is
   spent. A poll that fails with `network`, `rate-limited` or `unexpected-response`, after the
   request's own retries, is logged at `warn`, and polling goes on at the next interval.
5. Maps the job's end to a result or an error (see below).
6. When `timeoutMs` runs out while the job is still pending, or after 3 failed polls in a row, it
   looks the contract up once more. Some explorers finish a job before their status endpoint says
   so. A match returns `verified`; otherwise the call throws `not-confirmed` with the handle.
7. When a poll answers that the explorer no longer knows the job, it looks the contract up once.
   Some explorers drop a job id after it ends. A match returns `verified`. Otherwise the call
   throws `job-not-found` with the handle.

`verify()` uses the address in lower case, as `validateInput` returns it: in the handle, the events
and `explorerUrl`.

A partial match found by the lookup is returned as `already-verified`, without a submit. To turn it
into an exact match, submit the exact sources another way; an option for this is planned.

## Linked libraries

A contract that calls an external library has the library's address in its deployed code. Pass
those addresses in `libraries`, keyed by the library's fully qualified name:

Here `built` is what `buildVerifyInput` returned for `src/Counter.sol:Counter`, which calls the
library `Tally`:

```ts
import { linkLibraries, validateInput, verify } from "explorer-verify";

const input = validateInput({
  chainId: 11155111,
  address: "0x8275D36F64F047D2D8a1F42c79Bf80Caea39D7cC",
  ...built, // from buildVerifyInput
  libraries: { "src/Tally.sol:Tally": "0x5A0b54D5dc17e0AadC383d2db43B0a0D3E029c4c" },
});

// Sends compiler.input unchanged.
const result = await verify(input);
console.log(result.status);

// For an explorer that needs the addresses in the input:
const linked = linkLibraries(input);
console.log(JSON.stringify(linked.compiler.input.settings.libraries));
```

When Sourcify already has the contract, it prints:

```text
already-verified
{"src/Tally.sol":{"Tally":"0x5a0b54d5dc17e0aadc383d2db43b0a0d3e029c4c"}}
```

`validateInput` checks each entry. The key must be `path:Name`, with a path of
`compiler.input.sources` that is not a local path (absolute, home, drive, file URL, or climbing
above the root). The value must be an address. When `settings.libraries` already holds a value for
the same library under its path, that value must be the same address, in any case; any other value
is rejected. Each issue names
`libraries.<position>`, counted from 1 in key order, and never repeats the key. Addresses come
back in lower case.

`verify()` sends `compiler.input` as it is and does not add the addresses. Foundry and Hardhat
compile without the addresses and link afterwards. Solidity's metadata includes
`settings.libraries`, so an input with the addresses added compiles to a different metadata hash
than the deployed code. In a live test on 2026-11-03, with two contracts linked after compiling
([probe E](../../contributor/research/2026-11-03-m2-live-probes.md#e-a-contract-linked-to-an-external-library)):

| Backend   | Input with the addresses | Input without them |
| --------- | ------------------------ | ------------------ |
| Sourcify  | `partial`                | `exact`            |
| Etherscan | exact match              | exact match        |

In that test, Etherscan found the library address itself. Call `linkLibraries(input)` only for an explorer that
needs the addresses in the input. It validates the input, keeps every entry `settings.libraries`
already holds, and returns a new input. It also rejects a value for the same library under the
empty path `""`, which solc applies to every file, unless it is the same address, and a
`settings.libraries` or path entry that is not an object. When the contract was compiled with `settings.libraries`
set, the input already holds the addresses: submit it as it is.

## Options

Every field is optional.

| Option                  | Default              | What it does                                                                                                                                                                           |
| ----------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fetch`                 | `globalThis.fetch`   | Every request goes through it, for logging, retries, tests or a proxy. It must not follow redirects, and it does not turn off the missing-key check                                    |
| `signal`                | none                 | Cancels the call. The call rejects with `signal.reason`, unchanged                                                                                                                     |
| `timeoutMs`             | `120000`             | Time budget for the whole call, every request and retry included                                                                                                                       |
| `pollIntervalMs`        | `3000`               | Wait before each status poll                                                                                                                                                           |
| `logger`                | none, writes nothing | Receives log lines, keys removed. See [Logging and events](logging-and-events.md)                                                                                                      |
| `onEvent`               | none                 | Receives the stage events, keys removed. See [Logging and events](logging-and-events.md#events)                                                                                        |
| `route`                 | the routing table    | `{ backend?, apiUrl?, apiKey? }`: another backend from the chain's row, or another server, such as a self-hosted Sourcify. See [Routing](routing.md#route) and [API keys](api-keys.md) |
| `allowSourcifyFallback` | `false`              | Lets a chain the routing table does not list go to the public Sourcify API. Without it, such a chain throws `unsupported-chain`. See [Routing](routing.md)                             |
| `apiKeys`               | none                 | API keys by backend name, each sent only to its backend's host. See [API keys](api-keys.md)                                                                                            |
| `rpcUrl`                | none                 | A JSON-RPC endpoint of the contract's chain, used only to derive constructor arguments. See [Constructor arguments](#constructor-arguments)                                            |
| `handlerUrl`            | none                 | Your server handler, which adds the Etherscan key. Etherscan requests go there with no key. See [API keys](api-keys.md#a-server-adds-the-key)                                          |

`timeoutMs` and `pollIntervalMs` must be positive numbers of milliseconds; anything else throws
`invalid-input`. A value above 2147483647, the largest delay `setTimeout` takes, is lowered to it.
A `pollIntervalMs` below 1000 is raised to 1000.

`signal` must be an `AbortSignal`, `fetch` and `onEvent` functions, `logger` an object, and
`apiKeys` a plain object of key strings by backend name. Only the
options object's own properties are read, each once. A value of the wrong kind, or a property that
cannot be read, throws `invalid-input` before any request.

The library sends every request with `redirect: "manual"` and never follows a redirect, because a
redirect could carry a key to another host. A `fetch` you pass must keep that behaviour: it must not
follow redirects itself. These answers end the call with `unexpected-response`, without a retry:

- a 3xx status, or an opaque redirect, which a browser returns for `redirect: "manual"`;
- an answer marked `redirected`, which a platform `fetch` sets when it followed a redirect;
- with the default `fetch` only, an answer whose `url` has another origin than the request.

A `fetch` you pass may send a request to another URL on purpose, such as a server handler on the
page's own origin, so the URL of its answer is not checked. The first two checks still apply to it.

The call ends within `timeoutMs` plus `min(pollIntervalMs, 30000)`. The lookups after polling,
in steps 6 and 7 above, get that much more time, so a server that never answers cannot hold the call
longer.

The values of `route.apiUrl`'s query string count as keys: they are removed from every error, log
line, event and result, even when an explorer repeats them in an answer. Only values count, not
parameter names. A value counts only when it is at least 8 characters long, holds a character that
is not a digit, and does not appear in the handle's `ev1:<backend>:<chainId>:<address>` part.
Other values, such as a short token, are not removed from free text. Put a key in a parameter named
like a key, such as `apikey` or `token`: those values are removed whatever their length.

## Results

| `status`           | When                                                                                    | Fields                                       | Exit code |
| ------------------ | --------------------------------------------------------------------------------------- | -------------------------------------------- | --------- |
| `already-verified` | The lookup found the contract verified, or the explorer said so on submit or in the job | `backend`, `match`, `explorerUrl` when known | 0         |
| `verified`         | The job verified the contract, or a lookup after polling found it verified              | `backend`, `match`, `explorerUrl` when known | 0         |
| `failed`           | The explorer definitively rejected the source, for example because the bytecode differs | `backend`, `reason`                          | 1         |

- `match` is `exact` when the metadata hash matches too, and `partial` when everything else does.
- `explorerUrl` is the public page of the contract, such as
  `https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc`. It is absent
  when `route` points at another server.
- `reason` is the explorer's code and message, such as
  `no_match: The deployed and recompiled bytecode don't match.`, with keys removed and cut to 300
  characters.
- When a job reports the contract already verified without the grade, `verify()` looks the grade
  up. If that lookup fails, or says the contract is not verified, it throws `unknown-state`.

`already-verified` can describe a verification this same call caused. A submit can reach the
explorer without the library learning the job id, for example when the connection drops. The
library then looks the contract up before it submits again. If the first submit was accepted and
its job has finished, that lookup finds the contract verified.

## Errors

Every failure throws an `ExplorerVerifyError`. An unknown or ambiguous state is never returned as
a result. [Errors](errors/index.md) links a page with the fix for each code.

| Code                           | When `verify()` throws it                                                                                                                                                       | Exit code |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `invalid-input`                | The input, an option or the route is invalid. Nothing was sent                                                                                                                  | 2         |
| `unsupported-chain`            | The routing table or the explorer does not serve the chain. See [Routing](routing.md#errors)                                                                                    | 2         |
| `timeout`                      | The budget ran out before the explorer accepted the submission. No handle                                                                                                       | 5         |
| `not-confirmed`                | The budget ran out, or 3 polls in a row failed, before the job ended. `details.handle` resumes it                                                                               | 4         |
| `verification-inconclusive`    | The job ended without a verdict. No handle: call `verify()` again later                                                                                                         | 4         |
| `unknown-state`                | The explorer reported a final state the library cannot classify. Has a handle                                                                                                   | 6         |
| `job-not-found`                | The explorer no longer knows the job, and a lookup found the contract not verified, or failed                                                                                   | 6         |
| `in-progress`                  | The explorer is already verifying this contract from another submission                                                                                                         | 5         |
| `network`                      | No request got an answer, retries included                                                                                                                                      | 5         |
| `rate-limited`                 | The explorer answered 429 on every try                                                                                                                                          | 5         |
| `unexpected-response`          | The explorer answered something the library does not recognise                                                                                                                  | 5         |
| `missing-api-key`              | The route's backend needs a key and none is set for its host, or the explorer says it is missing                                                                                | 3         |
| `api-key-rejected`             | The explorer refused the API key                                                                                                                                                | 3         |
| `quota-exceeded`               | The API key's daily limit is spent                                                                                                                                              | 3         |
| `constructor-args-unavailable` | On an Etherscan-style backend, the creation code shows `creationBytecode` is not the deployed build. Nothing was submitted. See [Constructor arguments](#constructor-arguments) | 2         |

A budget that runs out after the explorer accepted the submission always ends in `not-confirmed`,
never `timeout`, so the handle is not lost. The same holds when status polls keep failing.

When that lookup finds the contract not verified, the `job-not-found` hint says to call `verify()`
again. When the lookup fails, the hint says to check the contract on the explorer first, and the
`cause` is the lookup's error. `checkStatus()` handles a forgotten job the same way.

The `cause` of a `not-confirmed` error is the last poll error, or the last lookup's error. Like
every cause, it is a redacted copy: a plain `Error` with the original `name`
(`ExplorerVerifyError`), message and `code`, not an `ExplorerVerifyError` instance. Read
`cause.code` for the error code.

## Dry run

`dryRun(input, options)` runs the steps of `verify()` that send no submission, and says what
`verify()` would do. It takes the same input and options. It validates the input, resolves the
route, looks the contract up once, and stops. It never submits.

```ts
import { dryRun } from "explorer-verify";

const result = await dryRun(input);
console.log(result.status, result.backend, result.apiHost, result.lookup);
```

```text
dry-run sourcify sourcify.dev exact
```

The result is a `DryRunResult`:

- `status`: always `dry-run`.
- `backend`: the backend `verify()` would use.
- `apiHost`: the API host `verify()` would send to, such as `sourcify.dev`, with the port when it
  is not the scheme's default, such as `127.0.0.1:5555`.
- `lookup`: `exact` or `partial` when the explorer holds a match, so `verify()` would return
  `already-verified` without a submit; `none` when it holds none, so `verify()` would submit;
  `skipped` when the backend needs an API key and none is set, so no request was sent.
- `explorerUrl`: the public page of the contract, for a match, when the library knows one.
- `routedBy`: how the backend was chosen. `caller` when `route.backend` named it, `table` when the
  routing table picked it, `fallback` for the Sourcify fallback of a chain without a row, and
  `api-url` when `route.apiUrl` named the server.

A dry run needs no API key. Where `verify()` would throw `missing-api-key`, a dry run sends nothing
and returns `lookup: "skipped"`, whether `fetch` is set or not. With `handlerUrl`, it looks the
contract up through your server handler, which adds the key, and `apiHost` names the handler. It
throws what `verify()` throws before its submit: `invalid-input`, `unsupported-chain`, and the
errors of a failed lookup. It emits `verify.validated`, `verify.routed` and `verify.lookup`, whose
`match` is `skipped` when no request was sent.

The CLI runs it for `explorer-verify verify --dry-run` and prints the result in an envelope with
`ok: true` and exit code 0 ([CLI](cli.md#dry-run)). `toEnvelope()` and `exitCodeOf()` take a
`DryRunResult` too: they give that envelope and exit code 0.

## Several backends in one call

`verifyEach(input, options)` verifies on several backends in one call and returns one outcome per
backend. Use it to verify the same contract on Etherscan and Sourcify, for example. It takes the
options of `verify()` without `route`, plus `backends`.

<!-- no-run: it sends requests to Etherscan, which the recorded answers of the docs test do not cover -->

```ts no-run
import { formatHandle, verifyEach } from "explorer-verify";

const { outcomes } = await verifyEach(input, {
  backends: ["sourcify", "etherscan-v2"],
  apiKeys: { "etherscan-v2": etherscanKey },
  timeoutMs: 120_000,
});
for (const outcome of outcomes) {
  if ("error" in outcome) {
    const { error } = outcome;
    // Checking error.code narrows error.details to that code's data.
    const handle = error.code === "not-confirmed" ? formatHandle(error.details.handle) : "";
    console.log(outcome.backend, error.code, handle);
  } else {
    console.log(outcome.backend, outcome.result.status);
  }
}
```

It prints one line per backend, such as `sourcify verified` and `etherscan-v2 already-verified`.

- `backends` is an array of 1 to 16 entries, or `"all"`. An entry is a backend name, which the
  routing table resolves for the chain, or a route override that names its backend, such as
  `{ backend: "etherscan-compatible", apiUrl, apiKey }` for a standalone explorer. Other fields of
  an entry are ignored, as they are in `route`. A top-level `route` throws `invalid-input`.
- `"all"` stands for every backend the routing table lists for the chain that this version has a
  client for, less a backend that needs a key when none is set in `apiKeys`, as the routing table
  chooses for `verify()`. With `handlerUrl`, `etherscan-v2` counts as keyed, so it stays, and its
  requests go to your server handler ([API keys](api-keys.md#a-server-adds-the-key)).
- Two entries that resolve to the same backend and API URL throw `invalid-input`. The URL is
  compared once normalised, so `"sourcify"` and
  `{ backend: "sourcify", apiUrl: "https://sourcify.dev/server/" }` are the same entry. The same
  backend on two hosts is allowed; the position in `backends` tells the entries apart.
- The backends run at once, with one time budget, `timeoutMs`, shared by all of them, and the
  caller's `signal`. Each runs the steps of `verify()` as described above.
- Each backend gets only its own key: a key from `apiKeys` goes only to its backend's
  routing-table host, and an entry's `apiKey` only to that entry's `apiUrl`
  ([API keys](api-keys.md)). Every key is removed from every outcome, log line and event. A key
  found in the address, or in the handle's fixed part of any backend, throws `invalid-input`
  before any request.
- `outcomes` is in the order of `backends`. An outcome is `{ backend, ok: true, result }` for
  `verified` or `already-verified`, `{ backend, ok: false, result }` for `failed`, or
  `{ backend, ok: false, error }` with the `ExplorerVerifyError`, its `details` and `instanceof`
  intact. `toEnvelope()` writes the error as its `toJSON()`. One backend's error never hides
  another's result.
- A `not-confirmed` outcome keeps its handle in `error.details.handle`. Pass it to
  `checkStatus()`, with that entry's route as `route`, to resume that backend alone.
- A backend the chain's row does not list gives an `unsupported-chain` outcome, a keyed backend
  without a key a `missing-api-key` outcome, and a client module that fails to load, such as a
  chunk the page cannot fetch, a `network` outcome whose `cause` is the load's error. The other
  backends still run.

It throws, and sends nothing, for an input or options that fail validation, and for `"all"` on a
chain the routing table does not list (`unsupported-chain`, unless `allowSourcifyFallback` is
set). An abort rejects with `signal.reason`; the `verify.submitted` event of every submission made
before it was emitted, so each pending job can still be resumed. It emits `verify.validated` once,
then each backend's events, each with its `backend`
([Logging and events](logging-and-events.md#several-backends)).

`exitCodeOf()` and `toEnvelope()` take the result. The exit code is 0 only when every backend
verified. Otherwise it is the first of 6, 4, 3, 2, 5, 1 and 130 that any outcome has, so a job to
resume comes before a key or an input to fix. The code names only the first outcome that has it:
read `outcomes` for every backend ([JSON output](json-output.md#several-backends)). The CLI runs
`verifyEach()` when `--backend` is given more than once ([CLI](cli.md#verify)).

## Abort and resume

An aborted call rejects with `signal.reason`, unchanged, at the next wait or request. It carries no
handle. To resume after an abort, keep the handle from the `verify.submitted` event: `verify()`
emits it, and logs it at `info`, as soon as the explorer accepts the submission.

```ts
import { verify } from "explorer-verify";

const controller = new AbortController();
let handle: string | undefined;
const pending = verify(input, {
  signal: controller.signal,
  onEvent: (event) => {
    if (event.type === "verify.submitted") {
      handle = event.handle; // ev1:sourcify:<chainId>:<address>:<jobId>
    }
  },
});
```

Pass the handle, as an object or in its one-line form, to [checkStatus()](check-status.md) to
continue polling without a new submission.

## Events

`verify()` emits the stage events in this order: `verify.validated`, `verify.routed`,
`verify.lookup`, then `verify.submitted` and one `verify.poll` per pending poll when it submits,
and `verify.result` last. `verify.retry` comes before each retry wait, wherever a request is
retried. A call that throws emits no `verify.result`. `verify.poll` reports only polls that found
the job still pending; the poll that ends the job is reported by `verify.result`. See
[Logging and events](logging-and-events.md#events).

## Constructor arguments

Etherscan v2, Routescan, standalone Etherscan-compatible explorers and Blockscout take the ABI-encoded constructor arguments with the
source; Sourcify reads them from the chain. Pass them as `constructorArgs` when you have them:
they always win, and nothing below runs.

When `constructorArgs` is absent, the route's backend takes constructor arguments,
and the input has `creationBytecode`, `verify()` derives them before the submit. The creation code
is the compiled creation bytecode followed by the arguments, so the arguments are what follows
`creationBytecode` in it.

`creationBytecode` is the compiler's `evm.bytecode.object` for the contract, with or without `0x`.
`buildVerifyInput` fills it when the documents hold it: a build-info with its output, a Foundry
artifact or a Hardhat artifact. It is never sent to an explorer.

`verify()` reads the creation code from the first source that gives it:

1. With the `rpcUrl` option and `creationTxHash`: it checks `eth_chainId`, then reads the
   transaction.
   - A call to the CREATE2 deployer `0x4e59b44847b379578588920cA78FbF26c0B4956C` holds a 32-byte
     salt and then the init code; the init code is the creation code.
   - For a transaction whose `to` is `null` or absent, it reads the receipt. When the receipt's
     `contractAddress` is the contract, the transaction input is the creation code.
   - Any other transaction did not create the contract directly: a factory did, or
     `creationTxHash` names another transaction. Its input is not the creation code.
2. On an Etherscan v2 route with a key bound to the route: Etherscan's `getcontractcreation`. Its
   `creationBytecode` is the contract's own creation code with its arguments, also for a contract a
   factory created. Without a key, as with `handlerUrl`, this request is not sent: a server
   handler does not forward it.

A JSON-RPC request that fails, a result that is not usable, or a transaction that is not found
moves on to the next source. So does a `getcontractcreation` request that fails with `network`,
`rate-limited` or `unexpected-response`. The time budget and the signal cover these requests too.

The creation code must start with `creationBytecode`. Every byte is compared except the 20-byte
library placeholders (`__$`, 34 hex digits, `$__`), where the creation code holds the linked
address. What follows must be a whole number of 32-byte words. Nothing follows for a constructor
without arguments, and the submit then carries none.

When no arguments are derived, `verify()` logs one line with a `reason` field and submits without
arguments, as it did before derivation existed. Etherscan verified such submits in a live test on
2026-11-03, and Blockscout reads the arguments from the chain too.

| `reason`                        | When                                                                                         | Level  |
| ------------------------------- | -------------------------------------------------------------------------------------------- | ------ |
| `no-source`                     | No `rpcUrl` with `creationTxHash`, and no Etherscan key bound to the route                   | `info` |
| `no-creation-code`              | Every source asked gave no usable answer                                                     | `warn` |
| `factory-deployment`            | The transaction did not create the contract directly, and no explorer gave the creation code | `warn` |
| `prefix-mismatch`, `bad-length` | As below, on Blockscout, which reports a partial match for a build that differs              | `warn` |

On Etherscan v2, Routescan and Etherscan-compatible explorers, which refuse a build other than the deployed one, a creation code
that shows the build is wrong throws `constructor-args-unavailable` before any submit.
`details.reason` says why:

| `details.reason`  | When                                                                                                           |
| ----------------- | -------------------------------------------------------------------------------------------------------------- |
| `prefix-mismatch` | The creation code does not start with `creationBytecode`: the input or settings differ from the deployed build |
| `bad-length`      | What follows `creationBytecode` is not a whole number of 32-byte words                                         |

A source comment that differs from the deployed build changes the metadata hash at the end of the
bytecode, and gives `prefix-mismatch`.

`rpcUrl` follows the `route.apiUrl` rules: `https`, or `http` on `localhost`, `127.0.0.1` or
`[::1]`, with no user name, password or fragment. Its path segments and query values of 8 or more
characters count as keys, because providers put keys there: they are removed from every error,
log line and event. The host name is not removed, so never put a key in it. The CLI takes the URL
from `--rpc-url-file` or `--rpc-url-stdin`, or from `--rpc-url` when no part can hold a key; see
[RPC URL](cli.md#rpc-url).

<!-- fragment: it needs a build-info file, an Etherscan key and a live JSON-RPC endpoint. -->

```ts fragment
import { buildVerifyInput, verify } from "explorer-verify";

declare const buildInfo: unknown; // a build-info file with its output, parsed
const built = buildVerifyInput([buildInfo], { contract: "src/ArgsGreeter.sol:ArgsGreeter" });
const result = await verify(
  {
    chainId: 11155111,
    address: "0xc9bbbabe86d85a714bb3f955042277b2dcb3a1b6",
    creationTxHash: "0x38021ccb091a8eab63cc6471e0240805b44c9099426c7904156790f269952af2",
    ...built,
  },
  {
    apiKeys: { "etherscan-v2": process.env.ETHERSCAN_API_KEY },
    rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
  },
);
```

Tested on Ethereum Sepolia on 2026-11-04, with solc 0.8.24: for a contract deployed directly, the
transaction input equalled Etherscan's `creationBytecode`. For a contract created in a factory's
constructor, and for one created through a CREATE2 deployer contract, `getcontractcreation`
returned the contract's own creation code, and the compiled creation bytecode was its prefix.

## Tested live

On 2026-11-03, with Node.js and the public Sourcify server, no key:

- Base Sepolia (chain id 84532), contract `0x616dc0f820416e46841d2e1122ff7ca615a740fe`, deployed in
  transaction `0x916e36a160b0b1cce018905f9cf3634c63c7b339d07d130a123badc5aed181ef`. The first
  `verify()` submitted, got job `c2ecf68c-2f91-436f-8670-3210387bb3ea`, and returned `verified`
  with `exact` after 2.5 s. A second `verify()` returned `already-verified` with `exact` after one
  lookup request, in 65 ms, with no submit.
- Sepolia (chain id 11155111), contract `0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc`, already
  verified: `verify()` returned `already-verified` with `exact` after one GET request.
