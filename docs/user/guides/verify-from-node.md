# Verify from Node.js

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers who verify contracts from a Node.js backend service or script. Nothing is
published to npm yet.

On a backend, the keys stay on your server, a call may wait for minutes, and a job queue can
resume a verification long after the process that submitted it has ended. This guide shows a
verification with keys from the environment, a logger, events for your telemetry and a long time
budget, then a queue job that resumes it with `checkStatus()`. The same code runs in Deno and Bun;
see [Deno and Bun](#deno-and-bun).

## Setup

Node.js 22.18 or later. Install the core package:

```sh
npm install explorer-verify
```

To build the input from a Foundry or Hardhat project, see
[Verify a contract from a Foundry project](verify-from-a-foundry-project.md) and
[Verify a contract from a Hardhat project](verify-from-a-hardhat-project.md). Both helpers run on
Node.js only.

## Keys

The library never reads `process.env`. Read the keys yourself and pass them in `apiKeys`, by backend
name. Each key goes only to its backend's host ([API keys](../reference/api-keys.md)). Load them
from your secret store into the environment, or in development from a `.env` file kept out of git
with `node --env-file=.env` ([Node.js CLI](https://nodejs.org/api/cli.html#--env-filefile), v26
docs, read on 2026-11-04). Never write a key into code, a log or a fixture.

## Verify

`verifyAndQueue` verifies one contract. Its logger writes one JSON line per log line to stderr,
and `onEvent` passes each stage event to your telemetry. The time budget is ten minutes, because a
backend has no user waiting on a page. When the budget runs out while the explorer is still
checking, it queues the handle for the job of the next section. The last lines run it once, with a
queue that prints the handle; in your service, pass your own queue.

```ts
import { ExplorerVerifyError, formatHandle, verify } from "explorer-verify";
import type { LogFields, Logger, VerifyEvent, VerifyInput, VerifyOptions } from "explorer-verify";

type ApiKeys = NonNullable<VerifyOptions["apiKeys"]>;

/** The keys in the environment, by backend. An empty variable counts as unset. */
export function apiKeysFrom(env: Readonly<Record<string, string | undefined>>): ApiKeys {
  const etherscan = env["ETHERSCAN_API_KEY"] ?? "";
  return etherscan === "" ? {} : { "etherscan-v2": etherscan };
}

/** One JSON line per log line, on stderr. The library removes keys before it calls the logger. */
function jsonLine(level: string): (message: string, fields?: LogFields) => void {
  return (message, fields) => {
    process.stderr.write(`${JSON.stringify({ level, message, ...fields })}\n`);
  };
}
const logger: Logger = {
  debug: () => undefined,
  info: jsonLine("info"),
  warn: jsonLine("warn"),
  error: jsonLine("error"),
};

export interface Queue {
  /** Stores a handle for a later checkStatus() job. */
  add: (handle: string) => Promise<void>;
}

export async function verifyAndQueue(
  input: VerifyInput,
  queue: Queue,
  telemetry: (event: VerifyEvent) => void,
): Promise<string> {
  try {
    const result = await verify(input, {
      apiKeys: apiKeysFrom(process.env),
      logger,
      onEvent: telemetry,
      timeoutMs: 10 * 60_000,
    });
    return result.status === "failed"
      ? `failed on ${result.backend}: ${result.reason}`
      : `${result.status} on ${result.backend}`;
  } catch (error) {
    if (error instanceof ExplorerVerifyError && error.details.code === "not-confirmed") {
      await queue.add(formatHandle(error.details.handle));
      return "queued for a status check";
    }
    throw error;
  }
}

const queue: Queue = {
  add: async (handle) => {
    console.log(`queued ${handle}`);
    await Promise.resolve();
  },
};
console.log(await verifyAndQueue(input, queue, (event) => process.stderr.write(`${event.type}\n`)));
```

With no Etherscan key in the environment, the Sepolia contract goes to Sourcify, which verifies it:

```text
verified on sourcify
```

With `ETHERSCAN_API_KEY` set, the routing table sends the same chain to Etherscan v2, which already
holds the contract, and it prints `already-verified on etherscan-v2`. When the budget runs out
first, it prints the handle and `queued for a status check`.

A call ends within `timeoutMs` plus at most 30 seconds. Give a script that runs under a process
manager, or a request handler behind a proxy, a budget shorter than their own limits. To stop a call
early, such as on shutdown, pass an `AbortSignal` in `signal`; the call rejects with the signal's
reason. Save the handle from the `verify.submitted` event when a crash between submit and result
must not lose the job ([Abort and resume](../reference/verify.md#abort-and-resume)).

## Resume from a job queue

The queue job polls the handle with `checkStatus()`, which never submits. Pass the same `apiKeys`
and `route` the submit used: the handle names the backend, and the route must resolve to it, or the
call throws `invalid-input` before any request. The job returns `again` while the explorer is still
checking, so your queue runs it later.

```ts
import { ExplorerVerifyError, checkStatus } from "explorer-verify";
import type { VerifyOptions } from "explorer-verify";

type ApiKeys = NonNullable<VerifyOptions["apiKeys"]>;

/** The same keys as the submit used. */
function apiKeysFrom(env: Readonly<Record<string, string | undefined>>): ApiKeys {
  const etherscan = env["ETHERSCAN_API_KEY"] ?? "";
  return etherscan === "" ? {} : { "etherscan-v2": etherscan };
}

export async function statusJob(handle: string): Promise<"done" | "again"> {
  try {
    const result = await checkStatus(handle, {
      apiKeys: apiKeysFrom(process.env),
      timeoutMs: 60_000,
    });
    console.log(`${result.status} on ${result.backend}`);
    return "done";
  } catch (error) {
    if (error instanceof ExplorerVerifyError && error.details.code === "not-confirmed") {
      return "again";
    }
    throw error;
  }
}

console.log(
  await statusJob(
    "ev1:sourcify:11155111:0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc:ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718",
  ),
);
```

When the job has ended with a match, it prints:

```text
verified on sourcify
done
```

Limit how often a handle is retried. A job that gives `again` for hours, or ends with an error that
is not `not-confirmed`, needs a person: log the handle, the code and the hint.

## Errors

| Code                                                                            | What the service does                                                                                            |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [`not-confirmed`](../reference/errors/not-confirmed.md)                         | Queue `details.handle` and poll it later with `checkStatus()`                                                    |
| [`missing-api-key`](../reference/errors/missing-api-key.md)                     | The route needs a key that `apiKeys` lacks. Set the variable; nothing was sent                                   |
| [`api-key-rejected`](../reference/errors/api-key-rejected.md)                   | The explorer refused the key. Replace it; do not retry with the same key                                         |
| [`quota-exceeded`](../reference/errors/quota-exceeded.md)                       | The key's daily limit is spent. Retry after the reset                                                            |
| [`rate-limited`](../reference/errors/rate-limited.md)                           | Retries ran out. Slow down the queue                                                                             |
| [`verification-inconclusive`](../reference/errors/verification-inconclusive.md) | The job ended without a verdict. Call `verify()` again later, once                                               |
| [`job-not-found`](../reference/errors/job-not-found.md)                         | The explorer forgot the job and the contract is not verified. Log it for a person; do not resubmit automatically |

[Errors](../reference/errors/index.md) lists every code and its exit code. The `toEnvelope()` and
`exitCodeOf()` functions turn an outcome into the CLI's JSON envelope and exit code
([JSON output](../reference/json-output.md)); pass your keys in `secrets` when you log the envelope.

## Deno and Bun

The core uses only web-platform globals, so the code above runs in Deno and Bun unchanged, except
where it reads the environment.

- Deno: import `npm:explorer-verify@<version>`, or install it from `package.json`
  ([Deno, Node and npm](https://docs.deno.com/runtime/fundamentals/node/), read on 2026-11-04, page
  updated 2026-07-30). Read the key with `Deno.env.get("ETHERSCAN_API_KEY")`, and run with
  `--allow-env=ETHERSCAN_API_KEY` and `--allow-net` limited to the explorer hosts you use, such as
  `--allow-net=sourcify.dev,api.etherscan.io`. Deno reads a `.env` file only with `--env-file`
  ([Deno environment variables](https://docs.deno.com/runtime/reference/env_variables/), read on
  2026-11-04, page updated 2026-07-02).
- Bun: `process.env` works as in Node.js. Bun loads `.env` files on its own, so keep them out of
  git, or pass `--no-env-file`
  ([Bun environment variables](https://bun.com/docs/runtime/environment-variables), read on
  2026-11-04).

Not tested: the repository's tests run on Node.js and, for the browser, in Chromium. No test runs
in Deno or Bun.

The Etherscan plan rule applies to a backend too: a business, protocol, foundation or DAO needs an
Advanced plan or higher. See [Etherscan plans and attribution](../explanation/etherscan-plans-and-attribution.md).
