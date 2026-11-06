# Wrap explorer-verify behind your tool's API

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: authors of a tool that already verifies contracts, such as a deploy framework, a
dashboard or an SDK, who want to call explorer-verify inside their existing functions. Nothing is
published to npm yet.

Your users keep calling the functions they call today. Inside those functions, the tool calls
[`verify()`](../reference/verify.md) and [`checkStatus()`](../reference/check-status.md), maps its
own settings onto `VerifyOptions`, and maps results and error codes back onto its own results and
error classes. The examples use a made-up tool, `deployKit`, with a function
`deployKit.verifyContract(params, settings)` whose signature stays as it was.

## Setup

Node.js 22.18 or later, or any runtime with `fetch`. Install the core package:

```sh
npm install explorer-verify
```

The core has no Node.js built-ins, so the same wrapper runs in a browser, a backend or a CLI.

## The wrapper

This module is the whole integration. `verifyContract` and `resumeVerification` keep the tool's
public types. Only their bodies change:

1. `toInput` maps the tool's parameters onto a `VerifyInput`.
2. `toOptions` maps the tool's settings onto `VerifyOptions`.
3. `toReport` maps a `VerifyResult` onto the tool's report.
4. `toDeployKitError` maps an `ExplorerVerifyError` onto the tool's error class, with `KIND`, which
   names a kind for every error code. Because `KIND` is a `Record<ErrorCode, …>`, the tool stops
   compiling when a release adds a code, until you map it.

`verifyContract` also keeps the handle from the `verify.submitted` event. An abort rejects with
`signal.reason`, which carries no handle, so without the event a call cancelled after the submit
would lose the job. The handle is what to log or persist: the wrapper passes it to the tool's
`onSubmitted` setting and puts it on the `cancelled` error as `resumeToken`.

The last lines run it twice on the Greeter on Sepolia. The first call has a two-minute deadline.
The second call cancels as soon as the explorer accepts the submission. After each, the example
resumes the job from the token when the call ended without a verdict.

