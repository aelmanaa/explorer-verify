# Wrap explorer-verify behind your tool's API

Version: explorer-verify 0.4.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Call explorer-verify inside the functions your tool already has. The examples change the body of
`deployKit.verifyContract()` in a made-up tool; its callers change nothing.

For: authors of a deploy framework, a dashboard or an SDK that already verifies contracts.

You need: Node.js 22.18 or later, or any runtime with `fetch`. For a five-minute version, start
with the [SDK wrapper quickstart](../start/quickstart-sdk-wrapper.md).

## Install

Install the core package, which runs in a browser, a backend or a CLI. Download the sample
request, a Greeter contract on Sepolia that Sourcify already holds:

```sh
npm install explorer-verify
repo=https://raw.githubusercontent.com/aelmanaa/explorer-verify/main
curl -O "$repo/docs/user/start/greeter-sepolia.json"
```

## Start with a dry run

Give your tool a function that says what a verify call would do. `dryRun()` checks the input,
picks the explorer and looks the contract up once. It never submits and needs no key:

```ts [plan.ts]
import { readFile } from "node:fs/promises";

import { dryRun } from "explorer-verify";
import type { VerifyInput } from "explorer-verify";

/** deployKit's new function: what verifyContract() would do. */
export async function planVerification(input: VerifyInput): Promise<string> {
  const plan = await dryRun(input);
  return `${plan.status} on ${plan.backend}: lookup ${plan.lookup}`;
}

const json = await readFile("greeter-sepolia.json", "utf8");
const sample: VerifyInput = JSON.parse(json);
console.log(await planVerification(sample));
```

Run it:

```sh
node plan.ts
```

```text
dry-run on sourcify: lookup exact
```

| `lookup`  | What a verify call would do                              |
| --------- | -------------------------------------------------------- |
| `exact`   | Nothing to submit: the explorer holds the contract       |
| `partial` | Nothing to submit: the explorer holds a partial match    |
| `none`    | Submit the source, which the explorer publishes for good |
| `skipped` | Fail with `missing-api-key`: the backend needs a key     |

## Write the wrapper

Your public functions keep their signatures. Only their bodies change, and four functions do the
mapping:

1. `toInput` maps the tool's parameters onto a `VerifyInput`.
2. `toOptions` maps the tool's settings onto `VerifyOptions`.
3. `toReport` maps a `VerifyResult` onto the tool's report.
4. `toDeployKitError` maps an error onto the tool's error class.

At the core of `verifyContract`, the wrapper keeps the handle that `onSubmitted` receives, because
an abort rejects with `signal.reason`, which carries no handle:

<!-- fragment: an excerpt of deploykit.ts below, which runs in full. -->

```ts fragment
let handle: string | undefined;
const onSubmitted = (line: string): void => {
  handle = line;
};
try {
  const options = { ...toOptions(settings), onSubmitted };
  return toReport(await verify(toInput(params), options));
} catch (error) {
  throw toDeployKitError(error, settings.signal, handle);
}
```

`KIND` in the module gives every error code a kind. Its type is `Record<ErrorCode, …>`, so your
tool stops compiling when a release adds a code. The module ends with a dry run, then two verify
calls: one with a two-minute deadline, one cancelled once the explorer accepts the submission.

<details>
<summary>The whole module, deploykit.ts (about 240 lines)</summary>

Copy it, then replace deployKit's types with your tool's:

