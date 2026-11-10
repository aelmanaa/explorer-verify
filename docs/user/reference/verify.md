# verify()

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Check a contract's source on an explorer, and submit it when the explorer
does not have it yet:

<!-- fragment: the signature only; the examples below run. -->

```ts fragment
function verify(
  input: VerifyInput, // the contract, its chain and its compiler input
  options?: VerifyOptions,
): Promise<VerifyResult>;
```

> [!WARNING]
> A submit cannot be undone. Run a [dry run](#dry-run) first.

## Example

This example reads the docs' [sample request](../start/greeter-sepolia.json):

```ts [verify.ts]
import { readFile } from "node:fs/promises";

import { validateInput, verify } from "explorer-verify";

const text = await readFile("greeter-sepolia.json", "utf8");
const input = validateInput(JSON.parse(text));
const result = await verify(input, { timeoutMs: 60_000 });
console.log(result.status, result.backend);
```

Sourcify already holds this Greeter on Sepolia, so the call submits nothing:

```text
already-verified sourcify
```

## Dry run

`dryRun()` says what `verify()` would do, and never submits. This script
submits only when there is no match:

```ts [dry-run.ts]
import { readFile } from "node:fs/promises";

import { dryRun, validateInput, verify } from "explorer-verify";
import type { VerifyOptions } from "explorer-verify";

const text = await readFile("greeter-sepolia.json", "utf8");
const input = validateInput(JSON.parse(text));
const options: VerifyOptions = { timeoutMs: 60_000 };
const plan = await dryRun(input, options);
console.log(plan.status, plan.backend, plan.apiHost, plan.lookup);
if (plan.lookup === "none") await verify(input, options);
```

```text
dry-run sourcify sourcify.dev exact
```

[Dry run results](#dry-run-results) lists every field.

## Options

Every field is optional. A field set to `undefined` counts as absent.

| Option                  | Default            | What it does                                                                 |
| ----------------------- | ------------------ | ---------------------------------------------------------------------------- |
| `fetch`                 | `globalThis.fetch` | Sends every request; must not follow redirects                               |
| `signal`                | none               | Cancels the call, which rejects with `signal.reason`                         |
| `timeoutMs`             | `120000`           | Time budget for the whole call, retries included                             |
| `pollIntervalMs`        | `3000`             | Wait before each status poll, at least 1000                                  |
| `logger`                | none               | Receives [log lines](logging-and-events.md), keys removed                    |
| `onEvent`               | none               | Receives the [stage events](logging-and-events.md#events)                    |
| `route`                 | the routing table  | `{ backend?, apiUrl?, apiKey? }`, see [Routing](routing.md#route)            |
| `allowSourcifyFallback` | `false`            | Sends a chain the table does not list to public Sourcify                     |
| `apiKeys`               | none               | Keys by backend, each sent only to its host: [API keys](api-keys.md)         |
| `rpcUrl`                | none               | JSON-RPC endpoint for [constructor arguments](#constructor-arguments)        |
| `handlerUrl`            | none               | Your [server handler](api-keys.md#a-server-adds-the-key), which adds the key |

[Option checks](#option-checks) lists the values each option accepts.

### Options of each function

Each options type lists only what its function reads. All share
`CallOptions`: every option above except `pollIntervalMs` and `rpcUrl`.

| Function        | Options type         | Besides `CallOptions`                  |
| --------------- | -------------------- | -------------------------------------- |
| `verify()`      | `VerifyOptions`      | `pollIntervalMs`, `rpcUrl`             |
| `dryRun()`      | `DryRunOptions`      | `rpcUrl`, checked but sent no request  |
| `checkStatus()` | `CheckStatusOptions` | `pollIntervalMs`                       |
| `linkProxy()`   | `LinkProxyOptions`   | `pollIntervalMs`                       |
| `verifyEach()`  | `VerifyEachOptions`  | `pollIntervalMs`, `rpcUrl`, `backends` |

At run time each function accepts every key of `VerifyOptions`, so one
object typed `VerifyOptions` can go to all of them, as in the dry run.

## Results

| `status`           | When                                         | Fields                            | Exit code |
| ------------------ | -------------------------------------------- | --------------------------------- | --------- |
| `already-verified` | The explorer had the contract verified       | `backend`, `match`, `explorerUrl` | 0         |
| `verified`         | This call's submission verified the contract | `backend`, `match`, `explorerUrl` | 0         |
| `failed`           | The explorer rejected the source             | `backend`, `reason`               | 1         |

`match` is `exact` or `partial` ([Match types](../explanation/match-types.md)).
`explorerUrl` is absent when `route` points at another server. `reason` is
the explorer's message, keys removed, at most 300 characters.

## Errors

Every failure throws an `ExplorerVerifyError`, never a result. Each code has
a page with its fix in [Errors](errors/index.md).

| Codes                                                                                                                                                                                                                              | What to do                      | Exit code |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | --------- |
| [`invalid-input`](errors/invalid-input.md), [`unsupported-chain`](errors/unsupported-chain.md), [`unsupported-compiler`](errors/unsupported-compiler.md), [`constructor-args-unavailable`](errors/constructor-args-unavailable.md) | Fix the input; nothing was sent | 2         |
| [`missing-api-key`](errors/missing-api-key.md), [`api-key-rejected`](errors/api-key-rejected.md), [`quota-exceeded`](errors/quota-exceeded.md)                                                                                     | Fix the key or the plan         | 3         |
| [`not-confirmed`](errors/not-confirmed.md), [`verification-inconclusive`](errors/verification-inconclusive.md)                                                                                                                     | Resume, or call again later     | 4         |
| [`timeout`](errors/timeout.md), [`in-progress`](errors/in-progress.md), [`network`](errors/network.md), [`rate-limited`](errors/rate-limited.md), [`unexpected-response`](errors/unexpected-response.md)                           | Retry later                     | 5         |
| [`unknown-state`](errors/unknown-state.md), [`job-not-found`](errors/job-not-found.md)                                                                                                                                             | Check the explorer by hand      | 6         |

After the explorer accepts a submission, a spent budget gives
`not-confirmed`, whose `details.handle` resumes the job
([keep the handle](../advanced/abort-and-resume.md#keep-the-handle-of-an-error)).

## What it does

1. Validates the input and options, and resolves the route. A problem throws
   `invalid-input`, and nothing is sent.
2. Looks the contract up. An `exact` or `partial` match returns
   `already-verified`, and nothing is submitted.
3. Derives [constructor arguments](#constructor-arguments) when the backend
   needs them, then submits the source.
4. Polls the job every `pollIntervalMs` until it ends. A failed poll is
   logged at `warn`, and polling goes on.
5. When the budget runs out, 3 polls in a row fail, or the explorer forgets
   the job, it looks the contract up once more. A match returns `verified`;
   otherwise it throws `not-confirmed` or `job-not-found`.

The call ends within `timeoutMs` plus `min(pollIntervalMs, 30000)`. Each
step emits a [stage event](logging-and-events.md#events), and
`verify.result` comes last.

## Dry run results

| Field         | Value                                                                  |
| ------------- | ---------------------------------------------------------------------- |
| `status`      | Always `dry-run`                                                       |
| `backend`     | The backend `verify()` would use                                       |
| `apiHost`     | The host `verify()` would send to, with a port that is not the default |
| `lookup`      | `exact`, `partial`, `none` or `skipped`                                |
| `explorerUrl` | The contract's public page, for a match                                |
| `routedBy`    | `caller`, `table`, `fallback` or `api-url`                             |

A dry run needs no key: where `verify()` would throw `missing-api-key`, it
returns `lookup: "skipped"`. It throws what `verify()` throws before its
submit. The CLI runs it for [`verify --dry-run`](cli.md#dry-run), with exit
code 0.

## Option checks

- `timeoutMs` and `pollIntervalMs` are positive milliseconds, capped at
  2147483647. `timeoutMs` also takes `Infinity`.
- `pollIntervalMs` is finite, and raised to at least 1000.
- `signal` is an `AbortSignal`, and `fetch` and `onEvent` are functions.
- `apiKeys` is a plain object of strings.

A wrong value or an unknown key throws `invalid-input` before any request.
For `{ "timeout": 5 }` the issue reads
`timeout: is not a known option; did you mean timeoutMs?`. The error never
repeats a value.

## Redirects and redaction

Requests never follow a redirect, which could carry a key to another host.
A redirect ends the call with `unexpected-response`. Query values of
`route.apiUrl` of 8 or more characters, and any value of a parameter such
as `apikey` or `token`, are redacted as keys.

## Compiler kinds

| `compiler.kind` | Fields                                         | For                 |
| --------------- | ---------------------------------------------- | ------------------- |
| `solc`          | `version`, `input`                             | the EVM             |
| `zksolc`        | `version`, `solcVersion`, `solcFork?`, `input` | EraVM on ZKsync Era |

For zksolc, `version` is zksolc's, such as `1.5.15`. `solcVersion` is the
full solc version, such as `0.8.24+commit.e11b9ed9`, and `solcFork` ZKsync's
fork revision, such as `1.0.2`. Blockscout verifies zksolc on ZKsync Era
(324) and ZKsync Sepolia (300). Pass `constructorArgs` yourself for zksolc.

A route that does not verify the kind throws
[`unsupported-compiler`](errors/unsupported-compiler.md).

## Linked libraries

A contract that calls an external library holds the library's address in its
deployed code. Pass the addresses in `libraries`, keyed by `path:Name`. This
example builds the input from the Standard JSON input of `src/Counter.sol`,
which calls the library `Tally`:

```ts [linked.ts]
import { readFile } from "node:fs/promises";

import { buildVerifyInput, verify } from "explorer-verify";

const text = await readFile("counter-input.json", "utf8");
const built = buildVerifyInput([JSON.parse(text)], {
  contract: "src/Counter.sol:Counter",
  compilerVersion: "0.8.24+commit.e11b9ed9",
});
// verify() sends compiler.input unchanged.
const result = await verify({
  chainId: 11155111,
  address: "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc",
  ...built,
  libraries: {
    "src/Tally.sol:Tally": "0x5A0b54D5dc17e0AadC383d2db43B0a0D3E029c4c",
  },
});
console.log(result.status);
```

```text
already-verified
```

Foundry and Hardhat link after compiling, so adding the addresses to
`settings.libraries` changes the metadata hash, and Sourcify gives only
`partial`. For an explorer that needs them there, `linkLibraries(input)`
returns a new input with the addresses added.

## Constructor arguments

Etherscan v2, Routescan, Etherscan-compatible explorers and Blockscout take
the ABI-encoded constructor arguments with the source. Sourcify reads them
from the chain. Pass `constructorArgs` when you have them: they always win.

Without them, `verify()` takes what follows `creationBytecode` in the
creation code. It reads that code from the transaction, with `rpcUrl` and
`creationTxHash`, or from Etherscan's `getcontractcreation` with a key on
the route. When nothing is derived, it logs a `reason` and submits without
arguments:

| `reason`                        | When                                                      | Level  |
| ------------------------------- | --------------------------------------------------------- | ------ |
| `no-source`                     | No `rpcUrl` with `creationTxHash`, and no Etherscan key   | `info` |
| `no-creation-code`              | No source gave a usable answer                            | `warn` |
| `factory-deployment`            | A factory deployed it, and no explorer gave the code      | `warn` |
| `prefix-mismatch`, `bad-length` | On Blockscout, which gives a partial match for that build | `warn` |

On the Etherscan-style backends, `prefix-mismatch` and `bad-length` throw
`constructor-args-unavailable` before the submit: the build is not the
deployed one. `rpcUrl` takes `https`, or `http` on a loopback host; see
[RPC URL](cli.md#rpc-url).

## Several backends in one call

`verifyEach()` verifies one contract on several explorers and returns one
outcome per backend. See
[Verify on several explorers](../advanced/verify-on-several-explorers.md).

## Abort and resume

An aborted call rejects with `signal.reason` and carries no handle. Keep the
handle from the `verify.submitted` event, then resume with `checkStatus()`:
[Abort and resume](../advanced/abort-and-resume.md).

## Sources

- Linked libraries, live on 2026-11-03: Sourcify gave `partial` with the
  addresses and `exact` without; Etherscan gave exact for both
  ([probe E](../../contributor/research/2026-11-03-m2-live-probes.md#e-a-contract-linked-to-an-external-library)).
- Constructor arguments, Sepolia, 2026-11-04: `getcontractcreation`
  returned the contract's own creation code, also for a factory deploy.
- Public Sourcify, 2026-11-03: on Base Sepolia, `verify()` verified
  `0x616dc0f820416e46841d2e1122ff7ca615a740fe` in 2.5 s.
