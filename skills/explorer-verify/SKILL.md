---
name: explorer-verify
description: Verify deployed smart contract source code on a block explorer with the explorer-verify npm package. This release verifies on Sourcify, Etherscan v2, Routescan, Blockscout and standalone Etherscan-compatible explorers. Load this skill when asked to verify a contract, publish its source, or check or resume a verification, in a project built with Foundry or Hardhat or from Solidity metadata and sources. It covers building the input, verify(), storing the handle, checkStatus(), the result, the error codes, the exit codes and when to stop. verify() publishes the source on the explorer permanently, so call it only when the person asked to verify that contract on that chain.
---

# Verify a contract with explorer-verify

explorer-verify verifies the source of a deployed contract on a block explorer. In this release
the routing table sends a chain it lists to Etherscan v2 when the person passes an Etherscan key and
the chain is on Etherscan's free tier, and to Sourcify, which needs no API key, otherwise.
Routescan, Blockscout and standalone Etherscan-compatible explorers are reached only with
`route.backend` and `route.apiUrl`. A chain the table does not list throws `unsupported-chain`
unless you pass `allowSourcifyFallback: true`.

This skill ships in the npm package, next to the docs of the same version:

- [llms.txt](../../llms.txt) lists every page of the docs.
- [Using explorer-verify from an agent](../../docs/user/guides/using-from-an-agent.md) has the
  rules for agents: which calls are safe, which one submits, where keys come from.
- [verify()](../../docs/user/reference/verify.md),
  [checkStatus()](../../docs/user/reference/check-status.md),
  [Errors](../../docs/user/reference/errors/index.md), with one page per error code, and
  [JSON output and exit codes](../../docs/user/reference/json-output.md) are the reference.

The examples are ES modules in TypeScript, for Node.js 22.18 or later, which runs `.ts` files by
stripping the types. For a `.mjs` file, drop the type annotations and the `import type` lines. The
project's `package.json` needs `"type": "module"`. The package's tests run each example against
the build it ships with, so they match this version.

## Submit is permanent

`verify()` submits the source unless the explorer already has it. The explorer publishes the
source, and you cannot take it back. A Sourcify submit can also publish the source on other
explorers, because Sourcify forwards it. Call `verify()` only when the person asked you to verify
that contract on that chain.

These calls never submit. Run them without asking:

| Call                 | What it does                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `buildVerifyInput()` | Builds the compiler input and contract name from parsed build files                           |
| `validateInput()`    | Checks an input locally and lists every problem. Sends nothing                                |
| `dryRun()`           | Looks the contract up and says whether `verify()` would submit                                |
| `linkLibraries()`    | Adds `libraries` to `settings.libraries`. Sends nothing                                       |
| `checkStatus()`      | Asks the explorer about a submission it already has. Never submits                            |
| `parseHandle()`      | Reads a stored handle and checks it. Sends nothing                                            |
| `tryParseHandle()`   | As `parseHandle()`, but returns `undefined` instead of throwing                               |
| `isHandleString()`   | Tells whether a string is a valid one-line handle. Sends nothing                              |
| `formatHandle()`     | Writes a handle in its one-line form. Sends nothing                                           |
| `toEnvelope()`       | Turns a result or an error into the JSON envelope (`explorer-verify/envelope`). Sends nothing |
| `exitCodeOf()`       | Gives the exit code of a result or an error (`explorer-verify/envelope`). Sends nothing       |