```ts [deploykit.ts]
import { readFile } from "node:fs/promises";

import {
  ExplorerVerifyError,
  checkStatus,
  dryRun,
  verify,
} from "explorer-verify";
import type {
  ErrorCode,
  Hex,
  SolidityStandardJsonInput,
  VerifyInput,
  VerifyOptions,
  VerifyResult,
} from "explorer-verify";

// deployKit's public types. They do not change.
export interface VerifyContractParams {
  chainId: number;
  address: Hex;
  /** Fully qualified name, as `src/Greeter.sol:Greeter`. */
  contract: string;
  /** Full solc version, as `0.8.24+commit.e11b9ed9`. */
  compilerVersion: string;
  standardJsonInput: SolidityStandardJsonInput;
  constructorArgs?: Hex;
}

export interface VerifyContractSettings {
  etherscanApiKey?: string;
  /** Seconds to wait for a verdict. Unset: the longest budget. */
  waitTimeoutSeconds?: number;
  signal?: AbortSignal;
  /** Called with the resume token when the explorer accepts. */
  onSubmitted?: (resumeToken: string) => void;
}

export interface VerifyReport {
  status: "success" | "already-verified" | "failed";
  explorer: string;
  match?: "exact" | "partial";
  url?: string;
  message?: string;
}

export type DeployKitErrorKind =
  | "config"
  | "auth"
  | "pending"
  | "unavailable"
  | "needs-review"
  | "cancelled"
  | "bug";

export class DeployKitError extends Error {
  readonly kind: DeployKitErrorKind;
  /** Pass it to resumeVerification() to poll without a new submit. */
  readonly resumeToken: string | undefined;

  constructor(
    kind: DeployKitErrorKind,
    message: string,
    resumeToken: string | undefined,
    cause: unknown,
  ) {
    super(message, { cause });
    this.name = "DeployKitError";
    this.kind = kind;
    this.resumeToken = resumeToken;
  }
}

// The mapping.
const KIND: Readonly<Record<ErrorCode, DeployKitErrorKind>> = {
  "invalid-input": "config",
  "not-confirmed": "pending",
  "unsupported-chain": "config",
  network: "unavailable",
  "rate-limited": "unavailable",
  timeout: "unavailable",
  "unexpected-response": "unavailable",
  "in-progress": "unavailable",
  "unknown-state": "needs-review",
  "job-not-found": "needs-review",
  cancelled: "cancelled",
  "incomplete-input": "config",
  "insufficient-artifact": "config",
  "unsupported-compiler": "config",
  "verification-inconclusive": "unavailable",
  "source-mismatch": "config",
  "missing-api-key": "auth",
  "api-key-rejected": "auth",
  "quota-exceeded": "auth",
  "internal-error": "bug",
  "no-metadata-hash": "config",
  "metadata-unavailable": "unavailable",
  "constructor-args-unavailable": "config",
  "proxy-link-pending": "pending",
  "proxy-link-unknown-state": "needs-review",
  "handler-refused": "config",
  "not-indexed": "unavailable",
};

function toInput(params: VerifyContractParams): VerifyInput {
  const args = params.constructorArgs;
  return {
    chainId: params.chainId,
    address: params.address,
    contractName: params.contract,
    compiler: {
      kind: "solc",
      version: params.compilerVersion,
      input: params.standardJsonInput,
    },
    ...(args === undefined ? {} : { constructorArgs: args }),
  };
}

function toOptions(settings: VerifyContractSettings): VerifyOptions {
  const seconds = settings.waitTimeoutSeconds;
  return {
    apiKeys: { "etherscan-v2": settings.etherscanApiKey },
    // Infinity is lowered to the longest budget, about 24.8 days.
    timeoutMs: seconds === undefined ? Infinity : seconds * 1000,
    ...(settings.signal === undefined ? {} : { signal: settings.signal }),
  };
}

function toReport(result: VerifyResult): VerifyReport {
  const explorer = result.backend;
  if (result.status === "failed") {
    return { status: "failed", explorer, message: result.reason };
  }
  // A partial match counts as success; the report says which match.
  return {
    status: result.status === "verified" ? "success" : "already-verified",
    explorer,
    match: result.match,
    ...(result.explorerUrl === undefined ? {} : { url: result.explorerUrl }),
  };
}

function toDeployKitError(
  error: unknown,
  signal: AbortSignal | undefined,
  handle: string | undefined,
): unknown {
  // An abort rejects with signal.reason: no ExplorerVerifyError, no handle.
  if (signal?.aborted === true && error === signal.reason) {
    return new DeployKitError("cancelled", "Cancelled.", handle, error);
  }
  if (!(error instanceof ExplorerVerifyError)) {
    return error;
  }
  const token = error.toJSON().handle ?? handle;
  const message = `${error.message} ${error.hint}`;
  return new DeployKitError(KIND[error.code], message, token, error);
}

// deployKit's public functions. Same signatures, new bodies.
async function planVerification(params: VerifyContractParams) {
  return await dryRun(toInput(params));
}

async function verifyContract(
  params: VerifyContractParams,
  settings: VerifyContractSettings = {},
): Promise<VerifyReport> {
  let handle: string | undefined;
  const onSubmitted = (line: string): void => {
    handle = line;
    settings.onSubmitted?.(line);
  };
  try {
    const options = { ...toOptions(settings), onSubmitted };
    return toReport(await verify(toInput(params), options));
  } catch (error) {
    throw toDeployKitError(error, settings.signal, handle);
  }
}

/** Polls a submitted job again; never submits. Route to the same backend. */
async function resumeVerification(
  resumeToken: string,
  settings: VerifyContractSettings = {},
): Promise<VerifyReport> {
  try {
    return toReport(await checkStatus(resumeToken, toOptions(settings)));
  } catch (error) {
    throw toDeployKitError(error, settings.signal, resumeToken);
  }
}

export const deployKit = {
  planVerification,
  verifyContract,
  resumeVerification,
};

// The sample, as deployKit's parameters.
const json = await readFile("greeter-sepolia.json", "utf8");
const sample: VerifyInput = JSON.parse(json);
const params: VerifyContractParams = {
  chainId: sample.chainId,
  address: sample.address,
  contract: sample.contractName,
  compilerVersion: sample.compiler.version,
  standardJsonInput: sample.compiler.input,
};

/** Verifies; resumes once when the call ends without a verdict. */
async function verifyAndResume(settings: VerifyContractSettings) {
  let report: VerifyReport;
  try {
    report = await deployKit.verifyContract(params, settings);
  } catch (error) {
    if (
      !(error instanceof DeployKitError) ||
      (error.kind !== "pending" && error.kind !== "cancelled") ||
      error.resumeToken === undefined
    ) {
      throw error;
    }
    console.log(`${error.kind}, resume with ${error.resumeToken}`);
    report = await deployKit.resumeVerification(error.resumeToken, {
      waitTimeoutSeconds: 120,
    });
  }
  const match = report.match ?? "no match";
  console.log(`${report.status} (${match}) on ${report.explorer}`);
}

// First the dry run, then a two-minute deadline.
const plan = await deployKit.planVerification(params);
console.log(`${plan.status} on ${plan.backend}: lookup ${plan.lookup}`);
await verifyAndResume({ waitTimeoutSeconds: 120 });

// A user who cancels as soon as the explorer accepts the submission.
const controller = new AbortController();
await verifyAndResume({
  waitTimeoutSeconds: 120,
  signal: controller.signal,
  onSubmitted: () => controller.abort(),
});
```

