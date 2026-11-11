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

| Option                  | Default            | What it does                                                                                                                             |
| ----------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `fetch`                 | `globalThis.fetch` | Sends every request; must not follow redirects; gets no `cache` field, so it handles caching ([Sourcify](sourcify.md#behaviour-to-know)) |
| `signal`                | none               | Cancels the call, which rejects with `signal.reason`                                                                                     |
| `timeoutMs`             | `120000`           | Time budget for the whole call, retries included                                                                                         |
| `pollIntervalMs`        | `3000`             | Wait before each status poll, at least 1000                                                                                              |
| `indexWaitMs`           | none, 10 submits   | How long to resubmit while the explorer finds no contract code: [Etherscan](etherscan.md#how-answers-are-read)                           |
| `logger`                | none               | Receives [log lines](logging-and-events.md), keys removed                                                                                |
| `onEvent`               | none               | Receives the [stage events](logging-and-events.md#events)                                                                                |
| `route`                 | the routing table  | `{ backend?, apiUrl?, apiKey? }`, see [Routing](routing.md#route)                                                                        |
| `allowSourcifyFallback` | `false`            | Sends a chain the table does not list to public Sourcify                                                                                 |
| `apiKeys`               | none               | Keys by backend, each sent only to its host: [API keys](api-keys.md)                                                                     |
| `rpcUrl`                | none               | JSON-RPC endpoint for [constructor arguments](#constructor-arguments)                                                                    |
| `handlerUrl`            | none               | Your [server handler](api-keys.md#a-server-adds-the-key), which adds the key                                                             |
| `submitOverPartial`     | `false`            | Submits over a [partial match](#submit-over-a-partial-match) of this source                                                              |

[Option checks](#option-checks) lists the values each option accepts.

### Options of each function

Each options type lists only what its function reads. All share
`CallOptions`: every option above except those the table lists for one function.

| Function        | Options type         | Besides `CallOptions`                                                                        |
| --------------- | -------------------- | -------------------------------------------------------------------------------------------- |
| `verify()`      | `VerifyOptions`      | `pollIntervalMs`, `indexWaitMs`, `rpcUrl`, `submitOverPartial`                               |
| `dryRun()`      | `DryRunOptions`      | `rpcUrl`, checked but sent no request                                                        |
| `checkStatus()` | `CheckStatusOptions` | `pollIntervalMs`                                                                             |
| `linkProxy()`   | `LinkProxyOptions`   | `pollIntervalMs`, `resumeJobId` ([guide](../guides/verify-a-proxy.md#resume-a-pending-link)) |
| `verifyEach()`  | `VerifyEachOptions`  | `pollIntervalMs`, `indexWaitMs`, `rpcUrl`, `submitOverPartial`, `backends`                   |

At run time each function accepts every key of `VerifyOptions`, so one
object typed `VerifyOptions` can go to all of them, as in the dry run.

## Results

| `status`           | When                                         | Fields                                              | Exit code |
| ------------------ | -------------------------------------------- | --------------------------------------------------- | --------- |
| `already-verified` | The explorer had the contract verified       | `backend`, `match`, `explorerUrl`, `storedContract` | 0         |
| `verified`         | This call's submission verified the contract | `backend`, `match`, `explorerUrl`                   | 0         |
| `failed`           | The explorer rejected the source             | `backend`, `reason`                                 | 1         |

`match` is `exact` or `partial` ([Match types](../explanation/match-types.md)).
`explorerUrl` is absent when `route` points at another server. `reason` is
the explorer's message, keys removed, at most 300 characters.

`storedContract` is present when the explorer holds another contract's
source for the address. Your source is then not on the explorer, yet the
exit code stays 0 and the envelope says `ok: true`. To require your own
source, check `result.storedContract === undefined`
([Another contract's source](#another-contracts-source)). After a
Sourcify `409`, `storedContract` comes from a lookup that can be up to an hour
old, so it may be out of date ([Sourcify](sourcify.md#behaviour-to-know)).
With `storedContract` present, the CLI's `verify --require-own-source` exits 1, with `ok: false`.

## Errors

Every failure throws an `ExplorerVerifyError`, never a result. Each code has
a page with its fix in [Errors](errors/index.md).

| Codes                                                                                                                                                                                                                              | What to do                      | Exit code |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | --------- |
| [`invalid-input`](errors/invalid-input.md), [`unsupported-chain`](errors/unsupported-chain.md), [`unsupported-compiler`](errors/unsupported-compiler.md), [`constructor-args-unavailable`](errors/constructor-args-unavailable.md) | Fix the input; nothing was sent | 2         |
| [`missing-api-key`](errors/missing-api-key.md), [`api-key-rejected`](errors/api-key-rejected.md), [`quota-exceeded`](errors/quota-exceeded.md)                                                                                     | Fix the key or the plan         | 3         |
| [`not-confirmed`](errors/not-confirmed.md), [`verification-inconclusive`](errors/verification-inconclusive.md), [`not-indexed`](errors/not-indexed.md)                                                                             | Resume, or call again later     | 4         |
| [`timeout`](errors/timeout.md), [`in-progress`](errors/in-progress.md), [`network`](errors/network.md), [`rate-limited`](errors/rate-limited.md), [`unexpected-response`](errors/unexpected-response.md)                           | Retry later                     | 5         |
| [`unknown-state`](errors/unknown-state.md), [`job-not-found`](errors/job-not-found.md)                                                                                                                                             | Check the explorer by hand      | 6         |

After the explorer accepts a submission, a spent budget gives
`not-confirmed`, whose `details.handle` resumes the job
([keep the handle](../advanced/abort-and-resume.md#keep-the-handle-of-an-error)).

## What it does

1. Validates the input and options, and resolves the route. A problem throws
   `invalid-input`, and nothing is sent.
2. Looks the contract up. A match of this source returns
   `already-verified`, and nothing is submitted. Only a partial match with
   [`submitOverPartial`](#submit-over-a-partial-match) set goes on to a
   submit. A match of
   [another contract's source](#another-contracts-source) is logged at
   `info`, and the call goes on.
3. Derives [constructor arguments](#constructor-arguments) when the backend
   needs them, then submits the source.
4. Polls the job every `pollIntervalMs` until it ends. A failed poll is
   logged at `warn`, and polling goes on.
5. When the budget runs out, 3 polls in a row fail, or the explorer forgets
   the job, it looks the contract up once more. A match of this source
   returns `verified`; otherwise it throws `not-confirmed` or
   `job-not-found`.

The call ends within `timeoutMs` plus `min(pollIntervalMs, 30000)`. Each
step emits a [stage event](logging-and-events.md#events), and
`verify.result` comes last.

## Another contract's source

An explorer can hold a match for the address made from another contract's
source. On Ethereum Sepolia on 2026-11-10, Sourcify, Blockscout and
Routescan held such matches within two minutes of a deployment. The lookup
reads the contract name and the compiler version the explorer stores, and
`verify()` compares them with the input:

| Backend                        | Name compared                                                     | Version compared              |
| ------------------------------ | ----------------------------------------------------------------- | ----------------------------- |
| Sourcify                       | `compilation.fullyQualifiedName` with the whole `contractName`    | `compilation.compilerVersion` |
| Etherscan v2, Routescan        | `ContractName` with the part of `contractName` after its last `:` | `CompilerVersion`             |
| Etherscan-compatible explorers | `ContractName`, as for Etherscan, when the answer has it          | `CompilerVersion`             |
| Blockscout                     | `name` with the part of `contractName` after its last `:`         | `compiler_version`            |

| Rule                        | What happens                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| Versions                    | Compared without a leading `v`, in lower case; only the release when one side has no `+commit.` |
| zksolc input                | Its `solcVersion` is compared                                                                   |
| Answer names neither field  | The match counts as this source; an `info` line says the answer names no contract               |
| Either field differs        | `verify()` submits the source                                                                   |
| Explorer refuses the submit | `already-verified`, `partial`, with `storedContract`, and a `warn` line                         |
| Stored text                 | Cut to 300 characters, control characters replaced, your keys removed                           |

No `verify()` path returns `verified` or `exact` for a match whose stored
name or version differs from the input. `verifyEach()` and
`explorer-verify/core` follow the same rule. Sourcify's `409`, an
Etherscan-compatible explorer without `ContractName` and a Sourcify server
that ignores `fields=compilation` give answers that name no contract.

The comparison uses the name and the version only. A partial match of
another source with the same contract name and compiler version counts as
yours. Set [`submitOverPartial`](#submit-over-a-partial-match) to replace
it with your source.

## Submit over a partial match

By default, a `partial` match of this source ends the call as
`already-verified`, and nothing is submitted. With
`submitOverPartial: true`, `verify()` and `verifyEach()` submit the source,
so the explorer can replace the partial match with an exact one. An `exact`
match never submits. A match of another contract's source submits with or
without the option.

| The explorer's answer to the submit                  | Result                                                                  |
| ---------------------------------------------------- | ----------------------------------------------------------------------- |
| It verifies the source                               | `verified`, with the job's match                                        |
| The contract is already verified                     | `already-verified`, with the match a lookup reads                       |
| It rejects the source                                | `already-verified`, `partial`, from the first lookup, and a `warn` line |
| It rejects the source, and its lookup finds no match | `failed`, and a `warn` line                                             |

When the explorer rejects the source, the partial match stays, so the
result is `already-verified`. Etherscan, Routescan and the
Etherscan-compatible explorers look the contract up after a rejection. When
that newer lookup finds no match, the result is `failed`. Each `warn` line
gives the explorer's reason.

After the submit, a lookup that finds only the `partial` match does not
confirm the job. When the time budget runs out, or 3 polls in a row fail,
the call throws `not-confirmed`. When the explorer forgets the job, it
throws `job-not-found`. On Routescan, whose matches are all `partial`, a
forgotten job therefore always ends with `job-not-found`.

The handle of such a job ends with `:over-partial`, and its object has
`overPartial: true`. [checkStatus()](check-status.md#a-submit-over-a-partial-match)
ends it by the same rules. `dryRun()` with `submitOverPartial: true` says
that `verify()` would submit over the partial match; without it, that
`verify()` would not. The CLI flag is [`--submit-over-partial`](cli.md).

What each explorer did on Ethereum Sepolia on 2026-11-11
([research](../../contributor/research/2026-11-11-submit-over-partial.md)):

| Explorer   | The exact source over its partial match                                              | The partial source again                                             |
| ---------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Sourcify   | The match became `exact_match`: `verified`, `exact`                                  | The job ended with `already_verified`: `already-verified`, `partial` |
| Blockscout | The lookup then gave `is_fully_verified`: `verified`, `exact`                        | `Fail - Unable to verify`: `already-verified`, `partial`             |
| Routescan  | `Pass - Verified`, and the stored source became the exact one: `verified`, `partial` | Not sent                                                             |

- Routescan states no grade, so every Routescan match is `partial`, and the
  option submits over every match there. Routescan replaces the source it
  holds on a resubmit, so a build that differs only in its metadata can
  replace an exact source with a partial one.
- Sourcify's lookup answer can be cached for up to an hour. A call soon
  after an upgrade can still read `partial` and submit again. Sourcify then
  answers `409`, and the result is `already-verified`, `exact`.
- Etherscan's Similar Match is `partial`; the research note records
  Etherscan's answer to a submit over it.

## Dry run results

| Field            | Value                                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `status`         | Always `dry-run`                                                                                                        |
| `backend`        | The backend `verify()` would use                                                                                        |
| `apiHost`        | The host `verify()` would send to, with a port that is not the default                                                  |
| `lookup`         | `exact`, `partial`, `none` or `skipped`                                                                                 |
| `explorerUrl`    | The contract's public page, for a match                                                                                 |
| `routedBy`       | `caller`, `table`, `fallback` or `api-url`                                                                              |
| `storedContract` | The other contract's `name` and `compilerVersion`, when the match is another contract's source: `verify()` would submit |

A Sourcify `lookup` can be up to an hour old: see
[Sourcify](sourcify.md#behaviour-to-know).

A dry run needs no key: where `verify()` would throw `missing-api-key`, it
returns `lookup: "skipped"`. It throws what `verify()` throws before its
submit. The CLI runs it for [`verify --dry-run`](cli.md#dry-run), with exit
code 0.

## Option checks

- `timeoutMs`, `pollIntervalMs` and `indexWaitMs` are positive milliseconds,
  capped at 2147483647. `timeoutMs` and `indexWaitMs` also take `Infinity`.
  `indexWaitMs` never extends `timeoutMs`.
- `pollIntervalMs` is finite, and raised to at least 1000.
- `signal` is an `AbortSignal`, and `fetch` and `onEvent` are functions.
- `apiKeys` is a plain object of strings.
- `allowSourcifyFallback` and `submitOverPartial` are booleans.

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
- Matches from another contract's source, Ethereum Sepolia, 2026-11-10:
  Sourcify, Blockscout and Routescan stored them 56 to 94 s after each
  deployment ([research](../../contributor/research/2026-11-10-foreign-matches.md),
  [decision 0063](../../contributor/decisions/0063-submit-over-another-contracts-match.md)).
- Submits over a partial match, Ethereum Sepolia, 2026-11-11: Sourcify and
  Blockscout upgraded their partial matches to exact, and Routescan replaced
  its stored source ([research](../../contributor/research/2026-11-11-submit-over-partial.md),
  [decision 0067](../../contributor/decisions/0067-submit-over-a-partial-match.md)).
- Public Sourcify, 2026-11-03: on Base Sepolia, `verify()` verified
  `0x616dc0f820416e46841d2e1122ff7ca615a740fe` in 2.5 s.
