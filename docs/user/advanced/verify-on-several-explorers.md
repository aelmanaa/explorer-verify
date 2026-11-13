# Verify on several explorers

Verify one contract on several explorers in one call, with one outcome per
explorer.

Version: explorer-verify 0.3.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers who want a contract verified on Etherscan and Sourcify,
or on every explorer a chain has. [verify()](../reference/verify.md) covers a
single explorer.

The signature:

<!-- fragment: the signature only; the example below is type-checked. -->

```ts fragment
function verifyEach(
  input: VerifyInput,
  options: VerifyEachOptions, // the options of verify() and backends
): Promise<VerifyEachResult>;
```

## Example

This example verifies one contract on Sourcify and Etherscan:

<!-- no-run: it sends requests to Etherscan, which the recorded answers of the docs test do not cover -->

```ts no-run [verify-each.ts]
import { readFile } from "node:fs/promises";

import { formatHandle, verifyEach } from "explorer-verify";
import { validateInput } from "explorer-verify";

const text = await readFile("greeter-sepolia.json", "utf8");
const input = validateInput(JSON.parse(text));

const { outcomes } = await verifyEach(input, {
  backends: ["sourcify", "etherscan-v2"],
  apiKeys: { "etherscan-v2": etherscanKey },
  timeoutMs: 120_000,
});
for (const outcome of outcomes) {
  if (!("error" in outcome)) {
    console.log(outcome.backend, outcome.result.status);
  } else if (outcome.error.code === "not-confirmed") {
    // Checking the code narrows details: this one holds the handle.
    const handle = formatHandle(outcome.error.details.handle);
    console.log(outcome.backend, "resume with", handle);
  } else {
    console.log(outcome.backend, outcome.error.code);
  }
}
```

It prints one line per backend, such as `sourcify already-verified`. The
example uses the docs' [sample request](../start/greeter-sepolia.json).

## Choose the backends

`verifyEach()` takes the options of `verify()` without `route`, plus
`backends`. A top-level `route` throws `invalid-input`.

`backends` is an array of 1 to 16 entries, or `"all"`:

| Entry                              | What it names                                                          |
| ---------------------------------- | ---------------------------------------------------------------------- |
| A backend name, such as `sourcify` | The routing table's host for that backend on the chain                 |
| `{ backend, apiUrl?, apiKey? }`    | A route override, such as a standalone Etherscan-compatible site       |
| `"all"`                            | Every backend the chain's row lists that this version has a client for |

`"all"` leaves out a backend that needs a key when `apiKeys` has none for
it. With `handlerUrl`, `etherscan-v2` stays, and its requests go to your
[server handler](../reference/api-keys.md#a-server-adds-the-key).

An entry with any other field throws `invalid-input` naming it. So do two
entries with the same backend and API URL, compared once normalised:
`"sourcify"` and `{ backend: "sourcify", apiUrl: "https://sourcify.dev/server/" }`
are the same. The same backend on two hosts is allowed.

## Read the outcomes

`outcomes` is in the order of `backends`. One backend's error never hides
another's result.

| Outcome                          | When                                     |
| -------------------------------- | ---------------------------------------- |
| `{ backend, ok: true, result }`  | `verified` or `already-verified`         |
| `{ backend, ok: false, result }` | `failed`                                 |
| `{ backend, ok: false, error }`  | An `ExplorerVerifyError`, with `details` |

The error keeps its `details` and `instanceof`. `toEnvelope()` writes it as
its `toJSON()`. These cases give an outcome, and the other backends still
run:

- a backend the chain's row does not list: `unsupported-chain`;
- a backend that needs a key and has none: `missing-api-key`;
- a client module that fails to load, such as a chunk the page cannot
  fetch: `network`, with the load's error as `cause`.

## Resume one backend

A `not-confirmed` outcome keeps its handle in `error.details.handle`. Pass it
to [checkStatus()](../reference/check-status.md), with that entry's route as
`route`, to resume that backend alone.

An abort rejects the whole call with `signal.reason`. `onSubmitted` has
received the handle of every submission made before it, so each pending job
can still be resumed ([Abort and resume](abort-and-resume.md)).

## Keys

Each backend gets only its own key. A key in `apiKeys` goes only to its
backend's routing-table host. An entry's `apiKey` goes only to that entry's
`apiUrl`. Every key is removed from every outcome, log line and event.

A key found in the address, or in the fixed part of any backend's handle,
throws `invalid-input` before any request. See
[API keys](../reference/api-keys.md).

## How it runs

The backends run at once, with one time budget, `timeoutMs`, shared by all
of them, and the caller's `signal`. Each runs the steps of
[verify()](../reference/verify.md#what-it-does).

It throws, and sends nothing, when the input or options fail validation. It
also throws `unsupported-chain` for `"all"` on a chain the routing table
does not list, unless `allowSourcifyFallback` is set.

It emits `verify.validated` once, then each backend's events, each with its
`backend` ([Logging and events](../reference/logging-and-events.md#several-backends)).

## Exit code

`exitCodeOf()` and `toEnvelope()` take the result. The exit code is 0 only
when every backend verified. Otherwise it is the first of 6, 4, 3, 2, 5, 1
and 130 that any outcome has, so a job to resume comes before a key or an
input to fix.

The code names only one outcome: read `outcomes` for every backend
([JSON output](../reference/json-output.md#several-backends)). The CLI runs
`verifyEach()` when `--backend` is given more than once
([CLI](../reference/cli.md#verify)).

## Next steps

- [Abort and resume](abort-and-resume.md): keep the handle of each submit.
- [API keys](../reference/api-keys.md): which host gets each key.
- [Etherscan-compatible explorers](../reference/etherscan-compatible.md): a
  standalone explorer as a `backends` entry.