</details>

With no Etherscan key, the routing table sends Sepolia to Sourcify, which already holds the
sample:

```text
dry-run on sourcify: lookup exact
already-verified (exact) on sourcify
already-verified (exact) on sourcify
```

On a contract Sourcify lacks, the dry run says `lookup none` and both calls submit. The second
prints `cancelled, resume with ev1:sourcify:…` and resumes the same job. When a deadline runs out,
`verifyContract` throws a `pending` error with the token. [Resume from a job
queue](../advanced/resume-from-a-job-queue.md) polls it later.

## Map the settings onto VerifyOptions

| deployKit setting    | `VerifyOptions` field     | Notes                                                                                                |
| -------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------- |
| `etherscanApiKey`    | `apiKeys["etherscan-v2"]` | Sent only to Etherscan's host. Without it, Sourcify                                                  |
| `waitTimeoutSeconds` | `timeoutMs`               | The budget for the whole call, polls included                                                        |
| `signal`             | `signal`                  | An abort rejects with `signal.reason` unchanged                                                      |
| `onSubmitted`        | `onSubmitted`             | Gets the one-line handle once the explorer accepts, before the first poll                            |
| A `fetch`            | `fetch`                   | Every request goes through it. It must not redirect. It gets no `cache` field, so it handles caching |
| A fixed explorer     | `route`                   | See [Routing](../reference/routing.md#route)                                                         |
| A logger             | `logger`, `onEvent`       | See [Logging](../reference/logging-and-events.md)                                                    |
| A server with a key  | `handlerUrl`              | See [Server handler](run-the-server-handler.md)                                                      |

The library never reads `process.env`: read keys in your tool and pass them in `apiKeys`. In a
browser, use `handlerUrl` instead; Etherscan's terms forbid its key in browser code. Type one
options object for `verify()` and `dryRun()` as `VerifyOptions`
([why](../reference/verify.md#options-of-each-function)).

explorer-verify sets no `User-Agent` and reads no proxy variable. To keep your tool's
`User-Agent` or its `HTTPS_PROXY` support, pass a `fetch` that adds them, as in
[Set the User-Agent and send requests through a proxy](verify-from-node.md#set-the-user-agent-and-send-requests-through-a-proxy).

## Behaviour that changes

`verify()` may act differently from your tool's old code. Keep the old behaviour as the default
where you can:

| What `verify()` does                                               | What to do in the wrapper                                       |
| ------------------------------------------------------------------ | --------------------------------------------------------------- |
| Stops after its budget, 2 minutes by default, with `not-confirmed` | Map it to a pending result you can resume; offer `signal`       |
| Looks the contract up first; returns `already-verified`            | Map it onto your own result for that case                       |
| Picks the backend from the routing table                           | Pass `route`, or `allowSourcifyFallback: true` for other chains |
| Derives constructor arguments from `creationBytecode`              | Pass `constructorArgs`, `0x` for none, to skip it               |
| Retries a request up to 5 times; never resends a submit            | Remove your own retry loop                                      |
| Returns `failed`, and throws every other outcome                   | Map both, as the next sections show                             |
| Never follows a redirect                                           | Make sure your own `fetch` does not either                      |

The largest budget is about 24.8 days. [Constructor arguments](../reference/verify.md#constructor-arguments)
says when a derived argument throws `constructor-args-unavailable`.

## Map the results

A result's `status` is `verified`, `already-verified` or `failed`. `toReport` maps each onto
deployKit's own. `failed` carries the explorer's `reason`. The other two carry `match`, which
is `partial` when the explorer matched the code but not the metadata hash. Decide whether a partial
match counts as success, and say so in your docs ([Match types](../explanation/match-types.md)).

## Map the errors

Every failure but an abort is an `ExplorerVerifyError`. Switch on `error.code`, never on the
message. `error.hint` says what to do next, and `error.toJSON().handle` holds the handle when the
code carries one.

After `not-confirmed`, or a cancel with a saved handle, call `checkStatus()`, which never submits.
After `timeout`, `network` or `verification-inconclusive`, a new `verify()` is safe: it looks the
contract up first. The kind column is the example's `KIND`:

| Code                                                                                  | Retryable | Exit code | deployKit kind |
| ------------------------------------------------------------------------------------- | --------- | --------- | -------------- |
| [`invalid-input`](../reference/errors/invalid-input.md)                               | no        | 2         | `config`       |
| [`not-confirmed`](../reference/errors/not-confirmed.md)                               | yes       | 4         | `pending`      |
| [`unsupported-chain`](../reference/errors/unsupported-chain.md)                       | no        | 2         | `config`       |
| [`network`](../reference/errors/network.md)                                           | yes       | 5         | `unavailable`  |
| [`rate-limited`](../reference/errors/rate-limited.md)                                 | yes       | 5         | `unavailable`  |
| [`timeout`](../reference/errors/timeout.md)                                           | yes       | 5         | `unavailable`  |
| [`unexpected-response`](../reference/errors/unexpected-response.md)                   | yes       | 5         | `unavailable`  |
| [`in-progress`](../reference/errors/in-progress.md)                                   | yes       | 5         | `unavailable`  |
| [`unknown-state`](../reference/errors/unknown-state.md)                               | no        | 6         | `needs-review` |
| [`job-not-found`](../reference/errors/job-not-found.md)                               | no        | 6         | `needs-review` |
| [`cancelled`](../reference/errors/cancelled.md)                                       | no        | 130       | `cancelled`    |
| [`incomplete-input`](../reference/errors/incomplete-input.md)                         | no        | 2         | `config`       |
| [`insufficient-artifact`](../reference/errors/insufficient-artifact.md)               | no        | 2         | `config`       |
| [`unsupported-compiler`](../reference/errors/unsupported-compiler.md)                 | no        | 2         | `config`       |
| [`verification-inconclusive`](../reference/errors/verification-inconclusive.md)       | yes       | 4         | `unavailable`  |
| [`source-mismatch`](../reference/errors/source-mismatch.md)                           | no        | 2         | `config`       |
| [`missing-api-key`](../reference/errors/missing-api-key.md)                           | no        | 3         | `auth`         |
| [`api-key-rejected`](../reference/errors/api-key-rejected.md)                         | no        | 3         | `auth`         |
| [`quota-exceeded`](../reference/errors/quota-exceeded.md)                             | no        | 3         | `auth`         |
| [`internal-error`](../reference/errors/internal-error.md)                             | no        | 6         | `bug`          |
| [`no-metadata-hash`](../reference/errors/no-metadata-hash.md)                         | no        | 2         | `config`       |
| [`metadata-unavailable`](../reference/errors/metadata-unavailable.md)                 | yes       | 5         | `unavailable`  |
| [`constructor-args-unavailable`](../reference/errors/constructor-args-unavailable.md) | no        | 2         | `config`       |
| [`proxy-link-pending`](../reference/errors/proxy-link-pending.md)                     | yes       | 4         | `pending`      |
| [`proxy-link-unknown-state`](../reference/errors/proxy-link-unknown-state.md)         | no        | 6         | `needs-review` |
| [`handler-refused`](../reference/errors/handler-refused.md)                           | no        | 2         | `config`       |
| [`not-indexed`](../reference/errors/not-indexed.md)                                   | yes       | 4         | `unavailable`  |

A test checks this table against the library. A CLI takes the exit code from `ERROR_EXIT_CODES` in
`explorer-verify/envelope`.

## Show errors to your users

`error.hint` and `error.message` are for the developer who calls explorer-verify. They can name a
function, an option or a field, such as `checkStatus` or `chainId`. The people who use your tool,
in an IDE, a dapp or a verification receipt, cannot act on those names.

Show them `hintFor(error, "user")` instead. It names no function, option, field or command. It
reads the error's details, such as the wait the explorer asked for. Show it alone, or after a
summary in your tool's own words, and keep `error.message` for your logs.

This module builds the line an IDE terminal shows, here for a `rate-limited` error whose explorer
asked for 3 seconds:

```ts [user-message.ts]
import { ExplorerVerifyError, hintFor } from "explorer-verify/errors";
import type { AnyExplorerVerifyError } from "explorer-verify/errors";

/** The line an IDE terminal shows for a failed verification. */
export function terminalLine(error: AnyExplorerVerifyError): string {
  return `Verification failed. ${hintFor(error, "user")}`;
}

const error = new ExplorerVerifyError(
  { code: "rate-limited", backend: "sourcify", retryAfterMs: 3_000 },
  "sourcify answered HTTP 429.",
  { secrets: [] },
);
console.log(terminalLine(error));
```

```text
Verification failed. The explorer is limiting requests. Wait 3 seconds, then try again.
```

`hintFor` also takes the JSON form, from `error.toJSON()` or an envelope, and never throws.
`hintFor(error, "developer")` returns `error.hint`.

`error.hint` names field paths only in parentheses, such as "(details.handle)". So it still reads
correctly when your error class keeps the details under another name. Keep `error.toJSON().details`
on your error, for example as `cause.details`, so a developer who uses your tool can act on it.

Each code's page in the [error reference](../reference/errors/index.md) gives its end-user hint on
its "For end users" line. To write your own words, as the CLI does for its flags, switch on
`error.code` and read `error.details`.

## Ship only the clients your tool uses

Declare `explorer-verify` as a peer dependency and do not bundle it: your users' bundler then
loads each explorer client only when a call needs it. If your tool ships one bundled file, import
`verify` from `explorer-verify/core` and pass only the clients you use:

```ts [verify-core.ts]
import { readFile } from "node:fs/promises";

import type { VerifyInput } from "explorer-verify";
import { sourcify } from "explorer-verify/clients/sourcify";
import { verify } from "explorer-verify/core";
import { routingTable } from "explorer-verify/table";

const json = await readFile("greeter-sepolia.json", "utf8");
const input: VerifyInput = JSON.parse(json);
// The routing table chooses among the clients passed: Sourcify here.
const result = await verify(input, {
  clients: [sourcify()],
  table: routingTable,
});
console.log(result.status, result.backend);
```

```text
already-verified sourcify
```

Build the clients inside your tool: a client works only with the copy of explorer-verify that
made it. [Bundle size](../advanced/bundle-size.md) has the sizes and the small entries to
re-export from.

## Make verification an optional feature

When verification is one opt-in feature, declare `explorer-verify` as an optional peer dependency.
Users who never verify then do not install it:

```json [package.json]
{
  "peerDependencies": { "explorer-verify": "^0.1.0" },
  "peerDependenciesMeta": { "explorer-verify": { "optional": true } }
}
```

Load explorer-verify with `import()` inside `try`, in a subpath such as `deploykit/verify` that
the root entry never imports. Turn a failed load into an error of your tool:

```ts [verify.ts]
import { readFile } from "node:fs/promises";

import type { VerifyInput, VerifyResult } from "explorer-verify";

const NEEDED =
  "Verification needs explorer-verify: npm install explorer-verify";

export class VerificationUnavailableError extends Error {}

export async function verifyContract(
  input: VerifyInput,
): Promise<VerifyResult> {
  let library: typeof import("explorer-verify");
  try {
    // Inside try, bundlers leave a missing package to run time.
    library = await import("explorer-verify");
  } catch (cause) {
    throw new VerificationUnavailableError(NEEDED, { cause });
  }
  return await library.verify(input);
}

// What a user of deploykit writes.
const json = await readFile("greeter-sepolia.json", "utf8");
const input: VerifyInput = JSON.parse(json);
try {
  console.log((await verifyContract(input)).status);
} catch (error) {
  if (!(error instanceof VerificationUnavailableError)) {
    throw error;
  }
  console.log(error.message);
}
```

With explorer-verify installed, it prints the status. Without it:

```text
Verification needs explorer-verify: npm install explorer-verify
```

With `import()` inside `try`, esbuild, Rollup, webpack and Vite all build an app that lacks the
package, and the failed load reaches your `catch`. Vite needs the peer marked optional. Without
`try`, esbuild and webpack fail the build.

## Test with recorded answers

Replay explorer answers through an injected `fetch`, so your tests need no network. Record each
answer once from the live explorer, with the date, the method and the URL. This `fetch` answers
each request with the next recording and fails on any other:

```ts [replay.test.ts]
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { verify } from "explorer-verify";
import type { VerifyInput } from "explorer-verify";

type Recording = { method: string; url: string; status: number; body: unknown };

function replay(recordings: readonly Recording[]): typeof fetch {
  let next = 0;
  return async (request, init) => {
    const url = request instanceof Request ? request.url : String(request);
    const sent = `${init?.method ?? "GET"} ${url}`;
    const recording = recordings[next++];
    assert.ok(recording, `unexpected request: ${sent}`);
    assert.equal(sent, `${recording.method} ${recording.url}`);
    const body = JSON.stringify(recording.body);
    const headers = { "content-type": "application/json" };
    const answer = new Response(body, { status: recording.status, headers });
    return await Promise.resolve(answer);
  };
}

const json = await readFile("greeter-sepolia.json", "utf8");
const input: VerifyInput = JSON.parse(json);
const lookup =
  "https://sourcify.dev/server/v2/contract/11155111/" +
  `${input.address}?fields=compilation`;

// Sourcify's lookup answer for the sample, trimmed. Without `compilation`, the
// answer names no contract, so the library compares no name and takes the match
// as this source.
const answer = {
  match: "exact_match",
  chainId: "11155111",
  address: input.address,
};
const result = await verify(input, {
  fetch: replay([{ method: "GET", url: lookup, status: 200, body: answer }]),
});
assert.equal(result.status, "already-verified");
```

For a pending answer, answer every poll with one recording, and mock the timers and `Date.now` so
the test does not wait.

> [!WARNING]
> Never record a request or an answer that holds an API key. Replace the key with a dummy value
> before you save the recording.

## Sources

- Bundler behaviour with a missing optional peer, checked on 2026-11-10 with Node 24.21.0:
  esbuild 0.28.2, Rollup 4.67.4 with `@rollup/plugin-node-resolve` 16.0.3, webpack 5.112.2 and
  Vite 8.3.7 (Rolldown 1.2.18).

## Next steps

- [Server handler](run-the-server-handler.md): keep an Etherscan key off the browser.
- [Using explorer-verify from an agent](using-from-an-agent.md): which calls submit.
- [Bundle size](../advanced/bundle-size.md): what each entry adds.
- [Errors](../reference/errors/index.md): every code, its cause and fix.
