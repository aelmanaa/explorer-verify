# Verify from Node.js

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

For: developers who verify contracts from a Node.js script or backend service.

You need: Node.js 22.18 or later. An Etherscan key is optional; the first steps need none.

On a backend, the keys stay on your server and a call may wait for minutes. This guide runs a dry
run on a sample contract, verifies it, then builds a service with a logger, telemetry and a queue.
The same code runs in Deno and Bun; see [Deno and Bun](#deno-and-bun).

## Install

Add the core package:

```sh
npm install explorer-verify
```

Node.js 22.18 runs the `.ts` files below directly. Supported Node.js versions follow Node's LTS
schedule ([decision 0060](../../contributor/decisions/0060-supported-node-versions-follow-lts.md)).

## Run a dry run on the sample contract

Save [greeter-sepolia.json](../start/greeter-sepolia.json) in the project folder. It is a verify
request for a Greeter contract on Sepolia that Sourcify already holds. A dry run checks the input,
picks the explorer and looks the contract up once. It submits nothing:

```ts [dry-run.ts]
import { readFile } from "node:fs/promises";

import { dryRun, validateInput } from "explorer-verify";

// validateInput() checks the parsed JSON and returns a typed VerifyInput.
const input = validateInput(JSON.parse(await readFile("greeter-sepolia.json", "utf8")));
const plan = await dryRun(input);
console.log(plan.status, plan.backend, plan.apiHost, plan.lookup);
```

Run it:

```sh
node dry-run.ts
```

```text
dry-run sourcify sourcify.dev exact
```

With no key, the routing table picks the first backend of the chain's row that needs none, here
Sourcify. `exact` means Sourcify already holds the contract.

## Verify

The real run is the same call with `verify()`. Read the keys from the environment yourself: the
library never reads `process.env`. An empty variable counts as unset:

```ts [verify.ts]
import { readFile } from "node:fs/promises";

import { validateInput, verify } from "explorer-verify";

const input = validateInput(JSON.parse(await readFile("greeter-sepolia.json", "utf8")));
const etherscan = process.env["ETHERSCAN_API_KEY"] ?? "";
const result = await verify(input, {
  apiKeys: etherscan === "" ? {} : { "etherscan-v2": etherscan },
});
console.log(`${result.status} on ${result.backend}`);
```

Run it:

```sh
node verify.ts
```

```text
already-verified on sourcify
```

With `ETHERSCAN_API_KEY` set, the routing table sends the same chain to Etherscan v2, which also
holds the contract, and it prints `already-verified on etherscan-v2`. For your own contract, build
the input from your project: see [Next steps](#next-steps).

## Keep keys out of code

Each key goes only to its backend's host ([API keys](../reference/api-keys.md)). Load keys from
your secret store into the environment. In development, keep them in a `.env` file out of git and
run `node --env-file=.env verify.ts`. Never write a key into code, a log or a fixture.

## Build a service: logger, telemetry and a long budget

`verifyAndQueue` verifies one contract in a service. Its logger writes one JSON line per log line
to stderr, and `onEvent` passes each stage event to your telemetry. The budget is ten minutes:
no user waits on a page. If the explorer is still checking when the budget runs out, the function
queues the handle for a later job:

```ts [service.ts]
import { readFile } from "node:fs/promises";

import { ExplorerVerifyError, formatHandle, validateInput, verify } from "explorer-verify";
import type { LogFields, Logger, VerifyEvent, VerifyInput } from "explorer-verify";

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
  const etherscan = process.env["ETHERSCAN_API_KEY"] ?? "";
  try {
    const result = await verify(input, {
      apiKeys: etherscan === "" ? {} : { "etherscan-v2": etherscan },
      logger,
      onEvent: telemetry,
      timeoutMs: 10 * 60_000,
    });
    return result.status === "failed"
      ? `failed on ${result.backend}: ${result.reason}`
      : `${result.status} on ${result.backend}`;
  } catch (error) {
    if (error instanceof ExplorerVerifyError && error.code === "not-confirmed") {
      await queue.add(formatHandle(error.details.handle));
      return "queued for a status check";
    }
    throw error;
  }
}

// Runs it once, with a queue that prints the handle. In your service, pass your own queue.
const input = validateInput(JSON.parse(await readFile("greeter-sepolia.json", "utf8")));
const queue: Queue = {
  add: async (handle) => {
    console.log(`queued ${handle}`);
    await Promise.resolve();
  },
};
const toStderr = (event: VerifyEvent): void => {
  process.stderr.write(`${event.type}\n`);
};
console.log(await verifyAndQueue(input, queue, toStderr));
```

For the sample, it prints the same line as `verify.ts`:

```text
already-verified on sourcify
```

If the budget runs out first, it prints the handle, then `queued for a status check`. The job that
finishes it is in [Resume from a job queue](../advanced/resume-from-a-job-queue.md).

## Set the budget and stop a call

A call ends within `timeoutMs` plus at most 30 seconds. Give a script that runs under a process
manager, or a request handler behind a proxy, a budget shorter than their own limits.

To stop a call early, such as on shutdown, pass an `AbortSignal` in `signal`. The call rejects with
the signal's reason. When a crash between submit and result must not lose the job, save the handle
from the `verify.submitted` event ([Abort and resume](../reference/verify.md#abort-and-resume)).

## Verify on several explorers at once

To publish the source on Etherscan and on Sourcify, call `verifyEach()` once instead of `verify()`
twice. Both backends run at once with one time budget, and the call returns one outcome per
backend. Each key goes only to its own backend:

<!-- no-run: it sends requests to Etherscan, which the recorded answers of the docs test do not cover -->

```ts no-run [verify-each.ts]
import { readFile } from "node:fs/promises";

import { formatHandle, validateInput, verifyEach } from "explorer-verify";

const input = validateInput(JSON.parse(await readFile("greeter-sepolia.json", "utf8")));
const { outcomes } = await verifyEach(input, {
  backends: ["etherscan-v2", "sourcify"],
  apiKeys: { "etherscan-v2": process.env["ETHERSCAN_API_KEY"] },
  timeoutMs: 600_000,
});
for (const outcome of outcomes) {
  if ("error" in outcome) {
    const { error } = outcome;
    // A pending backend: resume it later with checkStatus(error.details.handle).
    const handle = error.code === "not-confirmed" ? formatHandle(error.details.handle) : "";
    console.log(`${outcome.backend}: ${error.code} ${handle}`);
  } else {
    console.log(`${outcome.backend}: ${outcome.result.status}`);
  }
}
```

One backend's error never hides another's result: read `ok` on each outcome. See
[Several backends in one call](../reference/verify.md#several-backends-in-one-call).

## Errors

| Code                                                                            | What the service does                                              |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [`not-confirmed`](../reference/errors/not-confirmed.md)                         | Queue `details.handle` and poll it later with `checkStatus()`      |
| [`missing-api-key`](../reference/errors/missing-api-key.md)                     | The route needs a key that `apiKeys` lacks. Nothing was sent       |
| [`api-key-rejected`](../reference/errors/api-key-rejected.md)                   | The explorer refused the key. Replace it; do not retry with it     |
| [`quota-exceeded`](../reference/errors/quota-exceeded.md)                       | The key's daily limit is spent. Retry after the reset              |
| [`rate-limited`](../reference/errors/rate-limited.md)                           | Retries ran out. Slow down the queue                               |
| [`verification-inconclusive`](../reference/errors/verification-inconclusive.md) | The job ended without a verdict. Call `verify()` again later, once |
| [`job-not-found`](../reference/errors/job-not-found.md)                         | The explorer forgot the job. Log it for a person; do not resubmit  |

[Errors](../reference/errors/index.md) lists every code and its exit code. `toEnvelope()` and
`exitCodeOf()` from `explorer-verify/envelope` turn an outcome into the CLI's JSON envelope and
exit code ([JSON output](../reference/json-output.md)). Pass your keys in `secrets` when you log
the envelope.

## Deno and Bun

The core uses only web-platform globals, so the code above runs in Deno and Bun unchanged, except
where it reads the environment or a file:

| Runtime | Import                                         | Read the key                        | `.env` files                                                       |
| ------- | ---------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------ |
| Deno    | `npm:explorer-verify@0.1.0`, or `package.json` | `Deno.env.get("ETHERSCAN_API_KEY")` | Read only with `--env-file`                                        |
| Bun     | `explorer-verify`                              | `process.env`, as in Node.js        | Loaded on their own; keep them out of git, or pass `--no-env-file` |

In Deno, run with `--allow-env=ETHERSCAN_API_KEY`, `--allow-read` for the input file, and
`--allow-net` limited to the explorer hosts you use, such as `--allow-net=sourcify.dev`.

> [!NOTE]
> The repository's tests run on Node.js and, for the browser, in Chromium. No test runs in Deno or
> Bun.

The Etherscan plan rule applies to a backend too: a business, protocol, foundation or DAO needs an
Advanced plan or higher. See [Etherscan plans and attribution](../explanation/etherscan-plans-and-attribution.md).

## Sources

- Node.js, [`--env-file`](https://nodejs.org/api/cli.html#--env-filefile): loads variables from a
  file. v26 docs, read on 2026-11-04.
- Deno, [Node and npm](https://docs.deno.com/runtime/fundamentals/node/): `npm:` specifiers and
  `package.json`. Read on 2026-11-04 (page updated 2026-07-30).
- Deno, [Environment variables](https://docs.deno.com/runtime/reference/env_variables/): `.env`
  only with `--env-file`. Read on 2026-11-04 (page updated 2026-07-02).
- Bun, [Environment variables](https://bun.com/docs/runtime/environment-variables): loads `.env`
  files by default; `--no-env-file` turns it off. Read on 2026-11-04.

## Next steps

- [Verify a contract from a Foundry project](verify-from-a-foundry-project.md) or
  [from a Hardhat project](verify-from-a-hardhat-project.md): build the input from your own build.
- [Resume from a job queue](../advanced/resume-from-a-job-queue.md): finish a queued handle with
  `checkStatus()`.
- [API keys](../reference/api-keys.md): which host gets each key.
- [verify()](../reference/verify.md): every option, result and error.
