# Using explorer-verify from an agent

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Which calls are safe to run alone, which one publishes for good, where keys come from and when to
stop and ask the person.

For: coding agents that call explorer-verify or its command for a person, and the people who run
them.

You need: Node.js 22.18 or later. A key only for Etherscan or Blockscout's hosted API. For a
copyable prompt, start with the [AI agent quickstart](../start/quickstart-agent.md).

## Read the docs of the installed version

Read these before you run anything:

- `node_modules/explorer-verify/llms.txt` and the pages under `docs/` next to it. The docs site
  describes the version on npm `latest`, which may be newer.
- The skill the package ships,
  [skills/explorer-verify/SKILL.md](../../../skills/explorer-verify/SKILL.md), with tested
  examples of each step.
- For the command, `npx @explorer-verify/cli --help --json`: every command, option, environment
  variable and exit code in one envelope.

Append `.md` to a site page's URL for its Markdown copy, such as an error's `docsUrl` plus `.md`. A
folder's page is `index.md`: <https://aelmanaa.github.io/explorer-verify/reference/errors/index.md>.

## Submit is permanent

These calls and commands send something an explorer publishes. You cannot take it back:

| Call or command          | What it sends                                                                |
| ------------------------ | ---------------------------------------------------------------------------- |
| `verify()`               | Looks the contract up, submits the source when the explorer lacks it, polls  |
| `verifyEach()`           | Runs `verify()` on each backend it lists, so it can submit to several        |
| `explorer-verify verify` | Without `--dry-run`, submits when the lookup finds no match                  |
| `createVerifyHandler()`  | A server handler: whoever reaches it can submit under your Etherscan key     |
| `linkProxy()`            | Links a proxy to its implementation, which changes the proxy's explorer page |

Submit only when the person asked you to verify that contract on that chain. Run a dry run first,
and ask before the real run when the dry run says it would submit.