```ts
import { ExplorerVerifyError, checkStatus, verify } from "explorer-verify";
import type {
  ErrorCode,
  Hex,
  SolidityStandardJsonInput,
  VerifyEvent,
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
  deployTxHash?: Hex;
  /** The compiled creation bytecode, to derive constructorArgs when they are absent. */
  bytecode?: Hex;
}

export interface VerifyContractSettings {
  etherscanApiKey?: string;
  /** Seconds to wait for the explorer's verdict. Unset: the longest budget, about 24.8 days. */
  waitTimeoutSeconds?: number;
  fetch?: typeof fetch;
  /** Stops the call. Use it to end a long wait. */
  signal?: AbortSignal;
  rpcUrl?: string;
  /** Called with the resume token as soon as the explorer accepts the submission. */
  onSubmitted?: (resumeToken: string) => void;
}

export interface VerifyReport {
  status: "success" | "already-verified" | "failed";
  explorer: string;
  /** `partial` when the explorer matched the code but not the metadata hash. */
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
  readonly retryable: boolean;
  /** Pass it to resumeVerification() to keep polling without a new submission. */
  readonly resumeToken: string | undefined;

  constructor(
    kind: DeployKitErrorKind,
    message: string,
    options: { retryable: boolean; resumeToken: string | undefined; cause: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = "DeployKitError";
    this.kind = kind;
    this.retryable = options.retryable;
    this.resumeToken = options.resumeToken;
  }
}

// The mapping.

/** The largest time budget verify() takes, about 24.8 days. A larger value is lowered to it. */
const LONGEST_BUDGET_MS = 2_147_483_647;

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
};

function toInput(params: VerifyContractParams): VerifyInput {
  return {
    chainId: params.chainId,
    address: params.address,
    contractName: params.contract,
    compiler: { kind: "solc", version: params.compilerVersion, input: params.standardJsonInput },
    ...(params.constructorArgs === undefined ? {} : { constructorArgs: params.constructorArgs }),
    ...(params.deployTxHash === undefined ? {} : { creationTxHash: params.deployTxHash }),
    ...(params.bytecode === undefined ? {} : { creationBytecode: params.bytecode }),
  };
}

function toOptions(settings: VerifyContractSettings): VerifyOptions {
  return {
    apiKeys: { "etherscan-v2": settings.etherscanApiKey },
    timeoutMs:
      settings.waitTimeoutSeconds === undefined
        ? LONGEST_BUDGET_MS
        : settings.waitTimeoutSeconds * 1000,
    ...(settings.fetch === undefined ? {} : { fetch: settings.fetch }),
    ...(settings.signal === undefined ? {} : { signal: settings.signal }),
    ...(settings.rpcUrl === undefined ? {} : { rpcUrl: settings.rpcUrl }),
  };
}

function toReport(result: VerifyResult): VerifyReport {
  if (result.status === "failed") {
    return { status: "failed", explorer: result.backend, message: result.reason };
  }
  // A partial match counts as success; the report says which match it is.
  return {
    status: result.status === "verified" ? "success" : "already-verified",
    explorer: result.backend,
    match: result.match,
    ...(result.explorerUrl === undefined ? {} : { url: result.explorerUrl }),
  };
}

function toDeployKitError(
  error: unknown,
  signal: AbortSignal | undefined,
  handle: string | undefined,
): unknown {
  // An abort rejects with signal.reason, unchanged: it is not an ExplorerVerifyError and carries
  // no handle, so the handle comes from the verify.submitted event.
  if (signal?.aborted === true && error === signal.reason) {
    return new DeployKitError("cancelled", "Verification was cancelled.", {
      retryable: false,
      resumeToken: handle,
      cause: error,
    });
  }
  if (!(error instanceof ExplorerVerifyError)) {
    return error;
  }
  return new DeployKitError(KIND[error.code], `${error.message} ${error.hint}`, {
    retryable: error.retryable,
    // The handle in its one-line form, when the code carries one.
    resumeToken: error.toJSON().handle ?? handle,
    cause: error,
  });
}

// deployKit's public functions. Same signatures, new bodies.

async function verifyContract(
  params: VerifyContractParams,
  settings: VerifyContractSettings = {},
): Promise<VerifyReport> {
  let handle: string | undefined;
  const onEvent = (event: VerifyEvent): void => {
    if (event.type === "verify.submitted") {
      handle = event.handle;
      settings.onSubmitted?.(event.handle);
    }
  };
  try {
    return toReport(await verify(toInput(params), { ...toOptions(settings), onEvent }));
  } catch (error) {
    throw toDeployKitError(error, settings.signal, handle);
  }
}

/**
 * Polls a submitted verification again; it never submits. Pass settings that route to the same
 * backend as the submit, the same key included; otherwise checkStatus() throws invalid-input.
 */
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

export const deployKit = { verifyContract, resumeVerification };

// Two runs on the Greeter on Sepolia.
const params: VerifyContractParams = {
  chainId: input.chainId,
  address: input.address,
  contract: input.contractName,
  compilerVersion: input.compiler.version,
  standardJsonInput: input.compiler.input,
};

/** Verifies, and resumes from the token once when the call ends without a verdict. */
async function verifyAndResume(settings: VerifyContractSettings): Promise<void> {
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
    report = await deployKit.resumeVerification(error.resumeToken, { waitTimeoutSeconds: 120 });
  }
  console.log(`${report.status} (${report.match ?? "no match"}) on ${report.explorer}`);
}

// A two-minute deadline.
await verifyAndResume({ waitTimeoutSeconds: 120 });

// A user who cancels as soon as the explorer accepts the submission.
const controller = new AbortController();
await verifyAndResume({
  waitTimeoutSeconds: 120,
  signal: controller.signal,
  onSubmitted: () => controller.abort(),
});
```

With no Etherscan key, the routing table sends Sepolia to Sourcify. When Sourcify does not have the
contract yet, the first call submits it and the job ends with an exact match. The second call
submits, is cancelled with the handle saved, and resumes the same job:

```text
success (exact) on sourcify
cancelled, resume with ev1:sourcify:11155111:0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc:ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718
success (exact) on sourcify
```

When Sourcify already holds the contract, neither call submits, and each prints
`already-verified (exact) on sourcify`. When the two minutes of the first call run out while
Sourcify is still checking, `verifyContract` throws a `pending` error with the resume token, and
`resumeVerification` polls the same job.

## Map the settings onto VerifyOptions