The [agent page](../../docs/user/guides/using-from-an-agent.md#safe-steps) lists every call and
command as safe or outward.

## 1. Build the input

`buildVerifyInput()` takes parsed build files in any order and returns the `compiler` and
`contractName` fields of a `VerifyInput`. It works out what each file is from its shape. Pass:

- a Hardhat 3 build-info and the contract's artifact;
- a Hardhat 2 build-info, and the artifact or the `contract` option;
- a Foundry build-info and the artifact. Foundry writes a build-info only with
  `forge build --build-info`. With it, no source files are needed;
- a Standard JSON input, with `contract` as `path:Name` and `compilerVersion`;
- a Foundry artifact or Solidity metadata, with the source files in `sources`. Use this when there
  is no build-info.

The metadata route rebuilds the Standard JSON input from the metadata. `sources` maps each path,
as the metadata lists it, to the file's content. Pass each file exactly as it was compiled: the
builder checks its keccak-256 hash against the metadata and throws `source-mismatch` when a line
ending or a formatter changed it.

Add the chain ID and the deployed address, then check the whole input with `validateInput()`:

```ts
import { readFile, writeFile } from "node:fs/promises";

import { buildVerifyInput, validateInput } from "explorer-verify";

const artifact: unknown = JSON.parse(
  await readFile("out/Greeter.sol/Greeter.json", "utf8"),
);
const built = buildVerifyInput([artifact], {
  sources: {
    "src/Base.sol": await readFile("src/Base.sol", "utf8"),
    "src/Greeter.sol": await readFile("src/Greeter.sol", "utf8"),
  },
});

const input = validateInput({
  chainId: 11155111,
  address: "0x8275D36F64F047D2D8a1F42c79Bf80Caea39D7cC",
  ...built,
});
await writeFile("verify-input.json", JSON.stringify(input));
console.log(input.contractName, input.compiler.version, input.address);
```

It prints:

```text
src/Greeter.sol:Greeter 0.8.24+commit.e11b9ed9 0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc
```

- `validateInput()` returns a checked copy with the address in lower case. It throws only
  `invalid-input`, and lists each bad field in `error.details.issues`.
- `buildVerifyInput()` throws `incomplete-input` when the files are not enough, with the missing
  field in `error.details.field`. It throws `insufficient-artifact` when you have only ABI and
  bytecode, which cannot be verified.
- Do not pass constructor arguments: Sourcify reads them from the creation code.
- Add `creationTxHash`, the hash of the deployment transaction, when you have it. Sourcify then
  matches the creation code as well as the runtime code.

[Verify a contract shipped in an npm package](../../docs/user/guides/verify-a-contract-from-an-npm-package.md)
covers every build format.

## 2. Verify, or resume a stored handle

`verify()` looks the contract up, submits it when the explorer lacks it, and polls the job. As
soon as the explorer accepts the submission, before the first poll, it calls `onSubmitted` with
the handle in its one-line form, `ev1:<backend>:<chainId>:<address>:<jobId>`, which ends with
`:over-partial` after a submit over a partial match. Store it whole, at once: it is the only
way back to the job after an abort, a crash or a timeout. `verify()` does not wait for a promise
that `onSubmitted` returns, so write the handle synchronously. If the handle cannot be stored,
stop and give it to the person.

With `verifyEach()`, the second argument of `onSubmitted` holds `entry`, the index of the entry in
`backends`. Store the entry with the handle, and resume each handle with `checkStatus()` and that
entry's route: two entries can name the same backend on different hosts. A submit still in flight
at an abort may have been accepted with no handle returned.

Before you call `verify()`, look for a stored handle. If there is one, an earlier run submitted
already: call `checkStatus()` with it, not `verify()`. After a final outcome, delete the stored
handle. This script does both, so you can run it again after any stop:

```ts
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import {
  checkStatus,
  ExplorerVerifyError,
  formatHandle,
  parseHandle,
  validateInput,
  verify,
} from "explorer-verify";
import type { VerifyOptions, VerifyResult } from "explorer-verify";
import { exitCodeOf } from "explorer-verify/envelope";

const HANDLE_FILE = "verification-handle.txt";

function storeHandle(handle: string): void {
  try {
    writeFileSync(HANDLE_FILE, handle);
  } catch {
    console.error(
      `Could not store the handle. Stop and give it to the person: ${handle}`,
    );
  }
}

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
// The same options go to verify() and checkStatus(), so a `route`, if you add
// one, is the same for the submit and the resume.
const options: VerifyOptions = {
  signal: controller.signal,
  timeoutMs: 120_000,
  onSubmitted: storeHandle,
};

// A stored handle means an earlier run submitted: resume it, never submit
// again.
const pending = existsSync(HANDLE_FILE)
  ? parseHandle(readFileSync(HANDLE_FILE, "utf8").trim())
  : undefined;

try {
  const result: VerifyResult =
    pending === undefined
      ? await verify(
          validateInput(JSON.parse(readFileSync("verify-input.json", "utf8"))),
          options,
        )
      : await checkStatus(pending, options);
  rmSync(HANDLE_FILE, { force: true });
  if (result.status === "failed") {
    console.log(`failed: ${result.reason}`);
  } else {
    console.log(result.status, result.match, result.explorerUrl ?? "");
  }
  process.exitCode = exitCodeOf(result);
} catch (error) {
  if (controller.signal.aborted && error === controller.signal.reason) {
    // An abort rejects with signal.reason. Keep the stored handle and exit 130.
    process.exitCode = 130;
  } else if (error instanceof ExplorerVerifyError) {
    if (error.code === "not-confirmed") {
      storeHandle(formatHandle(error.details.handle));
    } else {
      rmSync(HANDLE_FILE, { force: true });
    }
    // The code, the handle when there is one, and the hint. Never the cause or
    // the stack.
    const json = error.toJSON();
    console.log(json.code, json.handle ?? "-", json.hint);
    process.exitCode = exitCodeOf(error);
  } else {
    throw error;
  }
}
```

On a first run that submits and gets an exact match, it prints:

```text
verified exact https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc
```

The handle is plain data with no URL and no key. It holds no spaces or shell characters.

## 3. Resume with checkStatus()

`checkStatus()` polls the job from a handle and never submits. The script above calls it when a
handle is stored: after a `not-confirmed` error, an abort or a restart. Store the one-line form.
`parseHandle()` reads it or the handle object, and throws `invalid-input` for anything else. The handle never chooses the host: pass the same `route` option the submit used, if
any.

- `not-confirmed` again: the job is still running. Keep the handle and try later.
- `job-not-found`: the explorer no longer has the job, and a lookup found the contract not
  verified. Ask the person, then call `verify()` once.

## 4. Read the outcome

A call ends with a `VerifyResult` or throws an `ExplorerVerifyError`. An unknown or ambiguous
state always throws; it never comes back as a result.

- `result.status` is `verified`, `already-verified` or `failed`. The first two carry
  `result.match` (`exact` or `partial`) and, for a public explorer, `result.explorerUrl`. `failed`
  carries `result.reason`, the explorer's text, and `result.reasonCode`: why the explorer rejected
  the source, such as `bytecode-mismatch`, `missing-source` or `unknown`. Read `reasonCode`, not
  the text.
- `result.storedContract` on `already-verified` means the explorer holds another contract's source
  for the address, with that `name` and `compilerVersion`: `verify()` submitted and the explorer
  refused. Tell the person; the explorer page shows the other contract, not theirs. The CLI exits
  0 for it, or 1 with `ok: false` under `verify --require-own-source`. Exit 1 here is not a
  rejection of the source: do not edit it. Check the contract name and compiler version with the
  person.
- `already-verified` with `partial` and no `storedContract` means the explorer holds a partial
  match of this source. To replace it with an exact one, the person can ask for a second call with
  `submitOverPartial: true` (CLI: `--submit-over-partial`). That call submits the source: ask the
  person first. When the explorer rejects that submit, the result stays `already-verified` with
  `partial`.
- `error.code` is a stable code, and checking it narrows `error.details` to that code's data.
  `ExplorerVerifyError.is(error, "not-confirmed")` does both checks in one call and also holds for
  an error from another installed copy of the package. `error.hint` says what to do next,
  `error.retryable` says whether trying again may succeed, and `error.docsUrl` links the code's own
  page in the docs.
  Append `.md` to `error.docsUrl` to fetch that page as Markdown.
  `ERROR_CODES` lists every code. `error.toJSON()` and the envelope keep `details`, redacted, with
  each handle in its one-line form: read `error.details.issues` or `error.details.candidates` there
  instead of parsing the message.

To report the outcome as data, turn it into the versioned JSON envelope with `toEnvelope()` and
take the exit code from `exitCodeOf()`, both from `explorer-verify/envelope`. `VerifyOutcome` is a
result or an error. This example also
passes its own `fetch`, which logs each request without its query string. In a script that may run
again, add the handle check from step 2.

```ts
import { readFile } from "node:fs/promises";

import { ExplorerVerifyError, validateInput, verify } from "explorer-verify";
import { exitCodeOf, toEnvelope } from "explorer-verify/envelope";
import type { VerifyOutcome } from "explorer-verify/envelope";

// Logs the method, host and path of each request, never the query string, where
// keys go. It passes `init` through unchanged, so the library's `redirect:
// "manual"` still applies.
const loggingFetch: typeof fetch = async (request, init) => {
  const url = new URL(request instanceof Request ? request.url : request);
  console.error(`${init?.method ?? "GET"} ${url.host}${url.pathname}`);
  return fetch(request, init);
};

const input = validateInput(
  JSON.parse(await readFile("verify-input.json", "utf8")),
);
let outcome: VerifyOutcome;
try {
  outcome = await verify(input, { fetch: loggingFetch });
} catch (error) {
  if (!(error instanceof ExplorerVerifyError)) throw error;
  outcome = error;
}
// Sourcify needs no key. Pass { secrets: [key] } when there is one.
console.log(JSON.stringify(toEnvelope(outcome)));
process.exitCode = exitCodeOf(outcome);
```

Here the explorer already has the contract, so the call submits nothing. It prints:

```text
{"schemaVersion":1,"ok":true,"result":{"status":"already-verified","backend":"sourcify","match":"exact","explorerUrl":"https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc"}}
```

An error gives an envelope with `ok: false` and an `error` object. This input has a short address,
so `validateInput()` throws before anything is sent:

```ts
import { ExplorerVerifyError, validateInput } from "explorer-verify";
import { exitCodeOf, toEnvelope } from "explorer-verify/envelope";

try {
  validateInput({ chainId: 11155111, address: "0x1234" });
} catch (error) {
  if (!(error instanceof ExplorerVerifyError)) throw error;
  const envelope = toEnvelope(error);
  console.log(envelope.ok, error.code, error.retryable, exitCodeOf(error));
  process.exitCode = exitCodeOf(error);
}
```

It prints:

```text
false invalid-input false 2
```

Act on the exit code, or on `ERROR_EXIT_CODES[code]`. The table describes `exitCodeOf()` and the
exit codes of the CLI. A script sets `process.exitCode` itself, as the
examples do. See [When to stop](#when-to-stop) for how often to retry.

| Exit code | Outcome                                                                                                                                                                                                                                       | What to do                                                                                                                                                                                                                                                                                                                                                     |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0         | `verified` or `already-verified`                                                                                                                                                                                                              | Done. Delete the stored handle                                                                                                                                                                                                                                                                                                                                 |
| 1         | `failed`: the explorer rejected the source. With `--require-own-source`, also `already-verified` with `storedContract`                                                                                                                        | `failed`: report `result.reason`. `storedContract`: report its `name` and `compilerVersion`; the source was not rejected, so do not edit it. In both cases, do not change the sources or settings and submit again unless the person asks                                                                                                                      |
| 2         | `invalid-input`, `unsupported-chain`, `incomplete-input`, `insufficient-artifact`, `unsupported-compiler`, `source-mismatch`, `no-metadata-hash`, `constructor-args-unavailable` or `handler-refused`. Nothing was submitted for verification | Fix what `error.details.issues` or `error.details.field` names. An envelope has no `details`: read its `hint`. `no-metadata-hash`: build the input from the build files instead. `constructor-args-unavailable`: pass `constructorArgs`. `handler-refused`: do not retry; give the hint, which names the `createVerifyHandler` option to change, to the person |
| 3         | `missing-api-key`, `api-key-rejected` or `quota-exceeded`, from the Etherscan and Routescan clients on. Nothing more can succeed with this key in this call                                                                                   | Do not retry. Ask the person for a key, a valid key, or to wait until the daily limit resets. Never ask them to paste a key into the chat                                                                                                                                                                                                                      |
| 4         | `not-confirmed`, `verification-inconclusive`, `not-indexed` or `proxy-link-pending`                                                                                                                                                           | `not-confirmed`: call `checkStatus()` later with the handle. `verification-inconclusive`: no handle; call `verify()` again later, once. `not-indexed`: no handle; check the chain ID and address, then call again in a minute, once. `proxy-link-pending`: no handle; call `linkProxy()` again later, once, with `resumeJobId: error.details.jobId`            |
| 5         | `network`, `rate-limited`, `timeout`, `unexpected-response`, `in-progress` or `metadata-unavailable`                                                                                                                                          | Retry `verify()` later, at most once or twice. It looks the contract up before it submits. `in-progress` or `timeout` may mean an earlier submit is running. `metadata-unavailable` comes from `buildVerifyInputFromBytecode`: read `error.details.attempts`                                                                                                   |
| 6         | `unknown-state`, `job-not-found`, `proxy-link-unknown-state`, or `internal-error` from the CLI                                                                                                                                                | Do not retry automatically. `unknown-state`: give the handle and the hint to the person. `job-not-found`: ask the person, then call `verify()` once. `proxy-link-unknown-state`: give `details.excerpt` to the person. `internal-error`: a bug; give the message to the person                                                                                 |
| 130       | `cancelled`, from the CLI only                                                                                                                                                                                                                | In the library an abort rejects with `signal.reason`: set exit code 130 yourself, keep the stored handle, and resume with `checkStatus()`                                                                                                                                                                                                                      |

Within `schemaVersion` 1, a release may add fields and error codes. Ignore a field you do not
know. Handle an unknown code by its `retryable` value and its exit code. If the error carries a
handle, retry only with `checkStatus()`, never `verify()`.

## 5. From the command line

The `@explorer-verify/cli` package adds the `explorer-verify` command. It is not published yet.
`explorer-verify verify` runs `verify()` and `explorer-verify status <handle>` runs
`checkStatus()`. The rules above hold for it too:

- Start with `explorer-verify --help --json`. It prints the commands, their options and examples,
  the environment variables and the exit codes as one envelope. `explorer-verify help <command>`
  gives the help of one command. Help never submits.
- `explorer-verify --version --json` prints the CLI and core versions and `routingTableDate`, the
  date of the routing table. Check it before you trust a chain's route.
- Pass `--json` on every run. stdout then holds exactly one envelope, the same shape as
  `toEnvelope()` returns, and logs and events go to stderr. Act on the exit code, as in the table
  above.
- The `verify.submitted` line on stderr carries the handle. Store it at once, as in step 2.
- A mistyped command or option exits 2 with `invalid-input`, and the hint names the closest
  command or option. Read the hint, fix the command line, and run it once more. The error names a
  mistyped long option close to one of its names, such as `--colour`, and never repeats a value or any
  other argument, because a mistyped value can be a key. An option that takes one value, such as
  `--chain` or `--contract`, exits 2 when it is given twice.

This command line mistypes `--color`:

```sh
explorer-verify --version --json --colour=never
```

It exits 2 and prints:

```text
{"schemaVersion":1,"ok":false,"error":{"code":"invalid-input","message":"The command line is invalid: --colour is not an option.","hint":"Did you mean --color? Fix the arguments the message names, then run the command again. explorer-verify --help lists every command and option.","docsUrl":"https://aelmanaa.github.io/explorer-verify/reference/errors/invalid-input","retryable":false,"details":{"code":"invalid-input","issues":[{"field":"--colour","message":"is not an option"}]}}}
```

Before a real `verify`, run the same command line with `--dry-run`. It validates the input,
resolves the route and looks the contract up, then stops: it never submits, and it needs no API
key. Run it without asking. Read the `lookup` field of its result:

- `exact` or `partial`: the explorer already holds the contract. `verify` would submit nothing,
  unless the result has `storedContract`: then the match is another contract's source and
  `verify` would submit. Ask the person first. For `partial` without `storedContract`, `verify`
  submits only with `--submit-over-partial`.
- `none`: `verify` would submit. Ask the person before you run it without `--dry-run`.
- `skipped`: the backend needs an API key and none is set, so no request was sent. Do not run
  `verify`: it would exit 3 with `missing-api-key`. Ask the person to set the key.

These examples run in a Foundry project after `forge build --build-info`. `--foundry .` with
`--contract path:Name` finds the contract's build files under `out/`, whatever the build-info's
hash name; `--hardhat .` does the same in a Hardhat project. Pass `--input <file>`, once for each
file, only for build files outside a project:

```sh
explorer-verify verify 0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc \
  --chain 11155111 --foundry . --contract src/Greeter.sol:Greeter \
  --dry-run --json
```

It exits 0 and prints:

```text
{"schemaVersion":1,"ok":true,"result":{"status":"dry-run","backend":"sourcify","apiHost":"sourcify.dev","lookup":"exact","explorerUrl":"https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc","routedBy":"table"}}
```

Without `--backend`, the dry run shows the routing table's pick, the first backend of the chain's
row that works with the keys set, so with ETHERSCAN_API_KEY set the same command line may go to
Etherscan instead. Read `backend` and `routedBy` in the result.

`--chain` takes the chain ID or its name, such as `sepolia`; the CLI reference lists the names.

`verify` without `--dry-run` needs a target: `--backend <name>`, or `--backend auto` for the
routing table's pick. `--backend all` verifies on every backend of the chain's row that can run, in one
run, like a repeated `--backend`, and names on stderr each backend it skipped for lack of a key;
pass it only when the person asks for every explorer. Without a target it exits 2 with `invalid-input` and submits nothing; the hint
names the backends the chain lists and what `auto` would pick. When the person names an explorer,
pass its backend, such as `--backend etherscan-v2` for Etherscan, or `route.backend` in the
library, where `verify()` still submits to the table's pick without it. Pass `--backend auto` only
when the person accepts that pick: on Sepolia with no Etherscan key set, it is Sourcify. With
`--backend etherscan-v2` and no key, the command exits 3 with `missing-api-key` and submits
nothing. `--api-url` needs `--backend` naming the backend that serves it. For a chain whose row has no Etherscan entry, Etherscan is reached only with
`--backend etherscan-v2 --api-url https://api.etherscan.io/v2/api`. With no key, the dry run skips
the lookup:

```sh
explorer-verify verify 0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc \
  --chain 11155111 --foundry . --contract src/Greeter.sol:Greeter \
  --backend etherscan-v2 --api-url https://api.etherscan.io/v2/api \
  --dry-run --json
```

It exits 0 and prints:

```text
{"schemaVersion":1,"ok":true,"result":{"status":"dry-run","backend":"etherscan-v2","apiHost":"api.etherscan.io","lookup":"skipped","routedBy":"api-url"}}
```

Keys on the command line:

- No flag takes a key. The CLI reads the ETHERSCAN_API_KEY and ROUTESCAN_API_KEY variables, or one key from
  `--api-key-file <path>` or `--api-key-stdin`. A key flag needs `--backend`, and `--api-url` for a
  route the routing table does not hold.
- With `--api-url`, as Etherscan needs on a chain whose row has no Etherscan entry, the variable
  is not sent: give the key with `--api-key-file` or `--api-key-stdin`. The person sets the key;
  never ask them to paste it into the chat, and never write it into a command line.
- `--input-json <file>` reads the whole request as JSON: the `verify-input.json` of step 1, with an
  optional `route` of `backend` and `apiUrl`; a real run needs `route.backend`, a name or
  `"auto"`. It holds no key. Only the output, log, `--dry-run`,
  `--timeout`, `--poll-interval`, `--index-wait`, `--require-own-source` and key flags may go with
  it, not `--foundry` or `--hardhat`.
- A run that ends pending exits 4 with the handle in the error. Resume with
  `explorer-verify status <handle>`, never with a new `verify`. With `--json`, its envelope
  also holds `nextCommand`, that `status` command as an argument array: run it as it is. It never
  submits.
- The CLI's hints name its flags and environment variables, such as the Etherscan key variable
  and `--api-key-file` for `missing-api-key`, and `--contract` with the candidate names for
  `incomplete-input`. Follow the hint.

## When to stop

An agent that retries without a limit can submit twice or poll for hours. Keep to these limits:

- Call `checkStatus()` at most 3 times for one handle, a few minutes apart.
- After `verification-inconclusive`, `not-indexed` or an exit code 5, call the same function or
  command again at most once.
- After `job-not-found`, ask the person first, then call `verify()` at most once.
- Then stop, and report the handle, the error code and the hint to the person.
- After exit code 1, report `result.reason` and `result.reasonCode` for `failed`. For `already-verified` with
  `storedContract`, which exits 1 under `--require-own-source`, report its `name` and
  `compilerVersion`: the source was not rejected, so do not edit it. Either way, do not change the
  sources or the settings and submit again unless the person asks.
- Right after a deployment, Sourcify may answer `contract_not_deployed`, as
  `verification-inconclusive`, until its node sees the contract. Etherscan answers that it finds no
  contract code, and `verify()` throws `not-indexed` when its wait ends; pass a longer `indexWaitMs`,
  or `--index-wait <seconds>` to the CLI, to wait more. Wait for the deployment to be indexed, then try once more.

## Keys and redaction

- Read a key from an environment variable or a key file. Never pass it as a command-line flag
  value, and never write it into code, a commit, a fixture or a test.
- Do not print or read a key to check that it is set: no `echo`, `cat .env` or `printenv`. Run a
  dry run instead: its `backend` and `lookup` show whether the key was used.
- Treat a JSON-RPC URL as a key: providers put keys in its path or query. On the command line,
  pipe it with `--rpc-url-stdin` or name a file with `--rpc-url-file`. `--rpc-url` refuses a URL
  with a part that can hold a key.
- Pass a key to the library in `apiKeys`, by backend name, such as
  `{ apiKeys: { "etherscan-v2": key } }`. The library sends it only to that backend's own host and
  never in a URL. A standalone explorer's key goes in `route.apiKey`.
- Never put a key in a URL you print, log or store. The library removes each query value of
  `route.apiUrl` that is 8 or more characters long from every error, log line, event and result.
  Put a key in a parameter named like a key, such as `apikey` or `token`: then a shorter value is
  removed too.
- The library cleans only what it produces. In your own logs, print the host and the path, not
  the query.
- Errors, events, log lines and results replace keys with `[redacted]`. When you print an
  envelope, pass every key the process holds: `toEnvelope(outcome, { secrets: [key] })`.
- Do not print `error.cause` or an error's stack where others read it. `JSON.stringify(error)`,
  `error.toJSON()` and `toEnvelope()` leave them out.
- Do not ship an Etherscan key to a browser. Etherscan's API terms forbid it, and a public or
  business use needs a paid plan. See the agent page for the rule.

## Do not

- Do not call `verify()` to check whether a contract is verified. It submits when the explorer
  lacks the source. Call `dryRun()` instead.
- Do not call `verify()` while a handle is stored, or again after `not-confirmed`. Call
  `checkStatus()` with the handle.
- Do not run two `verify()` calls for the same contract at once.
- Do not inject a `fetch` that follows redirects. The library sends every request with
  `redirect: "manual"`, because a redirect could carry a key to another host. Pass `init`
  through unchanged, and never set `redirect: "follow"`.
- Do not take a host from a handle or from stored data. Hosts come from the routing table or from
  the `route` option.
- Do not parse error messages. Read `error.code`, `error.retryable` and the exit code.
- Do not reformat or re-save source files before passing them to `buildVerifyInput()`.