> [!WARNING]
> A Sourcify submit can also publish the source on Etherscan, Blockscout and Routescan: Sourcify
> forwards it. See [Sourcify](../reference/sourcify.md#behaviour-to-know).

[Server handler](../reference/server-handler.md#who-may-verify) and
[Verify a proxy](verify-a-proxy.md) say more about the last two rows. `linkProxy()` submits no
source, and on Sourcify it only reads. With `resumeJobId`, it sends no link request and only checks
the pending link.

## Safe steps

These calls and commands never submit. Run them without asking:

| Step             | Call or command                                                                                                                                                                                                         | Effect                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Build            | `buildVerifyInput()`, `buildVerifyInputFromFoundry()`, `findFoundryBuild()`, `buildVerifyInputFromHardhat()`, `findHardhatBuild()`                                                                                      | Read local build files; send nothing                             |
| Validate         | `validateInput()`, `linkLibraries()`                                                                                                                                                                                    | Check the input, add library addresses; send nothing             |
| Resolve          | `buildVerifyInputFromBytecode()`                                                                                                                                                                                        | Read-only requests to your RPC, Sourcify or an IPFS gateway      |
| Dry run          | `dryRun()`, `explorer-verify verify --dry-run`                                                                                                                                                                          | Look the contract up once; say whether `verify()` would submit   |
| Status           | `checkStatus()`, `explorer-verify status`                                                                                                                                                                               | Poll a job the explorer already has                              |
| Handles, output  | `parseHandle()`, `tryParseHandle()`, `isHandleString()`, `formatHandle()`, `toEnvelope()`, `exitCodeOf()`, `toBackendName()`, `routingTableDate()`, `routesFor()`, `hintFor()`                                          | Read handles, envelopes, exit codes, hints and the routing table |
| Clients          | `sourcify()`, `sourcifyProxyLink()`, `etherscanV2()`, `etherscanV2ProxyLink()`, `etherscanCompatible()`, `etherscanCompatibleProxyLink()`, `routescan()`, `blockscout()`, `blockscoutHosted()`, `blockscoutProxyLink()` | Create the clients `explorer-verify/core` takes                  |
| Help and version | `explorer-verify help`, `explorer-verify --version --json`                                                                                                                                                              | Print help or versions; contact no explorer                      |

Most of these come from `explorer-verify`. The others come from these entries:

- `@explorer-verify/foundry`: the Foundry build functions;
- `@explorer-verify/hardhat`: the Hardhat build functions;
- `explorer-verify/resolve`: `buildVerifyInputFromBytecode()`;
- `explorer-verify/server`: `createVerifyHandler()`;
- `explorer-verify/envelope`: `toEnvelope()` and `exitCodeOf()`;
- `explorer-verify/clients/<name>`: the clients.

`explorer-verify/core` has its own copy of each flow function, which takes the clients
([Core entry](../reference/core.md)).

## Dry run before you submit

A dry run needs no key. Read its `lookup` field:

| `lookup`             | Meaning                                 | What to do                    |
| -------------------- | --------------------------------------- | ----------------------------- |
| `exact` or `partial` | The explorer already holds the contract | Nothing to submit             |
| `none`               | `verify` would submit                   | Ask the person before the run |
| `skipped`            | The backend needs a key and none is set | Ask the person to set the key |

A dry run with `storedContract` found another contract's source at the address, so `verify` would
submit. Ask the person first, as for `none`.

In the library, with the docs' sample request
[greeter-sepolia.json](../start/greeter-sepolia.json):

```ts [plan.ts]
import { readFile } from "node:fs/promises";

import { dryRun } from "explorer-verify";
import type { VerifyInput } from "explorer-verify";

const json = await readFile("greeter-sepolia.json", "utf8");
const input: VerifyInput = JSON.parse(json);

const plan = await dryRun(input);
if (plan.lookup === "none" || plan.storedContract !== undefined) {
  console.log(`verify() would submit to ${plan.backend}: ask the person first`);
} else if (plan.lookup === "skipped") {
  console.log(`${plan.backend} needs an API key: ask the person to set it`);
} else {
  console.log(
    `${plan.backend} already holds the contract, ${plan.lookup} match: nothing to submit`,
  );
}
```

When Sourcify does not hold the contract yet, it prints:

```text
verify() would submit to sourcify: ask the person first
```

With the command, which reads the same file:

```sh [dry-run.sh]
# exit code 0
npx @explorer-verify/cli verify --input-json greeter-sepolia.json \
  --dry-run --json
```

```text
{"schemaVersion":1,"ok":true,"result":{"status":"dry-run","backend":"sourcify","apiHost":"sourcify.dev","lookup":"exact","explorerUrl":"https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc","routedBy":"table"}}
```

The `backend` field names the explorer the real run would use.

## Choose the explorer

The routing table picks the first backend of the chain's row that works with the keys set:

- Etherscan v2, when the row has it and an Etherscan key is set;
- Sourcify otherwise;
- Blockscout or Routescan, on a row that lists only them.

When the person names an explorer, pass it: `--backend etherscan-v2`, or
`route: { backend: "etherscan-v2" }` in a library call. Blockscout and Routescan need `--backend`
or `route.backend` on a chain whose row lists them, and `--api-url` elsewhere.

The real run asks for a target:

- `verify` without `--dry-run` and without `--backend` exits 2 with `invalid-input`. The hint names
  the chain's backends and what `--backend auto` would pick.
- Pass `--backend auto` only when the person accepts the table's pick.
- In a library call, `verify()` submits to the table's pick when `route.backend` is absent, so set
  it there too.

A chain with no row gives `unsupported-chain`, exit code 2, unless the call passes
`allowSourcifyFallback: true` or `--allow-sourcify-fallback`. [Routing](../reference/routing.md)
explains the table.

## API keys

Sourcify and Blockscout instances need no key. Etherscan v2 needs one; Routescan takes one
optionally. Blockscout's hosted API, `--backend blockscout-hosted`, needs `BLOCKSCOUT_API_KEY`.

| Where       | How the key arrives                                                                 |
| ----------- | ----------------------------------------------------------------------------------- |
| The command | `ETHERSCAN_API_KEY`, `ROUTESCAN_API_KEY` or `BLOCKSCOUT_API_KEY` in the environment |
| The command | One key from `--api-key-file <path>` or `--api-key-stdin`, with `--backend`         |
| The library | `apiKeys`, by backend name, or `route.apiKey` for a standalone explorer             |
| A browser   | None: use the [server handler](../reference/server-handler.md), which holds the key |

Each key goes only to its backend's host. With `--api-url` on another host, use one of the two
flags. [API keys](../reference/api-keys.md) lists the hosts, and
[the CLI reference](../reference/cli.md#api-keys-and-route-options) the rules.

The person sets the key, in their environment, a file or a secret store. Never ask them to paste a
key into the chat. Never write a key into a command line, code, a commit, a fixture or a log.

Do not print or read a key to check that it is set: no `echo`, `cat .env` or `printenv`. Run a dry
run instead: its `backend` and `lookup` show whether the key was used. No flag takes a key as its
value, and the command refuses the flags that look like one:

```sh
# exit code 2
npx @explorer-verify/cli verify --input-json greeter-sepolia.json \
  --api-key --json
```

```text
{"schemaVersion":1,"ok":false,"error":{"code":"invalid-input","message":"The command line is invalid: --api-key is not accepted: a key on the command line shows in the process list and the shell history; set ETHERSCAN_API_KEY, ROUTESCAN_API_KEY or BLOCKSCOUT_API_KEY, or use --api-key-file <path> or --api-key-stdin.","hint":"Fix the arguments the message names, then run the command again. explorer-verify --help lists every command and option.","docsUrl":"https://aelmanaa.github.io/explorer-verify/reference/errors/invalid-input","retryable":false,"details":{"code":"invalid-input","issues":[{"field":"--api-key","message":"is not accepted: a key on the command line shows in the process list and the shell history; set ETHERSCAN_API_KEY, ROUTESCAN_API_KEY or BLOCKSCOUT_API_KEY, or use --api-key-file <path> or --api-key-stdin"}]}}}
```

Errors, events, log lines, results and the command's output replace keys with `[redacted]`
([API keys in errors](../reference/errors/index.md#api-keys-in-errors)). When you print an envelope
from the library, pass every key the process holds: `toEnvelope(outcome, { secrets: [key] })`.

## Read the outcome

Pass `--json` on every run. stdout then holds one line, the
[JSON envelope](../reference/json-output.md#the-envelope), and logs go to stderr. `ok` is `true`
exactly when the exit code is 0.

| Outcome                                    | The envelope holds                                        |
| ------------------------------------------ | --------------------------------------------------------- |
| `verified`, `already-verified` or `failed` | `result`                                                  |
| A dry run                                  | `result`, whose `status` is `dry-run`                     |
| Anything else                              | `error`, with `code`, `hint`, `retryable`, maybe `handle` |

As soon as the explorer accepts a submission, stderr gets this line at the default level:

```text
Submitted to sourcify. Handle: ev1:sourcify:11155111:0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc:ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718
```

Store the handle at once: it is the only way back to the job after a timeout, a cancel or a crash.
With `--log-format json`, the line is a JSON object whose `type` is `verify.submitted`, with the
handle in its `handle` field. `--quiet` hides the line, so do not pass it to a run that may submit.
In the library, the handle comes in the `verify.submitted` event.

## Act on the exit code

| Exit code | Outcome                                                                       | What to do                                                                                                                           |
| --------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 0         | `verified`, `already-verified`, or a dry run                                  | Done. Delete the stored handle                                                                                                       |
| 1         | `failed`: the explorer rejected the source                                    | Report `result.reason`. Do not change the source and resubmit unasked                                                                |
| 2         | Usage or input error. Nothing was submitted                                   | Fix what the message and the hint name, then run again                                                                               |
| 3         | API key missing, rejected or out of quota                                     | Stop. Ask the person to set or fix the key, or wait for the limit to reset                                                           |
| 4         | `not-confirmed` (with a handle), `verification-inconclusive` or `not-indexed` | With a handle, run `status` later. Without one, run `verify` later, once. After `not-indexed`, check `--chain` and `--address` first |
| 5         | Network or explorer unavailable after retries                                 | Later, at most twice: `status` with a handle, `verify` without one                                                                   |
| 6         | `unknown-state`, `job-not-found` or `internal-error`                          | Stop. Do not retry. Give the person the handle, the code and the hint                                                                |
| 130       | Cancelled                                                                     | With a handle, run `status`. With none, nothing was accepted                                                                         |

A handle is in `error.handle`, in `error.handles` for a run on several backends, or on the stderr
line. A run with `--backend` repeated has one exit code for all its backends: the first of 6, 4, 3,
2, 5, 1 and 130 that any backend has. Act on each entry of `result.outcomes`.

[Errors](../reference/errors/index.md#exit-codes) lists the codes behind each exit code, with one
page per code.

## Resume a pending run

Resume with `status <handle>` and the same route options as the submit, never with a new `verify`.
It never submits, and it uses the same exit codes:

```sh
# exit code 0
npx @explorer-verify/cli status --json \
  ev1:sourcify:11155111:0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc:ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718
```

```text
{"schemaVersion":1,"ok":true,"result":{"status":"verified","backend":"sourcify","match":"exact","explorerUrl":"https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc"}}
```

Keep to the limits in the skill's [When to stop](../../../skills/explorer-verify/SKILL.md#when-to-stop):

- at most 3 status checks for one handle;
- after `verification-inconclusive`, `not-indexed` or exit code 5, at most one more `verify`;
- after `job-not-found`, ask the person first, then at most one `verify`.

Then report to the person.

## Etherscan plan rule

A public dapp, or any use by a business, protocol, foundation or DAO, needs an Etherscan Advanced
plan or higher and its own key. When it displays Etherscan data, it must show "Powered by
Etherscan.io APIs". Tell the person when their use falls under this rule.

Etherscan's Free, Lite and Standard plans cover personal and research use only, such as a developer
verifying their own testnet deployments. Commercial use includes anything offered to third parties,
free or paid, anything that earns revenue, and anything run by or for an organisation.

This is a reading of [Etherscan's API terms](https://etherscan.io/apiterms), not legal advice.
[Etherscan plans and attribution](../explanation/etherscan-plans-and-attribution.md) explains it.
This page does not cover the terms of Blockscout, Routescan or Sourcify; check them before you rely
on those APIs.

## Sources

- Etherscan, [API terms](https://etherscan.io/apiterms), last updated 1 October 2026. Read again
  on 2026-11-04.

## Next steps

- [AI agent quickstart](../start/quickstart-agent.md): a prompt to paste.
- [Agent skill](../../../skills/explorer-verify/SKILL.md): tested examples of each step.
- [JSON output and exit codes](../reference/json-output.md).
- [Errors](../reference/errors/index.md): every code, its cause and fix.