| deployKit setting    | `VerifyOptions` field     | Notes                                                                                                                                                                                                                                                      |
| -------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `etherscanApiKey`    | `apiKeys["etherscan-v2"]` | Sent only to Etherscan's API host. With a key, a chain on Etherscan's free tier goes to Etherscan v2; without one, to Sourcify. See [API keys](../reference/api-keys.md)                                                                                   |
| `waitTimeoutSeconds` | `timeoutMs`               | The budget for the whole call, every request, retry and poll included. See [Behaviour that changes](#behaviour-that-changes)                                                                                                                               |
| `fetch`              | `fetch`                   | Every request goes through it. It must not follow redirects. Use it for a proxy, logging or recorded answers in tests. It does not skip the `missing-api-key` check before any request: for a server that adds the key, map that setting onto `handlerUrl` |
| `signal`             | `signal`                  | An abort rejects with `signal.reason` unchanged; the wrapper turns it into its `cancelled` error, with the handle from `verify.submitted` when the submit was accepted                                                                                     |
| `onSubmitted`        | `onEvent`                 | The wrapper reads `verify.submitted` and passes its handle on. Log or persist it                                                                                                                                                                           |
| `rpcUrl`             | `rpcUrl`                  | Used only to derive constructor arguments from the creation transaction                                                                                                                                                                                    |
| A fixed explorer     | `route`                   | `{ backend }` picks another backend from the chain's row; `{ backend, apiUrl, apiKey }` targets another server. See [Routing](../reference/routing.md#route)                                                                                               |
| A logger             | `logger`, `onEvent`       | Log lines and stage events, keys removed. See [Logging and events](../reference/logging-and-events.md)                                                                                                                                                     |

The library never reads `process.env`. If your tool reads keys from environment variables or a
config file, read them in the tool and pass them in `apiKeys`. Etherscan's terms forbid an
Etherscan key in browser code: in a browser, set `handlerUrl` to a
[server handler](run-the-server-handler.md) that holds the key.

## Behaviour that changes

Some of what `verify()` does may differ from what your tool did before. Keep the old behaviour as
the default, and let your users opt in, where the table says how.

| What `verify()` does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | How to keep the old behaviour, or make it opt-in                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| It stops after a time budget, 2 minutes by default, and throws `not-confirmed` with a handle when the explorer is still checking. It also throws `not-confirmed` after 3 failed polls in a row                                                                                                                                                                                                                                                                                                                                                                          | There is no way to turn the deadline off. 2147483647 ms, about 24.8 days, is the largest budget, and a larger value is lowered to it; `LONGEST_BUDGET_MS` above passes it when your users set no deadline. Map `not-confirmed` onto a pending result that can be resumed, and offer `signal` so users can stop a long call |
| It looks the contract up before it submits, and returns `already-verified` without a submit when the explorer holds an `exact` or `partial` match                                                                                                                                                                                                                                                                                                                                                                                                                       | Nothing to change. Map `already-verified` onto your own result for that case                                                                                                                                                                                                                                               |
| It picks the backend from a routing table, by chain and by the keys you pass. A chain the table does not list throws `unsupported-chain`                                                                                                                                                                                                                                                                                                                                                                                                                                | Pass `route` to fix the backend. Pass `allowSourcifyFallback: true` to send an unlisted chain to the public Sourcify API                                                                                                                                                                                                   |
| On a backend that takes constructor arguments (Etherscan v2, Routescan, Etherscan-compatible explorers, Blockscout), it derives missing arguments from the creation code when the input has `creationBytecode`. It needs `rpcUrl` with `creationTxHash`, or an Etherscan key bound to the route; otherwise it logs why and submits without arguments. On Etherscan v2, Routescan and Etherscan-compatible explorers, which refuse a build other than the deployed one, a creation code that shows another build throws `constructor-args-unavailable` before the submit | Leave `creationBytecode` out, or pass `constructorArgs` (`0x` for none): passed arguments always win, and nothing is derived. See [Constructor arguments](../reference/verify.md#constructor-arguments)                                                                                                                    |
| It retries a failed request up to 5 attempts, and never resends a submit the explorer may have received                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Remove your own retry loop around the call. A loop around `verify()` multiplies the attempts                                                                                                                                                                                                                               |
| It throws on every outcome that is not a verdict. A `failed` result, a definitive rejection, is returned, not thrown                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Map `failed` onto your failure result, and errors onto your error classes, as below                                                                                                                                                                                                                                        |
| It never follows a redirect, and an injected `fetch` must not follow one either                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Nothing to change, unless your own `fetch` wrapper follows redirects                                                                                                                                                                                                                                                       |
| It waits at least 1 second between polls, and uses the address in lower case in handles, events and URLs                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Nothing to change. A `pollIntervalMs` below 1000 is raised to 1000                                                                                                                                                                                                                                                         |

## Map the results

| `VerifyResult.status` | deployKit `status` | Fields                                                              |
| --------------------- | ------------------ | ------------------------------------------------------------------- |
| `verified`            | `success`          | `backend`, `match` (`exact` or `partial`), `explorerUrl` when known |
| `already-verified`    | `already-verified` | The same. Nothing was submitted                                     |
| `failed`              | `failed`           | `backend`, `reason`: the explorer's code and message                |

`match` is `partial` when the explorer matched the code but not the metadata hash. The example
counts a partial match as success and carries `match` on the report, so its users can tell the
two apart. If your tool reports only success or failure, decide whether a partial match counts as
success, and say so in your docs. See [Match types](../explanation/match-types.md).

## Map the errors

Every failure is an `ExplorerVerifyError`, except an abort. Switch on `error.code`, not on the
message. `error.hint` says what to do next, `error.retryable` whether trying again may work, and
`error.toJSON().handle` holds the handle in its one-line form when the code carries one. The CLI
exit code comes from `ERROR_EXIT_CODES`; use it when your tool is a CLI too.

After `timeout`, `network` or `verification-inconclusive`, a new `verify()` call is safe: it looks
the contract up first and submits only when the explorer holds no match. After `not-confirmed`,
or a cancel with a saved handle, call `checkStatus()` instead, which never submits. Pass it
settings that route to the backend named in the handle, with the same key; otherwise it throws
`invalid-input` before any request.

The table lists every code. Retryable and exit code come from the library; the deployKit kind is
the example's choice, from `KIND` above.

| Code                                                                                  | Retryable | Exit code | deployKit kind | What the tool tells its user                                                               |
| ------------------------------------------------------------------------------------- | --------- | --------- | -------------- | ------------------------------------------------------------------------------------------ |
| [`invalid-input`](../reference/errors/invalid-input.md)                               | no        | 2         | `config`       | Fix the parameter or setting the message names; nothing was sent                           |
| [`not-confirmed`](../reference/errors/not-confirmed.md)                               | yes       | 4         | `pending`      | Still checking; resume with the token, do not submit again                                 |
| [`unsupported-chain`](../reference/errors/unsupported-chain.md)                       | no        | 2         | `config`       | Choose another explorer for this chain                                                     |
| [`network`](../reference/errors/network.md)                                           | yes       | 5         | `unavailable`  | No answer after retries; try again later                                                   |
| [`rate-limited`](../reference/errors/rate-limited.md)                                 | yes       | 5         | `unavailable`  | The explorer is limiting requests; try again later                                         |
| [`timeout`](../reference/errors/timeout.md)                                           | yes       | 5         | `unavailable`  | The deadline ran out before a submit was accepted; try again                               |
| [`unexpected-response`](../reference/errors/unexpected-response.md)                   | yes       | 5         | `unavailable`  | The explorer answered outside its API; try again later                                     |
| [`in-progress`](../reference/errors/in-progress.md)                                   | yes       | 5         | `unavailable`  | Another verification of this contract is running; wait, then try again                     |
| [`unknown-state`](../reference/errors/unknown-state.md)                               | no        | 6         | `needs-review` | Check the contract on the explorer; the token identifies the job                           |
| [`job-not-found`](../reference/errors/job-not-found.md)                               | no        | 6         | `needs-review` | The explorer forgot the job; check the contract before you submit again                    |
| [`cancelled`](../reference/errors/cancelled.md)                                       | no        | 130       | `cancelled`    | Cancelled. The core never throws it; an abort rejects with `signal.reason`                 |
| [`incomplete-input`](../reference/errors/incomplete-input.md)                         | no        | 2         | `config`       | Add the missing sources or settings                                                        |
| [`insufficient-artifact`](../reference/errors/insufficient-artifact.md)               | no        | 2         | `config`       | Use a build file with the compiler input or metadata                                       |
| [`unsupported-compiler`](../reference/errors/unsupported-compiler.md)                 | no        | 2         | `config`       | The compiler is not supported                                                              |
| [`verification-inconclusive`](../reference/errors/verification-inconclusive.md)       | yes       | 4         | `unavailable`  | The job ended without a verdict; verify again later, once                                  |
| [`source-mismatch`](../reference/errors/source-mismatch.md)                           | no        | 2         | `config`       | A source does not match its recorded hash; use the files of the deployed build             |
| [`missing-api-key`](../reference/errors/missing-api-key.md)                           | no        | 3         | `auth`         | Set the API key; nothing was sent                                                          |
| [`api-key-rejected`](../reference/errors/api-key-rejected.md)                         | no        | 3         | `auth`         | Replace the key, or use one on a plan that covers the chain                                |
| [`quota-exceeded`](../reference/errors/quota-exceeded.md)                             | no        | 3         | `auth`         | The key's daily limit is spent; try again after the reset                                  |
| [`internal-error`](../reference/errors/internal-error.md)                             | no        | 6         | `bug`          | The CLI creates it; the library never throws it                                            |
| [`no-metadata-hash`](../reference/errors/no-metadata-hash.md)                         | no        | 2         | `config`       | The bytecode has no metadata hash; build the input from build files                        |
| [`metadata-unavailable`](../reference/errors/metadata-unavailable.md)                 | yes       | 5         | `unavailable`  | The metadata could not be fetched; try again later or pass a gateway                       |
| [`constructor-args-unavailable`](../reference/errors/constructor-args-unavailable.md) | no        | 2         | `config`       | The creation code shows another build; pass the deployed build or the arguments            |
| [`proxy-link-pending`](../reference/errors/proxy-link-pending.md)                     | yes       | 4         | `pending`      | The explorer is still linking the proxy; call `linkProxy()` again later. There is no token |
| [`proxy-link-unknown-state`](../reference/errors/proxy-link-unknown-state.md)         | no        | 6         | `needs-review` | Check the proxy's page on the explorer; there is no token                                  |

`verify()`, `checkStatus()` and `linkProxy()` throw some of these codes. `buildVerifyInput`,
`buildVerifyInputFromBytecode` and the CLI throw the others. A test checks the code, retryable and exit
code columns of this table against the library, so the table changes when a release adds a code.
The [error reference](../reference/errors/index.md) has a page per code with the cause and the fix.

## Test with recorded answers

In your tool's tests, replay explorer answers through an injected `fetch`, so the tests need no
network and give the same result on every run. Record each answer once from the live explorer, with
the date, and keep the method and URL of the request with it. The `fetch` below answers each
request with the next recording and fails on any other request.

In your suite, pass it as your tool's `fetch` setting. Here it goes straight to `verify()`, so the
example runs on its own:

```ts
import assert from "node:assert/strict";

import { ExplorerVerifyError, verify } from "explorer-verify";

/** One recorded request and the explorer's answer. */
interface Recording {
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly body: unknown;
}

/** A fetch that answers each request with the next recording, and fails on any other request. */
function replay(recordings: readonly Recording[]): typeof fetch {
  let next = 0;
  return async (request, init) => {
    const url = request instanceof Request ? request.url : String(request);
    const method = init?.method ?? "GET";
    const recording = recordings[next];
    next += 1;
    assert.ok(recording, `unexpected request: ${method} ${url}`);
    assert.equal(`${method} ${url}`, `${recording.method} ${recording.url}`);
    // The library never follows a redirect; a fetch you pass must not either.
    assert.equal(init?.redirect, "manual");
    return await Promise.resolve(
      new Response(JSON.stringify(recording.body), {
        status: recording.status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
}

const GREETER = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";

// Sourcify's lookup answer for the Sepolia Greeter, recorded on 2026-11-02.
const verified = await verify(input, {
  fetch: replay([
    {
      method: "GET",
      url: `https://sourcify.dev/server/v2/contract/11155111/${GREETER}`,
      status: 200,
      body: {
        matchId: "58142236",
        creationMatch: "exact_match",
        runtimeMatch: "exact_match",
        verifiedAt: "2026-11-02T23:39:56Z",
        match: "exact_match",
        chainId: "11155111",
        address: "0x8275D36F64F047D2D8a1F42c79Bf80Caea39D7cC",
      },
    },
  ]),
});
assert.deepEqual(verified, {
  status: "already-verified",
  backend: "sourcify",
  match: "exact",
  explorerUrl: `https://repo.sourcify.dev/11155111/${GREETER}`,
});
console.log("already-verified: ok");

// Sourcify's answer for a chain it does not serve, recorded on 2026-11-02.
await assert.rejects(
  verify(
    { ...input, chainId: 9429413 },
    {
      allowSourcifyFallback: true,
      fetch: replay([
        {
          method: "GET",
          url: `https://sourcify.dev/server/v2/contract/9429413/${GREETER}`,
          status: 400,
          body: { customCode: "unsupported_chain", message: "Chain 9429413 not found" },
        },
      ]),
    },
  ),
  (error) => error instanceof ExplorerVerifyError && error.code === "unsupported-chain",
);
console.log("unsupported-chain: ok");
```

It prints:

```text
already-verified: ok
unsupported-chain: ok
```

For an answer that is still pending, record the pending poll once and answer every poll with it
until the time budget ends. Use your test runner's mock timers for the waits between polls, so the
test does not wait in real time. The library measures its budget with `Date.now`, so mock it too.

Never record a request or an answer that holds an API key. Replace the key with a dummy value
before you save the recording.
